<script setup lang="ts">
/**
 * /export 装订还原与验收归档
 * 登记装订方式与验收结论，验收合格触发全册归档；支持 JSON 结构版本导入导出。
 * 消费 Binding 及全部模型；复用 <StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Download, Edit, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLeafStats } from '@/hooks/useLeafStats'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import {
  BINDING_METHOD_OPTIONS,
  BINDING_VERDICT_COLOR,
  BINDING_VERDICT_LABEL,
  BINDING_VERDICT_OPTIONS,
  createEmptyBindingDraft,
  type Binding,
  type BindingDraft,
  type BindingVerdict
} from '@/types/binding'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL, isVolumeLocked } from '@/types/volume'
import type { Paper } from '@/types/paper'
import {
  DB_NAME,
  DB_VERSION,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  resetDatabase,
  validateSnapshot,
  writeLastBackupAt,
  type RestoreSnapshot
} from '@/utils/db'
import {
  buildArchiveReport,
  copyText,
  exportArchiveReport,
  exportLeafLedgerCsv,
  exportSnapshotJson
} from '@/utils/export'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const { totals } = useLeafStats()
const bindingTable = useIdbTable<Binding>((database) => database.bindings, { sortByUpdatedAt: false })
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const fileInput = ref<HTMLInputElement | null>(null)
const lastBackupAt = ref<string | null>(readLastBackupAt())

const volumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]} · ${VOLUME_STATE_LABEL[volume.state]}`,
      locked: isVolumeLocked(volume.state)
    }))
  )
)

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

const stat = computed(() => {
  const list = bindingTable.rows.value
  const pass = list.filter((item) => item.verdict === 'pass').length
  const archived = bookStore.volumes.filter((volume) => volume.state === 'archived').length
  const pendingBinding = bookStore.volumes.filter((volume) => !isVolumeLocked(volume.state)).length
  return {
    total: list.length,
    pass,
    rework: list.length - pass,
    passPercent: list.length === 0 ? 0 : Math.round((pass / list.length) * 100),
    archived,
    pendingBinding
  }
})

const context = computed(() => ({
  books: bookStore.books,
  volumes: bookStore.volumes,
  leaves: leafStore.leaves,
  papers: paperTable.rows.value,
  repairOrders: repairStore.orders,
  bindings: bindingTable.rows.value
}))

const archiveText = computed(() => buildArchiveReport(context.value))

/* ----------------------------- 装订表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Binding | null>(null)
const form = reactive<BindingDraft>(createEmptyBindingDraft(''))

function openCreate(): void {
  const first = volumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先登记古籍与册次')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyBindingDraft(first.value))
  dialog.value = true
}

function openEdit(binding: Binding): void {
  editing.value = binding
  Object.assign(form, {
    volumeId: binding.volumeId,
    method: binding.method,
    finishDate: binding.finishDate,
    verdict: binding.verdict,
    inspector: binding.inspector
  })
  dialog.value = true
}

async function submit(): Promise<void> {
  if (!form.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  if (editing.value) {
    await bindingTable.update(editing.value.id, { ...form })
    ElMessage.success('已更新验收记录')
  } else {
    await bindingTable.create({ ...form }, 'bind')
    ElMessage.success(
      form.verdict === 'pass' ? '验收合格，已登记装订还原' : '已登记验收返修，请返回工序页重新处理'
    )
  }
  // 验收合格 → 触发全册归档；返修 → 回退为修复中
  await bookStore.updateVolume(form.volumeId, {
    state: form.verdict === 'pass' ? 'archived' : 'repairing'
  })
  ElMessage.info(
    form.verdict === 'pass'
      ? `第 ${volumeLabel(form.volumeId)} 已归档，整册锁定为只读`
      : `第 ${volumeLabel(form.volumeId)} 已退回修复中`
  )
  dialog.value = false
}

async function remove(binding: Binding): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除该装订验收记录。', '删除验收记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await bindingTable.remove(binding.id)
  ElMessage.success('已删除')
}

/* ----------------------------- 数据导入导出 ----------------------------- */
async function handleExport(): Promise<void> {
  const snapshot = await exportSnapshot()
  const filename = exportSnapshotJson(snapshot)
  const stamp = new Date().toISOString()
  writeLastBackupAt(stamp)
  lastBackupAt.value = stamp
  ElMessage.success(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`)
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function handleFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ElMessage.error('JSON 解析失败，请确认文件格式')
    return
  }
  const invalid = validateSnapshot(parsed)
  if (invalid) {
    ElMessage.error(invalid)
    return
  }
  try {
    await ElMessageBox.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，不可撤销。', '覆盖导入本地数据', {
      type: 'warning',
      confirmButtonText: '确认导入',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await importSnapshot(parsed as RestoreSnapshot)
  await Promise.all([bookStore.loadBooks(), bookStore.loadVolumes(), leafStore.loadLeaves(), repairStore.loadOrders()])
  ElMessage.success('导入完成，数据已覆盖')
}

async function handleReset(): Promise<void> {
  try {
    await ElMessageBox.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。', '清空并重播种', {
      type: 'warning',
      confirmButtonText: '确认重置',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await resetDatabase()
  await Promise.all([bookStore.loadBooks(), bookStore.loadVolumes(), leafStore.loadLeaves(), repairStore.loadOrders()])
  ElMessage.success('已清空并重新载入演示数据')
}

async function copyArchive(): Promise<void> {
  const ok = await copyText(archiveText.value)
  if (ok) ElMessage.success('归档清单已复制到剪贴板')
  else ElMessage.warning('浏览器未授权剪贴板')
}

function verdictLabel(verdict: string): string {
  return BINDING_VERDICT_LABEL[verdict as BindingVerdict] ?? verdict
}

function verdictColor(verdict: string): string {
  return BINDING_VERDICT_COLOR[verdict as BindingVerdict] ?? '#6b6257'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>装订还原与验收归档</h2>
        <p>
          本地库 {{ DB_NAME }} · 结构版本 v{{ DB_VERSION }}
          <span class="gb-muted">{{ lastBackupAt ? `· 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : '· 尚未导出备份' }}</span>
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Download" @click="handleExport">导出 JSON</el-button>
        <el-button :icon="Upload" @click="triggerImport">导入 JSON</el-button>
        <el-button type="danger" plain :icon="Refresh" @click="handleReset">清空重播种</el-button>
        <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="handleFile" />
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="装订记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="验收合格率" :value="`${stat.passPercent}%`" :percent="stat.passPercent" tone="success" />
      <StatBadge label="返修" :value="stat.rework" suffix="条" tone="danger" />
      <StatBadge label="已归档册次" :value="stat.archived" suffix="册" tone="info" />
      <StatBadge label="待装订册次" :value="stat.pendingBinding" suffix="册" tone="warning" />
      <StatBadge label="工序完成率" :value="`${totals.orderPercent}%`" :percent="totals.orderPercent" />
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>装订验收登记</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新增验收</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="bindingTable.rows.value.length === 0"
            title="还没有装订验收记录"
            description="登记装订方式与完工日期；验收合格后整册自动归档并锁定为只读。"
            action-text="新增验收"
            size="small"
            @action="openCreate"
          />
          <el-table v-else :data="bindingTable.rows.value" size="small" border>
            <el-table-column label="册次" min-width="180">
              <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
            </el-table-column>
            <el-table-column prop="method" label="装订方式" width="130" />
            <el-table-column prop="finishDate" label="完工日期" width="120" sortable />
            <el-table-column label="结论" width="100">
              <template #default="{ row }">
                <el-tag :style="{ color: verdictColor(row.verdict), borderColor: `${verdictColor(row.verdict)}66` }" effect="plain" round>
                  {{ verdictLabel(row.verdict) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="inspector" label="验收人" width="110" />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>归档清单</span>
              <div>
                <el-button size="small" :icon="Download" @click="exportArchiveReport(context)">导出清单</el-button>
                <el-button size="small" @click="copyArchive">复制</el-button>
              </div>
            </div>
          </template>
          <pre style="max-height: 320px; overflow: auto; font-size: 12px; margin: 0; white-space: pre-wrap">{{ archiveText }}</pre>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>整库导出</template>
          <p class="gb-muted">
            导出文件包含 6 张业务表全量数据与结构版本号，可在其他设备通过「导入 JSON」还原。
          </p>
          <div class="gb-toolbar">
            <el-button :icon="Download" @click="handleExport">JSON 备份</el-button>
            <el-button @click="exportLeafLedgerCsv(context)">书叶破损台账 CSV</el-button>
          </div>
          <el-alert
            style="margin-top: 10px"
            type="info"
            show-icon
            :closable="false"
            title="无状态容器"
            description="服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialog" :title="editing ? '编辑装订验收' : '新增装订验收'" width="560px">
      <el-form label-width="100px">
        <el-form-item label="册次" required>
          <el-select v-model="form.volumeId" style="width: 100%">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="装订方式" required>
          <el-select v-model="form.method" style="width: 100%">
            <el-option v-for="item in BINDING_METHOD_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="完工日期">
          <el-input v-model="form.finishDate" type="date" />
        </el-form-item>
        <el-form-item label="验收结论" required>
          <el-select v-model="form.verdict" style="width: 100%">
            <el-option v-for="item in BINDING_VERDICT_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="验收人">
          <el-input v-model="form.inspector" placeholder="如：程砚" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="form.verdict === 'pass'"
        type="success"
        show-icon
        :closable="false"
        title="验收合格将触发全册归档，册次锁定为只读"
      />
      <el-alert
        v-else
        type="warning"
        show-icon
        :closable="false"
        title="验收返修将把册次退回「修复中」，可继续调整工序"
      />
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

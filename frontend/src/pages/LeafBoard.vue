<script setup lang="ts">
/**
 * /books/:id/leaves 书叶破损登记
 * 逐叶录入破损类型、面积与 pH；支持册次切换、批量改状态与深链（查不到 id 给友好空态）。
 * 消费 Leaf、Volume；复用 <DamageTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import DamageTag from '@/components/common/DamageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLeafStats } from '@/hooks/useLeafStats'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { reportConflict } from '@/utils/revision'
import { PAPER_TYPE_LABEL, type Paper } from '@/types/paper'
import {
  DAMAGE_TYPE_OPTIONS,
  LEAF_STATE_COLOR,
  LEAF_STATE_LABEL,
  LEAF_STATE_OPTIONS,
  createEmptyLeafDraft,
  phLevel,
  type DamageType,
  type Leaf,
  type LeafDraft,
  type LeafState
} from '@/types/leaf'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL, isVolumeLocked } from '@/types/volume'
import { useRepairStore } from '@/stores/repairStore'

const route = useRoute()
const router = useRouter()
const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const { statOf } = useLeafStats()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const bookId = computed(() => String(route.params.id ?? ''))
const book = computed(() => bookStore.bookById(bookId.value))
const volumes = computed(() => bookStore.volumesOfBook(bookId.value))

// 深链：URL 携带的 id 同步到 store；store 中没有该 id 时给出友好空态
watchEffect(() => {
  if (bookId.value.length > 0) bookStore.setCurrentBook(bookId.value)
})

watch(
  [volumes, () => bookStore.currentVolumeId],
  () => {
    const list = volumes.value
    if (list.length === 0) {
      bookStore.setCurrentVolume(null)
      return
    }
    const valid = list.some((volume) => volume.id === bookStore.currentVolumeId)
    if (!valid) bookStore.setCurrentVolume(list[0]?.id ?? null)
  },
  { immediate: true }
)

const currentVolume = computed(() => volumes.value.find((volume) => volume.id === bookStore.currentVolumeId) ?? null)
const locked = computed(() => (currentVolume.value ? isVolumeLocked(currentVolume.value.state) : false))

const FILTER_KEYS = ['damageType', 'state'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  damageType: url.values.value.damageType ?? [],
  state: url.values.value.state ?? []
}))

const filterSelects = [
  { key: 'damageType', label: '破损类型', options: DAMAGE_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'state', label: '状态', options: LEAF_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    damageType: (next.damageType as string[]) ?? [],
    state: (next.state as string[]) ?? []
  })
}

watchEffect(() => {
  leafStore.setKeyword(url.keyword.value)
  leafStore.setDamageTypes((url.values.value.damageType ?? []) as DamageType[])
  leafStore.setStates((url.values.value.state ?? []) as LeafState[])
})

const rows = computed(() => {
  const volumeId = bookStore.currentVolumeId
  if (!volumeId) return []
  return leafStore.filteredLeaves.filter((leaf) => leaf.volumeId === volumeId)
})

const stat = computed(() => (bookStore.currentVolumeId ? statOf(bookStore.currentVolumeId) : null))

/* ----------------------------- 书叶表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Leaf | null>(null)
const form = reactive<LeafDraft>(createEmptyLeafDraft('', 1))
const selected = ref<Leaf[]>([])
const batchState = ref<LeafState>('repaired')
/** 打开表单时捕获的册次修订号，保存时用于乐观锁比对 */
const baseRevision = ref(1)

function captureRevision(): void {
  baseRevision.value = currentVolume.value?.revision ?? 1
}

function openCreate(): void {
  const volumeId = bookStore.currentVolumeId
  if (!volumeId) {
    ElMessage.warning('请先选择册次')
    return
  }
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能再新增书叶记录')
    return
  }
  const existing = leafStore.leavesOfVolume(volumeId)
  const maxLeafNo = existing.reduce((max, leaf) => Math.max(max, leaf.leafNo), 0)
  editing.value = null
  Object.assign(form, createEmptyLeafDraft(volumeId, maxLeafNo + 1))
  captureRevision()
  dialog.value = true
}

function openEdit(leaf: Leaf): void {
  editing.value = leaf
  Object.assign(form, {
    volumeId: leaf.volumeId,
    leafNo: leaf.leafNo,
    damageType: leaf.damageType,
    damageAreaCm2: leaf.damageAreaCm2,
    phValue: leaf.phValue,
    state: leaf.state
  })
  captureRevision()
  dialog.value = true
}

async function submit(): Promise<void> {
  if (editing.value) {
    const result = await leafStore.updateLeaf(editing.value.id, { ...form }, baseRevision.value)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(`已更新第 ${form.leafNo} 叶破损记录`)
  } else {
    const result = await leafStore.createLeaf({ ...form }, baseRevision.value)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(`已登记第 ${form.leafNo} 叶破损记录`)
  }
  dialog.value = false
}

async function remove(leaf: Leaf): Promise<void> {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能删除书叶记录')
    return
  }
  try {
    await ElMessageBox.confirm(`将删除第 ${leaf.leafNo} 叶的该条破损记录及其补纸、工序记录。`, '删除书叶记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await leafStore.removeLeaf(leaf.id, currentVolume.value?.revision ?? 1)
  if (!result.ok) {
    await reportConflict(result.conflict)
    return
  }
  ElMessage.success('已删除')
}

async function advance(leaf: Leaf): Promise<void> {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能推进书叶状态')
    return
  }
  const result = await leafStore.advanceLeafState(leaf.id, currentVolume.value?.revision ?? 1)
  if (!result.ok) {
    await reportConflict(result.conflict)
    return
  }
  ElMessage.success(`第 ${leaf.leafNo} 叶状态已推进`)
}

async function applyBatchState(): Promise<void> {
  if (selected.value.length === 0) {
    ElMessage.warning('请先勾选书叶记录')
    return
  }
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能批量改状态')
    return
  }
  const result = await leafStore.batchUpdate(
    selected.value.map((leaf) => leaf.id),
    { state: batchState.value },
    currentVolume.value?.revision ?? 1
  )
  if (!result.ok) {
    await reportConflict(result.conflict)
    return
  }
  ElMessage.success(`已批量改为${LEAF_STATE_LABEL[batchState.value]}`)
  selected.value = []
}

function handleSelectionChange(list: Leaf[]): void {
  selected.value = list
}

async function addLeafRecord(leaf: Leaf): Promise<void> {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能叠加破损记录')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyLeafDraft(leaf.volumeId, leaf.leafNo))
  captureRevision()
  dialog.value = true
  ElMessage.info(`同一叶号可叠加多种破损：已带出第 ${leaf.leafNo} 叶`)
}

/** 该叶已选配的补纸文案（补纸选配页维护） */
function paperText(leafId: string): string {
  const paper = paperTable.rows.value.find((item) => item.leafId === leafId)
  if (!paper) return '未选配'
  return `${PAPER_TYPE_LABEL[paper.paperType]} · ΔE ${paper.deltaE}`
}

function phTag(ph: number): { label: string; color: string } {
  return phLevel(ph)
}

function stateLabel(state: string): string {
  return LEAF_STATE_LABEL[state as keyof typeof LEAF_STATE_LABEL] ?? state
}

function stateColor(state: string): string {
  return LEAF_STATE_COLOR[state as keyof typeof LEAF_STATE_COLOR] ?? '#8c8c8c'
}
</script>

<template>
  <div>
    <!-- 深链保护：查不到古籍时给友好空态，不白屏 -->
    <EmptyPanel
      v-if="bookStore.ready && !book"
      title="未找到该古籍"
      :description="`URL 中的古籍 id（${bookId}）在本地库中不存在，可能已被删除或来自其他设备的备份。`"
      action-text="返回古籍台账"
      @action="router.push('/books')"
    />

    <template v-else>
      <div class="gb-page-head">
        <div>
          <h2>书叶破损登记{{ book ? ` · 《${book.title}》` : '' }}</h2>
          <p>
            逐叶录入破损类型、面积与 pH；同一叶号可登记多条叠加破损。
            <el-button text type="primary" @click="router.push('/books')">返回古籍台账</el-button>
          </p>
        </div>
        <div class="gb-toolbar">
          <el-button :disabled="locked" :icon="Plus" type="primary" @click="openCreate">登记破损</el-button>
        </div>
      </div>

      <el-alert
        v-if="locked"
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom: 12px"
        title="该册已装订完成，整册锁定为只读"
        description="如需继续登记破损，请先在古籍台账中把册次状态回退为「修复中」。"
      />

      <el-card shadow="never" style="margin-bottom: 14px">
        <div class="gb-toolbar">
          <span class="gb-muted">册次：</span>
          <el-radio-group :model-value="bookStore.currentVolumeId" @update:model-value="(value: string | number | boolean | undefined) => bookStore.setCurrentVolume(String(value))">
            <el-radio-button v-for="volume in volumes" :key="volume.id" :value="volume.id">
              第 {{ volume.volumeNo }} 册 · {{ BINDING_TYPE_LABEL[volume.bindingType] }} ·
              {{ VOLUME_STATE_LABEL[volume.state] }}
            </el-radio-button>
          </el-radio-group>
          <el-tag v-if="currentVolume" type="info" effect="plain" round>
            已登记 {{ stat?.recordCount ?? 0 }} 条破损记录
          </el-tag>
        </div>
      </el-card>

      <div class="gb-stat-row">
        <StatBadge label="书叶数" :value="stat?.leafCount ?? 0" suffix="叶" tone="primary" />
        <StatBadge label="破损记录" :value="stat?.recordCount ?? 0" suffix="条" tone="warning" />
        <StatBadge label="破损总面积" :value="stat?.totalAreaCm2 ?? 0" suffix="cm²" tone="danger" />
        <StatBadge label="平均 pH" :value="stat?.averagePh ?? 0" />
        <StatBadge label="待修" :value="stat?.pendingCount ?? 0" suffix="条" />
        <StatBadge label="已修复" :value="stat?.repairedCount ?? 0" suffix="条" tone="success" />
        <StatBadge label="工序完成率" :value="`${stat?.orderPercent ?? 0}%`" :percent="stat?.orderPercent ?? 0" tone="success" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="filterSelects"
        keyword-placeholder="搜索叶号 / 面积 / pH…"
        @change="handleFilterChange"
        @reset="url.reset()"
      >
        <template #actions>
          <el-select v-model="batchState" size="small" style="width: 110px">
            <el-option v-for="item in LEAF_STATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button size="small" :disabled="selected.length === 0 || locked" @click="applyBatchState">
            批量改状态（{{ selected.length }}）
          </el-button>
        </template>
      </FilterBar>

      <el-card shadow="never" style="margin-top: 16px">
        <EmptyPanel
          v-if="rows.length === 0"
          :title="(stat?.recordCount ?? 0) === 0 ? '该册还没有破损登记' : '当前筛选条件下没有记录'"
          :description="
            (stat?.recordCount ?? 0) === 0
              ? '逐叶录入破损类型、面积与 pH，系统会按册汇总破损总面积与平均 pH。'
              : '试着调整破损类型或状态筛选。'
          "
          action-text="登记破损"
          secondary-text="重置筛选"
          size="small"
          @action="openCreate"
          @secondary="url.reset()"
        />

        <el-table v-else :data="rows" size="small" border @selection-change="handleSelectionChange">
          <el-table-column type="selection" width="44" />
          <el-table-column prop="leafNo" label="叶号" width="80" sortable />
          <el-table-column label="破损类型" width="150">
            <template #default="{ row }">
              <DamageTag :type="row.damageType" />
            </template>
          </el-table-column>
          <el-table-column prop="damageAreaCm2" label="破损面积(cm²)" width="130" sortable />
          <el-table-column label="pH" width="150">
            <template #default="{ row }">
              {{ row.phValue }}
              <el-tag :style="{ color: phTag(row.phValue).color, borderColor: `${phTag(row.phValue).color}66` }" effect="plain" size="small" round>
                {{ phTag(row.phValue).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :style="{ color: stateColor(row.state), borderColor: `${stateColor(row.state)}66` }" effect="plain" round>
                {{ stateLabel(row.state) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="补纸" width="140">
            <template #default="{ row }">
              <span class="gb-muted">{{ paperText(row.id) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="工序进度" width="120">
            <template #default="{ row }">
              {{ repairStore.ordersOfLeaf(row.id).filter((order) => order.state === 'done').length }} /
              {{ repairStore.ordersOfLeaf(row.id).length }}
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="260">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :disabled="locked" @click="advance(row)">推进状态</el-button>
              <el-button size="small" text :disabled="locked" @click="addLeafRecord(row)">叠加破损</el-button>
              <el-button size="small" text :disabled="locked" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" text type="danger" :disabled="locked" :icon="Delete" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="stat && Object.values(stat.damageCount).some((count) => count > 0)" style="margin-top: 10px">
          <span class="gb-muted">破损类型分布：</span>
          <el-tag v-for="item in DAMAGE_TYPE_OPTIONS" :key="item.value" style="margin-right: 6px" effect="plain" round>
            {{ item.label }} {{ stat.damageCount[item.value] }}
          </el-tag>
        </div>
      </el-card>
    </template>

    <el-dialog v-model="dialog" :title="editing ? `编辑第 ${editing.leafNo} 叶` : '登记书叶破损'" width="560px">
      <el-form label-width="110px">
        <el-form-item label="叶号" required>
          <el-input-number v-model="form.leafNo" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="破损类型" required>
          <el-select v-model="form.damageType" style="width: 100%">
            <el-option v-for="item in DAMAGE_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="破损面积(cm²)" required>
          <el-input-number v-model="form.damageAreaCm2" :min="0.1" :max="999" :step="0.5" :precision="1" />
        </el-form-item>
        <el-form-item label="酸化 pH" required>
          <el-input-number v-model="form.phValue" :min="3" :max="10" :step="0.1" :precision="1" />
          <el-tag style="margin-left: 8px" effect="plain" round>{{ phLevel(form.phValue).label }}</el-tag>
        </el-form-item>
        <el-form-item label="状态" required>
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in LEAF_STATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

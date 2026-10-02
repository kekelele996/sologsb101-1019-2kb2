<script setup lang="ts">
/**
 * /repairs 修复工序记录
 * 拖拽排序并回填材料与操作人，完成即回写书叶状态；未完成前置工序时提示。
 * 消费 RepairOrder、Leaf；复用 <DamageTag>、<StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Delete, Edit, Plus, Rank } from '@element-plus/icons-vue'
import DamageTag from '@/components/common/DamageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { DAMAGE_TYPE_LABEL } from '@/types/leaf'
import {
  ORDER_STATE_COLOR,
  ORDER_STATE_LABEL,
  ORDER_STATE_OPTIONS,
  REPAIR_MATERIAL_SUGGEST,
  REPAIR_NAME_LABEL,
  REPAIR_NAME_OPTIONS,
  createEmptyOrderDraft,
  type RepairName,
  type RepairOrder,
  type RepairOrderDraft
} from '@/types/repairOrder'
import { PAPER_TYPE_LABEL, type Paper } from '@/types/paper'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const FILTER_KEYS = ['name', 'state'] as const
const url = useFilterQuery(FILTER_KEYS)

const leafOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).flatMap((volume) =>
      leafStore.leavesOfVolume(volume.id).map((leaf) => ({
        value: leaf.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · 第 ${leaf.leafNo} 叶 · ${DAMAGE_TYPE_LABEL[leaf.damageType]}`
      }))
    )
  )
)

const currentLeafId = ref('')
watch(
  leafOptions,
  (list) => {
    if (list.length === 0) {
      currentLeafId.value = ''
      return
    }
    if (!list.some((item) => item.value === currentLeafId.value)) currentLeafId.value = list[0]?.value ?? ''
  },
  { immediate: true }
)

const currentLeaf = computed(() => (currentLeafId.value ? leafStore.leafById(currentLeafId.value) : undefined))
const currentPaper = computed(() =>
  currentLeafId.value ? paperTable.rows.value.find((paper) => paper.leafId === currentLeafId.value) : undefined
)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  name: url.values.value.name ?? [],
  state: url.values.value.state ?? []
}))

const filterSelects = [
  { key: 'name', label: '工序', options: REPAIR_NAME_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'state', label: '状态', options: ORDER_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    name: (next.name as string[]) ?? [],
    state: (next.state as string[]) ?? []
  })
}

const steps = computed<RepairOrder[]>(() => {
  if (!currentLeafId.value) return []
  const keyword = url.keyword.value.trim()
  const names = url.values.value.name ?? []
  const states = url.values.value.state ?? []
  return repairStore.ordersOfLeaf(currentLeafId.value).filter((order) => {
    if (keyword.length > 0) {
      const haystack = `${order.material}${order.operator}${order.date}`
      if (!haystack.includes(keyword)) return false
    }
    if (names.length > 0 && !names.includes(order.name)) return false
    if (states.length > 0 && !states.includes(order.state)) return false
    return true
  })
})

const stat = computed(() => {
  const list = repairStore.ordersOfLeaf(currentLeafId.value)
  const done = list.filter((order) => order.state === 'done').length
  return {
    total: list.length,
    done,
    doing: list.filter((order) => order.state === 'doing').length,
    todo: list.filter((order) => order.state === 'todo').length,
    percent: list.length === 0 ? 0 : Math.round((done / list.length) * 100)
  }
})

/** 前置工序未完成校验：返回阻塞的工序名 */
const blocking = computed(() => {
  const list = repairStore.ordersOfLeaf(currentLeafId.value)
  const index = list.findIndex((order) => order.state !== 'done')
  if (index <= 0) return null
  return list.slice(0, index).find((order) => order.state !== 'done') ?? null
})

/* ----------------------------- 工序表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<RepairOrder | null>(null)
const form = reactive<RepairOrderDraft>(createEmptyOrderDraft('', 1))
const selectedIds = ref<string[]>([])
const dragId = ref('')
const overId = ref('')

function openCreate(): void {
  if (!currentLeafId.value) {
    ElMessage.warning('请先选择书叶')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyOrderDraft(currentLeafId.value, repairStore.nextSeq(currentLeafId.value)))
  dialog.value = true
}

function openEdit(order: RepairOrder): void {
  editing.value = order
  Object.assign(form, {
    leafId: order.leafId,
    seq: order.seq,
    name: order.name,
    material: order.material,
    operator: order.operator,
    date: order.date,
    state: order.state
  })
  dialog.value = true
}

watch(
  () => form.name,
  (name: RepairName) => {
    if (!form.material || Object.values(REPAIR_MATERIAL_SUGGEST).includes(form.material)) {
      form.material = REPAIR_MATERIAL_SUGGEST[name]
    }
  }
)

async function submit(): Promise<void> {
  if (editing.value) {
    await repairStore.updateOrder(editing.value.id, { ...form })
    ElMessage.success('已更新工序')
  } else {
    await repairStore.createOrder({ ...form })
    ElMessage.success(`已新增第 ${form.seq} 道工序`)
  }
  dialog.value = false
}

async function remove(order: RepairOrder): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后其余工序会自动重编号。', '删除工序', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await repairStore.removeOrder(order.id)
  ElMessage.success('已删除')
}

async function advance(order: RepairOrder): Promise<void> {
  const list = repairStore.ordersOfLeaf(order.leafId)
  const previous = list.find((item) => item.seq === order.seq - 1)
  if (previous && previous.state !== 'done') {
    ElMessage.warning(`第 ${previous.seq} 道「${REPAIR_NAME_LABEL[previous.name]}」尚未完成，禁止推进`)
    return
  }
  const next = await repairStore.advanceOrder(order.id)
  ElMessage.success(`已置为「${ORDER_STATE_LABEL[next]}」${next === 'done' ? '，并回写书叶状态' : ''}`)
}

async function generate(): Promise<void> {
  if (!currentLeafId.value) {
    ElMessage.warning('请先选择书叶')
    return
  }
  const created = await repairStore.generateSequence(currentLeafId.value)
  if (created === 0) {
    ElMessage.info('该叶已有完整工序序列')
  } else {
    ElMessage.success(`已生成 ${created} 道标准工序（补破 → 托裱 → 溜口 → 裁齐 → 压平）`)
  }
}

async function batchComplete(): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选工序')
    return
  }
  await repairStore.batchUpdate(selectedIds.value, { state: 'done' })
  ElMessage.success(`已批量完成 ${selectedIds.value.length} 道工序`)
  selectedIds.value = []
}

async function drop(targetId: string): Promise<void> {
  const from = dragId.value
  overId.value = ''
  dragId.value = ''
  if (!from || from === targetId || !currentLeafId.value) return
  const ids = repairStore.ordersOfLeaf(currentLeafId.value).map((order) => order.id)
  const fromIndex = ids.indexOf(from)
  const toIndex = ids.indexOf(targetId)
  if (fromIndex < 0 || toIndex < 0) return
  const [moved] = ids.splice(fromIndex, 1)
  ids.splice(toIndex, 0, moved as string)
  await repairStore.reorderOrders(currentLeafId.value, ids)
  ElMessage.success('工序顺序已更新并重编号')
}

function toggleSelect(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function stateLabel(state: string): string {
  return ORDER_STATE_LABEL[state as keyof typeof ORDER_STATE_LABEL] ?? state
}

function stateColor(state: string): string {
  return ORDER_STATE_COLOR[state as keyof typeof ORDER_STATE_COLOR] ?? '#8c8c8c'
}

watchEffect(() => {
  // 保证筛选条件变化时列表自动重算（URL 为唯一事实来源）
  void url.keyword.value
  void url.values.value
})
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>修复工序记录</h2>
        <p>按叶编排修复工序，拖拽调整先后并回填材料与操作人；完成即回写书叶为已修复。</p>
      </div>
      <div class="gb-toolbar">
        <el-select v-model="currentLeafId" filterable placeholder="选择书叶" style="width: 320px">
          <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button :icon="Plus" @click="generate">生成标准序列</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增工序</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="工序总数" :value="stat.total" suffix="道" tone="primary" />
      <StatBadge label="完成率" :value="`${stat.percent}%`" :percent="stat.percent" tone="success" />
      <StatBadge label="已完成" :value="stat.done" suffix="道" tone="success" />
      <StatBadge label="进行中" :value="stat.doing" suffix="道" tone="warning" />
      <StatBadge label="未开始" :value="stat.todo" suffix="道" />
      <StatBadge label="全局完成率" :value="`${repairStore.donePercent}%`" :percent="repairStore.donePercent" tone="info" />
    </div>

    <el-card v-if="currentLeaf" shadow="never" style="margin-bottom: 14px">
      <div class="gb-toolbar">
        <span>当前书叶：第 {{ currentLeaf.leafNo }} 叶</span>
        <DamageTag :type="currentLeaf.damageType" :note="`${currentLeaf.damageAreaCm2} cm²`" />
        <el-tag effect="plain" round>pH {{ currentLeaf.phValue }}</el-tag>
        <el-tag v-if="currentPaper" type="success" effect="plain" round>
          补纸：{{ PAPER_TYPE_LABEL[currentPaper.paperType] }} · ΔE {{ currentPaper.deltaE }}
        </el-tag>
        <el-tag v-else type="warning" effect="plain" round>尚未选配补纸</el-tag>
      </div>
    </el-card>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索材料 / 操作人 / 日期…"
      @change="handleFilterChange"
      @reset="url.reset()"
    >
      <template #actions>
        <el-button size="small" :disabled="selectedIds.length === 0" :icon="Check" @click="batchComplete">
          批量完成（{{ selectedIds.length }}）
        </el-button>
      </template>
    </FilterBar>

    <el-card shadow="never" style="margin-top: 16px">
      <EmptyPanel
        v-if="steps.length === 0"
        :title="stat.total === 0 ? '该叶还没有工序记录' : '当前筛选条件下没有工序'"
        :description="
          stat.total === 0
            ? '可一键生成标准工序序列（补破 → 托裱 → 溜口 → 裁齐 → 压平），也可手动逐条新增。'
            : '试着调整工序或状态筛选条件。'
        "
        action-text="生成标准序列"
        secondary-text="重置筛选"
        size="small"
        @action="generate"
        @secondary="url.reset()"
      />

      <div v-else>
        <div
          v-for="order in steps"
          :key="order.id"
          class="gb-step-row"
          :class="{ 'is-dragging': dragId === order.id, 'is-over': overId === order.id && dragId !== order.id }"
          @dragover.prevent="overId = order.id"
          @drop="drop(order.id)"
        >
          <el-icon class="gb-drag-handle" draggable="true" @dragstart="dragId = order.id" @dragend="dragId = ''">
            <Rank />
          </el-icon>
          <el-checkbox
            :model-value="selectedIds.includes(order.id)"
            @update:model-value="() => toggleSelect(order.id)"
          />
          <el-tag effect="plain" round>第 {{ order.seq }} 道</el-tag>
          <strong>{{ REPAIR_NAME_LABEL[order.name] }}</strong>
          <el-tag :style="{ color: stateColor(order.state), borderColor: `${stateColor(order.state)}66` }" effect="plain" round>
            {{ stateLabel(order.state) }}
          </el-tag>
          <span class="gb-muted">{{ order.material || '未填材料' }}</span>
          <span class="gb-muted">{{ order.operator || '未填操作人' }} · {{ order.date }}</span>
          <div style="margin-left: auto; display: flex; gap: 4px">
            <el-button size="small" text type="primary" @click="advance(order)">推进状态</el-button>
            <el-button size="small" text :icon="Edit" @click="openEdit(order)">编辑</el-button>
            <el-button size="small" text type="danger" :icon="Delete" @click="remove(order)">删除</el-button>
          </div>
        </div>

        <el-alert
          v-if="blocking"
          type="warning"
          show-icon
          :closable="false"
          style="margin-top: 10px"
          :title="`第 ${blocking.seq} 道「${REPAIR_NAME_LABEL[blocking.name]}」尚未完成`"
          description="请先完成前置工序，再推进后续工序，避免修复记录出现跳步。"
        />
      </div>
    </el-card>

    <el-dialog v-model="dialog" :title="editing ? `编辑第 ${editing.seq} 道工序` : '新增修复工序'" width="560px">
      <el-form label-width="100px">
        <el-form-item label="工序序号" required>
          <el-input-number v-model="form.seq" :min="1" :max="99" />
        </el-form-item>
        <el-form-item label="工序名" required>
          <el-select v-model="form.name" style="width: 100%">
            <el-option v-for="item in REPAIR_NAME_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="材料">
          <el-input v-model="form.material" placeholder="如：补纸 0.06mm + 小麦淀粉糊" />
        </el-form-item>
        <el-form-item label="操作人">
          <el-input v-model="form.operator" placeholder="如：沈玉" />
        </el-form-item>
        <el-form-item label="日期">
          <el-input v-model="form.date" type="date" />
        </el-form-item>
        <el-form-item label="状态" required>
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ORDER_STATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
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

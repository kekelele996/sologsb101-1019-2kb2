<script setup lang="ts">
/**
 * /papers 补纸选配与染色比对
 * 按 ΔE 排序候选补纸并记录染色配方；ΔE 超阈值时提示重新染色。
 * 消费 Paper、Leaf；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import DamageTag from '@/components/common/DamageTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { reportConflict } from '@/utils/revision'
import {
  DEFAULT_DYE_RECIPE,
  DELTA_E_THRESHOLD,
  LAID_PATTERN_OPTIONS,
  PAPER_TYPE_LABEL,
  PAPER_TYPE_OPTIONS,
  createEmptyPaperDraft,
  deltaELevel,
  type Paper,
  type PaperDraft,
  type PaperType
} from '@/types/paper'
import { DAMAGE_TYPE_LABEL } from '@/types/leaf'
import { isVolumeLocked } from '@/types/volume'
import {
  PAPER_BASE_COLOR,
  candidateScore,
  deltaEForLeaf,
  laidPatternMatch,
  needRedye,
  recipeConcentration
} from '@/utils/paperColor'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const paperTable = useIdbTable<Paper>((database) => database.papers, {
  sortByUpdatedAt: false,
  revisionScope: {
    getVolumeId: (paper) => {
      const leaf = leafStore.leafById(paper.leafId)
      return leaf?.volumeId ?? null
    },
    getLabel: (paper) => {
      const leaf = leafStore.leafById(paper.leafId)
      return `第 ${leaf?.leafNo ?? '?'} 叶补纸记录`
    }
  }
})

const FILTER_KEYS = ['paperType', 'laidPattern'] as const
const url = useFilterQuery(FILTER_KEYS)
const sortBy = ref<'deltaE' | 'thickness' | 'score'>('deltaE')

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  paperType: url.values.value.paperType ?? [],
  laidPattern: url.values.value.laidPattern ?? []
}))

const filterSelects = [
  { key: 'paperType', label: '纸种', options: PAPER_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  { key: 'laidPattern', label: '帘纹', options: LAID_PATTERN_OPTIONS.map((item) => ({ label: item, value: item })) }
]

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    paperType: (next.paperType as string[]) ?? [],
    laidPattern: (next.laidPattern as string[]) ?? []
  })
}

function leafLabel(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '书叶已删除'
  const volume = bookStore.volumeById(leaf.volumeId)
  const book = volume ? bookStore.bookById(volume.bookId) : undefined
  return `${book ? `《${book.title}》` : ''}第 ${volume?.volumeNo ?? '?'} 册 · 第 ${leaf.leafNo} 叶`
}

function leafPattern(leafId: string): string {
  const leaf = leafStore.leafById(leafId)
  if (!leaf) return '二指帘纹'
  return leaf.damageType === 'stain' ? '细帘纹' : '二指帘纹'
}

const rows = computed(() => {
  const keyword = url.keyword.value.trim()
  const types = url.values.value.paperType ?? []
  const patterns = url.values.value.laidPattern ?? []
  const list = paperTable.rows.value.filter((paper) => {
    if (keyword.length > 0) {
      const haystack = `${leafLabel(paper.leafId)}${paper.dyeRecipe}${paper.thicknessMm}`
      if (!haystack.includes(keyword)) return false
    }
    if (types.length > 0 && !types.includes(paper.paperType)) return false
    if (patterns.length > 0 && !patterns.includes(paper.laidPattern)) return false
    return true
  })
  return [...list].sort((a, b) => {
    if (sortBy.value === 'thickness') return a.thicknessMm - b.thicknessMm
    if (sortBy.value === 'score') {
      return (
        candidateScore(b, leafPattern(b.leafId)) - candidateScore(a, leafPattern(a.leafId))
      )
    }
    return a.deltaE - b.deltaE
  })
})

const stat = computed(() => {
  const list = paperTable.rows.value
  const averageDeltaE =
    list.length === 0 ? 0 : Math.round((list.reduce((sum, paper) => sum + paper.deltaE, 0) / list.length) * 100) / 100
  return {
    total: list.length,
    averageDeltaE,
    redye: list.filter((paper) => needRedye(paper.deltaE)).length,
    coveredLeaves: new Set(list.map((paper) => paper.leafId)).size,
    matchRate:
      list.length === 0
        ? 0
        : Math.round(
            (list.filter((paper) => !needRedye(paper.deltaE)).length / list.length) * 100
          )
  }
})

/* ----------------------------- 补纸表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Paper | null>(null)
const form = reactive<PaperDraft>(createEmptyPaperDraft(''))
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

/** 当前表单所选书叶的册次（用于锁定判断与修订号捕获） */
const formVolume = computed(() => {
  if (!form.leafId) return undefined
  const leaf = leafStore.leafById(form.leafId)
  if (!leaf) return undefined
  return bookStore.volumeById(leaf.volumeId)
})
const locked = computed(() => (formVolume.value ? isVolumeLocked(formVolume.value.state) : false))

/** 打开表单时捕获的册次修订号，保存时用于乐观锁比对 */
const baseRevision = ref(1)

function captureRevision(): void {
  baseRevision.value = formVolume.value?.revision ?? 1
}

function openCreate(): void {
  const firstLeaf = leafOptions.value[0]
  if (!firstLeaf) {
    ElMessage.warning('请先登记书叶')
    return
  }
  const leaf = leafStore.leafById(firstLeaf.value)
  if (leaf) {
    const volume = bookStore.volumeById(leaf.volumeId)
    if (volume && isVolumeLocked(volume.state)) {
      ElMessage.warning('该册已装订锁定，不能新增补纸记录')
      return
    }
  }
  editing.value = null
  Object.assign(form, createEmptyPaperDraft(firstLeaf.value))
  captureRevision()
  dialog.value = true
}

function openEdit(paper: Paper): void {
  editing.value = paper
  Object.assign(form, {
    leafId: paper.leafId,
    paperType: paper.paperType,
    laidPattern: paper.laidPattern,
    thicknessMm: paper.thicknessMm,
    deltaE: paper.deltaE,
    dyeRecipe: paper.dyeRecipe
  })
  captureRevision()
  dialog.value = true
}

// 纸种变化时带出默认染色配方
watch(
  () => form.paperType,
  (type: PaperType) => {
    const recipe = DEFAULT_DYE_RECIPE[type]
    if (!form.dyeRecipe || Object.values(DEFAULT_DYE_RECIPE).includes(form.dyeRecipe)) {
      form.dyeRecipe = recipe
    }
  }
)

const recipePreview = computed(() => recipeConcentration(form.paperType, form.deltaE, 1))
const formMatch = computed(() => laidPatternMatch(form.laidPattern, '二指帘纹'))

async function submit(): Promise<void> {
  if (!form.leafId) {
    ElMessage.warning('请选择关联书叶')
    return
  }
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能保存补纸记录')
    return
  }
  if (editing.value) {
    const result = await paperTable.update(editing.value.id, { ...form }, baseRevision.value)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success('已更新补纸记录')
  } else {
    const result = await paperTable.create({ ...form }, 'paper', baseRevision.value)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(needRedye(form.deltaE) ? '已新增补纸，色差超阈值需重新染色' : '已新增补纸记录')
  }
  dialog.value = false
}

async function remove(paper: Paper): Promise<void> {
  if (locked.value) {
    ElMessage.warning('该册已装订锁定，不能删除补纸记录')
    return
  }
  try {
    await ElMessageBox.confirm('将删除该补纸选配记录。', '删除补纸', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const result = await paperTable.remove(paper.id, baseRevision.value)
  if (!result.ok) {
    await reportConflict(result.conflict)
    return
  }
  ElMessage.success('已删除')
}

/* ----------------------------- 候选推荐 ----------------------------- */
const candidateLeafId = ref('')
const candidates = computed(() => {
  if (!candidateLeafId.value) return []
  const leaf = leafStore.leafById(candidateLeafId.value)
  if (!leaf) return []
  const patterns = ['二指帘纹', '三指帘纹', '细帘纹']
  return PAPER_TYPE_OPTIONS.map((option) => {
    const paper = paperTable.rows.value.find(
      (item) => item.leafId === leaf.id && item.paperType === option.value
    )
    const deltaE = paper ? paper.deltaE : deltaEForLeaf(leaf.damageType, option.value)
    const laidPattern = paper ? paper.laidPattern : patterns[leaf.leafNo % patterns.length]
    const thicknessMm = paper ? paper.thicknessMm : 0.06
    return {
      type: option.value,
      label: PAPER_TYPE_LABEL[option.value],
      deltaE,
      laidPattern,
      thicknessMm,
      score: candidateScore({ deltaE, laidPattern, thicknessMm }, '二指帘纹'),
      hasRecord: Boolean(paper),
      paperId: paper?.id ?? ''
    }
  }).sort((a, b) => b.score - a.score)
})

const candidateLeafPattern = computed(() =>
  candidateLeafId.value ? leafPattern(candidateLeafId.value) : '二指帘纹'
)

async function selectCandidate(type: PaperType, deltaE: number, laidPatternValue: string, thicknessMm: number): Promise<void> {
  if (!candidateLeafId.value) return
  const candidateLeaf = leafStore.leafById(candidateLeafId.value)
  const candidateVolume = candidateLeaf ? bookStore.volumeById(candidateLeaf.volumeId) : undefined
  if (candidateVolume && isVolumeLocked(candidateVolume.state)) {
    ElMessage.warning('该册已装订锁定，不能采用候选补纸')
    return
  }
  const candidateRevision = candidateVolume?.revision ?? 1
  const existing = paperTable.rows.value.find(
    (item) => item.leafId === candidateLeafId.value && item.paperType === type
  )
  const payload: PaperDraft = {
    leafId: candidateLeafId.value,
    paperType: type,
    laidPattern: laidPatternValue,
    thicknessMm,
    deltaE,
    dyeRecipe: DEFAULT_DYE_RECIPE[type]
  }
  if (existing) {
    const result = await paperTable.update(existing.id, payload, candidateRevision)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(`已更新${PAPER_TYPE_LABEL[type]}候选`)
  } else {
    const result = await paperTable.create(payload, 'paper', candidateRevision)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(`已采用${PAPER_TYPE_LABEL[type]}候选补纸`)
  }
}

function deltaTag(deltaE: number): { label: string; color: string } {
  return deltaELevel(deltaE)
}

/** 判断某条补纸记录所属册次是否已锁定 */
function isPaperLocked(paper: Paper): boolean {
  const leaf = leafStore.leafById(paper.leafId)
  if (!leaf) return false
  const volume = bookStore.volumeById(leaf.volumeId)
  return volume ? isVolumeLocked(volume.state) : false
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>补纸选配与染色比对</h2>
        <p>
          按 ΔE 升序排列候选补纸（阈值 {{ DELTA_E_THRESHOLD }}），记录帘纹、厚度与染色配方；超阈值会提示重新染色。
        </p>
      </div>
      <div class="gb-toolbar">
        <el-select v-model="sortBy" style="width: 160px">
          <el-option label="按 ΔE 升序" value="deltaE" />
          <el-option label="按厚度升序" value="thickness" />
          <el-option label="按综合评分" value="score" />
        </el-select>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增补纸</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="补纸记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="平均 ΔE" :value="stat.averageDeltaE" tone="warning" />
      <StatBadge label="需重新染色" :value="stat.redye" suffix="条" tone="danger" />
      <StatBadge label="覆盖书叶" :value="stat.coveredLeaves" suffix="叶" tone="info" />
      <StatBadge label="ΔE 达标率" :value="`${stat.matchRate}%`" :percent="stat.matchRate" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索书叶 / 配方 / 厚度…"
      @change="handleFilterChange"
      @reset="url.reset()"
    />

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="16">
        <el-card shadow="never">
          <EmptyPanel
            v-if="rows.length === 0"
            :title="paperTable.rows.value.length === 0 ? '还没有补纸选配记录' : '当前条件下没有记录'"
            :description="
              paperTable.rows.value.length === 0
                ? '为破损书叶选配补纸，记录纸种、帘纹、厚度、色差与染色配方。'
                : '试着调整纸种或帘纹筛选条件。'
            "
            action-text="新增补纸"
            secondary-text="重置筛选"
            size="small"
            @action="openCreate"
            @secondary="url.reset()"
          />
          <el-table v-else :data="rows" size="small" border>
            <el-table-column label="关联书叶" min-width="200">
              <template #default="{ row }">
                <div>{{ leafLabel(row.leafId) }}</div>
                <div class="gb-muted">
                  <DamageTag v-if="leafStore.leafById(row.leafId)" :type="leafStore.leafById(row.leafId)!.damageType" size="small" />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="纸种" width="90">
              <template #default="{ row }">{{ PAPER_TYPE_LABEL[row.paperType as PaperType] }}</template>
            </el-table-column>
            <el-table-column label="帘纹" width="150">
              <template #default="{ row }">
                {{ row.laidPattern }}
                <el-tag size="small" effect="plain" round>{{ laidPatternMatch(row.laidPattern, leafPattern(row.leafId)) }}%</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="thicknessMm" label="厚度(mm)" width="100" />
            <el-table-column label="ΔE" width="140" sortable>
              <template #default="{ row }">
                {{ row.deltaE }}
                <el-tag :style="{ color: deltaTag(row.deltaE).color, borderColor: `${deltaTag(row.deltaE).color}66` }" effect="plain" size="small" round>
                  {{ deltaTag(row.deltaE).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="综合评分" width="100">
              <template #default="{ row }">{{ candidateScore(row, leafPattern(row.leafId)) }}</template>
            </el-table-column>
            <el-table-column label="染色配方" min-width="200">
              <template #default="{ row }">
                <el-tag v-if="needRedye(row.deltaE)" type="danger" effect="plain" size="small" round>需重新染色</el-tag>
                <div class="gb-muted">{{ row.dyeRecipe }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :disabled="isPaperLocked(row)" :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button size="small" text type="danger" :disabled="isPaperLocked(row)" :icon="Delete" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="8">
        <el-card shadow="never">
          <template #header>候选补纸推荐</template>
          <el-select v-model="candidateLeafId" placeholder="选择需要配纸的书叶" style="width: 100%; margin-bottom: 10px">
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>

          <EmptyPanel
            v-if="candidates.length === 0"
            title="选择书叶后生成候选"
            description="将按 ΔE、帘纹匹配度与厚度接近度综合评分排序。"
            size="small"
          />
          <div v-else style="display: flex; flex-direction: column; gap: 10px">
            <div v-for="item in candidates" :key="item.type">
              <div class="gb-paper-swatch" :style="{ background: PAPER_BASE_COLOR[item.type] }" />
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px">
                <div>
                  <strong>{{ item.label }}</strong>
                  <span class="gb-muted"> · 评分 {{ item.score }}</span>
                </div>
                <el-tag :type="needRedye(item.deltaE) ? 'danger' : 'success'" effect="plain" size="small" round>
                  ΔE {{ item.deltaE }}
                </el-tag>
              </div>
              <div class="gb-muted">
                帘纹 {{ item.laidPattern }}（匹配 {{ laidPatternMatch(item.laidPattern, candidateLeafPattern) }}%）· 厚度
                {{ item.thicknessMm }}mm · {{ item.hasRecord ? '已有登记' : '尚无登记（按基准色估算）' }}
              </div>
              <el-button
                size="small"
                style="margin-top: 6px"
                @click="selectCandidate(item.type, item.deltaE, item.laidPattern, item.thicknessMm)"
              >
                {{ item.hasRecord ? '更新为采用' : '采用该候选' }}
              </el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialog" :title="editing ? '编辑补纸记录' : '新增补纸记录'" width="620px">
      <el-form label-width="110px">
        <el-form-item label="关联书叶" required>
          <el-select v-model="form.leafId" style="width: 100%" filterable>
            <el-option v-for="item in leafOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="纸种" required>
          <el-select v-model="form.paperType" style="width: 100%">
            <el-option v-for="item in PAPER_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="帘纹">
          <el-select v-model="form.laidPattern" style="width: 100%">
            <el-option v-for="item in LAID_PATTERN_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
          <span class="gb-muted">与目标帘纹匹配度 {{ formMatch }}%</span>
        </el-form-item>
        <el-form-item label="厚度(mm)">
          <el-input-number v-model="form.thicknessMm" :min="0.01" :max="0.5" :step="0.01" :precision="2" />
        </el-form-item>
        <el-form-item label="色差 ΔE">
          <el-input-number v-model="form.deltaE" :min="0" :max="20" :step="0.1" :precision="1" />
          <el-tag
            style="margin-left: 8px"
            :style="{ color: deltaTag(form.deltaE).color, borderColor: `${deltaTag(form.deltaE).color}66` }"
            effect="plain"
            round
          >
            {{ deltaTag(form.deltaE).label }}
          </el-tag>
        </el-form-item>
        <el-form-item label="染色配方">
          <el-input v-model="form.dyeRecipe" type="textarea" :rows="2" />
          <span class="gb-muted">{{ recipePreview.note }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

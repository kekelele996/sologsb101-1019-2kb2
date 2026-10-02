<script setup lang="ts">
/**
 * /books 古籍与册次台账
 * 新建古籍、按年代与保护级别筛选（同步 URL query），卡片回显待修叶数与已完成工序数，并管理册次。
 * 消费 Book、Volume；复用 <DamageTag>、<EmptyPanel>、<StatBadge>、<FilterBar>。
 */
import { computed, reactive, ref, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, { useFilterQuery, type FilterModel } from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLeafStats } from '@/hooks/useLeafStats'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { reportConflict } from '@/utils/revision'
import {
  BOOK_LEVEL_COLOR,
  BOOK_LEVEL_LABEL,
  BOOK_LEVEL_OPTIONS,
  createEmptyBookDraft,
  type Book,
  type BookDraft,
  type BookLevel
} from '@/types/book'
import type { Binding } from '@/types/binding'
import {
  BINDING_TYPE_LABEL,
  BINDING_TYPE_OPTIONS,
  VOLUME_STATE_COLOR,
  VOLUME_STATE_LABEL,
  VOLUME_STATE_OPTIONS,
  createEmptyVolumeDraft,
  isVolumeLocked,
  type Volume,
  type VolumeDraft
} from '@/types/volume'

const router = useRouter()
const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const { statOf } = useLeafStats()
const bindingTable = useIdbTable<Binding>((database) => database.bindings, { sortByUpdatedAt: false })

const FILTER_KEYS = ['era', 'level'] as const
const url = useFilterQuery(FILTER_KEYS)

const filterModel = computed<FilterModel>(() => ({
  keyword: url.keyword.value,
  era: url.values.value.era ?? [],
  level: url.values.value.level ?? []
}))

const filterSelects = computed(() => [
  {
    key: 'era',
    label: '年代',
    options: bookStore.eraOptions.map((era) => ({ label: era, value: era }))
  },
  { key: 'level', label: '保护级别', options: BOOK_LEVEL_OPTIONS.map((item) => ({ label: item.label, value: item.value })) }
])

function handleFilterChange(next: FilterModel): void {
  url.apply({
    kw: typeof next.keyword === 'string' ? next.keyword : '',
    era: (next.era as string[]) ?? [],
    level: (next.level as string[]) ?? []
  })
}

// URL query → store 筛选条件（URL 为唯一事实来源）
watchEffect(() => {
  bookStore.setKeyword(url.keyword.value)
  bookStore.setEras(url.values.value.era ?? [])
  bookStore.setLevels((url.values.value.level ?? []) as BookLevel[])
})

/* ----------------------------- 古籍表单 ----------------------------- */
const bookDialog = ref(false)
const editingBook = ref<Book | null>(null)
const bookForm = reactive<BookDraft>(createEmptyBookDraft())

function openCreateBook(): void {
  editingBook.value = null
  Object.assign(bookForm, createEmptyBookDraft())
  bookDialog.value = true
}

function openEditBook(book: Book): void {
  editingBook.value = book
  Object.assign(bookForm, {
    title: book.title,
    edition: book.edition,
    era: book.era,
    volumeCount: book.volumeCount,
    collectionNo: book.collectionNo,
    level: book.level
  })
  bookDialog.value = true
}

async function submitBook(): Promise<void> {
  if (bookForm.title.trim().length === 0) {
    ElMessage.warning('请填写书名')
    return
  }
  if (editingBook.value) {
    await bookStore.updateBook(editingBook.value.id, { ...bookForm })
    ElMessage.success(`已更新《${bookForm.title}》`)
  } else {
    const created = await bookStore.createBook({ ...bookForm })
    ElMessage.success(`已新建《${created.title}》，可登记册次与书叶`)
  }
  bookDialog.value = false
}

async function removeBook(book: Book): Promise<void> {
  const hasArchived = bookStore.volumesOfBook(book.id).some((volume) => isVolumeLocked(volume.state))
  if (hasArchived) {
    ElMessage.warning('该古籍下有已装订归档的册次，不能删除')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将同时删除《${book.title}》下的册次、书叶、补纸、工序与装订记录，不可恢复。`,
      '删除古籍',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await bookStore.removeBook(book.id)
  ElMessage.success(`已删除《${book.title}》`)
}

/* ----------------------------- 册次管理 ----------------------------- */
const volumeDialog = ref(false)
const volumeBook = ref<Book | null>(null)
const editingVolume = ref<Volume | null>(null)
const volumeForm = reactive<VolumeDraft>(createEmptyVolumeDraft('', 1))
/** 打开表单时捕获的册次修订号，保存时用于乐观锁比对 */
const baseRevision = ref(1)

const volumeList = computed(() => (volumeBook.value ? bookStore.volumesOfBook(volumeBook.value.id) : []))

function openVolumeDialog(book: Book): void {
  volumeBook.value = book
  editingVolume.value = null
  Object.assign(volumeForm, createEmptyVolumeDraft(book.id, volumeList.value.length + 1))
  volumeDialog.value = true
}

function openEditVolume(volume: Volume): void {
  editingVolume.value = volume
  Object.assign(volumeForm, {
    bookId: volume.bookId,
    volumeNo: volume.volumeNo,
    leafCount: volume.leafCount,
    bindingType: volume.bindingType,
    state: volume.state
  })
  baseRevision.value = volume.revision
}

async function submitVolume(): Promise<void> {
  if (editingVolume.value) {
    const result = await bookStore.updateVolume(editingVolume.value.id, { ...volumeForm }, baseRevision.value)
    if (!result.ok) {
      await reportConflict(result.conflict)
      return
    }
    ElMessage.success(`已更新第 ${volumeForm.volumeNo} 册`)
  } else {
    await bookStore.createVolume({ ...volumeForm })
    ElMessage.success(`已新增第 ${volumeForm.volumeNo} 册`)
  }
  editingVolume.value = null
  Object.assign(volumeForm, createEmptyVolumeDraft(volumeForm.bookId, volumeList.value.length + 1))
}

async function removeVolume(volume: Volume): Promise<void> {
  if (isVolumeLocked(volume.state)) {
    ElMessage.warning('该册已装订锁定，不能删除')
    return
  }
  try {
    await ElMessageBox.confirm(`将删除第 ${volume.volumeNo} 册及其书叶、补纸与工序记录。`, '删除册次', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await bookStore.removeVolume(volume.id)
  ElMessage.success('已删除该册次')
}

async function advanceVolume(volume: Volume): Promise<void> {
  const result = await bookStore.advanceVolumeState(volume.id, volume.revision)
  if (!result.ok) {
    await reportConflict(result.conflict)
    return
  }
  ElMessage.success(`第 ${volume.volumeNo} 册状态已推进`)
}

function openLeaves(book: Book): void {
  bookStore.setCurrentBook(book.id)
  const first = bookStore.volumesOfBook(book.id)[0]
  bookStore.setCurrentVolume(first ? first.id : null)
  void router.push(`/books/${book.id}/leaves`)
}

/** 古籍维度统计：聚合其下所有册次 */
function bookStat(bookId: string): {
  volumes: number
  records: number
  pending: number
  orderDone: number
  orderTotal: number
  area: number
} {
  const volumes = bookStore.volumesOfBook(bookId)
  return volumes.reduce(
    (acc, volume) => {
      const stat = statOf(volume.id)
      acc.volumes += 1
      acc.records += stat.recordCount
      acc.pending += stat.pendingCount
      acc.orderDone += stat.orderDoneCount
      acc.orderTotal += stat.orderCount
      acc.area = Math.round((acc.area + stat.totalAreaCm2) * 10) / 10
      return acc
    },
    { volumes: 0, records: 0, pending: 0, orderDone: 0, orderTotal: 0, area: 0 }
  )
}

/** 该古籍下已装订 / 已归档的册数，卡片回显使用 */
function boundVolumes(bookId: string): number {
  const volumeIds = bookStore.volumesOfBook(bookId).map((volume) => volume.id)
  return bindingTable.rows.value.filter((binding) => volumeIds.includes(binding.volumeId)).length
}

const totals = computed(() => ({
  books: bookStore.books.length,
  volumes: bookStore.volumes.length,
  records: leafStore.leaves.length,
  pending: leafStore.pendingCount,
  area: leafStore.totalAreaCm2,
  averagePh: leafStore.averagePh,
  orderPercent: repairStore.donePercent
}))
function openVolumeFromHeader(): void {
  const target = bookStore.filteredBooks[0] ?? bookStore.books[0]
  if (!target) {
    ElMessage.warning('请先新建一部古籍')
    return
  }
  openVolumeDialog(target)
}

function volumeStateLabel(state: string): string {
  return VOLUME_STATE_LABEL[state as keyof typeof VOLUME_STATE_LABEL] ?? state
}

function volumeStateColor(state: string): string {
  return VOLUME_STATE_COLOR[state as keyof typeof VOLUME_STATE_COLOR] ?? '#6b6257'
}

function bindingLabel(value: string): string {
  return BINDING_TYPE_LABEL[value as keyof typeof BINDING_TYPE_LABEL] ?? value
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>古籍与册次台账</h2>
        <p>登记古籍版本、年代与保护级别；卡片回显待修叶数与已完成工序数，并可管理册次。</p>
      </div>
      <div class="gb-toolbar">
        <el-button @click="openVolumeFromHeader">管理册次</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreateBook">新建古籍</el-button>
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="古籍总数" :value="totals.books" suffix="部" tone="primary" />
      <StatBadge label="册次总数" :value="totals.volumes" suffix="册" tone="info" />
      <StatBadge label="破损记录" :value="totals.records" suffix="条" tone="warning" />
      <StatBadge label="待修叶数" :value="totals.pending" suffix="条" tone="danger" />
      <StatBadge label="破损总面积" :value="totals.area" suffix="cm²" />
      <StatBadge label="平均 pH" :value="totals.averagePh" />
      <StatBadge label="工序完成率" :value="`${totals.orderPercent}%`" :percent="totals.orderPercent" tone="success" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索书名 / 版本 / 收藏号…"
      @change="handleFilterChange"
      @reset="url.reset()"
    >
      <template #actions>
        <el-tag type="info" effect="plain" round>
          共 {{ bookStore.filteredBooks.length }} / {{ bookStore.books.length }} 部
        </el-tag>
      </template>
    </FilterBar>

    <div style="margin-top: 16px">
      <EmptyPanel
        v-if="bookStore.filteredBooks.length === 0"
        :title="bookStore.books.length === 0 ? '还没有登记任何古籍' : '当前筛选条件下没有古籍'"
        :description="
          bookStore.books.length === 0
            ? '先登记一部古籍的版本、年代与保护级别，再逐册登记书叶破损。'
            : '试着放宽年代或保护级别条件，或重置筛选。'
        "
        action-text="新建古籍"
        secondary-text="重置筛选"
        @action="openCreateBook"
        @secondary="url.reset()"
      />
      <el-row v-else :gutter="16">
        <el-col v-for="book in bookStore.filteredBooks" :key="book.id" :xs="24" :md="12" :xl="8" style="margin-bottom: 16px">
          <el-card
            class="gb-book-card"
            :class="{ 'is-active': bookStore.currentBookId === book.id }"
            shadow="hover"
            @click="bookStore.setCurrentBook(book.id)"
          >
            <template #header>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                  <strong>《{{ book.title }}》</strong>
                  <el-tag :style="{ background: `${BOOK_LEVEL_COLOR[book.level]}1f`, color: BOOK_LEVEL_COLOR[book.level], borderColor: `${BOOK_LEVEL_COLOR[book.level]}66` }" effect="plain" round>
                    {{ BOOK_LEVEL_LABEL[book.level] }}
                  </el-tag>
                </div>
                <el-button text type="primary" :icon="Right" @click.stop="openLeaves(book)">书叶</el-button>
              </div>
            </template>

            <div style="display: flex; flex-direction: column; gap: 6px">
              <span>{{ book.edition || '版本未填' }} · {{ book.era || '年代未填' }}</span>
              <span class="gb-muted">收藏号：{{ book.collectionNo || '未编' }} · 登记册数：{{ bookStat(book.id).volumes }} 册</span>
              <span>
                待修叶数 <strong>{{ bookStat(book.id).pending }}</strong> 条 · 已完成工序
                <strong>{{ bookStat(book.id).orderDone }}</strong> / {{ bookStat(book.id).orderTotal }}
              </span>
              <span class="gb-muted">破损总面积 {{ bookStat(book.id).area }} cm² · 装订验收 {{ boundVolumes(book.id) }} 册</span>

              <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px" @click.stop>
                <el-button size="small" @click="openVolumeDialog(book)">册次管理</el-button>
                <el-button size="small" :icon="Edit" @click="openEditBook(book)">编辑</el-button>
                <el-button size="small" type="danger" plain :icon="Delete" @click="removeBook(book)">删除</el-button>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- 古籍表单 -->
    <el-dialog v-model="bookDialog" :title="editingBook ? `编辑《${editingBook.title}》` : '新建古籍'" width="560px">
      <el-form label-width="96px">
        <el-form-item label="书名" required>
          <el-input v-model="bookForm.title" placeholder="如：昌黎先生集" />
        </el-form-item>
        <el-form-item label="版本">
          <el-input v-model="bookForm.edition" placeholder="如：明万历刻本" />
        </el-form-item>
        <el-form-item label="年代">
          <el-input v-model="bookForm.era" placeholder="如：明" />
        </el-form-item>
        <el-form-item label="收藏号">
          <el-input v-model="bookForm.collectionNo" placeholder="如：GJ-0017" />
        </el-form-item>
        <el-form-item label="保护级别">
          <el-select v-model="bookForm.level" style="width: 100%">
            <el-option v-for="item in BOOK_LEVEL_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bookDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBook">保存</el-button>
      </template>
    </el-dialog>

    <!-- 册次管理 -->
    <el-dialog v-model="volumeDialog" :title="`册次管理 · ${volumeBook ? `《${volumeBook.title}》` : ''}`" width="720px">
      <el-form :inline="true" label-width="80px" style="margin-bottom: 8px">
        <el-form-item label="册次号">
          <el-input-number v-model="volumeForm.volumeNo" :min="1" :max="99" />
        </el-form-item>
        <el-form-item label="叶数">
          <el-input-number v-model="volumeForm.leafCount" :min="0" :max="2000" />
        </el-form-item>
        <el-form-item label="装订">
          <el-select v-model="volumeForm.bindingType" style="width: 130px">
            <el-option v-for="item in BINDING_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="volumeForm.state" style="width: 130px">
            <el-option v-for="item in VOLUME_STATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="submitVolume">{{ editingVolume ? '保存修改' : '新增册次' }}</el-button>
          <el-button v-if="editingVolume" @click="editingVolume = null">取消编辑</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="volumeList" size="small" border>
        <el-table-column prop="volumeNo" label="册次" width="80" />
        <el-table-column label="装订形式" width="110">
          <template #default="{ row }">{{ bindingLabel(row.bindingType) }}</template>
        </el-table-column>
        <el-table-column prop="leafCount" label="叶数" width="80" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag
              :style="{ background: `${volumeStateColor(row.state)}1f`, color: volumeStateColor(row.state) }"
              effect="plain"
              round
            >
              {{ volumeStateLabel(row.state) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="破损 / 工序" min-width="140">
          <template #default="{ row }">
            {{ statOf(row.id).recordCount }} 条 / {{ statOf(row.id).orderDoneCount }}·{{ statOf(row.id).orderCount }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240">
          <template #default="{ row }">
            <el-button size="small" text type="primary" :disabled="isVolumeLocked(row.state)" @click="advanceVolume(row)">推进状态</el-button>
            <el-button size="small" text :disabled="isVolumeLocked(row.state)" @click="openEditVolume(row)">编辑</el-button>
            <el-button size="small" text type="danger" :disabled="isVolumeLocked(row.state)" @click="removeVolume(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="volumeDialog = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

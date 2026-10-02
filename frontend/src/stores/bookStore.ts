/**
 * 古籍与册次 store（Pinia setup store）
 * 维护古籍列表、册次列表、当前选中的古籍 / 册次与筛选条件；
 * 页面的跨页状态一律从这里读写，不留在组件内部 ref。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  createId,
  db,
  readUiPrefs,
  removeBookCascade,
  removeVolumeCascade,
  writeUiPrefs
} from '@/utils/db'
import { withVolumeRevision, type RevisionResult } from '@/utils/revision'
import type { Book, BookDraft, BookLevel } from '@/types/book'
import type { Binding, BindingVerdict } from '@/types/binding'
import {
  nextVolumeState,
  type Volume,
  type VolumeDraft,
  type VolumeState
} from '@/types/volume'

export interface BookFilters {
  keyword: string
  eras: string[]
  levels: BookLevel[]
}

export const DEFAULT_BOOK_FILTERS: BookFilters = { keyword: '', eras: [], levels: [] }

export const useBookStore = defineStore('book', () => {
  const prefs = readUiPrefs()
  const books = ref<Book[]>([])
  const volumes = ref<Volume[]>([])
  const currentBookId = ref<string | null>(prefs.lastBookId)
  const currentVolumeId = ref<string | null>(prefs.lastVolumeId)
  const filters = ref<BookFilters>({ ...DEFAULT_BOOK_FILTERS })
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  watch([currentBookId, currentVolumeId], ([bookId, volumeId]) => {
    writeUiPrefs({ ...readUiPrefs(), lastBookId: bookId, lastVolumeId: volumeId })
  })

  const currentBook = computed<Book | null>(
    () => books.value.find((book) => book.id === currentBookId.value) ?? null
  )

  const currentVolume = computed<Volume | null>(
    () => volumes.value.find((volume) => volume.id === currentVolumeId.value) ?? null
  )

  /** 年代候选：从数据中派生 */
  const eraOptions = computed<string[]>(() =>
    Array.from(new Set(books.value.map((book) => book.era).filter((era) => era.length > 0))).sort()
  )

  /** 古籍总览筛选结果（关键字 + 年代 + 保护级别） */
  const filteredBooks = computed<Book[]>(() => {
    const keyword = filters.value.keyword.trim()
    return books.value.filter((book) => {
      if (keyword.length > 0) {
        const haystack = `${book.title}${book.edition}${book.era}${book.collectionNo}`
        if (!haystack.includes(keyword)) return false
      }
      if (filters.value.eras.length > 0 && !filters.value.eras.includes(book.era)) return false
      if (filters.value.levels.length > 0 && !filters.value.levels.includes(book.level)) return false
      return true
    })
  })

  async function loadBooks(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.books.toArray()
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      books.value = rows
      const stillExists = currentBookId.value !== null && rows.some((book) => book.id === currentBookId.value)
      if (!stillExists) currentBookId.value = null
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '古籍读取失败'
    } finally {
      loading.value = false
    }
  }

  async function loadVolumes(): Promise<void> {
    const rows = await db.volumes.toArray()
    rows.sort((a, b) => (a.bookId === b.bookId ? a.volumeNo - b.volumeNo : a.bookId.localeCompare(b.bookId)))
    volumes.value = rows
  }

  function setCurrentBook(id: string | null): void {
    currentBookId.value = id
  }

  function setCurrentVolume(id: string | null): void {
    currentVolumeId.value = id
  }

  function setKeyword(keyword: string): void {
    filters.value = { ...filters.value, keyword }
  }

  function setEras(eras: string[]): void {
    filters.value = { ...filters.value, eras }
  }

  function setLevels(levels: BookLevel[]): void {
    filters.value = { ...filters.value, levels }
  }

  function resetFilters(): void {
    filters.value = { ...DEFAULT_BOOK_FILTERS }
  }

  async function createBook(draft: BookDraft): Promise<Book> {
    const now = Date.now()
    const row: Book = { ...draft, id: createId('book'), createdAt: now, updatedAt: now }
    await db.books.put(row)
    await loadBooks()
    currentBookId.value = row.id
    return row
  }

  async function updateBook(id: string, patch: Partial<Book>): Promise<void> {
    await db.books.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadBooks()
  }

  async function removeBook(id: string): Promise<void> {
    await removeBookCascade(id)
    if (currentBookId.value === id) currentBookId.value = null
    await Promise.all([loadBooks(), loadVolumes()])
  }

  async function createVolume(draft: VolumeDraft): Promise<Volume> {
    const now = Date.now()
    const row: Volume = { ...draft, id: createId('vol'), revision: 1, createdAt: now, updatedAt: now }
    await db.volumes.put(row)
    await loadVolumes()
    await syncBookVolumeCount(row.bookId)
    return row
  }

  /**
   * 更新册次（带修订号乐观锁）。
   * @param baseRevision 保存方看到的修订号
   */
  async function updateVolume(id: string, patch: Partial<Volume>, baseRevision: number): Promise<RevisionResult<void>> {
    const existing = volumes.value.find((volume) => volume.id === id)
    const result = await withVolumeRevision(id, baseRevision, async (tx) => {
      await tx.table<Volume>('volumes').update(id, { ...patch, updatedAt: Date.now() })
      return {
        data: undefined,
        changes: [
          {
            action: 'update',
            table: 'volumes',
            recordId: id,
            label: `第 ${existing?.volumeNo ?? '?'} 册册次信息`
          }
        ]
      }
    })
    if (result.ok) {
      await loadVolumes()
      if (existing) await syncBookVolumeCount(existing.bookId)
    }
    return result
  }

  async function removeVolume(id: string): Promise<void> {
    const existing = volumes.value.find((volume) => volume.id === id)
    await removeVolumeCascade(id)
    if (currentVolumeId.value === id) currentVolumeId.value = null
    await loadVolumes()
    if (existing) await syncBookVolumeCount(existing.bookId)
  }

  /** 册次增删后回写古籍的册数，保证卡片回显一致 */
  async function syncBookVolumeCount(bookId: string): Promise<void> {
    const count = volumes.value.filter((volume) => volume.bookId === bookId).length
    const book = books.value.find((item) => item.id === bookId)
    if (book && book.volumeCount !== count) {
      await db.books.update(bookId, { volumeCount: count, updatedAt: Date.now() } as never)
      await loadBooks()
    }
  }

  /** 推进册次状态（带修订号乐观锁） */
  async function advanceVolumeState(id: string, baseRevision: number): Promise<RevisionResult<void>> {
    const volume = volumes.value.find((item) => item.id === id)
    if (!volume) return { ok: true, revision: baseRevision, data: undefined }
    const next: VolumeState = nextVolumeState(volume.state)
    if (next === volume.state) return { ok: true, revision: baseRevision, data: undefined }
    return updateVolume(id, { state: next }, baseRevision)
  }

  /**
   * 装订验收提交（带修订号乐观锁）。
   * 在同一事务中完成：① 新建/更新装订验收记录；② 按结论更新册次状态（合格→已归档，返修→修复中）。
   * 两步合并为一次修订号自增，避免中间状态被其他窗口误改。
   */
  async function submitAcceptance(
    volumeId: string,
    bindingData: { id?: string; method: string; finishDate: string; verdict: BindingVerdict; inspector: string },
    baseRevision: number
  ): Promise<RevisionResult<void>> {
    const volume = volumes.value.find((item) => item.id === volumeId)
    if (!volume) return { ok: true, revision: baseRevision, data: undefined }
    const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
      const now = Date.now()
      const bindingsTable = tx.table<Binding>('bindings')
      const volumesTable = tx.table<Volume>('volumes')
      if (bindingData.id) {
        await bindingsTable.update(bindingData.id, {
          method: bindingData.method,
          finishDate: bindingData.finishDate,
          verdict: bindingData.verdict,
          inspector: bindingData.inspector,
          updatedAt: now
        })
      } else {
        await bindingsTable.put({
          id: createId('bind'),
          volumeId,
          method: bindingData.method,
          finishDate: bindingData.finishDate,
          verdict: bindingData.verdict,
          inspector: bindingData.inspector,
          createdAt: now,
          updatedAt: now
        })
      }
      const newState: VolumeState = bindingData.verdict === 'pass' ? 'archived' : 'repairing'
      await volumesTable.update(volumeId, { state: newState, updatedAt: now })
      return {
        data: undefined,
        changes: [
          {
            action: bindingData.id ? ('update' as const) : ('create' as const),
            table: 'bindings' as const,
            recordId: bindingData.id ?? 'new',
            label: '装订验收记录'
          },
          {
            action: 'update' as const,
            table: 'volumes' as const,
            recordId: volumeId,
            label: `册次状态（${newState === 'archived' ? '已归档' : '退回修复中'}）`
          }
        ]
      }
    })
    if (result.ok) await loadVolumes()
    return result
  }

  function volumesOfBook(bookId: string): Volume[] {
    return volumes.value.filter((volume) => volume.bookId === bookId).sort((a, b) => a.volumeNo - b.volumeNo)
  }

  function bookById(id: string): Book | undefined {
    return books.value.find((book) => book.id === id)
  }

  function volumeById(id: string): Volume | undefined {
    return volumes.value.find((volume) => volume.id === id)
  }

  return {
    books,
    volumes,
    currentBookId,
    currentVolumeId,
    currentBook,
    currentVolume,
    filters,
    loading,
    ready,
    error,
    eraOptions,
    filteredBooks,
    loadBooks,
    loadVolumes,
    setCurrentBook,
    setCurrentVolume,
    setKeyword,
    setEras,
    setLevels,
    resetFilters,
    createBook,
    updateBook,
    removeBook,
    createVolume,
    updateVolume,
    removeVolume,
    advanceVolumeState,
    submitAcceptance,
    volumesOfBook,
    bookById,
    volumeById
  }
})

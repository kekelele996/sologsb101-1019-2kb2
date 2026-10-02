/**
 * 书叶 store（Pinia setup store）
 * 维护书叶清单、破损筛选条件与统计派生值；筛选条件与 URL query 双向同步。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { useBookStore } from '@/stores/bookStore'
import {
  nextLeafState,
  type DamageType,
  type Leaf,
  type LeafDraft,
  type LeafState
} from '@/types/leaf'
import { commitVolumeChange, revisionOf, type VolumeSaveResult, type VolumeScopeSnapshot } from '@/utils/concurrency'
import { isVolumeContentEditable, type Volume } from '@/types/volume'

export interface LeafFilters {
  keyword: string
  damageTypes: DamageType[]
  states: LeafState[]
}

export const DEFAULT_LEAF_FILTERS: LeafFilters = { keyword: '', damageTypes: [], states: [] }

export const useLeafStore = defineStore('leaf', () => {
  const leaves = ref<Leaf[]>([])
  const filters = ref<LeafFilters>({ ...DEFAULT_LEAF_FILTERS })
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadLeaves(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.leaves.toArray()
      rows.sort((a, b) => (a.volumeId === b.volumeId ? a.leafNo - b.leafNo : a.volumeId.localeCompare(b.volumeId)))
      leaves.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '书叶读取失败'
    } finally {
      loading.value = false
    }
  }

  function leavesOfVolume(volumeId: string): Leaf[] {
    return leaves.value.filter((leaf) => leaf.volumeId === volumeId).sort((a, b) => a.leafNo - b.leafNo)
  }

  function volumeFromLoaded(volumeId: string): Volume | undefined {
    return useBookStore().volumes.find((item) => item.id === volumeId)
  }

  function requireWritableVolume(volumeId: string): Volume {
    const volume = volumeFromLoaded(volumeId)
    if (!volume) throw new Error('未找到对应册次')
    if (!isVolumeContentEditable(volume.state)) throw new Error('该册已装订或归档，不能修改书叶记录')
    return volume
  }

  /** 书叶页展示用筛选结果（按册 + 关键字 + 破损类型 + 状态） */
  const filteredLeaves = computed<Leaf[]>(() => {
    const keyword = filters.value.keyword.trim()
    return leaves.value.filter((leaf) => {
      if (keyword.length > 0) {
        const haystack = `${leaf.leafNo}${leaf.damageAreaCm2}${leaf.phValue}`
        if (!haystack.includes(keyword)) return false
      }
      if (filters.value.damageTypes.length > 0 && !filters.value.damageTypes.includes(leaf.damageType)) return false
      if (filters.value.states.length > 0 && !filters.value.states.includes(leaf.state)) return false
      return true
    })
  })

  /** 破损类型分布（全局），供统计徽标与图表使用 */
  const damageDistribution = computed<Record<DamageType, number>>(() => {
    const result: Record<DamageType, number> = { worm: 0, acid: 0, fibrin: 0, loss: 0, stain: 0 }
    leaves.value.forEach((leaf) => {
      result[leaf.damageType] += 1
    })
    return result
  })

  const averagePh = computed<number>(() => {
    if (leaves.value.length === 0) return 0
    const sum = leaves.value.reduce((acc, leaf) => acc + leaf.phValue, 0)
    return Math.round((sum / leaves.value.length) * 100) / 100
  })

  const totalAreaCm2 = computed<number>(
    () => Math.round(leaves.value.reduce((sum, leaf) => sum + leaf.damageAreaCm2, 0) * 10) / 10
  )

  const pendingCount = computed<number>(() => leaves.value.filter((leaf) => leaf.state !== 'repaired').length)

  function setKeyword(keyword: string): void {
    filters.value = { ...filters.value, keyword }
  }

  function setDamageTypes(damageTypes: DamageType[]): void {
    filters.value = { ...filters.value, damageTypes }
  }

  function setStates(states: LeafState[]): void {
    filters.value = { ...filters.value, states }
  }

  function resetFilters(): void {
    filters.value = { ...DEFAULT_LEAF_FILTERS }
  }

  interface LeafMutationOptions {
    expectedRevision: number
    baseline?: VolumeScopeSnapshot | null
  }

  async function createLeaf(draft: LeafDraft, options: LeafMutationOptions): Promise<VolumeSaveResult> {
    requireWritableVolume(draft.volumeId)
    const result = await commitVolumeChange(
      draft.volumeId,
      options,
      async ({ now }) => {
        await db.leaves.put({ ...draft, id: createId('leaf'), createdAt: now, updatedAt: now })
      },
      options.baseline
    )
    if (result.ok) await loadLeaves()
    return result
  }

  async function updateLeaf(id: string, patch: Partial<Leaf>, options?: LeafMutationOptions): Promise<VolumeSaveResult | null> {
    const existing = leaves.value.find((leaf) => leaf.id === id)
    if (!existing) return null
    const volume = requireWritableVolume(existing.volumeId)
    const result = await commitVolumeChange(
      existing.volumeId,
      options ?? { expectedRevision: revisionOf(volume) },
      async ({ now }) => {
        await db.leaves.put({ ...existing, ...patch, id, volumeId: existing.volumeId, createdAt: existing.createdAt, updatedAt: now })
      },
      options?.baseline
    )
    if (result.ok) await loadLeaves()
    return result
  }

  async function removeLeaf(id: string, options?: LeafMutationOptions): Promise<VolumeSaveResult | null> {
    const existing = leaves.value.find((leaf) => leaf.id === id)
    if (!existing) return null
    requireWritableVolume(existing.volumeId)
    const volume = volumeFromLoaded(existing.volumeId) as Volume
    const result = await commitVolumeChange(
      existing.volumeId,
      options ?? { expectedRevision: revisionOf(volume) },
      async () => {
        await db.papers.where('leafId').equals(id).delete()
        await db.repairOrders.where('leafId').equals(id).delete()
        await db.leaves.delete(id)
      },
      options?.baseline
    )
    if (result.ok) await loadLeaves()
    return result
  }

  /** 批量操作限定同一册，避免一次保存跨过不同修订号 */
  async function batchUpdate(ids: string[], patch: Partial<Leaf>, options: LeafMutationOptions): Promise<VolumeSaveResult> {
    const selected = leaves.value.filter((leaf) => ids.includes(leaf.id))
    const volumeIds = Array.from(new Set(selected.map((leaf) => leaf.volumeId)))
    if (volumeIds.length !== 1) throw new Error('批量操作只能选择同一册次的书叶')
    const volumeId = volumeIds[0] as string
    requireWritableVolume(volumeId)
    const result = await commitVolumeChange(
      volumeId,
      options,
      async ({ now }) => {
        await db.leaves.bulkPut(
          selected.map((leaf) => ({ ...leaf, ...patch, id: leaf.id, volumeId: leaf.volumeId, createdAt: leaf.createdAt, updatedAt: now }))
        )
      },
      options.baseline
    )
    if (result.ok) await loadLeaves()
    return result
  }

  async function advanceLeafState(id: string, options?: LeafMutationOptions): Promise<VolumeSaveResult | null> {
    const leaf = leaves.value.find((item) => item.id === id)
    if (!leaf) return null
    const next = nextLeafState(leaf.state)
    if (next === leaf.state) return null
    return updateLeaf(id, { state: next }, options)
  }

  function leafById(id: string): Leaf | undefined {
    return leaves.value.find((leaf) => leaf.id === id)
  }

  return {
    leaves,
    filters,
    loading,
    ready,
    error,
    filteredLeaves,
    damageDistribution,
    averagePh,
    totalAreaCm2,
    pendingCount,
    loadLeaves,
    leavesOfVolume,
    setKeyword,
    setDamageTypes,
    setStates,
    resetFilters,
    createLeaf,
    updateLeaf,
    removeLeaf,
    batchUpdate,
    advanceLeafState,
    leafById
  }
})

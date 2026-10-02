/**
 * 书叶 store（Pinia setup store）
 * 维护书叶清单、破损筛选条件与统计派生值；筛选条件与 URL query 双向同步。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, removeLeafCascade } from '@/utils/db'
import {
  nextLeafState,
  type DamageType,
  type Leaf,
  type LeafDraft,
  type LeafState
} from '@/types/leaf'

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

  async function createLeaf(draft: LeafDraft): Promise<Leaf> {
    const now = Date.now()
    const row: Leaf = { ...draft, id: createId('leaf'), createdAt: now, updatedAt: now }
    await db.leaves.put(row)
    await loadLeaves()
    return row
  }

  async function updateLeaf(id: string, patch: Partial<Leaf>): Promise<void> {
    await db.leaves.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadLeaves()
  }

  async function removeLeaf(id: string): Promise<void> {
    await removeLeafCascade(id)
    await loadLeaves()
  }

  async function batchUpdate(ids: string[], patch: Partial<Leaf>): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    const rows = leaves.value.filter((leaf) => ids.includes(leaf.id)).map((leaf) => ({ ...leaf, ...patch, updatedAt: now }))
    await db.leaves.bulkPut(rows)
    await loadLeaves()
  }

  async function advanceLeafState(id: string): Promise<void> {
    const leaf = leaves.value.find((item) => item.id === id)
    if (!leaf) return
    const next = nextLeafState(leaf.state)
    if (next === leaf.state) return
    await updateLeaf(id, { state: next })
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

/**
 * 书叶 store（Pinia setup store）
 * 维护书叶清单、破损筛选条件与统计派生值；筛选条件与 URL query 双向同步。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { withVolumeRevision, type RevisionResult } from '@/utils/revision'
import type { Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
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

  async function createLeaf(draft: LeafDraft, baseRevision: number): Promise<RevisionResult<Leaf>> {
    const now = Date.now()
    const row: Leaf = { ...draft, id: createId('leaf'), createdAt: now, updatedAt: now }
    const result = await withVolumeRevision(draft.volumeId, baseRevision, async (tx) => {
      await tx.table<Leaf>('leaves').put(row)
      return {
        data: row,
        changes: [
          {
            action: 'create',
            table: 'leaves',
            recordId: row.id,
            label: `第 ${row.leafNo} 叶破损记录`
          }
        ]
      }
    })
    if (result.ok) await loadLeaves()
    return result
  }

  async function updateLeaf(id: string, patch: Partial<Leaf>, baseRevision: number): Promise<RevisionResult<void>> {
    const leaf = leaves.value.find((item) => item.id === id)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      const leavesTable = tx.table<Leaf>('leaves')
      await leavesTable.update(id, { ...patch, updatedAt: Date.now() })
      const updated = await leavesTable.get(id)
      return {
        data: undefined,
        changes: [
          {
            action: 'update',
            table: 'leaves',
            recordId: id,
            label: `第 ${updated?.leafNo ?? leaf.leafNo} 叶破损记录`
          }
        ]
      }
    })
    if (result.ok) await loadLeaves()
    return result
  }

  async function removeLeaf(id: string, baseRevision: number): Promise<RevisionResult<void>> {
    const leaf = leaves.value.find((item) => item.id === id)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      const leavesTable = tx.table<Leaf>('leaves')
      const papersTable = tx.table<Paper>('papers')
      const repairOrdersTable = tx.table<RepairOrder>('repairOrders')
      // 级联删除该叶下的补纸与工序记录
      const paperIds = await papersTable.where('leafId').equals(id).primaryKeys()
      const orderIds = await repairOrdersTable.where('leafId').equals(id).primaryKeys()
      if (paperIds.length > 0) await papersTable.bulkDelete(paperIds)
      if (orderIds.length > 0) await repairOrdersTable.bulkDelete(orderIds)
      await leavesTable.delete(id)
      return {
        data: undefined,
        changes: [
          {
            action: 'delete',
            table: 'leaves',
            recordId: id,
            label: `第 ${leaf.leafNo} 叶破损记录`
          }
        ]
      }
    })
    if (result.ok) await loadLeaves()
    return result
  }

  async function batchUpdate(ids: string[], patch: Partial<Leaf>, baseRevision: number): Promise<RevisionResult<void>> {
    if (ids.length === 0) return { ok: true, revision: baseRevision, data: undefined }
    const selected = leaves.value.filter((leaf) => ids.includes(leaf.id))
    if (selected.length === 0) return { ok: true, revision: baseRevision, data: undefined }
    const volumeId = selected[0].volumeId
    const now = Date.now()
    const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
      const rows = selected.map((leaf) => ({ ...leaf, ...patch, updatedAt: now }))
      await tx.table<Leaf>('leaves').bulkPut(rows)
      return {
        data: undefined,
        changes: selected.map((leaf) => ({
          action: 'update' as const,
          table: 'leaves' as const,
          recordId: leaf.id,
          label: `第 ${leaf.leafNo} 叶破损记录`
        }))
      }
    })
    if (result.ok) await loadLeaves()
    return result
  }

  async function advanceLeafState(id: string, baseRevision: number): Promise<RevisionResult<void>> {
    const leaf = leaves.value.find((item) => item.id === id)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const next = nextLeafState(leaf.state)
    if (next === leaf.state) return { ok: true, revision: baseRevision, data: undefined }
    return updateLeaf(id, { state: next }, baseRevision)
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

/**
 * 修复工序 store（Pinia setup store）
 * 维护工序顺序、拖拽重排落库重编号与完成态；完成即回写书叶状态。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { withVolumeRevision, type RevisionResult } from '@/utils/revision'
import { createEmptyOrderDraft, type OrderState, type RepairOrder, type RepairOrderDraft } from '@/types/repairOrder'
import type { Leaf } from '@/types/leaf'
import { useLeafStore } from './leafStore'

export const useRepairStore = defineStore('repair', () => {
  const leafStore = useLeafStore()
  const orders = ref<RepairOrder[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')
  const sortMode = ref<'manual' | 'leaf'>(readUiPrefs().repairSort)

  const orderedOrders = computed<RepairOrder[]>(() =>
    [...orders.value].sort((a, b) =>
      a.leafId === b.leafId ? a.seq - b.seq : a.leafId.localeCompare(b.leafId)
    )
  )

  const totalSteps = computed<number>(() => orders.value.length)
  const doneSteps = computed<number>(() => orders.value.filter((order) => order.state === 'done').length)
  const donePercent = computed<number>(() =>
    orders.value.length === 0 ? 0 : Math.round((doneSteps.value / orders.value.length) * 100)
  )

  async function loadOrders(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.repairOrders.toArray()
      rows.sort((a, b) => (a.leafId === b.leafId ? a.seq - b.seq : a.leafId.localeCompare(b.leafId)))
      orders.value = rows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '工序读取失败'
    } finally {
      loading.value = false
    }
  }

  function ordersOfLeaf(leafId: string): RepairOrder[] {
    return orders.value.filter((order) => order.leafId === leafId).sort((a, b) => a.seq - b.seq)
  }

  function nextSeq(leafId: string): number {
    const list = orders.value.filter((order) => order.leafId === leafId)
    return list.length === 0 ? 1 : Math.max(...list.map((order) => order.seq)) + 1
  }

  async function createOrder(draft: RepairOrderDraft, baseRevision: number): Promise<RevisionResult<RepairOrder>> {
    const leaf = leafStore.leafById(draft.leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined as never }
    const now = Date.now()
    const row: RepairOrder = { ...draft, id: createId('order'), createdAt: now, updatedAt: now }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      await tx.table<RepairOrder>('repairOrders').put(row)
      return {
        data: row,
        changes: [
          {
            action: 'create',
            table: 'repairOrders',
            recordId: row.id,
            label: `第 ${leaf.leafNo} 叶第 ${row.seq} 道工序`
          }
        ]
      }
    })
    if (result.ok) await loadOrders()
    return result
  }

  /** 按叶生成标准工序序列（补破 → 托裱 → 溜口 → 裁齐 → 压平） */
  async function generateSequence(leafId: string, baseRevision: number): Promise<RevisionResult<number>> {
    const leaf = leafStore.leafById(leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: 0 }
    const existing = ordersOfLeaf(leafId)
    const names: RepairOrderDraft['name'][] = ['mend', 'mount', 'corner', 'trim', 'press']
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      let created = 0
      const changes: Array<{ action: 'create'; table: 'repairOrders'; recordId: string; label: string }> = []
      for (let index = 0; index < names.length; index += 1) {
        const seq = index + 1
        if (existing.some((order) => order.seq === seq)) continue
        const draft = createEmptyOrderDraft(leafId, seq)
        const id = createId('order')
        await tx.table<RepairOrder>('repairOrders').put({
          ...draft,
          name: names[index] as RepairOrderDraft['name'],
          material: '',
          id,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
        changes.push({
          action: 'create',
          table: 'repairOrders',
          recordId: id,
          label: `第 ${leaf.leafNo} 叶第 ${seq} 道工序`
        })
        created += 1
      }
      return { data: created, changes }
    })
    if (result.ok) await loadOrders()
    return result
  }

  async function updateOrder(id: string, patch: Partial<RepairOrder>, baseRevision: number): Promise<RevisionResult<void>> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return { ok: true, revision: baseRevision, data: undefined }
    const leaf = leafStore.leafById(order.leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      await tx.table<RepairOrder>('repairOrders').update(id, { ...patch, updatedAt: Date.now() })
      return {
        data: undefined,
        changes: [
          {
            action: 'update',
            table: 'repairOrders',
            recordId: id,
            label: `第 ${leaf.leafNo} 叶第 ${order.seq} 道工序`
          }
        ]
      }
    })
    if (result.ok) await loadOrders()
    return result
  }

  async function removeOrder(id: string, baseRevision: number): Promise<RevisionResult<void>> {
    const target = orders.value.find((order) => order.id === id)
    if (!target) return { ok: true, revision: baseRevision, data: undefined }
    const leaf = leafStore.leafById(target.leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      await tx.table<RepairOrder>('repairOrders').delete(id)
      const changes: Array<{ action: 'delete' | 'update'; table: 'repairOrders'; recordId: string; label: string }> = [
        {
          action: 'delete',
          table: 'repairOrders',
          recordId: id,
          label: `第 ${leaf.leafNo} 叶第 ${target.seq} 道工序`
        }
      ]
      const rest = orders.value
        .filter((order) => order.leafId === target.leafId && order.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
      if (rest.length > 0) {
        await tx.table<RepairOrder>('repairOrders').bulkPut(rest)
        rest.forEach((order) => {
          changes.push({
            action: 'update',
            table: 'repairOrders',
            recordId: order.id,
            label: `第 ${leaf.leafNo} 叶第 ${order.seq} 道工序（重编号）`
          })
        })
      }
      return { data: undefined, changes }
    })
    if (result.ok) await loadOrders()
    return result
  }

  async function batchUpdate(ids: string[], patch: Partial<RepairOrder>, baseRevision: number): Promise<RevisionResult<void>> {
    if (ids.length === 0) return { ok: true, revision: baseRevision, data: undefined }
    const selected = orders.value.filter((order) => ids.includes(order.id))
    if (selected.length === 0) return { ok: true, revision: baseRevision, data: undefined }
    const leaf = leafStore.leafById(selected[0].leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const now = Date.now()
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      const rows = selected.map((order) => ({ ...order, ...patch, updatedAt: now }))
      await tx.table<RepairOrder>('repairOrders').bulkPut(rows)
      return {
        data: undefined,
        changes: selected.map((order) => ({
          action: 'update' as const,
          table: 'repairOrders' as const,
          recordId: order.id,
          label: `第 ${leaf.leafNo} 叶第 ${order.seq} 道工序`
        }))
      }
    })
    if (result.ok) await loadOrders()
    return result
  }

  /** 拖拽重排：按新顺序落库并重编号 */
  async function reorderOrders(leafId: string, orderedIds: string[], baseRevision: number): Promise<RevisionResult<void>> {
    const leaf = leafStore.leafById(leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: undefined }
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]))
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      const rows = orders.value
        .filter((order) => order.leafId === leafId)
        .sort((a, b) => {
          const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER
          const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER
          return ai - bi
        })
        .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
      await tx.table<RepairOrder>('repairOrders').bulkPut(rows)
      return {
        data: undefined,
        changes: rows.map((order) => ({
          action: 'update' as const,
          table: 'repairOrders' as const,
          recordId: order.id,
          label: `第 ${leaf.leafNo} 叶第 ${order.seq} 道工序（重编号）`
        }))
      }
    })
    if (result.ok) await loadOrders()
    return result
  }

  /** 推进工序状态；完成时回写书叶状态 */
  async function advanceOrder(id: string, baseRevision: number): Promise<RevisionResult<OrderState>> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return { ok: true, revision: baseRevision, data: 'todo' }
    const leaf = leafStore.leafById(order.leafId)
    if (!leaf) return { ok: true, revision: baseRevision, data: order.state }
    const flow: OrderState[] = ['todo', 'doing', 'done']
    const index = flow.indexOf(order.state)
    const next = index < 0 || index >= flow.length - 1 ? order.state : (flow[index + 1] as OrderState)
    if (next === order.state) return { ok: true, revision: baseRevision, data: order.state }
    const result = await withVolumeRevision(leaf.volumeId, baseRevision, async (tx) => {
      await tx.table<RepairOrder>('repairOrders').update(id, { state: next, updatedAt: Date.now() })
      const changes: Array<{ action: 'update'; table: 'repairOrders' | 'leaves'; recordId: string; label: string }> = [
        {
          action: 'update',
          table: 'repairOrders',
          recordId: id,
          label: `第 ${leaf.leafNo} 叶第 ${order.seq} 道工序（置为「${next === 'done' ? '已完成' : next === 'doing' ? '进行中' : '未开始'}」）`
        }
      ]
      // 完成时回写书叶状态
      if (next === 'done') {
        const siblings = ordersOfLeaf(order.leafId)
        const allDone = siblings.every((item) => item.state === 'done' || item.id === id)
        if (allDone) {
          await tx.table<Leaf>('leaves').update(leaf.id, { state: 'repaired', updatedAt: Date.now() })
          changes.push({
            action: 'update',
            table: 'leaves',
            recordId: leaf.id,
            label: `第 ${leaf.leafNo} 叶破损记录（回写为已修复）`
          })
        } else if (leaf.state === 'pending') {
          await tx.table<Leaf>('leaves').update(leaf.id, { state: 'repairing', updatedAt: Date.now() })
          changes.push({
            action: 'update',
            table: 'leaves',
            recordId: leaf.id,
            label: `第 ${leaf.leafNo} 叶破损记录（回写为修复中）`
          })
        }
      } else if (next === 'doing' && leaf.state === 'pending') {
        await tx.table<Leaf>('leaves').update(leaf.id, { state: 'repairing', updatedAt: Date.now() })
        changes.push({
          action: 'update',
          table: 'leaves',
          recordId: leaf.id,
          label: `第 ${leaf.leafNo} 叶破损记录（回写为修复中）`
        })
      }
      return { data: next, changes }
    })
    if (result.ok) await Promise.all([loadOrders(), leafStore.loadLeaves()])
    return result
  }

  function setSortMode(mode: 'manual' | 'leaf'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), repairSort: mode })
  }

  return {
    orders,
    orderedOrders,
    loading,
    ready,
    error,
    sortMode,
    totalSteps,
    doneSteps,
    donePercent,
    loadOrders,
    ordersOfLeaf,
    nextSeq,
    createOrder,
    generateSequence,
    updateOrder,
    removeOrder,
    batchUpdate,
    reorderOrders,
    advanceOrder,
    setSortMode
  }
})

/**
 * 修复工序 store（Pinia setup store）
 * 维护工序顺序、拖拽重排落库重编号与完成态；完成即回写书叶状态。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { createEmptyOrderDraft, type OrderState, type RepairOrder, type RepairOrderDraft } from '@/types/repairOrder'
import { useLeafStore } from './leafStore'

export const useRepairStore = defineStore('repair', () => {
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

  async function createOrder(draft: RepairOrderDraft): Promise<RepairOrder> {
    const now = Date.now()
    const row: RepairOrder = { ...draft, id: createId('order'), createdAt: now, updatedAt: now }
    await db.repairOrders.put(row)
    await loadOrders()
    return row
  }

  /** 按叶生成标准工序序列（补破 → 托裱 → 溜口 → 裁齐 → 压平） */
  async function generateSequence(leafId: string): Promise<number> {
    const existing = ordersOfLeaf(leafId)
    const names: RepairOrderDraft['name'][] = ['mend', 'mount', 'corner', 'trim', 'press']
    let created = 0
    for (let index = 0; index < names.length; index += 1) {
      const seq = index + 1
      if (existing.some((order) => order.seq === seq)) continue
      const draft = createEmptyOrderDraft(leafId, seq)
      await db.repairOrders.put({
        ...draft,
        name: names[index] as RepairOrderDraft['name'],
        material: '',
        id: createId('order'),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      created += 1
    }
    await loadOrders()
    return created
  }

  async function updateOrder(id: string, patch: Partial<RepairOrder>): Promise<void> {
    await db.repairOrders.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadOrders()
  }

  async function removeOrder(id: string): Promise<void> {
    const target = orders.value.find((order) => order.id === id)
    await db.repairOrders.delete(id)
    if (target) {
      const rest = orders.value
        .filter((order) => order.leafId === target.leafId && order.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
      if (rest.length > 0) await db.repairOrders.bulkPut(rest)
    }
    await loadOrders()
  }

  async function batchUpdate(ids: string[], patch: Partial<RepairOrder>): Promise<void> {
    if (ids.length === 0) return
    const now = Date.now()
    const rows = orders.value.filter((order) => ids.includes(order.id)).map((order) => ({ ...order, ...patch, updatedAt: now }))
    await db.repairOrders.bulkPut(rows)
    await loadOrders()
  }

  /** 拖拽重排：按新顺序落库并重编号 */
  async function reorderOrders(leafId: string, orderedIds: string[]): Promise<void> {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]))
    const rows = orders.value
      .filter((order) => order.leafId === leafId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER
        return ai - bi
      })
      .map((order, index) => ({ ...order, seq: index + 1, updatedAt: Date.now() }))
    await db.repairOrders.bulkPut(rows)
    await loadOrders()
  }

  /** 推进工序状态；完成时回写书叶状态 */
  async function advanceOrder(id: string): Promise<OrderState> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return 'todo'
    const flow: OrderState[] = ['todo', 'doing', 'done']
    const index = flow.indexOf(order.state)
    const next = index < 0 || index >= flow.length - 1 ? order.state : (flow[index + 1] as OrderState)
    if (next === order.state) return order.state
    await updateOrder(id, { state: next })
    if (next === 'done') {
      const leafStore = useLeafStore()
      const leaf = leafStore.leafById(order.leafId)
      if (leaf) {
        const siblings = ordersOfLeaf(order.leafId)
        const allDone = siblings.every((item) => item.state === 'done' || item.id === id)
        if (allDone) await leafStore.updateLeaf(leaf.id, { state: 'repaired' })
        else if (leaf.state === 'pending') await leafStore.updateLeaf(leaf.id, { state: 'repairing' })
      }
    } else if (next === 'doing') {
      const leafStore = useLeafStore()
      const leaf = leafStore.leafById(order.leafId)
      if (leaf && leaf.state === 'pending') await leafStore.updateLeaf(leaf.id, { state: 'repairing' })
    }
    return next
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

/**
 * 修复工序 store（Pinia setup store）
 * 维护工序顺序、拖拽重排落库重编号与完成态；完成即回写书叶状态。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { createEmptyOrderDraft, type OrderState, type RepairOrder, type RepairOrderDraft } from '@/types/repairOrder'
import { isVolumeContentEditable, type Volume } from '@/types/volume'
import { commitVolumeChange, revisionOf, type VolumeSaveResult, type VolumeScopeSnapshot } from '@/utils/concurrency'
import { useBookStore } from './bookStore'
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

  function volumeForLeaf(leafId: string): Volume | undefined {
    const leaf = useLeafStore().leafById(leafId)
    if (!leaf) return undefined
    return useBookStore().volumes.find((volume) => volume.id === leaf.volumeId)
  }

  function requireWritableVolumeForLeaf(leafId: string): Volume {
    const volume = volumeForLeaf(leafId)
    if (!volume) throw new Error('未找到对应册次')
    if (!isVolumeContentEditable(volume.state)) throw new Error('该册已装订或归档，不能修改工序')
    return volume
  }

  function nextSeq(leafId: string): number {
    const list = orders.value.filter((order) => order.leafId === leafId)
    return list.length === 0 ? 1 : Math.max(...list.map((order) => order.seq)) + 1
  }

  interface OrderMutationOptions {
    expectedRevision: number
    baseline?: VolumeScopeSnapshot | null
  }

  async function createOrder(draft: RepairOrderDraft, options: OrderMutationOptions): Promise<VolumeSaveResult> {
    requireWritableVolumeForLeaf(draft.leafId)
    const result = await commitVolumeChange(
      volumeForLeaf(draft.leafId)!.id,
      options,
      async ({ now }) => {
        await db.repairOrders.put({ ...draft, id: createId('order'), createdAt: now, updatedAt: now })
      },
      options.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  /** 按叶生成标准工序序列（补破 → 托裱 → 溜口 → 裁齐 → 压平） */
  async function generateSequence(leafId: string, options: OrderMutationOptions): Promise<VolumeSaveResult> {
    requireWritableVolumeForLeaf(leafId)
    const existing = ordersOfLeaf(leafId)
    const names: RepairOrderDraft['name'][] = ['mend', 'mount', 'corner', 'trim', 'press']
    const result = await commitVolumeChange(
      volumeForLeaf(leafId)!.id,
      options,
      async ({ now }) => {
        for (let index = 0; index < names.length; index += 1) {
          const seq = index + 1
          if (existing.some((order) => order.seq === seq)) continue
          await db.repairOrders.put({
            ...createEmptyOrderDraft(leafId, seq),
            name: names[index] as RepairOrderDraft['name'],
            material: '',
            id: createId('order'),
            createdAt: now,
            updatedAt: now
          })
        }
      },
      options.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  async function updateOrder(id: string, patch: Partial<RepairOrder>, options?: OrderMutationOptions): Promise<VolumeSaveResult | null> {
    const existing = orders.value.find((order) => order.id === id)
    if (!existing) return null
    const volume = requireWritableVolumeForLeaf(existing.leafId)
    const result = await commitVolumeChange(
      volume.id,
      options ?? { expectedRevision: revisionOf(volume) },
      async ({ now }) => {
        await db.repairOrders.put({ ...existing, ...patch, id, leafId: existing.leafId, createdAt: existing.createdAt, updatedAt: now })
      },
      options?.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  async function removeOrder(id: string, options?: OrderMutationOptions): Promise<VolumeSaveResult | null> {
    const target = orders.value.find((order) => order.id === id)
    if (!target) return null
    const volume = requireWritableVolumeForLeaf(target.leafId)
    const result = await commitVolumeChange(
      volume.id,
      options ?? { expectedRevision: revisionOf(volume) },
      async ({ now }) => {
        await db.repairOrders.delete(id)
        const rest = orders.value
          .filter((order) => order.leafId === target.leafId && order.id !== id)
          .sort((a, b) => a.seq - b.seq)
          .map((order, index) => ({ ...order, seq: index + 1, updatedAt: now }))
        if (rest.length > 0) await db.repairOrders.bulkPut(rest)
      },
      options?.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  /** 批量操作限定同一叶，也就限定在同一册 */
  async function batchUpdate(ids: string[], patch: Partial<RepairOrder>, options: OrderMutationOptions): Promise<VolumeSaveResult> {
    if (ids.length === 0) throw new Error('请先选择工序')
    const selected = orders.value.filter((order) => ids.includes(order.id))
    const leafIds = Array.from(new Set(selected.map((order) => order.leafId)))
    if (leafIds.length !== 1) throw new Error('批量操作只能选择同一书叶的工序')
    const volume = requireWritableVolumeForLeaf(leafIds[0] as string)
    const result = await commitVolumeChange(
      volume.id,
      options,
      async ({ now }) => {
        await db.repairOrders.bulkPut(
          selected.map((order) => ({ ...order, ...patch, id: order.id, leafId: order.leafId, createdAt: order.createdAt, updatedAt: now }))
        )
      },
      options.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  /** 拖拽重排：按新顺序落库并重编号 */
  async function reorderOrders(leafId: string, orderedIds: string[], options: OrderMutationOptions): Promise<VolumeSaveResult> {
    const volume = requireWritableVolumeForLeaf(leafId)
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]))
    const result = await commitVolumeChange(
      volume.id,
      options,
      async ({ now }) => {
        const rows = orders.value
          .filter((order) => order.leafId === leafId)
          .sort((a, b) => {
            const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER
            const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER
            return ai - bi
          })
          .map((order, index) => ({ ...order, seq: index + 1, updatedAt: now }))
        await db.repairOrders.bulkPut(rows)
      },
      options.baseline
    )
    if (result.ok) await loadOrders()
    return result
  }

  /** 推进工序状态；完成时在同一事务和同一修订号下回写书叶状态 */
  async function advanceOrder(
    id: string,
    options?: OrderMutationOptions
  ): Promise<{ state: OrderState; result: VolumeSaveResult } | null> {
    const order = orders.value.find((item) => item.id === id)
    if (!order) return null
    const volume = requireWritableVolumeForLeaf(order.leafId)
    const flow: OrderState[] = ['todo', 'doing', 'done']
    const index = flow.indexOf(order.state)
    const next = index < 0 || index >= flow.length - 1 ? order.state : (flow[index + 1] as OrderState)
    if (next === order.state) {
      return { state: order.state, result: { ok: true, basedOnRevision: revisionOf(volume), revision: revisionOf(volume) } }
    }

    const leafStore = useLeafStore()
    const leaf = leafStore.leaves.find((item) => item.id === order.leafId)
    const siblings = ordersOfLeaf(order.leafId)
    const leafState =
      next === 'done'
        ? siblings.every((item) => item.state === 'done' || item.id === id)
          ? 'repaired'
          : leaf?.state === 'pending'
            ? 'repairing'
            : leaf?.state
        : next === 'doing' && leaf?.state === 'pending'
          ? 'repairing'
          : leaf?.state

    const result = await commitVolumeChange(
      volume.id,
      options ?? { expectedRevision: revisionOf(volume) },
      async ({ now }) => {
        await db.repairOrders.put({ ...order, state: next, updatedAt: now })
        if (leaf && leafState && leaf.state !== leafState) {
          await db.leaves.put({ ...leaf, state: leafState, updatedAt: now })
        }
      },
      options?.baseline
    )
    if (result.ok) await Promise.all([loadOrders(), leafStore.loadLeaves()])
    return { state: next, result }
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

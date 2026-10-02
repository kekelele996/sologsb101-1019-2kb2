/**
 * useLeafStats()：按册汇总破损面积、平均 pH 与工序进度
 * 被书叶页（/books/:id/leaves）、工序页（/repairs）、导出页（/export）消费。
 */
import { computed, type ComputedRef } from 'vue'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { DAMAGE_TYPE_LABEL, type DamageType } from '@/types/leaf'

export interface VolumeLeafStat {
  volumeId: string
  leafCount: number
  /** 破损记录条数 */
  recordCount: number
  /** 破损总面积 cm² */
  totalAreaCm2: number
  /** 平均 pH */
  averagePh: number
  /** 待修条数 */
  pendingCount: number
  /** 已修复条数 */
  repairedCount: number
  /** 工序总数 */
  orderCount: number
  /** 已完成工序 */
  orderDoneCount: number
  /** 工序完成率 0-100 */
  orderPercent: number
  /** 破损类型分布 */
  damageCount: Record<DamageType, number>
}

export interface LeafStatsResult {
  /** 册次 id → 统计 */
  statsMap: ComputedRef<Record<string, VolumeLeafStat>>
  /** 与册次列表同序的统计数组 */
  list: ComputedRef<VolumeLeafStat[]>
  statOf: (volumeId: string) => VolumeLeafStat
  /** 全部书叶的汇总 */
  totals: ComputedRef<{
    recordCount: number
    totalAreaCm2: number
    averagePh: number
    orderCount: number
    orderDoneCount: number
    orderPercent: number
  }>
  /** 破损类型分布文案，供统计徽标展示 */
  describeDamage: (count: Record<DamageType, number>) => string
}

function emptyStat(volumeId: string): VolumeLeafStat {
  return {
    volumeId,
    leafCount: 0,
    recordCount: 0,
    totalAreaCm2: 0,
    averagePh: 0,
    pendingCount: 0,
    repairedCount: 0,
    orderCount: 0,
    orderDoneCount: 0,
    orderPercent: 0,
    damageCount: { worm: 0, acid: 0, fibrin: 0, loss: 0, stain: 0 }
  }
}

export function useLeafStats(): LeafStatsResult {
  const bookStore = useBookStore()
  const leafStore = useLeafStore()
  const repairStore = useRepairStore()

  const statsMap = computed<Record<string, VolumeLeafStat>>(() => {
    const result: Record<string, VolumeLeafStat> = {}
    bookStore.volumes.forEach((volume) => {
      const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === volume.id)
      const leafIds = leaves.map((leaf) => leaf.id)
      const orders = repairStore.orders.filter((order) => leafIds.includes(order.leafId))
      const done = orders.filter((order) => order.state === 'done').length
      const totalArea = leaves.reduce((sum, leaf) => sum + leaf.damageAreaCm2, 0)
      const averagePh = leaves.length === 0 ? 0 : leaves.reduce((sum, leaf) => sum + leaf.phValue, 0) / leaves.length
      const damageCount: Record<DamageType, number> = { worm: 0, acid: 0, fibrin: 0, loss: 0, stain: 0 }
      leaves.forEach((leaf) => {
        damageCount[leaf.damageType] += 1
      })
      result[volume.id] = {
        volumeId: volume.id,
        leafCount: new Set(leaves.map((leaf) => leaf.leafNo)).size,
        recordCount: leaves.length,
        totalAreaCm2: Math.round(totalArea * 10) / 10,
        averagePh: Math.round(averagePh * 100) / 100,
        pendingCount: leaves.filter((leaf) => leaf.state === 'pending').length,
        repairedCount: leaves.filter((leaf) => leaf.state === 'repaired').length,
        orderCount: orders.length,
        orderDoneCount: done,
        orderPercent: orders.length === 0 ? 0 : Math.round((done / orders.length) * 100),
        damageCount
      }
    })
    return result
  })

  const list = computed<VolumeLeafStat[]>(() =>
    bookStore.volumes.map((volume) => statsMap.value[volume.id] ?? emptyStat(volume.id))
  )

  const statOf = (volumeId: string): VolumeLeafStat => statsMap.value[volumeId] ?? emptyStat(volumeId)

  const totals = computed(() => {
    const recordCount = leafStore.leaves.length
    const totalAreaCm2 = Math.round(leafStore.leaves.reduce((sum, leaf) => sum + leaf.damageAreaCm2, 0) * 10) / 10
    const averagePh =
      recordCount === 0
        ? 0
        : Math.round((leafStore.leaves.reduce((sum, leaf) => sum + leaf.phValue, 0) / recordCount) * 100) / 100
    const orderCount = repairStore.orders.length
    const orderDoneCount = repairStore.orders.filter((order) => order.state === 'done').length
    return {
      recordCount,
      totalAreaCm2,
      averagePh,
      orderCount,
      orderDoneCount,
      orderPercent: orderCount === 0 ? 0 : Math.round((orderDoneCount / orderCount) * 100)
    }
  })

  /** 破损类型分布文案，供统计徽标展示 */
  const describeDamage = (count: Record<DamageType, number>): string =>
    (Object.keys(count) as DamageType[])
      .filter((key) => count[key] > 0)
      .map((key) => `${DAMAGE_TYPE_LABEL[key]}${count[key]}`)
      .join(' / ') || '无'

  return { statsMap, list, statOf, totals, describeDamage }
}

export default useLeafStats

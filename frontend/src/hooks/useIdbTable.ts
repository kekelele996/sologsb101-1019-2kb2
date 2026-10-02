/**
 * useIdbTable：Dexie 单表增删改查 + liveQuery 响应式订阅封装
 * 被全部页面消费；页面不直接触碰 Dexie 实例。
 *
 * 可选 revisionScope：传入后写操作走修订号乐观锁（withVolumeRevision），
 * 保存时报告看到的版本，版本不一致则返回冲突信息，不覆盖对方结果。
 */
import { liveQuery } from 'dexie'
import type { Table } from 'dexie'
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import { createId, db } from '@/utils/db'
import { withVolumeRevision, type ChangeAction, type RevisionResult } from '@/utils/revision'

export type IdbRecord = { id: string; createdAt?: number; updatedAt?: number }

/** 修订号乐观锁作用域：告诉 hook 如何从记录找到所属册次、如何生成条目描述 */
export interface RevisionScope<T> {
  /** 从记录中提取册次 id；返回 null 表示该记录暂不关联册次（跳过乐观锁） */
  getVolumeId: (record: T) => string | null
  /** 生成变更日志的条目描述 */
  getLabel: (record: T, action: ChangeAction) => string
}

export interface UseIdbTableOptions<T extends IdbRecord> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean
  /** 是否在创建 hook 时立即订阅，默认 true */
  immediate?: boolean
  /** 数据变化后的额外回调 */
  onChange?: (rows: T[]) => void
  /** 修订号乐观锁作用域：传入后写操作做 compare-and-swap */
  revisionScope?: RevisionScope<T>
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: Ref<T[]>
  loading: Ref<boolean>
  /** 是否完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  stop: () => void
  getById: (id: string) => Promise<T | undefined>
  list: () => Promise<T[]>
  create: (payload: NewRecord<T>, idPrefix?: string, baseRevision?: number) => Promise<RevisionResult<T>>
  update: (id: string, patch: Partial<T>, baseRevision?: number) => Promise<RevisionResult<void>>
  upsert: (row: T, baseRevision?: number) => Promise<RevisionResult<void>>
  remove: (id: string, baseRevision?: number) => Promise<RevisionResult<void>>
  bulkRemove: (ids: string[]) => Promise<void>
  bulkPut: (list: T[]) => Promise<void>
  clear: () => Promise<void>
}

export type NewRecord<T extends IdbRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
  createdAt?: number
  updatedAt?: number
}

export function useIdbTable<T extends IdbRecord>(
  tableSelector: (database: typeof db) => Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, immediate = true, onChange, revisionScope } = options
  const table = tableSelector(db)

  const rows = ref([]) as Ref<T[]>
  const loading = ref(false)
  const ready = ref(false)
  const error = ref<string | null>(null)
  const subscription = shallowRef<{ unsubscribe: () => void } | null>(null)

  const applySort = (list: T[]): T[] => {
    if (!sortByUpdatedAt) return [...list]
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  const refresh = async (): Promise<void> => {
    loading.value = true
    try {
      rows.value = applySort(await table.toArray())
      error.value = null
      ready.value = true
      onChange?.(rows.value)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地数据失败'
    } finally {
      loading.value = false
    }
  }

  const stop = (): void => {
    subscription.value?.unsubscribe()
    subscription.value = null
  }

  /** 从记录中解析册次 id；revisionScope 未配置或记录不关联册次时返回 null */
  const resolveVolumeId = (record: T): string | null => {
    if (!revisionScope) return null
    return revisionScope.getVolumeId(record)
  }

  const create = async (payload: NewRecord<T>, idPrefix = 'row', baseRevision?: number): Promise<RevisionResult<T>> => {
    const now = Date.now()
    const record = {
      ...(payload as object),
      id: payload.id ?? createId(idPrefix),
      createdAt: payload.createdAt ?? now,
      updatedAt: payload.updatedAt ?? now
    } as T
    const volumeId = resolveVolumeId(record)
    if (revisionScope && volumeId && baseRevision !== undefined) {
      const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
        await tx.table(table.name).put(record)
        return {
          data: record,
          changes: [
            {
              action: 'create' as const,
              table: table.name as 'leaves' | 'papers' | 'repairOrders' | 'bindings',
              recordId: record.id,
              label: revisionScope.getLabel(record, 'create')
            }
          ]
        }
      })
      return result
    }
    await table.put(record)
    return { ok: true, revision: baseRevision ?? 0, data: record }
  }

  const update = async (id: string, patch: Partial<T>, baseRevision?: number): Promise<RevisionResult<void>> => {
    const existing = await table.get(id)
    const volumeId = existing ? resolveVolumeId(existing) : null
    if (revisionScope && volumeId && baseRevision !== undefined && existing) {
      const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
        await tx.table(table.name).update(id, { ...patch, updatedAt: Date.now() })
        const updated = await tx.table(table.name).get(id)
        return {
          data: undefined,
          changes: [
            {
              action: 'update' as const,
              table: table.name as 'leaves' | 'papers' | 'repairOrders' | 'bindings',
              recordId: id,
              label: revisionScope.getLabel(updated ?? existing, 'update')
            }
          ]
        }
      })
      return result
    }
    await table.update(id, { ...patch, updatedAt: Date.now() } as never)
    return { ok: true, revision: baseRevision ?? 0, data: undefined }
  }

  const upsert = async (row: T, baseRevision?: number): Promise<RevisionResult<void>> => {
    const volumeId = resolveVolumeId(row)
    if (revisionScope && volumeId && baseRevision !== undefined) {
      const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
        await tx.table(table.name).put({ ...row, updatedAt: Date.now() })
        return {
          data: undefined,
          changes: [
            {
              action: 'update' as const,
              table: table.name as 'leaves' | 'papers' | 'repairOrders' | 'bindings',
              recordId: row.id,
              label: revisionScope.getLabel(row, 'update')
            }
          ]
        }
      })
      return result
    }
    await table.put({ ...row, updatedAt: Date.now() } as T)
    return { ok: true, revision: baseRevision ?? 0, data: undefined }
  }

  const remove = async (id: string, baseRevision?: number): Promise<RevisionResult<void>> => {
    const existing = await table.get(id)
    const volumeId = existing ? resolveVolumeId(existing) : null
    if (revisionScope && volumeId && baseRevision !== undefined && existing) {
      const result = await withVolumeRevision(volumeId, baseRevision, async (tx) => {
        await tx.table(table.name).delete(id)
        return {
          data: undefined,
          changes: [
            {
              action: 'delete' as const,
              table: table.name as 'leaves' | 'papers' | 'repairOrders' | 'bindings',
              recordId: id,
              label: revisionScope.getLabel(existing, 'delete')
            }
          ]
        }
      })
      return result
    }
    await table.delete(id)
    return { ok: true, revision: baseRevision ?? 0, data: undefined }
  }

  const bulkRemove = async (ids: string[]): Promise<void> => {
    await table.bulkDelete(ids)
  }

  const bulkPut = async (list: T[]): Promise<void> => {
    await table.bulkPut(list)
  }

  const clear = async (): Promise<void> => {
    await table.clear()
  }

  if (immediate) {
    const observable = liveQuery(async () => applySort(await table.toArray()))
    subscription.value = observable.subscribe({
      next: (list) => {
        rows.value = list
        error.value = null
        ready.value = true
        onChange?.(list)
      },
      error: (err: unknown) => {
        error.value = err instanceof Error ? err.message : '订阅本地数据失败'
      }
    })
    void refresh()
  }

  onScopeDispose(stop)

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    stop,
    getById: (id: string) => table.get(id),
    list: () => table.toArray(),
    create,
    update,
    upsert,
    remove,
    bulkRemove,
    bulkPut,
    clear
  }
}

export default useIdbTable

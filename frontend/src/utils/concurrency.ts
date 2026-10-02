/**
 * 按册次做乐观并发控制：
 * - Volume.revision 是整册修订号，书叶、补纸、工序、验收保存都会递增
 * - 保存时必须提交本窗口看到的 expectedRevision，IndexedDB 事务内复核
 * - 修订号不一致时不执行写入，只返回自基线以来已被其他窗口更新的条目
 */
import { createId, db } from '@/utils/db'
import type { Binding, BindingDraft } from '@/types/binding'
import type { Leaf } from '@/types/leaf'
import type { Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import { isVolumeContentEditable, normalizeVolumeRevision, type Volume } from '@/types/volume'

export type VolumeScopeKind = 'volume' | 'leaf' | 'paper' | 'repairOrder' | 'binding'

export interface VolumeScopeRecord {
  kind: VolumeScopeKind
  id: string
  label: string
}

export interface VolumeScopeSnapshot {
  revision: number
  volume?: Readonly<Volume>
  leaves: readonly Leaf[]
  papers: readonly Paper[]
  repairOrders: readonly RepairOrder[]
  bindings: readonly Binding[]
}

export interface ChangedScopeRecord extends VolumeScopeRecord {
  change: 'updated' | 'created' | 'deleted'
}

export interface VolumeSaveOptions {
  /** 本窗口开始编辑时看到的修订号 */
  expectedRevision: number
  /** 验收操作可改变已归档册；普通修复操作不可 */
  acceptance?: boolean
  /** 验收人执行的退回返修操作 */
  inspectorRework?: boolean
}

export interface VolumeSaveSuccess {
  ok: true
  /** 本次保存提交时看到的版本 */
  basedOnRevision: number
  /** 保存成功后的最新版本 */
  revision: number
}

export interface VolumeSaveConflict {
  ok: false
  reason: 'conflict' | 'locked' | 'missing'
  currentRevision: number
  changedRecords: ChangedScopeRecord[]
  message: string
}

export type VolumeSaveResult = VolumeSaveSuccess | VolumeSaveConflict

export const REVISION_NOTE_FIELD = 'revision'

export async function captureVolumeScope(volumeId: string): Promise<VolumeScopeSnapshot | null> {
  const [volume, leaves, papers, allOrders, bindings] = await Promise.all([
    db.volumes.get(volumeId),
    db.leaves.where('volumeId').equals(volumeId).toArray(),
    db.leaves.where('volumeId').equals(volumeId).primaryKeys().then((keys) =>
      keys.length > 0 ? db.papers.where('leafId').anyOf(keys as string[]).toArray() : []
    ),
    db.leaves.where('volumeId').equals(volumeId).primaryKeys().then((keys) =>
      keys.length > 0 ? db.repairOrders.where('leafId').anyOf(keys as string[]).toArray() : []
    ),
    db.bindings.where('volumeId').equals(volumeId).toArray()
  ])
  if (!volume) return null
  return {
    revision: normalizeVolumeRevision(volume),
    volume,
    leaves,
    papers,
    repairOrders: allOrders,
    bindings
  }
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function comparableRecord(record: unknown, omitUpdatedAt = true): string {
  if (!record || typeof record !== 'object') return stableStringify(record)
  const copy: Record<string, unknown> = { ...(record as Record<string, unknown>) }
  if (omitUpdatedAt) delete copy.updatedAt
  return stableStringify(copy)
}

function comparableVolume(volume: Volume): string {
  const { updatedAt: _updatedAt, revision: _revision, ...rest } = volume
  return stableStringify(rest)
}

function findDifference<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  kind: Exclude<VolumeScopeKind, 'volume'>,
  labelOf: (row: T) => string
): ChangedScopeRecord[] {
  const beforeMap = new Map(before.map((row) => [row.id, row]))
  const afterMap = new Map(after.map((row) => [row.id, row]))
  const result: ChangedScopeRecord[] = []

  after.forEach((row) => {
    const old = beforeMap.get(row.id)
    if (!old) {
      result.push({ kind, id: row.id, label: labelOf(row), change: 'created' })
    } else if (comparableRecord(old) !== comparableRecord(row)) {
      result.push({ kind, id: row.id, label: labelOf(row), change: 'updated' })
    }
  })
  before.forEach((row) => {
    if (!afterMap.has(row.id)) result.push({ kind, id: row.id, label: labelOf(row), change: 'deleted' })
  })
  return result
}

export function diffVolumeScope(before: VolumeScopeSnapshot, after: VolumeScopeSnapshot): ChangedScopeRecord[] {
  const changed: ChangedScopeRecord[] = []
  if (before.volume && after.volume && comparableVolume(before.volume) !== comparableVolume(after.volume)) {
    changed.push({ kind: 'volume', id: after.volume.id, label: `第 ${after.volume.volumeNo} 册册次信息`, change: 'updated' })
  }
  changed.push(
    ...findDifference(before.leaves, after.leaves, 'leaf', (row) => `第 ${row.leafNo} 叶破损记录`),
    ...findDifference(before.papers, after.papers, 'paper', (row) => `补纸记录（${row.id}）`),
    ...findDifference(before.repairOrders, after.repairOrders, 'repairOrder', (row) => `第 ${row.seq} 道工序`),
    ...findDifference(before.bindings, after.bindings, 'binding', (row) => `验收记录（${row.method}）`)
  )
  return changed
}

export function conflictMessage(expectedRevision: number, result: VolumeSaveConflict): string {
  if (result.reason === 'missing') return '该册次已被其他窗口删除，本次保存未写入。'
  if (result.reason === 'locked') return '该册已归档；除验收人退回返修外，不能再修改修复内容。'
  const names = result.changedRecords.length > 0
    ? result.changedRecords.map((item) => `· ${changeLabel(item.change)}${item.label}`).join('\n')
    : '· 册次信息已更新'
  return [
    `版本冲突：本次保存基于第 ${expectedRevision} 版，当前已是第 ${result.currentRevision} 版。`,
    '本次保存未覆盖他人结果，以下条目已有更新：',
    names,
    '请刷新查看最新内容后，再决定是否重新编辑。'
  ].join('\n')
}

function changeLabel(change: ChangedScopeRecord['change']): string {
  if (change === 'created') return '新增 '
  if (change === 'deleted') return '删除 '
  return '更新 '
}

function assertWritable(volume: Volume, options: VolumeSaveOptions): boolean {
  if (options.inspectorRework) return true
  if (options.acceptance) return true
  return isVolumeContentEditable(volume.state)
}

/**
 * 在同一事务中复核修订号并执行一次整册写入。
 * writer 内所有子表修改与 volume.revision 递增同时成功或同时回滚。
 */
export async function commitVolumeChange(
  volumeId: string,
  options: VolumeSaveOptions,
  writer: (tx: {
    volume: Volume
    nextRevision: number
    now: number
  }) => Promise<void> | void,
  baseline?: VolumeScopeSnapshot | null
): Promise<VolumeSaveResult> {
  return db.transaction(
    'rw',
    [db.volumes, db.leaves, db.papers, db.repairOrders, db.bindings],
    async () => {
      const volume = await db.volumes.get(volumeId)
      if (!volume) {
        return {
          ok: false,
          reason: 'missing',
          currentRevision: options.expectedRevision,
          changedRecords: [],
          message: conflictMessage(options.expectedRevision, {
            ok: false,
            reason: 'missing',
            currentRevision: options.expectedRevision,
            changedRecords: [],
            message: ''
          })
        } satisfies VolumeSaveConflict
      }

      const currentRevision = normalizeVolumeRevision(volume)
      if (!assertWritable(volume, options)) {
        const result: VolumeSaveConflict = {
          ok: false,
          reason: 'locked',
          currentRevision,
          changedRecords: [],
          message: ''
        }
        result.message = conflictMessage(options.expectedRevision, result)
        return result
      }

      if (currentRevision !== options.expectedRevision) {
        const currentScope: VolumeScopeSnapshot = {
          revision: currentRevision,
          volume,
          leaves: await db.leaves.where('volumeId').equals(volumeId).toArray(),
          papers: [],
          repairOrders: [],
          bindings: await db.bindings.where('volumeId').equals(volumeId).toArray()
        }
        const leafIds = currentScope.leaves.map((leaf) => leaf.id)
        if (leafIds.length > 0) {
          const [papers, repairOrders] = await Promise.all([
            db.papers.where('leafId').anyOf(leafIds).toArray(),
            db.repairOrders.where('leafId').anyOf(leafIds).toArray()
          ])
          currentScope.papers = papers
          currentScope.repairOrders = repairOrders
        }
        const changedRecords = baseline ? diffVolumeScope(baseline, currentScope) : []
        const result: VolumeSaveConflict = {
          ok: false,
          reason: 'conflict',
          currentRevision,
          changedRecords,
          message: ''
        }
        result.message = conflictMessage(options.expectedRevision, result)
        return result
      }

      const now = Date.now()
      const nextRevision = currentRevision + 1
      await writer({ volume, nextRevision, now })
      await db.volumes.update(volumeId, { revision: nextRevision, updatedAt: now } as never)
      return { ok: true, basedOnRevision: currentRevision, revision: nextRevision } satisfies VolumeSaveSuccess
    }
  )
}

export async function saveAcceptanceBinding(
  bindingId: string | null,
  draft: BindingDraft,
  expectedRevision: number,
  baseline?: VolumeScopeSnapshot | null
): Promise<VolumeSaveResult> {
  return commitVolumeChange(
    draft.volumeId,
    { expectedRevision, acceptance: draft.verdict === 'pass', inspectorRework: draft.verdict === 'rework' },
    async ({ now, volume }) => {
      const existing = bindingId ? await db.bindings.get(bindingId) : null
      const changingArchived = volume.state === 'archived'
      if (changingArchived) {
        if (draft.verdict !== 'rework' || !draft.inspector.trim()) {
          throw new Error('已归档册只能由验收人登记返修退回')
        }
        if (!existing) throw new Error('已归档册不能新增验收记录')
      }
      if (existing) {
        if (existing.volumeId !== draft.volumeId) throw new Error('不能改变验收记录所属册次')
        await db.bindings.put({ ...existing, ...draft, id: bindingId as string, createdAt: existing.createdAt, updatedAt: now })
      } else {
        await db.bindings.put({ ...draft, id: createId('bind'), createdAt: now, updatedAt: now })
      }
      await db.volumes.update(draft.volumeId, {
        state: draft.verdict === 'pass' ? 'archived' : 'repairing',
        updatedAt: now
      } as never)
    },
    baseline
  )
}

/** 已归档册只开放这一条修改路径：验收人登记返修结论并退回修复中 */
export async function returnArchivedVolumeForRework(
  bindingId: string,
  inspector: string,
  expectedRevision: number,
  baseline?: VolumeScopeSnapshot | null
): Promise<VolumeSaveResult> {
  const binding = await db.bindings.get(bindingId)
  if (!binding) throw new Error('未找到验收记录')
  const now = Date.now()
  const draft: BindingDraft = {
    ...binding,
    verdict: 'rework',
    inspector,
    finishDate: new Date(now).toISOString().slice(0, 10)
  }
  return saveAcceptanceBinding(bindingId, draft, expectedRevision, baseline)
}

export async function removeAcceptanceBinding(
  bindingId: string,
  expectedRevision: number,
  baseline?: VolumeScopeSnapshot | null
): Promise<VolumeSaveResult> {
  const binding = await db.bindings.get(bindingId)
  if (!binding) throw new Error('未找到验收记录')
  return commitVolumeChange(
    binding.volumeId,
    { expectedRevision, acceptance: true },
    async ({ volume }) => {
      if (volume.state === 'archived') throw new Error('已归档册的验收记录不能删除')
      await db.bindings.delete(bindingId)
    },
    baseline
  )
}

/** 从册次对象读取修订号，兼容旧备份 / 旧 IndexedDB 数据 */
export function revisionOf(volume: Pick<Volume, 'state' | 'revision'> | null | undefined): number {
  return volume ? normalizeVolumeRevision(volume) : 0
}

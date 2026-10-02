/**
 * 修订号乐观锁（Optimistic Concurrency Control）
 *
 * 修复室常开两个窗口并发做同一部书：一个窗口登记书叶破损和补纸，
 * 另一个窗口排修复工序。后保存的窗口若直接整段写入，会盖掉对方刚填的内容。
 *
 * 为此给每册（Volume）带上修订号：保存时报告自己看到的版本，
 * 若期间已被其他窗口改过（修订号不一致），则只报告对方改了哪几条，
 * 不覆盖对方结果，由用户在最新数据上重新应用。
 *
 * 变更日志（VolumeChange）按册记录每次改动，供冲突时回放「哪几条已被更新」。
 */
import { createId, db } from '@/utils/db'
import type { Volume } from '@/types/volume'
import type { Transaction } from 'dexie'
import { ElMessageBox } from 'element-plus'

/** 变更动作 */
export type ChangeAction = 'create' | 'update' | 'delete'

/** 变更日志：记录某册在某修订号下发生的一条改动 */
export interface VolumeChange {
  id: string
  /** 所属册次 id */
  volumeId: string
  /** 改动后的修订号 */
  revision: number
  /** 改动时间戳 */
  timestamp: number
  /** 动作 */
  action: ChangeAction
  /** 被改记录所在表 */
  table: 'volumes' | 'leaves' | 'papers' | 'repairOrders' | 'bindings'
  /** 被改记录 id */
  recordId: string
  /** 人类可读的条目描述，如「第 3 叶破损记录」「第 2 道工序」 */
  label: string
}

/** 冲突信息：对方已把修订号从 baseRevision 推进到 currentRevision */
export interface ConflictInfo {
  /** 保存方看到的修订号 */
  baseRevision: number
  /** 当前库里的修订号 */
  currentRevision: number
  /** 对方在 (baseRevision, currentRevision] 区间内做的改动 */
  changes: VolumeChange[]
}

/** 乐观锁写操作的返回结果 */
export type RevisionResult<T> =
  | { ok: true; revision: number; data: T }
  | { ok: false; conflict: ConflictInfo }

/** 单条变更描述，由 operation 在事务内生成 */
export interface ChangeEntry {
  action: ChangeAction
  table: VolumeChange['table']
  recordId: string
  label: string
}

/** 每册保留的变更日志条数上限，超出后清理最旧的 */
const MAX_CHANGES_PER_VOLUME = 60

/**
 * 带修订号乐观锁的事务写操作。
 *
 * 流程：
 * 1. 在事务中读取册次当前修订号；
 * 2. 若与 baseRevision 不一致 → 读取区间内变更日志，返回冲突信息，不执行 operation；
 * 3. 若一致 → 执行 operation，记录变更日志，修订号 +1。
 *
 * @param volumeId     册次 id
 * @param baseRevision 保存方看到的修订号（打开编辑表单时捕获）
 * @param operation    实际写操作，在事务内执行，返回数据与变更条目
 */
export async function withVolumeRevision<T>(
  volumeId: string,
  baseRevision: number,
  operation: (tx: Transaction) => Promise<{ data: T; changes: ChangeEntry[] }>
): Promise<RevisionResult<T>> {
  return db.transaction(
    'rw',
    [db.volumes, db.volumeChanges, db.leaves, db.papers, db.repairOrders, db.bindings],
    async (tx) => {
      const volumesTable = tx.table<Volume>('volumes')
      const changesTable = tx.table<VolumeChange>('volumeChanges')
      const volume = await volumesTable.get(volumeId)
      if (!volume) throw new Error('册次不存在或已被删除')
      if (volume.revision !== baseRevision) {
        const changes = await changesTable
          .where('volumeId')
          .equals(volumeId)
          .and((c) => c.revision > baseRevision)
          .toArray()
        return {
          ok: false,
          conflict: { baseRevision, currentRevision: volume.revision, changes }
        }
      }
      const { data, changes } = await operation(tx)
      const newRevision = volume.revision + 1
      const now = Date.now()
      if (changes.length > 0) {
        await changesTable.bulkPut(
          changes.map((c, i) => ({
            id: createId('chg'),
            volumeId,
            revision: newRevision,
            timestamp: now + i,
            ...c
          }))
        )
        // 清理超出上限的旧日志
        const count = await changesTable.where('volumeId').equals(volumeId).count()
        if (count > MAX_CHANGES_PER_VOLUME) {
          const stale = await changesTable
            .where('volumeId')
            .equals(volumeId)
            .sortBy('timestamp')
            .then((rows) => rows.slice(0, rows.length - MAX_CHANGES_PER_VOLUME))
          if (stale.length > 0) await changesTable.bulkDelete(stale.map((c) => c.id))
        }
      }
      await volumesTable.update(volumeId, { revision: newRevision, updatedAt: now })
      return { ok: true, revision: newRevision, data }
    }
  )
}

/** 动作对应的中文文案，供冲突提示使用 */
export const CHANGE_ACTION_LABEL: Record<ChangeAction, string> = {
  create: '新增',
  update: '修改',
  delete: '删除'
}

/**
 * 把冲突信息格式化为用户可读的提示文案。
 * 列出对方改了哪几条，避免盖掉对方结果。
 */
export function formatConflictMessage(conflict: ConflictInfo): string {
  const lines = conflict.changes.map((c) => `· ${c.label}（${CHANGE_ACTION_LABEL[c.action]}）`)
  const detail = lines.length > 0 ? `\n\n对方已更新：\n${lines.join('\n')}` : ''
  return `该册已被其他窗口更新（修订号 ${conflict.baseRevision} → ${conflict.currentRevision}）。\n为避免覆盖对方刚填的内容，本次保存已取消。${detail}\n\n请刷新后在最新数据上重新修改。`
}

/**
 * 弹出冲突提示框，并在用户确认后刷新页面数据。
 * 返回 true 表示发生了冲突。
 */
export async function reportConflict(conflict: ConflictInfo): Promise<boolean> {
  try {
    await ElMessageBox.alert(formatConflictMessage(conflict), '保存冲突', {
      type: 'warning',
      confirmButtonText: '知道了',
      customClass: 'gb-conflict-box'
    })
  } catch {
    /* 用户关闭提示框 */
  }
  return true
}

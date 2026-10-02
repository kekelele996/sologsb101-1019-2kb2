/**
 * 导出工具：整库 JSON 存档、修复验收清单、书叶破损台账 CSV
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { Book } from '@/types/book'
import type { Volume } from '@/types/volume'
import type { Leaf } from '@/types/leaf'
import type { Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import { BOOK_LEVEL_LABEL } from '@/types/book'
import { BINDING_TYPE_LABEL, VOLUME_STATE_LABEL } from '@/types/volume'
import { DAMAGE_TYPE_LABEL, LEAF_STATE_LABEL } from '@/types/leaf'
import { PAPER_TYPE_LABEL, deltaELevel } from '@/types/paper'
import { REPAIR_NAME_LABEL } from '@/types/repairOrder'
import { BINDING_VERDICT_LABEL } from '@/types/binding'
import type { RestoreSnapshot } from './db'

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 时间戳文件名片段 */
export function stampSuffix(): string {
  const date = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 导出整库 JSON，返回文件名 */
export function exportSnapshotJson(snapshot: RestoreSnapshot): string {
  const filename = `gbbookrestore-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8')
  return filename
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface ExportContext {
  books: Book[]
  volumes: Volume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
}

/** 验收归档清单文本：按古籍 → 册次 → 书叶 → 工序展开 */
export function buildArchiveReport(context: ExportContext): string {
  const lines: string[] = ['古籍修复验收归档清单', `生成时间：${new Date().toLocaleString('zh-CN')}`, '']
  if (context.books.length === 0) {
    lines.push('当前没有古籍档案。')
    return lines.join('\n')
  }
  context.books.forEach((book, bookIndex) => {
    lines.push(`${bookIndex + 1}. 《${book.title}》　${book.edition}　${book.era}　${BOOK_LEVEL_LABEL[book.level]}　收藏号 ${book.collectionNo || '未编'}`)
    const volumes = context.volumes.filter((volume) => volume.bookId === book.id)
    if (volumes.length === 0) lines.push('   （暂无册次）')
    volumes.forEach((volume) => {
      const leaves = context.leaves.filter((leaf) => leaf.volumeId === volume.id)
      const binding = context.bindings.find((item) => item.volumeId === volume.id)
      const totalArea = Math.round(leaves.reduce((sum, leaf) => sum + leaf.damageAreaCm2, 0) * 10) / 10
      const averagePh =
        leaves.length === 0 ? 0 : Math.round((leaves.reduce((sum, leaf) => sum + leaf.phValue, 0) / leaves.length) * 100) / 100
      lines.push(
        `   第 ${volume.volumeNo} 册　${BINDING_TYPE_LABEL[volume.bindingType]}　${VOLUME_STATE_LABEL[volume.state]}　叶数 ${volume.leafCount}　破损 ${totalArea} cm²　平均 pH ${averagePh}`
      )
      lines.push(
        `      装订验收：${
          binding
            ? `${binding.method}　${binding.finishDate}　${BINDING_VERDICT_LABEL[binding.verdict]}　验收人 ${binding.inspector || '未填写'}`
            : '尚未装订'
        }`
      )
      leaves.forEach((leaf) => {
        const orders = context.repairOrders.filter((order) => order.leafId === leaf.id)
        const done = orders.filter((order) => order.state === 'done').length
        lines.push(
          `      · 第 ${leaf.leafNo} 叶　${DAMAGE_TYPE_LABEL[leaf.damageType]}　${leaf.damageAreaCm2} cm²　pH ${leaf.phValue}　${LEAF_STATE_LABEL[leaf.state]}　工序 ${done}/${orders.length}`
        )
      })
    })
    lines.push('')
  })
  return lines.join('\n')
}

/** 导出验收归档清单为文本 */
export function exportArchiveReport(context: ExportContext): string {
  const filename = `古籍修复归档清单-${stampSuffix()}.txt`
  download(filename, buildArchiveReport(context), 'text/plain;charset=utf-8')
  return filename
}

/** 书叶破损台账 CSV（含补纸与工序进度） */
export function exportLeafLedgerCsv(context: ExportContext): string {
  const header = [
    '书名',
    '册次',
    '叶号',
    '破损类型',
    '面积(cm²)',
    'pH',
    '书叶状态',
    '补纸纸种',
    '帘纹',
    '厚度(mm)',
    '色差ΔE',
    'ΔE判定',
    '染色配方',
    '工序进度',
    '最近工序',
    '操作人'
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  context.books.forEach((book) => {
    const volumes = context.volumes.filter((volume) => volume.bookId === book.id)
    volumes.forEach((volume) => {
      const leaves = context.leaves
        .filter((leaf) => leaf.volumeId === volume.id)
        .sort((a, b) => a.leafNo - b.leafNo)
      leaves.forEach((leaf) => {
        const paper = context.papers.find((item) => item.leafId === leaf.id)
        const orders = context.repairOrders
          .filter((order) => order.leafId === leaf.id)
          .sort((a, b) => a.seq - b.seq)
        const done = orders.filter((order) => order.state === 'done').length
        const last = orders[orders.length - 1]
        lines.push(
          [
            book.title,
            `第 ${volume.volumeNo} 册`,
            leaf.leafNo,
            DAMAGE_TYPE_LABEL[leaf.damageType],
            leaf.damageAreaCm2,
            leaf.phValue,
            LEAF_STATE_LABEL[leaf.state],
            paper ? PAPER_TYPE_LABEL[paper.paperType] : '未选配',
            paper ? paper.laidPattern : '',
            paper ? paper.thicknessMm : '',
            paper ? paper.deltaE : '',
            paper ? deltaELevel(paper.deltaE).label : '',
            paper ? paper.dyeRecipe : '',
            `${done}/${orders.length}`,
            last ? REPAIR_NAME_LABEL[last.name] : '',
            last ? last.operator : ''
          ]
            .map(csvCell)
            .join(',')
        )
      })
    })
  })
  const filename = `古籍书叶破损台账-${stampSuffix()}.csv`
  download(filename, `\uFEFF${lines.join('\n')}`, 'text/csv;charset=utf-8')
  return filename
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

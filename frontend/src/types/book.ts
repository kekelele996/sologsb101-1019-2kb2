/**
 * 古籍（Book）数据模型
 * 一部古籍的版本信息、册数与保护级别。
 */

/** 保护级别：一级 / 二级 / 三级 / 普通 */
export type BookLevel = 'first' | 'second' | 'third' | 'normal';

export interface Book {
  /** 主键，播种数据使用固定字符串便于深链命中 */
  id: string;
  /** 书名 */
  title: string;
  /** 版本，如「明万历刻本」 */
  edition: string;
  /** 年代 */
  era: string;
  /** 册数 */
  volumeCount: number;
  /** 收藏号 */
  collectionNo: string;
  /** 保护级别 */
  level: BookLevel;
  createdAt: number;
  updatedAt: number;
}

export type BookDraft = Omit<Book, 'id' | 'createdAt' | 'updatedAt'>;

export const BOOK_LEVEL_LABEL: Record<BookLevel, string> = {
  first: '一级',
  second: '二级',
  third: '三级',
  normal: '普通',
};

export const BOOK_LEVEL_COLOR: Record<BookLevel, string> = {
  first: '#b03a2e',
  second: '#a8623a',
  third: '#3a6ea5',
  normal: '#6b6257',
};

export const BOOK_LEVEL_OPTIONS: ReadonlyArray<{ value: BookLevel; label: string }> = [
  { value: 'first', label: '一级' },
  { value: 'second', label: '二级' },
  { value: 'third', label: '三级' },
  { value: 'normal', label: '普通' },
];

/** 古籍维度的汇总统计，卡片回显使用 */
export interface BookStat {
  bookId: string;
  /** 册数（实际登记） */
  volumeCount: number;
  /** 总叶数 */
  leafCount: number;
  /** 待修叶数 */
  pendingLeafCount: number;
  /** 已完成工序数 */
  doneOrderCount: number;
  /** 工序总数 */
  orderCount: number;
  /** 破损总面积 cm² */
  damageAreaCm2: number;
  /** 平均 pH */
  averagePh: number;
}

export function createEmptyBookDraft(): BookDraft {
  return {
    title: '',
    edition: '',
    era: '',
    volumeCount: 1,
    collectionNo: '',
    level: 'normal',
  };
}

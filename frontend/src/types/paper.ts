/**
 * 补纸（Paper）数据模型
 * 为书叶选配的补纸：纸种、帘纹、厚度、色差 ΔE 与染色配方。
 */

/** 纸种：竹纸 / 皮纸 / 宣纸 */
export type PaperType = 'bamboo' | 'bark' | 'xuan';

export interface Paper {
  id: string;
  /** 关联书叶 id */
  leafId: string;
  /** 纸种 */
  paperType: PaperType;
  /** 帘纹，如「二指帘纹」 */
  laidPattern: string;
  /** 厚度 mm */
  thicknessMm: number;
  /** 与原叶的色差 ΔE */
  deltaE: number;
  /** 染色配方（v2 迁移时按纸种回填默认值） */
  dyeRecipe: string;
  createdAt: number;
  updatedAt: number;
}

export type PaperDraft = Omit<Paper, 'id' | 'createdAt' | 'updatedAt'>;

export const PAPER_TYPE_LABEL: Record<PaperType, string> = {
  bamboo: '竹纸',
  bark: '皮纸',
  xuan: '宣纸',
};

export const PAPER_TYPE_OPTIONS: ReadonlyArray<{ value: PaperType; label: string }> = [
  { value: 'bamboo', label: '竹纸' },
  { value: 'bark', label: '皮纸' },
  { value: 'xuan', label: '宣纸' },
];

/** 各纸种的默认染色配方，db v1→v2 迁移按纸种回填 */
export const DEFAULT_DYE_RECIPE: Record<PaperType, string> = {
  bamboo: '橡碗子 12g/L + 少量墨汁调灰，水温 60℃ 浸染 8 分钟',
  bark: '黄檗 8g/L + 栀子 3g/L，水温 70℃ 浸染 6 分钟',
  xuan: '藤黄 5g/L + 赭石 2g/L，常温浸染 10 分钟',
};

export const LAID_PATTERN_OPTIONS: readonly string[] = [
  '二指帘纹',
  '三指帘纹',
  '细帘纹',
  '无帘纹',
];

/** ΔE 阈值：超过需重新染色 */
export const DELTA_E_THRESHOLD = 2.5;

export function deltaELevel(deltaE: number): { label: string; color: string } {
  if (deltaE <= 1) return { label: '几乎一致', color: '#1e8449' };
  if (deltaE <= DELTA_E_THRESHOLD) return { label: '可接受', color: '#3a6ea5' };
  if (deltaE <= 5) return { label: '需重新染色', color: '#d68910' };
  return { label: '色差过大', color: '#b03a2e' };
}

export function createEmptyPaperDraft(leafId: string): PaperDraft {
  return {
    leafId,
    paperType: 'bamboo',
    laidPattern: '二指帘纹',
    thicknessMm: 0.06,
    deltaE: 1.5,
    dyeRecipe: DEFAULT_DYE_RECIPE.bamboo,
  };
}

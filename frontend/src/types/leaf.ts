/**
 * 书叶（Leaf）数据模型
 * 逐叶登记的破损状况；同一叶号可登记多条破损记录（叠加多种破损）。
 */

/** 破损类型：虫蛀 / 酸化 / 絮化 / 缺肉 / 水渍 */
export type DamageType = 'worm' | 'acid' | 'fibrin' | 'loss' | 'stain';

/** 书叶状态：待修 / 修复中 / 已修复 */
export type LeafState = 'pending' | 'repairing' | 'repaired';

export interface Leaf {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 叶号，从 1 开始 */
  leafNo: number;
  /** 破损类型 */
  damageType: DamageType;
  /** 破损面积 cm² */
  damageAreaCm2: number;
  /** 酸化 pH 值 */
  phValue: number;
  /** 当前状态 */
  state: LeafState;
  createdAt: number;
  updatedAt: number;
}

export type LeafDraft = Omit<Leaf, 'id' | 'createdAt' | 'updatedAt'>;

export const DAMAGE_TYPE_LABEL: Record<DamageType, string> = {
  worm: '虫蛀',
  acid: '酸化',
  fibrin: '絮化',
  loss: '缺肉',
  stain: '水渍',
};

export const DAMAGE_TYPE_COLOR: Record<DamageType, string> = {
  worm: '#8a6d3b',
  acid: '#b03a2e',
  fibrin: '#7d6ba8',
  loss: '#1e8449',
  stain: '#3a6ea5',
};

/** 图标名，供 DamageTag 渲染 Element Plus 图标 */
export const DAMAGE_TYPE_ICON: Record<DamageType, string> = {
  worm: 'Sunny',
  acid: 'WarningFilled',
  fibrin: 'Cloudy',
  loss: 'Scissor',
  stain: 'Moon',
};

export const DAMAGE_TYPE_OPTIONS: ReadonlyArray<{ value: DamageType; label: string }> = [
  { value: 'worm', label: '虫蛀' },
  { value: 'acid', label: '酸化' },
  { value: 'fibrin', label: '絮化' },
  { value: 'loss', label: '缺肉' },
  { value: 'stain', label: '水渍' },
];

export const LEAF_STATE_LABEL: Record<LeafState, string> = {
  pending: '待修',
  repairing: '修复中',
  repaired: '已修复',
};

export const LEAF_STATE_COLOR: Record<LeafState, string> = {
  pending: '#8c8c8c',
  repairing: '#d68910',
  repaired: '#1e8449',
};

export const LEAF_STATE_OPTIONS: ReadonlyArray<{ value: LeafState; label: string }> = [
  { value: 'pending', label: '待修' },
  { value: 'repairing', label: '修复中' },
  { value: 'repaired', label: '已修复' },
];

export const LEAF_STATE_FLOW: readonly LeafState[] = ['pending', 'repairing', 'repaired'];

export function nextLeafState(state: LeafState): LeafState {
  const index = LEAF_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= LEAF_STATE_FLOW.length - 1) return state;
  return LEAF_STATE_FLOW[index + 1] as LeafState;
}

/** pH 判定：低于 6.5 视为酸化，需要脱酸处理 */
export function phLevel(ph: number): { label: string; color: string } {
  if (ph < 5) return { label: '重度酸化', color: '#b03a2e' };
  if (ph < 6.5) return { label: '轻度酸化', color: '#d68910' };
  if (ph > 8.5) return { label: '偏碱', color: '#3a6ea5' };
  return { label: '中性', color: '#1e8449' };
}

export function createEmptyLeafDraft(volumeId: string, leafNo: number): LeafDraft {
  return {
    volumeId,
    leafNo,
    damageType: 'worm',
    damageAreaCm2: 4,
    phValue: 6.8,
    state: 'pending',
  };
}

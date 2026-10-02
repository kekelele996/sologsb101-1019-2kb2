/**
 * 册次（Volume）数据模型
 * 一部古籍下的册，是书叶与装订记录的挂载单元。
 */

/** 装订形式：线装 / 蝴蝶装 / 包背装 */
export type BindingType = 'thread' | 'butterfly' | 'wrapped';

/** 册次状态：待修复 / 修复中 / 已装订 / 已归档 */
export type VolumeState = 'pending' | 'repairing' | 'bound' | 'archived';

export interface Volume {
  id: string;
  /** 所属古籍 id */
  bookId: string;
  /** 册次号，从 1 开始 */
  volumeNo: number;
  /** 叶数 */
  leafCount: number;
  /** 装订形式 */
  bindingType: BindingType;
  /** 当前状态 */
  state: VolumeState;
  createdAt: number;
  updatedAt: number;
}

export type VolumeDraft = Omit<Volume, 'id' | 'createdAt' | 'updatedAt'>;

export const BINDING_TYPE_LABEL: Record<BindingType, string> = {
  thread: '线装',
  butterfly: '蝴蝶装',
  wrapped: '包背装',
};

export const BINDING_TYPE_OPTIONS: ReadonlyArray<{ value: BindingType; label: string }> = [
  { value: 'thread', label: '线装' },
  { value: 'butterfly', label: '蝴蝶装' },
  { value: 'wrapped', label: '包背装' },
];

export const VOLUME_STATE_LABEL: Record<VolumeState, string> = {
  pending: '待修复',
  repairing: '修复中',
  bound: '已装订',
  archived: '已归档',
};

export const VOLUME_STATE_COLOR: Record<VolumeState, string> = {
  pending: '#8c8c8c',
  repairing: '#d68910',
  bound: '#3a6ea5',
  archived: '#1e8449',
};

export const VOLUME_STATE_OPTIONS: ReadonlyArray<{ value: VolumeState; label: string }> = [
  { value: 'pending', label: '待修复' },
  { value: 'repairing', label: '修复中' },
  { value: 'bound', label: '已装订' },
  { value: 'archived', label: '已归档' },
];

/** 装订完成后整册锁定为只读 */
export function isVolumeLocked(state: VolumeState): boolean {
  return state === 'bound' || state === 'archived';
}

export const VOLUME_STATE_FLOW: readonly VolumeState[] = ['pending', 'repairing', 'bound', 'archived'];

export function nextVolumeState(state: VolumeState): VolumeState {
  const index = VOLUME_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= VOLUME_STATE_FLOW.length - 1) return state;
  return VOLUME_STATE_FLOW[index + 1] as VolumeState;
}

export function createEmptyVolumeDraft(bookId: string, volumeNo: number): VolumeDraft {
  return {
    bookId,
    volumeNo,
    leafCount: 0,
    bindingType: 'thread',
    state: 'pending',
  };
}

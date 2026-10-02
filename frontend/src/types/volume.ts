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
  /** 乐观修订号：册次内任一处保存成功后递增 */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type VolumeDraft = Omit<Volume, 'id' | 'createdAt' | 'updatedAt' | 'revision'>;

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

/** 已装订后内容锁定；已归档仅允许验收人退回返修 */
export function isVolumeLocked(state: VolumeState): boolean {
  return state === 'bound' || state === 'archived';
}

/** 修复内容（书叶、补纸、工序）是否可编辑 */
export function isVolumeContentEditable(state: VolumeState): boolean {
  return state === 'pending' || state === 'repairing';
}

/** 为旧数据补齐修订号：已归档以 1 作为稳定基线，其余从 0 开始 */
export function initialVolumeRevision(state: VolumeState): number {
  return state === 'archived' ? 1 : 0;
}

export function normalizeVolumeRevision(volume: Pick<Volume, 'state' | 'revision'>): number {
  return Number.isInteger(volume.revision) && volume.revision >= 0
    ? volume.revision
    : initialVolumeRevision(volume.state);
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

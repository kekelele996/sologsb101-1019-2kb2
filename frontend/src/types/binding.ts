/**
 * 装订（Binding）数据模型
 * 装订还原记录与验收结论；验收合格触发整册归档。
 */

/** 验收结论：合格 / 返修 */
export type BindingVerdict = 'pass' | 'rework';

export interface Binding {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 装订方式 */
  method: string;
  /** 完工日期 yyyy-MM-dd */
  finishDate: string;
  /** 验收结论 */
  verdict: BindingVerdict;
  /** 验收人 */
  inspector: string;
  createdAt: number;
  updatedAt: number;
}

export type BindingDraft = Omit<Binding, 'id' | 'createdAt' | 'updatedAt'>;

export const BINDING_VERDICT_LABEL: Record<BindingVerdict, string> = {
  pass: '合格',
  rework: '返修',
};

export const BINDING_VERDICT_COLOR: Record<BindingVerdict, string> = {
  pass: '#1e8449',
  rework: '#b03a2e',
};

export const BINDING_VERDICT_OPTIONS: ReadonlyArray<{ value: BindingVerdict; label: string }> = [
  { value: 'pass', label: '合格' },
  { value: 'rework', label: '返修' },
];

export const BINDING_METHOD_OPTIONS: readonly string[] = [
  '四眼线装',
  '六眼线装',
  '蝴蝶装复原',
  '包背装复原',
  '金镶玉装',
];

export function createEmptyBindingDraft(volumeId: string): BindingDraft {
  return {
    volumeId,
    method: '四眼线装',
    finishDate: new Date().toISOString().slice(0, 10),
    verdict: 'pass',
    inspector: '',
  };
}

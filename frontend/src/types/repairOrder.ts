/**
 * 修复工序（RepairOrder）数据模型
 * 逐叶的修复工序序列：补破、托裱、溜口、裁齐、压平。
 */

/** 工序名：补破 / 托裱 / 溜口 / 裁齐 / 压平 */
export type RepairName = 'mend' | 'mount' | 'corner' | 'trim' | 'press';

/** 工序状态：未开始 / 进行中 / 已完成 */
export type OrderState = 'todo' | 'doing' | 'done';

export interface RepairOrder {
  id: string;
  /** 关联书叶 id */
  leafId: string;
  /** 工序序号，从 1 开始连续整数 */
  seq: number;
  /** 工序名 */
  name: RepairName;
  /** 材料 */
  material: string;
  /** 操作人 */
  operator: string;
  /** 日期 yyyy-MM-dd */
  date: string;
  /** 工序状态 */
  state: OrderState;
  createdAt: number;
  updatedAt: number;
}

export type RepairOrderDraft = Omit<RepairOrder, 'id' | 'createdAt' | 'updatedAt'>;

export const REPAIR_NAME_LABEL: Record<RepairName, string> = {
  mend: '补破',
  mount: '托裱',
  corner: '溜口',
  trim: '裁齐',
  press: '压平',
};

export const REPAIR_NAME_OPTIONS: ReadonlyArray<{ value: RepairName; label: string }> = [
  { value: 'mend', label: '补破' },
  { value: 'mount', label: '托裱' },
  { value: 'corner', label: '溜口' },
  { value: 'trim', label: '裁齐' },
  { value: 'press', label: '压平' },
];

export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
};

export const ORDER_STATE_COLOR: Record<OrderState, string> = {
  todo: '#8c8c8c',
  doing: '#d68910',
  done: '#1e8449',
};

export const ORDER_STATE_OPTIONS: ReadonlyArray<{ value: OrderState; label: string }> = [
  { value: 'todo', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

/** 工序材料建议，表单带出 */
export const REPAIR_MATERIAL_SUGGEST: Record<RepairName, string> = {
  mend: '补纸 0.06mm + 小麦淀粉糊',
  mount: '托纸 + 稀浆糊',
  corner: '溜口纸条 + 稠浆糊',
  trim: '裁板 + 竹起子',
  press: '压书板 + 宣纸吸水层',
};

export function createEmptyOrderDraft(leafId: string, seq: number): RepairOrderDraft {
  return {
    leafId,
    seq,
    name: 'mend',
    material: REPAIR_MATERIAL_SUGGEST.mend,
    operator: '',
    date: new Date().toISOString().slice(0, 10),
    state: 'todo',
  };
}

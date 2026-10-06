/**
 * 厂家保修鉴定回执：琴行把钢琴档案交厂家做保修鉴定后，回传的回执结构与对账差异定义。
 * - 回执按序列号（serialNo）认到本地钢琴；
 * - 鉴定结论与厂家建议更换部件写回钢琴档案，建议部件顺手生成维修计划；
 * - 回执的调律日期 / 维修条目与本地对不上时，两边都保留并生成待确认差异。
 */

/** 厂家建议更换的部件 */
export interface WarrantyPartSuggestion {
  /** 部件名称（毡槌 / 琴弦 / 联动杆 / 呢毡，亦可写厂家原词，无法映射时生成差异待确认） */
  part: string;
  /** 建议的维修类型，可空；为空时按部件推断 */
  type?: string;
  /** 材料与规格 */
  material?: string;
}

/** 回执上登记的维修条目 */
export interface WarrantyWorkItem {
  /** 维修类型（整音 / 换弦 / 击弦机调整 / 踏板调整，亦可写厂家原词） */
  type: string;
  /** 部件 */
  part: string;
  /** 维修日期 YYYY-MM-DD */
  date: string;
  /** 操作人 */
  operator?: string;
  /** 材料与规格 */
  material?: string;
}

/** 单台琴的鉴定回执条目 */
export interface WarrantyReceiptItem {
  /** 序列号（与本地 Piano.serialNo 对账） */
  serialNo: string;
  /** 厂家鉴定结论 */
  conclusion: string;
  /** 回执记载的最近调律日期 YYYY-MM-DD，可空 */
  lastTuningDate?: string;
  /** 厂家建议更换的部件（该换的顺手生成维修计划） */
  suggestedParts?: WarrantyPartSuggestion[];
  /** 回执上登记的维修条目 */
  workItems?: WarrantyWorkItem[];
}

/** 厂家保修鉴定回执文件 */
export interface WarrantyReceipt {
  /** 标识名 */
  name?: string;
  /** 回执编号 */
  receiptNo?: string;
  /** 厂家出具日期 YYYY-MM-DD */
  issuedAt?: string;
  /** 厂家名称 */
  manufacturer?: string;
  items: WarrantyReceiptItem[];
}

/** 差异种类 */
export type WarrantyDiffKind =
  | 'serial-not-found' // 回执序列号在本地查无对应钢琴
  | 'tuning-date-mismatch' // 回执调律日期与本地最近调律日期不一致（两边都保留）
  | 'tuning-date-receipt-only' // 本地无调律记录，回执有调律日期
  | 'work-item-receipt-only' // 维修条目仅回执有、本地没有
  | 'work-item-local-only' // 维修条目仅本地有、回执没有
  | 'work-date-mismatch' // 同一维修条目两边日期不一致
  | 'part-unmappable'; // 建议部件无法映射为本地维修类型，需人工确认

/** 差异确认状态 */
export type WarrantyDiffStatus = '待确认' | '已确认';

export const WARRANTY_DIFF_KINDS: WarrantyDiffKind[] = [
  'serial-not-found',
  'tuning-date-mismatch',
  'tuning-date-receipt-only',
  'work-item-receipt-only',
  'work-item-local-only',
  'work-date-mismatch',
  'part-unmappable'
];

export const WARRANTY_DIFF_STATUSES: WarrantyDiffStatus[] = ['待确认', '已确认'];

/** 差异种类的中文说明 */
export const WARRANTY_DIFF_LABELS: Record<WarrantyDiffKind, string> = {
  'serial-not-found': '序列号本地无对应钢琴',
  'tuning-date-mismatch': '调律日期不一致',
  'tuning-date-receipt-only': '本地缺调律记录',
  'work-item-receipt-only': '维修条目仅回执有',
  'work-item-local-only': '维修条目仅本地有',
  'work-date-mismatch': '维修日期不一致',
  'part-unmappable': '部件无法映射维修类型'
};

/** 一条对账差异（两边都留原值，等人确认） */
export interface WarrantyDiff {
  id: string;
  /** 所属对账批次 */
  batchId: string;
  /** 关联到的本地钢琴（序列号查不到时为空） */
  pianoId: string;
  /** 回执序列号 */
  serialNo: string;
  /** 差异种类 */
  kind: WarrantyDiffKind;
  /** 差异说明 */
  detail: string;
  /** 本地一侧的原始内容（如本地最近调律日期、本地维修条目） */
  localValue: string;
  /** 回执一侧的原始内容（回执调律日期、回执维修条目） */
  receiptValue: string;
  /** 回执维修条目的结构化内容（确认时可顺手生成维修计划） */
  receiptWork?: WarrantyWorkItem;
  /** 状态 */
  status: WarrantyDiffStatus;
  /** 确认时间 */
  confirmedAt?: string;
}

/** 一次回执导入对账的批次记录 */
export interface WarrantyBatch {
  id: string;
  /** 回执编号 */
  receiptNo: string;
  /** 厂家出具日期 */
  issuedAt: string;
  /** 厂家名称 */
  manufacturer: string;
  /** 导入时间 ISO */
  importedAt: string;
  /** 回执条目数 */
  itemCount: number;
  /** 认到本地钢琴的条目数 */
  matchedCount: number;
  /** 更新了档案的钢琴数 */
  updatedPianoCount: number;
  /** 生成的维修计划数 */
  createdPlanCount: number;
  /** 产生的差异数 */
  diffCount: number;
}

/** 由建议部件生成的维修计划（尚未落库） */
export interface PlannedVoicing {
  pianoId: string;
  type: string;
  parts: string;
  material: string;
  date: string;
  operator: string;
}

/** 对账完成后的统计结果 */
export interface WarrantyReconcileSummary {
  batchId: string;
  itemCount: number;
  matchedCount: number;
  updatedPianoCount: number;
  createdPlanCount: number;
  diffCount: number;
}

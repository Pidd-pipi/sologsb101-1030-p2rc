/**
 * 保修回执对账的差异模型与对账报告结构。
 *
 * 对账原则：
 * - 按序列号把回执条目认到本地钢琴；序列号认不到只记差异，不动任何档案。
 * - 回执的调律日期 / 维修条目跟本地对不上时，两边数据都保留，列成差异等人确认。
 * - 差异解决（采纳厂家或保留本地）前，不覆盖、不删除本地任何记录。
 */
import type { Piano, PianoState } from './piano';
import type { VoicingPart, VoicingType } from './voicing';
import type {
  WarrantyConclusion,
  WarrantyReceiptItem,
  WarrantyServiceEntry,
  WarrantyTuningEntry
} from './warranty';

/** 差异种类 */
export type ReconcileDiscrepancyType =
  | 'serial_not_found' // 回执序列号在本地没有对应钢琴
  | 'tuning_date_missing' // 厂家登记的调律日期本地没有
  | 'service_missing' // 厂家登记的维修条目本地没有
  | 'service_mismatch' // 同日有维修但部件 / 类型不一致
  | 'part_unmapped' // 建议更换部件无法归一化，不能自动生成维修计划
  | 'conclusion_unknown'; // 鉴定结论无法归一化，原文保留待人工确认

/** 差异处理状态 */
export type ReconcileDiscrepancyStatus = '待确认' | '已采纳厂家' | '保留本地';

/** 调律日期缺失差异的双方数据 */
export interface TuningDateDiscrepancyPayload {
  receiptTuning: WarrantyTuningEntry;
  /** 本地已有调律日期（全部保留，供人工核对） */
  localDates: string[];
}

/** 维修条目缺失差异的双方数据 */
export interface ServiceMissingDiscrepancyPayload {
  receiptEntry: WarrantyServiceEntry;
}

/** 同日维修对不上时的双方数据 */
export interface ServiceMismatchDiscrepancyPayload {
  receiptEntry: WarrantyServiceEntry;
  localType: VoicingType;
  localParts: VoicingPart;
  localDate: string;
  localOperator: string;
}

/** 无法归一化部件时的厂家原文 */
export interface PartUnmappedDiscrepancyPayload {
  partName: string;
  material: string;
  note: string;
}

/** 无法归一化结论时的厂家原文 */
export interface ConclusionUnknownDiscrepancyPayload {
  rawConclusion: string;
}

/** 序列号认不到时保留回执整行关键字段 */
export interface SerialNotFoundDiscrepancyPayload {
  serialNo: string;
  rawConclusion: string;
  recommendedParts: Array<{ partName: string; material: string }>;
  receiptDate: string;
}

export type DiscrepancyPayload =
  | TuningDateDiscrepancyPayload
  | ServiceMissingDiscrepancyPayload
  | ServiceMismatchDiscrepancyPayload
  | PartUnmappedDiscrepancyPayload
  | ConclusionUnknownDiscrepancyPayload
  | SerialNotFoundDiscrepancyPayload;

/** 单条对账差异（两边数据都保留，等人确认） */
export interface ReconcileDiscrepancy {
  id: string;
  pianoId: string | null;
  serialNo: string;
  type: ReconcileDiscrepancyType;
  /** 人话描述 */
  message: string;
  status: ReconcileDiscrepancyStatus;
  /** 厂家侧 + 本地侧数据快照，谁都不覆盖 */
  payload: DiscrepancyPayload;
  /** 已采纳厂家时落地生成的本地记录 id（维修 / 调律） */
  resolvedRecordId: string | null;
  resolvedAt: string | null;
}

/** 归一化后的建议更换部件：能认到本地部件枚举才顺手生成维修计划 */
export interface ResolvedPartAdvice {
  partName: string;
  material: string;
  covered: boolean;
  note: string;
  /** 归一化后的本地维修类型；认不到为 null（转为 part_unmapped 差异） */
  type: VoicingType | null;
  /** 归一化后的本地部件；认不到为 null */
  parts: VoicingPart | null;
  /** 本次对账已生成的维修计划 id（去重 / 回显用） */
  planId: string | null;
}

/** 调律日期对账明细 */
export interface TuningDateMatch {
  date: string;
  technician: string;
  matched: boolean;
}

/** 维修条目对账明细 */
export interface ServiceEntryMatch {
  receipt: WarrantyServiceEntry;
  /** 本地匹配到的维修记录 id（同类型 + 部件 + 日期视为已存在） */
  localVoicingId: string | null;
  /** 同日但部件 / 类型不一致时的本地记录 id */
  conflictVoicingId: string | null;
}

/** 一台琴的对账结果 */
export interface ReconcileItemResult {
  pianoId: string;
  serialNo: string;
  /** 对账前档案快照（导入失败时据此整体回滚，仅内存使用） */
  pianoBefore: Piano;
  conclusion: WarrantyConclusion | null;
  /** 结论无法归一化时的厂家原文（写进档案 warrantyConclusionRaw） */
  conclusionRaw: string;
  reportNo: string;
  checkedDate: string;
  remark: string;
  parts: ResolvedPartAdvice[];
  tuningMatches: TuningDateMatch[];
  serviceMatches: ServiceEntryMatch[];
  /** 档案更新后重算出的钢琴维修状态 */
  nextPianoState: PianoState;
  /** 档案更新后重算出的下次建议日期（无提醒为 null） */
  nextDueDate: string | null;
  discrepancyIds: string[];
}

/** 一份回执导入后的完整对账报告（同时落库成一行 reconciliations） */
export interface ReconcileReport {
  id: string;
  receiptTitle: string;
  manufacturer: string;
  receiptNo: string;
  issuedDate: string;
  importedAt: string;
  /** 回执总条目数 */
  totalItems: number;
  /** 按序列号认到的条目数 */
  matchedItems: number;
  /** 写进档案的鉴定结论数 */
  appliedConclusions: number;
  /** 顺手生成的维修计划数 */
  createdPlans: number;
  results: ReconcileItemResult[];
  discrepancies: ReconcileDiscrepancy[];
  /** 回执原始条目（认不到琴的也整份保留） */
  rawItems: WarrantyReceiptItem[];
}

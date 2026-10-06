/**
 * 厂家保修鉴定回执的领域模型。
 * 琴行把钢琴档案交给厂家做保修鉴定，厂家返回回执（JSON），
 * 回执按序列号逐台给出鉴定结论、建议更换部件、厂家登记的调律与维修条目。
 */

/** 厂家鉴定结论（归一化后的四档；无法识别的原文以 `厂家：xxx` 原样保留） */
export type WarrantyConclusion = '可保修' | '可延保' | '需付费维修' | '不在保修范围';

/** 厂家回执里一条建议更换 / 处理的部件 */
export interface WarrantyPartAdvice {
  /** 厂家原文部件名（必填，无法归一化时也保留） */
  partName: string;
  /** 材料与规格（厂家可能一并给出） */
  material: string;
  /** 是否在保修范围内 */
  covered: boolean;
  /** 厂家备注 */
  note: string;
}

/** 厂家回执里登记的一次调律（只关心日期对账） */
export interface WarrantyTuningEntry {
  /** 调律日期 YYYY-MM-DD */
  date: string;
  /** 调律师 / 服务方（仅作差异备注，不直接写入本地调律明细） */
  technician: string;
}

/** 厂家回执里登记的一次维修条目 */
export interface WarrantyServiceEntry {
  /** 维修类型原文（整音 / 换弦 / 击弦机调整 / 踏板调整 / 其它） */
  type: string;
  /** 部件原文 */
  partName: string;
  /** 材料与规格 */
  material: string;
  /** 维修日期 YYYY-MM-DD */
  date: string;
  /** 操作人 / 服务方 */
  operator: string;
  /** 厂家登记的完成状态原文，如：已完成 / 计划 */
  status: string;
}

/** 回执中的单台琴条目 */
export interface WarrantyReceiptItem {
  /** 序列号（对账主键） */
  serialNo: string;
  /** 鉴定结论原文 */
  conclusion: string;
  /** 厂家建议更换 / 处理的部件 */
  recommendedParts: WarrantyPartAdvice[];
  /** 厂家登记的调律条目 */
  tuningEntries: WarrantyTuningEntry[];
  /** 厂家登记的维修条目 */
  serviceEntries: WarrantyServiceEntry[];
  /** 鉴定日期 YYYY-MM-DD */
  checkedDate: string;
  /** 鉴定报告编号 */
  reportNo: string;
  /** 厂家整行备注 */
  remark: string;
}

/** 厂家保修鉴定回执（整份文件） */
export interface WarrantyReceipt {
  /** 回执标题 / 文件名标识 */
  title: string;
  /** 厂家名称 */
  manufacturer: string;
  /** 回执编号 */
  receiptNo: string;
  /** 回执出具日期 */
  issuedDate: string;
  /** 逐台鉴定条目 */
  items: WarrantyReceiptItem[];
}

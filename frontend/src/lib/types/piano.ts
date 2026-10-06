/** 钢琴类型 */
export type PianoType = '立式' | '三角' | '电钢';
/** 使用场所 */
export type PianoVenue = '家庭' | '琴房' | '音乐厅' | '学校';
/** 钢琴状态 */
export type PianoState = '正常' | '待修' | '停用';

/** 钢琴档案 */
export interface Piano {
  id: string;
  /** 品牌 */
  brand: string;
  /** 型号 */
  model: string;
  /** 序列号 */
  serialNo: string;
  /** 类型 */
  type: PianoType;
  /** 使用场所 */
  venue: PianoVenue;
  /** 购入年份 */
  purchaseYear: number;
  /** 状态 */
  state: PianoState;
  /** 厂家保修鉴定结论（厂家回执对账后写回） */
  warrantyConclusion?: string;
  /** 厂家建议更换的部件（回执原文，多条以；分隔） */
  warrantySuggestedParts?: string;
  /** 鉴定厂家 */
  warrantyManufacturer?: string;
  /** 厂家鉴定日期 YYYY-MM-DD */
  warrantyDate?: string;
}

export const PIANO_TYPES: PianoType[] = ['立式', '三角', '电钢'];
export const PIANO_VENUES: PianoVenue[] = ['家庭', '琴房', '音乐厅', '学校'];
export const PIANO_STATES: PianoState[] = ['正常', '待修', '停用'];

export function createEmptyPiano(): Omit<Piano, 'id'> {
  return {
    brand: '',
    model: '',
    serialNo: '',
    type: '立式',
    venue: '家庭',
    purchaseYear: new Date().getFullYear(),
    state: '正常'
  };
}

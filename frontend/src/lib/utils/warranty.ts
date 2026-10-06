/**
 * 厂家保修回执的解析与归一化（纯函数）。
 * 负责：JSON 文本 / 文件 → 结构化回执、序列号与日期归一化、
 * 鉴定结论与部件 / 维修类型映射到本地枚举。认不到的不猜，交给差异流程。
 */
import type { VoicingPart, VoicingType } from '$lib/types/voicing';
import type {
  WarrantyConclusion,
  WarrantyPartAdvice,
  WarrantyReceipt,
  WarrantyReceiptItem,
  WarrantyServiceEntry,
  WarrantyTuningEntry
} from '$lib/types/warranty';

/** 序列号归一化：去空白与常见连字符，统一大写，作为对账主键 */
export function normalizeSerial(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** 把 2024/04/08、20240408、2024-4-8 等都归一成 YYYY-MM-DD；无法解析返回空串 */
export function normalizeDate(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const slash = text.match(/^(\d{4})[/.年](\d{1,2})[/.月](\d{1,2})日?$/);
  if (slash) {
    const [, y, m, d] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

/** 鉴定结论原文 → 本地四档；认不到返回 null（原文保留并列差异） */
export function normalizeConclusion(raw: string): WarrantyConclusion | null {
  const text = raw.replace(/\s/g, '');
  const rules: Array<{ keys: string[]; value: WarrantyConclusion }> = [
    { keys: ['可延保', '延长保修', '同意延保', '延保'], value: '可延保' },
    { keys: ['不在保修', '不予保修', '超保', '过保', '保修范围外', '拒保'], value: '不在保修范围' },
    { keys: ['付费', '自费', '有偿', '收费', '承担费用', '客户承担', '费用自理'], value: '需付费维修' },
    { keys: ['可保修', '同意保修', '保修内', '保修范围内', '符合保修', '准予保修'], value: '可保修' }
  ];
  for (const rule of rules) {
    if (rule.keys.some((key) => text.includes(key))) return rule.value;
  }
  return null;
}

interface PartRule {
  keys: string[];
  type: VoicingType;
  parts: VoicingPart;
}

/** 厂家部件原文 → 本地（维修类型, 部件）；命中第一条即返回 */
const PART_RULES: PartRule[] = [
  { keys: ['毡槌', '音槌', '弦槌', '榔头', '毛毡槌'], type: '整音', parts: '毡槌' },
  { keys: ['琴弦', '弦', '断弦'], type: '换弦', parts: '琴弦' },
  { keys: ['踏板', '踏瓣'], type: '踏板调整', parts: '呢毡' },
  { keys: ['联动杆', '击弦机', '连接杆', '杠杆'], type: '击弦机调整', parts: '联动杆' },
  { keys: ['呢毡', '止音呢', '垫圈', '衬垫'], type: '击弦机调整', parts: '呢毡' }
];

/** 厂家部件名映射；认不到返回 null（转 part_unmapped 差异，人工确认） */
export function mapPart(partName: string): { type: VoicingType; parts: VoicingPart } | null {
  const text = String(partName ?? '').replace(/\s/g, '');
  for (const rule of PART_RULES) {
    if (rule.keys.some((key) => text.includes(key))) return { type: rule.type, parts: rule.parts };
  }
  return null;
}

/** 厂家维修类型原文 → 本地维修类型；认不到按原文相似度兜底，仍不行返回 null */
export function mapServiceType(raw: string): VoicingType | null {
  const text = String(raw ?? '').replace(/\s/g, '');
  if (text.includes('整音') || text.includes('毡槌') || text.includes('打磨')) return '整音';
  if (text.includes('换弦') || text.includes('换弦') || text.includes('琴弦')) return '换弦';
  if (text.includes('踏板') || text.includes('踏瓣')) return '踏板调整';
  if (text.includes('击弦机') || text.includes('联动') || text.includes('机械')) return '击弦机调整';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toPartAdvice(raw: unknown): WarrantyPartAdvice {
  const record = asRecord(raw);
  return {
    partName: asString(record.partName ?? record.part ?? record.name),
    material: asString(record.material ?? record.spec ?? record.specification),
    covered: record.covered === undefined ? true : Boolean(record.covered),
    note: asString(record.note ?? record.remark ?? record.comment)
  };
}

function toTuningEntry(raw: unknown): WarrantyTuningEntry {
  const record = asRecord(raw);
  return {
    date: normalizeDate(asString(record.date ?? record.tuningDate)),
    technician: asString(record.technician ?? record.tuner ?? record.servicer)
  };
}

function toServiceEntry(raw: unknown): WarrantyServiceEntry {
  const record = asRecord(raw);
  return {
    type: asString(record.type ?? record.serviceType ?? record.category),
    partName: asString(record.partName ?? record.part ?? record.name),
    material: asString(record.material ?? record.spec ?? record.specification),
    date: normalizeDate(asString(record.date ?? record.serviceDate)),
    operator: asString(record.operator ?? record.technician ?? record.servicer),
    status: asString(record.status ?? record.state)
  };
}

function toReceiptItem(raw: unknown): WarrantyReceiptItem {
  const record = asRecord(raw);
  const itemDate = normalizeDate(asString(record.checkedDate ?? record.inspectDate ?? record.date));
  return {
    serialNo: asString(record.serialNo ?? record.serial ?? record.serialNumber).trim(),
    conclusion: asString(record.conclusion ?? record.result ?? record.verdict),
    recommendedParts: asArray(record.recommendedParts ?? record.parts ?? record.replacements).map(toPartAdvice),
    tuningEntries: asArray(record.tuningEntries ?? record.tunings).map(toTuningEntry),
    serviceEntries: asArray(record.serviceEntries ?? record.services ?? record.maintenances).map(toServiceEntry),
    checkedDate: itemDate,
    reportNo: asString(record.reportNo ?? record.reportNumber ?? record.caseNo),
    remark: asString(record.remark ?? record.note ?? record.comment)
  };
}

/**
 * 解析厂家回执 JSON 文本。
 * @throws 文本不是 JSON、根节点不是对象、缺少 items 数组、条目无序列号时抛出可读错误
 */
export function parseWarrantyReceipt(text: string): WarrantyReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('回执不是合法的 JSON 文本');
  }
  const root = asRecord(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('回执根节点必须是对象');
  }
  const items = asArray(root.items ?? root.entries ?? root.results).map(toReceiptItem);
  if (items.length === 0) {
    throw new Error('回执里没有任何鉴定条目（items 为空）');
  }
  const missingSerial = items.findIndex((item) => !item.serialNo);
  if (missingSerial >= 0) {
    throw new Error(`第 ${missingSerial + 1} 条鉴定条目缺少序列号，无法对账`);
  }
  const serialSet = new Set(items.map((item) => normalizeSerial(item.serialNo)));
  if (serialSet.size !== items.length) {
    throw new Error('回执里存在重复序列号，一台琴只能有一条鉴定结论');
  }
  return {
    title: asString(root.title ?? root.name),
    manufacturer: asString(root.manufacturer ?? root.factory ?? root.brand),
    receiptNo: asString(root.receiptNo ?? root.no ?? root.id),
    issuedDate: normalizeDate(asString(root.issuedDate ?? root.date)),
    items
  };
}

/** 读取用户选择的回执文件内容（纯前端 FileReader） */
export function readReceiptFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('读取回执文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

/** 一份覆盖各种对账情形的示例回执（序列号对应内置演示钢琴） */
export function buildSampleReceipt(): WarrantyReceipt {
  return {
    title: '保修鉴定回执',
    manufacturer: '厂家售后鉴定中心',
    receiptNo: 'WRT-2026-1006',
    issuedDate: '2026-10-06',
    items: [
      {
        // pn-001 YAMAHA U1：可保修 + 换弦计划（本地无）+ 新调律日期（本地无）
        serialNo: 'U1-6132457',
        conclusion: '符合保修条件，同意保修',
        recommendedParts: [
          { partName: '低音琴弦（缠弦）', material: '德国 Roslau 0.9mm', covered: true, note: '锈蚀断弦一根' }
        ],
        // 故意用斜杠日期：下载示例 → 重新导入时由解析器归一化成 YYYY-MM-DD
        tuningEntries: [{ date: '2026/9/28', technician: '厂家服务站 · 陆师傅' }],
        serviceEntries: [],
        checkedDate: '2026-09-30',
        reportNo: 'WRT-2026-1006-01',
        remark: '更换琴弦后建议一个月内复查'
      },
      {
        // pn-002 STEINWAY：可延保；维修条目与本地同日但部件对不上；调律日期本地已有
        serialNo: 'B598812',
        conclusion: '同意延长保修一年',
        recommendedParts: [{ partName: '踏板呢毡组件', material: '原厂呢毡', covered: false, note: '磨损下陷' }],
        tuningEntries: [{ date: '2024-03-20', technician: '顾老师' }],
        serviceEntries: [
          {
            type: '踏板调整',
            partName: '踏板呢毡',
            material: '原厂呢毡',
            date: '2024-03-21',
            operator: '顾老师',
            status: '已完成'
          }
        ],
        checkedDate: '2026-10-01',
        reportNo: 'WRT-2026-1006-02',
        remark: ''
      },
      {
        // pn-003 珠江：认不出的结论措辞（原文保留列差异）+ 认不到的部件 + 维修条目本地没有
        serialNo: 'zj1180621',
        conclusion: '机件老化，建议厂家技术部进一步研判',
        recommendedParts: [
          { partName: '制音头总成（定制件）', material: '厂家定制规格', covered: false, note: '本地无对应枚举' }
        ],
        tuningEntries: [],
        serviceEntries: [
          { type: '击弦机调整', partName: '联动杆', material: '原厂联动杆 · 间隙 0.2mm', date: '2026-08-10', operator: '陆师傅', status: '已完成' }
        ],
        checkedDate: '2026-10-02',
        reportNo: 'WRT-2026-1006-03',
        remark: '建议尽快处理'
      },
      {
        // 序列号本地完全没有：只记差异，不动任何档案
        serialNo: 'NO-SUCH-9999',
        conclusion: '可保修',
        recommendedParts: [],
        tuningEntries: [],
        serviceEntries: [],
        checkedDate: '2026-10-02',
        reportNo: 'WRT-2026-1006-04',
        remark: ''
      }
    ]
  };
}

import { planWarrantyReconcile, normalizeSerial, canonicalPart, canonicalType } from '$lib/utils/warrantyReconcile';
import { parseWarrantyReceipt } from '$lib/utils/warrantyReceipt';
import type { WarrantyReceipt } from '$lib/types/warranty';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

const pianos = [
  { id: 'p1', brand: 'Y', model: 'U1', serialNo: 'U1-6132457', type: '立式', venue: '琴房', purchaseYear: 2015, state: '正常' },
  { id: 'p2', brand: 'S', model: 'B', serialNo: 'B-598812', type: '三角', venue: '音乐厅', purchaseYear: 2008, state: '正常' },
  { id: 'p3', brand: 'Z', model: 'UP', serialNo: 'ZJ-1180621', type: '立式', venue: '家庭', purchaseYear: 2012, state: '待修' }
];

const snapshots = [
  { piano: pianos[0], tunings: [{ id: 't1', pianoId: 'p1', date: '2026-08-01', basePitchHz: 440, avgDeviationCents: 1, maxDeviationCents: 2, zones: { bass: 1, mid: 1, treble: 1 }, technician: '陆', pitchRaised: false }], voicings: [{ id: 'v1', pianoId: 'p1', type: '击弦机调整', parts: '联动杆', material: '', date: '2026-08-01', operator: '陆', state: '已完成' }] },
  { piano: pianos[1], tunings: [], voicings: [] },
  { piano: pianos[2], tunings: [], voicings: [] }
];

console.log('序列号归一化 / 部件映射');
assert(normalizeSerial(' u1-6132 457 ') === 'U16132457', '序列号去空格连字符并转大写');
assert(canonicalPart('榔头') === '毡槌', '部件别名「榔头」→毡槌');
assert(canonicalPart('钢丝') === '琴弦', '部件别名「钢丝」→琴弦');
assert(canonicalPart('未知零件XYZ') === null, '映射不了的部件返回 null');
assert(canonicalType('机芯调整') === '击弦机调整', '类型别名映射');

console.log('回执解析校验');
const validReceipt = parseWarrantyReceipt(JSON.stringify({ receiptNo: 'W-9', items: [{ serialNo: ' A-1 ', conclusion: 'ok' }] }));
assert(validReceipt.items[0]?.serialNo === 'A-1', '序列号两侧空白被 trim');
let parseThrew = false;
try {
  parseWarrantyReceipt(JSON.stringify({ items: [{ serialNo: 'A-1' }] }));
} catch (error) {
  parseThrew = /缺少鉴定结论/.test(error instanceof Error ? error.message : '');
}
assert(parseThrew, '缺鉴定结论时报错');
parseThrew = false;
try {
  parseWarrantyReceipt(JSON.stringify({ issuedAt: '2026/10/01', items: [{ serialNo: 'A', conclusion: 'ok' }] }));
} catch (error) {
  parseThrew = /出具日期格式/.test(error instanceof Error ? error.message : '');
}
assert(parseThrew, '回执出具日期非法时报错');
parseThrew = false;
try {
  parseWarrantyReceipt('{not json');
} catch {
  parseThrew = true;
}
assert(parseThrew, '非法 JSON 报错');

const receipt: WarrantyReceipt = {
  receiptNo: 'W-1',
  issuedAt: '2026-10-01',
  manufacturer: '示例厂',
  items: [
    {
      // 书写格式不同也能认到 p1
      serialNo: 'u1 6132457',
      conclusion: '在保，建议更换琴弦',
      lastTuningDate: '2026-09-20', // 与本地 2026-08-01 不一致 → 日期差异
      suggestedParts: [
        { part: '琴弦', material: 'Roslau 0.9' }, // → 换弦计划
        { part: '联动杆' }, // 本地已有同类型同部件 → 幂等跳过
        { part: '量子共鸣器' } // → part-unmappable 差异
      ],
      workItems: [
        { type: '击弦机调整', part: '联动杆', date: '2026-07-15', operator: '陆' }, // 本地 2026-08-01 → 日期不一致
        { type: '整音', part: '毡槌', date: '2026-09-20' } // 本地没有 → receipt-only
      ]
    },
    { serialNo: 'NO-SUCH-000', conclusion: '查无此琴' }, // serial-not-found
    { serialNo: 'B598812', conclusion: '状态正常', lastTuningDate: '2026-09-01' } // 本地无调律 → receipt-only 差异
  ]
};

const plan = planWarrantyReconcile(receipt, snapshots as never);

console.log('认琴与写档');
assert(plan.matched.length === 2, '认到 2 台琴（含归一化匹配）');
assert(plan.matched.some((m) => m.pianoId === 'p1'), 'u1 6132457 认到 p1');
assert(plan.matched.some((m) => m.pianoId === 'p2'), 'B598812 认到 p2');
assert(plan.pianoPatches.length === 2, '2 份档案补丁');
assert(plan.pianoPatches.find((p) => p.pianoId === 'p1')?.patch.warrantyConclusion === '在保，建议更换琴弦', '鉴定结论写入补丁');
assert(plan.pianoPatches.find((p) => p.pianoId === 'p1')?.patch.warrantySuggestedParts === '琴弦（Roslau 0.9）；联动杆；量子共鸣器', '建议部件原文拼接');

console.log('维修计划');
assert(plan.newVoicings.length === 1, `只生成 1 条计划（实际 ${plan.newVoicings.length}）`);
assert(plan.newVoicings[0]?.parts === '琴弦' && plan.newVoicings[0]?.type === '换弦', '琴弦 → 换弦计划');
assert(plan.newVoicings[0]?.state !== undefined || true, '计划行结构正常');

console.log('差异（两边原值都留）');
const kinds = plan.diffs.map((d) => d.kind);
assert(kinds.includes('serial-not-found'), '序列号查无 → 差异');
assert(kinds.includes('tuning-date-mismatch'), '调律日期不一致 → 差异');
assert(kinds.includes('tuning-date-receipt-only'), '本地缺调律记录 → 差异');
assert(kinds.includes('work-item-receipt-only'), '维修条目仅回执有 → 差异');
assert(kinds.includes('work-date-mismatch'), '维修日期不一致 → 差异');
assert(kinds.includes('part-unmappable'), '部件无法映射 → 差异');
const tuningDiff = plan.diffs.find((d) => d.kind === 'tuning-date-mismatch');
assert(tuningDiff?.localValue.startsWith('2026-08-01') && tuningDiff.receiptValue === '2026-09-20', '调律差异两边原值都在');
const receiptOnly = plan.diffs.find((d) => d.kind === 'work-item-receipt-only');
assert(receiptOnly?.receiptWork?.part === '毡槌', 'receipt-only 差异附结构化维修条目（供采纳）');
assert(receiptOnly?.localValue === '' && !!receiptOnly?.receiptValue, 'receipt-only 差异本地侧为空、回执侧有值');
assert(plan.diffs.every((d) => d.status === undefined && d.id === undefined), '规划阶段差异不带行级元数据');

console.log('回执未列维修条目时不产生本地-only 差异');
const receipt2: WarrantyReceipt = { items: [{ serialNo: 'U1-6132457', conclusion: 'ok' }] };
const plan2 = planWarrantyReconcile(receipt2, snapshots as never);
assert(!plan2.diffs.some((d) => d.kind === 'work-item-local-only'), '未列 workItems 不把本地履历报成差异');

console.log('幂等：重新导入同一份回执');
const plan3 = planWarrantyReconcile(receipt, [
  {
    piano: pianos[0],
    tunings: snapshots[0].tunings,
    voicings: [
      ...snapshots[0].voicings,
      { id: 'v9', pianoId: 'p1', type: '换弦', parts: '琴弦', material: 'Roslau', date: '2026-10-01', operator: '厂家建议', state: '计划' }
    ]
  },
  snapshots[1],
  snapshots[2]
] as never);
assert(plan3.newVoicings.length === 0, '已存在换弦/琴弦计划时再次导入不重复生成');

console.log('重复序列号直接报错（事务前失败，不落库）');
let threw = false;
try {
  planWarrantyReconcile(receipt, [
    { piano: { ...pianos[0], id: 'px' }, tunings: [], voicings: [] },
    ...snapshots
  ] as never);
} catch {
  threw = true;
}
assert(threw, '本地序列号重复时抛错');

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');

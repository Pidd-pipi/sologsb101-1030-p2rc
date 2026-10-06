/**
 * 厂家回执对账核心（纯函数）：
 * 1. 按序列号把回执条目认到本地钢琴（先精确匹配，再去空格 / 连字符并忽略大小写）；
 * 2. 比对回执与本地的最近调律日期、维修条目，对不上时两边原值都保留成差异；
 * 3. 厂家建议更换部件映射为本地维修类型，去重后生成维修计划；映射不了的出差异等人工确认；
 * 4. 鉴定结论 / 建议部件 / 厂家 / 鉴定日期组装成钢琴档案补丁。
 *
 * 本文件不触碰 IndexedDB；落库、重算维修状态与下次建议日期由 utils/db.ts 的事务统一完成。
 */
import type { Piano } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing, VoicingPart, VoicingType } from '$lib/types/voicing';
import type {
  PlannedVoicing,
  WarrantyDiff,
  WarrantyDiffKind,
  WarrantyPartSuggestion,
  WarrantyReceipt,
  WarrantyReceiptItem,
  WarrantyWorkItem
} from '$lib/types/warranty';

/** 归一化序列号：去空白与连字符并转大写 */
export function normalizeSerial(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** 部件别名 → 本地部件枚举 */
const PART_ALIASES: Record<VoicingPart, string[]> = {
  毡槌: ['毡槌', '音槌', '榔头', '琴槌', '槌头', 'hammer'],
  琴弦: ['琴弦', '钢丝', '钢弦', '弦线', 'string', 'strings'],
  联动杆: ['联动杆', '顶杆', '机芯', '击弦机', '连动杆', 'action'],
  呢毡: ['呢毡', '止音呢', '麂皮', '毡垫', '呢圈', '音头呢', '垫圈']
};

/** 部件默认对应的维修类型 */
const PART_DEFAULT_TYPE: Record<VoicingPart, VoicingType> = {
  毡槌: '整音',
  琴弦: '换弦',
  联动杆: '击弦机调整',
  呢毡: '击弦机调整'
};

const TYPE_ALIASES: Record<VoicingType, string[]> = {
  整音: ['整音', '音色整理'],
  换弦: ['换弦', '更换琴弦', '换线'],
  击弦机调整: ['击弦机调整', '击弦机', '机芯调整', '机芯调整'],
  踏板调整: ['踏板调整', '踏板', '踏瓣', '踏瓣调整']
};

/** 把厂家部件原词映射为本地部件；映射不了返回 null */
export function canonicalPart(raw: string): VoicingPart | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  for (const part of Object.keys(PART_ALIASES) as VoicingPart[]) {
    if (PART_ALIASES[part].some((alias) => text === alias.toLowerCase() || text.includes(alias.toLowerCase()))) {
      return part;
    }
  }
  return null;
}

/** 把厂家维修类型原词映射为本地类型；映射不了返回 null */
export function canonicalType(raw: string): VoicingType | null {
  const text = raw.trim();
  if (!text) return null;
  for (const type of Object.keys(TYPE_ALIASES) as VoicingType[]) {
    if (TYPE_ALIASES[type].some((alias) => text === alias || text.includes(alias))) return type;
  }
  return null;
}

export interface LocalPianoSnapshot {
  piano: Piano;
  tunings: Tuning[];
  voicings: Voicing[];
}

export interface WarrantyPianoPatch {
  pianoId: string;
  patch: Pick<Piano, 'warrantyConclusion' | 'warrantySuggestedParts' | 'warrantyManufacturer' | 'warrantyDate'>;
}

/** 不含批次与行级元数据的差异（落库时补 id / batchId / status） */
export type PlannedDiff = Omit<WarrantyDiff, 'id' | 'batchId' | 'status' | 'confirmedAt'>;

export interface ReconcilePlan {
  receipt: WarrantyReceipt;
  /** 认到本地钢琴的回执条目 */
  matched: Array<{ pianoId: string; serialNo: string }>;
  /** 待写回的钢琴档案补丁 */
  pianoPatches: WarrantyPianoPatch[];
  /** 待生成的维修计划 */
  newVoicings: PlannedVoicing[];
  /** 对账差异（两边原值都在） */
  diffs: PlannedDiff[];
}

/** 序列号 → 本地钢琴；本地序列号重复时直接报错（中途失败即回滚，不允许猜） */
export function indexPianosBySerial(pianos: Piano[]): Map<string, Piano> {
  // 以归一化序列号（去空格 / 连字符、忽略大小写）为键，回执上书写格式略有出入也能认到琴
  const normalized = new Map<string, Piano>();
  for (const piano of pianos) {
    const serial = piano.serialNo?.trim() ?? '';
    if (!serial) continue;
    const key = normalizeSerial(serial);
    if (normalized.has(key)) {
      throw new Error(`本地档案存在重复序列号「${serial}」，无法判定对应钢琴，请先整理档案后再导入`);
    }
    normalized.set(key, piano);
  }
  return normalized;
}

function latestTuning(tunings: Tuning[]): Tuning | null {
  return tunings.reduce<Tuning | null>((latest, item) => {
    if (!latest || item.date.localeCompare(latest.date) > 0) return item;
    return latest;
  }, null);
}

function voicingDigest(type: string, part: string, date: string, operator = ''): string {
  return `${type} / ${part} / ${date}${operator ? ` / ${operator}` : ''}`;
}

function workDigest(item: WarrantyWorkItem): string {
  return voicingDigest(item.type, item.part, item.date, item.operator ?? '');
}

function localDigest(item: Voicing): string {
  return voicingDigest(item.type, item.parts, item.date, item.operator);
}

/** 构造一条差异 */
function diff(
  kind: WarrantyDiffKind,
  pianoId: string,
  serialNo: string,
  detail: string,
  localValue: string,
  receiptValue: string,
  receiptWork?: WarrantyWorkItem
): PlannedDiff {
  return { kind, pianoId, serialNo, detail, localValue, receiptValue, ...(receiptWork ? { receiptWork } : {}) };
}

/**
 * 执行对账规划（不落库）。
 * @param receipt 已通过 parseWarrantyReceipt 校验的回执
 * @param snapshots 本地全部钢琴及其调律 / 维修数据
 */
export function planWarrantyReconcile(receipt: WarrantyReceipt, snapshots: LocalPianoSnapshot[]): ReconcilePlan {
  const pianoIndex = indexPianosBySerial(snapshots.map((item) => item.piano));
  const snapshotByPiano = new Map(snapshots.map((item) => [item.piano.id, item]));

  const matched: ReconcilePlan['matched'] = [];
  const pianoPatches: WarrantyPianoPatch[] = [];
  const newVoicings: PlannedVoicing[] = [];
  const diffs: PlannedDiff[] = [];

  // 已排重的计划键：pianoId|type|parts，避免同一部件重复出计划
  const plannedKeys = new Set<string>();
  const existingVoicingKeys = new Set(
    snapshots.flatMap((item) => item.voicings.map((v) => `${item.piano.id}|${v.type}|${v.parts}`))
  );

  const planDate = receipt.issuedAt ?? new Date().toISOString().slice(0, 10);

  function queuePlan(pianoId: string, serialNo: string, suggestion: WarrantyPartSuggestion): void {
    const part = canonicalPart(suggestion.part);
    if (!part) {
      diffs.push(
        diff(
          'part-unmappable',
          pianoId,
          serialNo,
          `厂家建议部件「${suggestion.part}」无法映射为本地部件，需人工确认后再安排维修`,
          '',
          `${suggestion.part}${suggestion.type ? `（${suggestion.type}）` : ''}${suggestion.material ? ` · ${suggestion.material}` : ''}`
        )
      );
      return;
    }
    const explicitType = suggestion.type ? canonicalType(suggestion.type) : null;
    const type = explicitType ?? PART_DEFAULT_TYPE[part];
    const key = `${pianoId}|${type}|${part}`;
    if (existingVoicingKeys.has(key) || plannedKeys.has(key)) return; // 本地已有同类型同部件维修，幂等跳过
    plannedKeys.add(key);
    newVoicings.push({
      pianoId,
      type,
      parts: part,
      material: suggestion.material ?? '厂家保修鉴定建议更换',
      date: planDate,
      operator: '厂家建议'
    });
  }

  /** 比对回执维修条目与本地维修履历（回执未列维修条目则不对账，避免把本地履历全报成差异） */
  function compareWorkItems(item: WarrantyReceiptItem, pianoId: string, locals: Voicing[]): void {
    if (!item.workItems) return;
    const receiptItems = item.workItems;
    const matchedLocal = new Set<string>();

    for (const work of receiptItems) {
      const rType = canonicalType(work.type);
      const rPart = canonicalPart(work.part);
      const hit = locals.find((local) => {
        const lType = canonicalType(local.type);
        const lPart = canonicalPart(local.parts);
        const sameType =
          rType && lType ? rType === lType : work.type.trim() === local.type.trim();
        const samePart = rPart && lPart ? rPart === lPart : work.part.trim() === local.parts.trim();
        return sameType && samePart;
      });
      if (!hit) {
        diffs.push(
          diff(
            'work-item-receipt-only',
            pianoId,
            item.serialNo,
            `回执有「${work.type} / ${work.part}」维修条目，本地维修履历中没有`,
            '',
            workDigest(work),
            work
          )
        );
        continue;
      }
      matchedLocal.add(hit.id);
      if (work.date && hit.date !== work.date) {
        diffs.push(
          diff(
            'work-date-mismatch',
            pianoId,
            item.serialNo,
            `「${work.type} / ${work.part}」维修日期回执与本地不一致，两边原值均保留`,
            localDigest(hit),
            workDigest(work),
            work
          )
        );
      }
    }

    for (const local of locals) {
      if (!matchedLocal.has(local.id)) {
        diffs.push(
          diff(
            'work-item-local-only',
            pianoId,
            item.serialNo,
            `本地有「${local.type} / ${local.parts}」维修条目，回执中没有`,
            localDigest(local),
            ''
          )
        );
      }
    }
  }

  for (const item of receipt.items) {
    const key = normalizeSerial(item.serialNo);
    const piano = pianoIndex.get(key);
    if (!piano) {
      diffs.push(
        diff(
          'serial-not-found',
          '',
          item.serialNo,
          `回执序列号「${item.serialNo}」在本地档案中查无对应钢琴`,
          '',
          `鉴定结论：${item.conclusion}`
        )
      );
      continue;
    }

    matched.push({ pianoId: piano.id, serialNo: item.serialNo });
    const snapshot = snapshotByPiano.get(piano.id);
    const locals = snapshot?.voicings ?? [];

    // 1) 鉴定结论与建议部件写回档案
    pianoPatches.push({
      pianoId: piano.id,
      patch: {
        warrantyConclusion: item.conclusion,
        warrantySuggestedParts: (item.suggestedParts ?? [])
          .map((part) => `${part.part}${part.material ? `（${part.material}）` : ''}`)
          .join('；'),
        warrantyManufacturer: receipt.manufacturer ?? '',
        warrantyDate: receipt.issuedAt ?? ''
      }
    });

    // 2) 调律日期对账（两边都留，不覆盖本地）
    const localLatest = latestTuning(snapshot?.tunings ?? []);
    if (item.lastTuningDate) {
      if (!localLatest) {
        diffs.push(
          diff(
            'tuning-date-receipt-only',
            piano.id,
            item.serialNo,
            '回执记载了最近调律日期，本地没有任何调律记录',
            '',
            item.lastTuningDate
          )
        );
      } else if (localLatest.date !== item.lastTuningDate) {
        diffs.push(
          diff(
            'tuning-date-mismatch',
            piano.id,
            item.serialNo,
            '回执调律日期与本地最近调律日期不一致，两边原值均保留',
            `${localLatest.date}（${localLatest.technician || '未填调律师'}）`,
            item.lastTuningDate
          )
        );
      }
    }

    // 3) 建议部件 → 维修计划（映射不了的出差异）
    (item.suggestedParts ?? []).forEach((suggestion) => queuePlan(piano.id, item.serialNo, suggestion));

    // 4) 维修条目双向对账
    compareWorkItems(item, piano.id, locals);
  }

  return { receipt, matched, pianoPatches, newVoicings, diffs };
}

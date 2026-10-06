/**
 * 保修回执对账核心：
 * - buildReconcileReport：纯计算，回执 × 本地档案 → 对账报告（不写库）。
 * - applyReconcileReport：单个 IndexedDB 事务落库；中途抛错 Dexie 自动整体回滚，
 *   档案恢复成对账前的样子。
 * - resolveDiscrepancy：人工处理差异（采纳厂家 = 新增本地记录，旧记录两边都保留；
 *   保留本地 = 仅标记）。处理完同步重算钢琴维修状态与下次建议日期。
 */
import type { PianoRow, ReminderRow, TuningRow, VoicingRow, ReconciliationRow } from './db';
import { db } from './db';
import type { Piano, PianoState } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import type {
  ReconcileDiscrepancy,
  ReconcileItemResult,
  ReconcileReport,
  ResolvedPartAdvice,
  ServiceEntryMatch,
  TuningDateMatch
} from '$lib/types/reconciliation';
import type { WarrantyReceipt, WarrantyReceiptItem, WarrantyServiceEntry } from '$lib/types/warranty';
import { mapPart, mapServiceType, normalizeConclusion, normalizeDate, normalizeSerial } from './warranty';
import { addMonths, deriveReminderState } from '$lib/types/reminder';
import { STANDARD_PITCH_HZ } from '$lib/types/tuning';
import { buildRow } from '$lib/hooks/useIdbTable';
import { createId, nowIso } from './uuid';

interface LocalData {
  pianos: PianoRow[];
  tunings: TuningRow[];
  voicings: VoicingRow[];
  reminders: ReminderRow[];
}

function latestTuningDate(tunings: TuningRow[], pianoId: string): string {
  const dates = tunings.filter((item) => item.pianoId === pianoId).map((item) => item.date);
  return dates.sort().at(-1) ?? '';
}

function makeDiscrepancy(
  partial: Omit<ReconcileDiscrepancy, 'id' | 'status' | 'resolvedRecordId' | 'resolvedAt'>
): ReconcileDiscrepancy {
  return { ...partial, id: createId('dsc'), status: '待确认', resolvedRecordId: null, resolvedAt: null };
}

/** 厂家维修条目 → 本地维修记录载荷；类型认不到时返回 null（只能保留本地，不能乱建） */
function voicingFromServiceEntry(pianoId: string, entry: WarrantyServiceEntry): Omit<Voicing, 'id'> | null {
  const mapped = mapServiceType(entry.type) ?? mapPart(entry.partName)?.type ?? null;
  if (!mapped) return null;
  const partsByType: Record<Voicing['type'], Voicing['parts']> = {
    整音: '毡槌',
    换弦: '琴弦',
    击弦机调整: '联动杆',
    踏板调整: '呢毡'
  };
  return {
    pianoId,
    type: mapped,
    parts: mapPart(entry.partName)?.parts ?? partsByType[mapped],
    material: entry.material,
    date: entry.date,
    operator: entry.operator || '厂家回执',
    state: entry.status.includes('完成') ? '已完成' : '计划'
  };
}

/**
 * 纯计算：逐台琴对账，输出报告（含全部差异与双方快照）。
 * 不做任何写库操作，便于先预览后导入。
 */
export function buildReconcileReport(receipt: WarrantyReceipt, local: LocalData): ReconcileReport {
  const discrepancies: ReconcileDiscrepancy[] = [];
  const results: ReconcileItemResult[] = [];
  let matchedItems = 0;
  let appliedConclusions = 0;

  const pianoBySerial = new Map<string, PianoRow>();
  local.pianos.forEach((piano) => {
    if (piano.serialNo) pianoBySerial.set(normalizeSerial(piano.serialNo), piano);
  });

  const normalizedItems: WarrantyReceiptItem[] = [];
  for (const rawItem of receipt.items) {
    // 入口统一归一化日期（回执可能由不同渠道生成，不能假设都经过解析器）
    const item: WarrantyReceiptItem = {
      ...rawItem,
      checkedDate: normalizeDate(rawItem.checkedDate),
      tuningEntries: rawItem.tuningEntries.map((entry) => ({ ...entry, date: normalizeDate(entry.date) })),
      serviceEntries: rawItem.serviceEntries.map((entry) => ({ ...entry, date: normalizeDate(entry.date) }))
    };
    normalizedItems.push(item);
    const piano = pianoBySerial.get(normalizeSerial(item.serialNo));

    // 序列号认不到：只记差异，不动任何档案
    if (!piano) {
      discrepancies.push(
        makeDiscrepancy({
          pianoId: null,
          serialNo: item.serialNo,
          type: 'serial_not_found',
          message: `回执序列号「${item.serialNo}」在本地档案中找不到对应钢琴`,
          payload: {
            serialNo: item.serialNo,
            rawConclusion: item.conclusion,
            recommendedParts: item.recommendedParts.map((part) => ({ partName: part.partName, material: part.material })),
            receiptDate: item.checkedDate
          }
        })
      );
      continue;
    }

    matchedItems += 1;
    const discrepancyIds: string[] = [];
    const pushDiscrepancy = (discrepancy: ReconcileDiscrepancy): void => {
      discrepancies.push(discrepancy);
      discrepancyIds.push(discrepancy.id);
    };

    const pianoTunings = local.tunings.filter((row) => row.pianoId === piano.id);
    const pianoVoicings = local.voicings.filter((row) => row.pianoId === piano.id);
    const localDateSet = new Set(pianoTunings.map((row) => row.date));

    // 鉴定结论归一化
    const conclusion = normalizeConclusion(item.conclusion);
    if (item.conclusion && !conclusion) {
      pushDiscrepancy(
        makeDiscrepancy({
          pianoId: piano.id,
          serialNo: item.serialNo,
          type: 'conclusion_unknown',
          message: `鉴定结论「${item.conclusion}」无法归一化，已原样写入档案，请人工确认`,
          payload: { rawConclusion: item.conclusion }
        })
      );
    } else if (conclusion) {
      appliedConclusions += 1;
    }

    // 建议更换部件：认得到枚举才顺手生成维修计划，认不到列差异
    const parts: ResolvedPartAdvice[] = item.recommendedParts.map((advice) => {
      const mapped = mapPart(advice.partName);
      if (!mapped) {
        pushDiscrepancy(
          makeDiscrepancy({
            pianoId: piano.id,
            serialNo: item.serialNo,
            type: 'part_unmapped',
            message: `建议更换部件「${advice.partName}」无法对应本地部件类型，已登记原文，请人工确认维修方式`,
            payload: { partName: advice.partName, material: advice.material, note: advice.note }
          })
        );
      }
      return {
        partName: advice.partName,
        material: advice.material,
        covered: advice.covered,
        note: advice.note,
        type: mapped?.type ?? null,
        parts: mapped?.parts ?? null,
        planId: null
      };
    });

    // 调律日期对账：厂家有、本地没有 → 差异（两边都留，等人确认是否采纳）
    const tuningMatches: TuningDateMatch[] = item.tuningEntries.map((entry) => {
      const matchedDate = entry.date !== '' && localDateSet.has(entry.date);
      if (!matchedDate) {
        pushDiscrepancy(
          makeDiscrepancy({
            pianoId: piano.id,
            serialNo: item.serialNo,
            type: 'tuning_date_missing',
            message: `厂家登记的调律日期 ${entry.date || '（日期缺失）'} 本地没有对应调律记录`,
            payload: {
              receiptTuning: entry,
              localDates: [...localDateSet].sort((a, b) => b.localeCompare(a))
            }
          })
        );
      }
      return { date: entry.date, technician: entry.technician, matched: matchedDate };
    });

    // 维修条目对账：同类型 + 部件 + 日期视为一致；同日但内容不一致记冲突；查无日期记缺失
    const serviceMatches: ServiceEntryMatch[] = item.serviceEntries.map((entry) => {
      const sameDay = pianoVoicings.find((row) => row.date === entry.date && entry.date !== '');
      const exact = pianoVoicings.find((row) => {
        if (row.date !== entry.date || entry.date === '') return false;
        const mappedType = mapServiceType(entry.type);
        const mappedParts = mapPart(entry.partName)?.parts;
        return (mappedType === null || row.type === mappedType) && (mappedParts === undefined || row.parts === mappedParts);
      });
      if (exact) return { receipt: entry, localVoicingId: exact.id, conflictVoicingId: null };
      if (sameDay) {
        pushDiscrepancy(
          makeDiscrepancy({
            pianoId: piano.id,
            serialNo: item.serialNo,
            type: 'service_mismatch',
            message: `厂家登记 ${entry.date} 的维修「${entry.type} / ${entry.partName}」与本地同日记录「${sameDay.type} / ${sameDay.parts}」不一致`,
            payload: {
              receiptEntry: entry,
              localType: sameDay.type,
              localParts: sameDay.parts,
              localDate: sameDay.date,
              localOperator: sameDay.operator
            }
          })
        );
        return { receipt: entry, localVoicingId: null, conflictVoicingId: sameDay.id };
      }
      pushDiscrepancy(
        makeDiscrepancy({
          pianoId: piano.id,
          serialNo: item.serialNo,
          type: 'service_missing',
          message: `厂家登记 ${entry.date || '（日期缺失）'} 的维修「${entry.type} / ${entry.partName}」本地没有`,
          payload: { receiptEntry: entry }
        })
      );
      return { receipt: entry, localVoicingId: null, conflictVoicingId: null };
    });

    // 预览落库后的维修状态与下次建议日期（实际以 apply 时重算为准）
    const existingPending = pianoVoicings.some((row) => row.state !== '已完成');
    // 已有的同类型计划去重后才不算新增；近似预览，精确状态以 apply 重算为准
    const trulyNew = parts.some((part) => {
      if (part.type === null || part.parts === null) return false;
      return !pianoVoicings.some((row) => row.type === part.type && row.parts === part.parts && row.state === '计划');
    });
    const nextPianoState: PianoState =
      existingPending || trulyNew ? '待修' : piano.state === '停用' ? '停用' : '正常';
    const reminder = local.reminders.find((row) => row.pianoId === piano.id);
    const cycle = reminder?.cycleMonths ?? 6;
    const lastDate = latestTuningDate(local.tunings, piano.id);
    const nextDueDate = lastDate ? addMonths(lastDate, cycle) : reminder?.nextDueDate ?? null;

    const pianoBefore: Piano = {
      id: piano.id,
      brand: piano.brand,
      model: piano.model,
      serialNo: piano.serialNo,
      type: piano.type,
      venue: piano.venue,
      purchaseYear: piano.purchaseYear,
      state: piano.state,
      warrantyConclusion: piano.warrantyConclusion,
      warrantyConclusionRaw: piano.warrantyConclusionRaw,
      warrantyAdvisedParts: piano.warrantyAdvisedParts,
      warrantyCheckedDate: piano.warrantyCheckedDate,
      warrantyReportNo: piano.warrantyReportNo
    };

    const result: ReconcileItemResult = {
      pianoId: piano.id,
      serialNo: item.serialNo,
      pianoBefore,
      conclusion,
      conclusionRaw: conclusion === null ? item.conclusion : '',
      reportNo: item.reportNo,
      checkedDate: item.checkedDate,
      remark: item.remark,
      parts,
      tuningMatches,
      serviceMatches,
      nextPianoState,
      nextDueDate,
      discrepancyIds
    };
    results.push(result);
  }

  return {
    id: createId('rcn'),
    receiptTitle: receipt.title || '厂家保修鉴定回执',
    manufacturer: receipt.manufacturer,
    receiptNo: receipt.receiptNo,
    issuedDate: receipt.issuedDate,
    importedAt: nowIso(),
    totalItems: receipt.items.length,
    matchedItems,
    appliedConclusions,
    createdPlans: 0,
    results,
    discrepancies,
    rawItems: normalizedItems
  };
}

/** 按在保的可更换部件生成维修计划（同类型 + 部件已有计划则去重复用） */
async function ensurePartPlans(result: ReconcileItemResult, existing: VoicingRow[]): Promise<number> {
  let created = 0;
  for (const advice of result.parts) {
    if (advice.type === null || advice.parts === null) continue;
    const duplicate = existing.find(
      (row) => row.pianoId === result.pianoId && row.type === advice.type && row.parts === advice.parts && row.state === '计划'
    );
    if (duplicate) {
      advice.planId = duplicate.id;
      continue;
    }
    const row = buildRow<Omit<Voicing, 'id'>>(
      {
        pianoId: result.pianoId,
        type: advice.type,
        parts: advice.parts,
        material: advice.material || advice.partName,
        date: result.checkedDate || new Date().toISOString().slice(0, 10),
        operator: advice.covered ? '厂家保修（待更换）' : '厂家建议（自费）',
        state: '计划'
      },
      'vo'
    );
    await db.voicings.put(row);
    advice.planId = row.id;
    existing.push(row);
    created += 1;
  }
  return created;
}

/** 重算钢琴维修状态：有未完成维修 → 待修，否则正常（停用琴维持停用） */
async function recalcPianoState(pianoId: string): Promise<void> {
  const piano = await db.pianos.get(pianoId);
  if (!piano) return;
  const pending = await db.voicings.where('pianoId').equals(pianoId).filter((row) => row.state !== '已完成').count();
  const state: PianoState = pending > 0 ? '待修' : piano.state === '停用' ? '停用' : '正常';
  await db.pianos.update(pianoId, { state, updatedAt: Date.now() } as never);
}

/** 重算下次建议日期：按本地最新调律日期 + 周期；没有提醒但有调律记录则补建一条 */
async function recalcReminder(pianoId: string): Promise<void> {
  const last = latestTuningDate(await db.tunings.toArray(), pianoId);
  if (!last) return;
  const reminder = await db.reminders.where('pianoId').equals(pianoId).first();
  const cycleMonths = reminder?.cycleMonths ?? 6;
  const nextDueDate = addMonths(last, cycleMonths);
  const state = deriveReminderState(nextDueDate);
  if (reminder) {
    await db.reminders.update(reminder.id, {
      lastTuningDate: last,
      nextDueDate,
      state,
      updatedAt: Date.now()
    } as never);
  } else {
    const row = buildRow<Omit<ReminderRow, 'id' | 'revision' | 'createdAt' | 'updatedAt'>>(
      { pianoId, cycleMonths, lastTuningDate: last, nextDueDate, state },
      'rm'
    );
    await db.reminders.put(row);
  }
}

/**
 * 单事务导入对账结果：写鉴定结论 / 建议部件、生成维修计划、重算状态与下次建议日期、
 * 留存对账报告。任何一步失败，整个 IndexedDB 事务回滚，档案恢复成对账前的样子。
 */
export async function applyReconcileReport(report: ReconcileReport): Promise<ReconciliationRow> {
  return db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.reconciliations],
    async () => {
      const allVoicings = await db.voicings.toArray();
      let createdPlans = 0;
      for (const result of report.results) {
        createdPlans += await ensurePartPlans(result, allVoicings);

        // 厂家建议部件原文全部写进档案（含无法归一化的），去重后「、」连接
        const advisedNames = Array.from(
          new Set(result.parts.map((part) => part.partName).filter((name) => name.length > 0))
        ).join('、');

        await db.pianos.update(result.pianoId, {
          warrantyConclusion: result.conclusion,
          warrantyConclusionRaw: result.conclusionRaw,
          warrantyAdvisedParts: advisedNames,
          warrantyCheckedDate: result.checkedDate,
          warrantyReportNo: result.reportNo,
          updatedAt: Date.now()
        } as never);

        await recalcPianoState(result.pianoId);
        await recalcReminder(result.pianoId);

        // 回写预览值，供落库后页面展示
        const pending = await db.voicings
          .where('pianoId')
          .equals(result.pianoId)
          .filter((row) => row.state !== '已完成')
          .count();
        const piano = await db.pianos.get(result.pianoId);
        const reminder = await db.reminders.where('pianoId').equals(result.pianoId).first();
        result.nextPianoState = pending > 0 ? '待修' : piano?.state === '停用' ? '停用' : '正常';
        result.nextDueDate = reminder?.nextDueDate ?? null;
      }

      report.createdPlans = createdPlans;
      const now = Date.now();
      const row: ReconciliationRow = {
        ...report,
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
      await db.reconciliations.put(row);
      return row;
    }
  );
}

/** 差异可否「采纳厂家」：调律日期缺失、维修缺失 / 冲突支持；其余只能保留本地 */
export function canAdopt(discrepancy: ReconcileDiscrepancy): boolean {
  return (
    discrepancy.status === '待确认' &&
    (discrepancy.type === 'tuning_date_missing' ||
      discrepancy.type === 'service_missing' ||
      discrepancy.type === 'service_mismatch')
  );
}

/**
 * 人工处理一条差异：
 * - adopt：按厂家数据新增一条本地记录（绝不覆盖或删除本地原记录，两边都留）；
 * - keep：保留本地，仅标记差异。
 * 处理完重算该琴维修状态与下次建议日期，并更新对账报告留档。
 */
export async function resolveDiscrepancy(
  reconciliationId: string,
  discrepancyId: string,
  action: 'adopt' | 'keep'
): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.reminders, db.reconciliations], async () => {
    const record = await db.reconciliations.get(reconciliationId);
    if (!record) throw new Error('对账记录不存在');
    const discrepancy = record.discrepancies.find((item) => item.id === discrepancyId);
    if (!discrepancy) throw new Error('差异条目不存在');
    if (discrepancy.status !== '待确认') throw new Error('该差异已确认过');

    let resolvedRecordId: string | null = null;

    if (action === 'adopt') {
      if (discrepancy.pianoId === null) throw new Error('序列号未认到本地钢琴，无法采纳');
      if (discrepancy.type === 'tuning_date_missing') {
        const payload = discrepancy.payload as Extract<ReconcileDiscrepancy['payload'], { receiptTuning: unknown }>;
        const entry = payload.receiptTuning;
        const tuning: Omit<Tuning, 'id'> = {
          pianoId: discrepancy.pianoId,
          date: entry.date,
          basePitchHz: STANDARD_PITCH_HZ,
          avgDeviationCents: 0,
          maxDeviationCents: 0,
          zones: { bass: 0, mid: 0, treble: 0 },
          technician: entry.technician || '厂家回执',
          pitchRaised: false
        };
        const row = buildRow(tuning, 'tn');
        await db.tunings.put(row);
        resolvedRecordId = row.id;
      } else if (discrepancy.type === 'service_missing' || discrepancy.type === 'service_mismatch') {
        const payload = discrepancy.payload as Extract<ReconcileDiscrepancy['payload'], { receiptEntry: WarrantyServiceEntry }>;
        const voicing = voicingFromServiceEntry(discrepancy.pianoId, payload.receiptEntry);
        if (!voicing) throw new Error('厂家维修类型无法识别，不能自动登记，请手工补录');
        const row = buildRow(voicing, 'vo');
        await db.voicings.put(row);
        resolvedRecordId = row.id;
      } else {
        throw new Error('该类差异不能采纳厂家数据');
      }
      await recalcPianoState(discrepancy.pianoId);
      await recalcReminder(discrepancy.pianoId);
    }

    discrepancy.status = action === 'adopt' ? '已采纳厂家' : '保留本地';
    discrepancy.resolvedRecordId = resolvedRecordId;
    discrepancy.resolvedAt = nowIso();
    await db.reconciliations.update(reconciliationId, { discrepancies: record.discrepancies, updatedAt: Date.now() } as never);
  });
}

/** 预览用：鉴定结论徽章配色键 */
export function conclusionBadgeClass(conclusion: string | null): string {
  switch (conclusion) {
    case '可保修':
      return 'bg-emerald-100 text-emerald-700';
    case '可延保':
      return 'bg-sky-100 text-sky-700';
    case '需付费维修':
      return 'bg-amber-100 text-amber-700';
    case '不在保修范围':
      return 'bg-stone-200 text-stone-600';
    default:
      return 'bg-rose-100 text-rose-700';
  }
}

/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbpianotune-db，数据结构版本号 v2（v1 五张表，v2 增加保修回执批次 / 差异表）
 * - 钢琴 / 调律 / 整音维修 / 琴房环境 / 周期提醒 / 保修对账批次 / 对账差异 分表存储
 * - 首次打开自动播种互相引用的演示数据（含超期琴与异常环境），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Piano } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import type { Environment } from '$lib/types/environment';
import type { Reminder } from '$lib/types/reminder';
import type { PlannedVoicing, WarrantyBatch, WarrantyDiff } from '$lib/types/warranty';
import { canonicalPart, canonicalType, type ReconcilePlan } from './warrantyReconcile';
import { addMonths, deriveReminderState } from '$lib/types/reminder';
import { nowIso, createId, today } from './uuid';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbpianotune-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 1;

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type PianoRow = Piano & Revisioned;
export type TuningRow = Tuning & Revisioned;
export type VoicingRow = Voicing & Revisioned;
export type EnvironmentRow = Environment & Revisioned;
export type ReminderRow = Reminder & Revisioned;
export type WarrantyBatchRow = WarrantyBatch & Revisioned;
export type WarrantyDiffRow = WarrantyDiff & Revisioned;

class GbPianoTuneDatabase extends Dexie {
  pianos!: Table<PianoRow, string>;
  tunings!: Table<TuningRow, string>;
  voicings!: Table<VoicingRow, string>;
  environments!: Table<EnvironmentRow, string>;
  reminders!: Table<ReminderRow, string>;
  warrantyBatches!: Table<WarrantyBatchRow, string>;
  warrantyDiffs!: Table<WarrantyDiffRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版五张表；升级到 v2 时保留历史行（鉴定字段为可选，无需回填）
    this.version(1)
      .stores({
        pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
        tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
        voicings: 'id, pianoId, type, parts, state, date, updatedAt',
        environments: 'id, pianoId, date, device, abnormal, updatedAt',
        reminders: 'id, pianoId, state, nextDueDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['pianos', 'tunings', 'voicings', 'environments', 'reminders'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });

    // v2：新增厂家保修回执的对账批次与差异表（新表无需搬数据，Dexie 自动建表建索引）
    this.version(2).stores({
      pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
      tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
      voicings: 'id, pianoId, type, parts, state, date, updatedAt',
      environments: 'id, pianoId, date, device, abnormal, updatedAt',
      reminders: 'id, pianoId, state, nextDueDate, updatedAt',
      warrantyBatches: 'id, receiptNo, issuedAt, importedAt',
      warrantyDiffs: 'id, batchId, pianoId, serialNo, kind, status, updatedAt'
    });
  }
}

export const db = new GbPianoTuneDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.pianos.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 钢琴 ------------------------------ */

export async function listPianos(): Promise<PianoRow[]> {
  const rows = await db.pianos.toArray();
  return rows.sort((a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN') || a.model.localeCompare(b.model, 'zh-Hans-CN'));
}

export async function putPiano(row: PianoRow): Promise<void> {
  await db.pianos.put(row);
}

export async function updatePiano(id: string, patch: Partial<Piano>): Promise<void> {
  await db.pianos.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除钢琴：级联删除其调律 / 维修 / 环境 / 提醒及对账差异 */
export async function removePiano(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.warrantyDiffs],
    async () => {
      await db.tunings.where('pianoId').equals(id).delete();
      await db.voicings.where('pianoId').equals(id).delete();
      await db.environments.where('pianoId').equals(id).delete();
      await db.reminders.where('pianoId').equals(id).delete();
      await db.warrantyDiffs.where('pianoId').equals(id).delete();
      await db.pianos.delete(id);
    }
  );
}

/* ------------------------------ 调律 ------------------------------ */

export async function listTunings(): Promise<TuningRow[]> {
  const rows = await db.tunings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putTuning(row: TuningRow): Promise<void> {
  await db.tunings.put(row);
}

export async function updateTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await db.tunings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeTuning(id: string): Promise<void> {
  await db.tunings.delete(id);
}

/* --------------------------- 整音与维修 --------------------------- */

export async function listVoicings(): Promise<VoicingRow[]> {
  const rows = await db.voicings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putVoicing(row: VoicingRow): Promise<void> {
  await db.voicings.put(row);
}

export async function updateVoicing(id: string, patch: Partial<Voicing>): Promise<void> {
  await db.voicings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 完成维修：回写钢琴状态（全部完成则置为正常，否则置为待修） */
export async function completeVoicing(id: string): Promise<void> {
  await db.transaction('rw', [db.voicings, db.pianos], async () => {
    const voicing = await db.voicings.get(id);
    if (!voicing) throw new Error('维修记录不存在');
    await db.voicings.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.voicings
      .where('pianoId')
      .equals(voicing.pianoId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.pianos.update(voicing.pianoId, {
      state: pending === 0 ? '正常' : '待修',
      updatedAt: Date.now()
    } as never);
  });
}

/** 新建维修计划时把钢琴置为待修 */
export async function markPianoPending(pianoId: string): Promise<void> {
  await db.pianos.update(pianoId, { state: '待修', updatedAt: Date.now() } as never);
}

export async function removeVoicing(id: string): Promise<void> {
  await db.voicings.delete(id);
}

/* ---------------------------- 琴房环境 ---------------------------- */

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.environments.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putEnvironment(row: EnvironmentRow): Promise<void> {
  await db.environments.put(row);
}

export async function updateEnvironment(id: string, patch: Partial<Environment>): Promise<void> {
  await db.environments.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeEnvironment(id: string): Promise<void> {
  await db.environments.delete(id);
}

/* ---------------------------- 周期提醒 ---------------------------- */

export async function listReminders(): Promise<ReminderRow[]> {
  const rows = await db.reminders.toArray();
  return rows.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}

export async function putReminder(row: ReminderRow): Promise<void> {
  await db.reminders.put(row);
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<void> {
  await db.reminders.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeReminder(id: string): Promise<void> {
  await db.reminders.delete(id);
}

/* --------------------------- 厂家回执对账 --------------------------- */

export async function listWarrantyBatches(): Promise<WarrantyBatchRow[]> {
  const rows = await db.warrantyBatches.toArray();
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function listWarrantyDiffs(): Promise<WarrantyDiffRow[]> {
  const rows = await db.warrantyDiffs.toArray();
  // 待确认在前，再按批次、种类稳定排序
  return rows.sort(
    (a, b) =>
      (a.status === '待确认' ? 0 : 1) - (b.status === '待确认' ? 0 : 1) ||
      b.batchId.localeCompare(a.batchId) ||
      a.kind.localeCompare(b.kind)
  );
}

function stampVoicing(
  plan: PlannedVoicing,
  batchId: string
): VoicingRow {
  const now = Date.now();
  return {
    id: createId('vo'),
    pianoId: plan.pianoId,
    type: plan.type as Voicing['type'],
    parts: plan.parts as Voicing['parts'],
    material: plan.material,
    date: plan.date,
    operator: plan.operator,
    state: '计划',
    source: 'warranty',
    warrantyBatchId: batchId,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 按当前调律 / 维修数据重算钢琴维修状态与下次建议日期。
 * - 停用琴不自动改状态；有待完成维修 → 待修，否则 → 正常；
 * - 提醒的上次调律日期取本地最近调律（回执调律日期有差异时只登记差异，不覆盖本地）；
 * - 没有提醒记录则按 6 个月周期新建。
 */
async function recalcPianoAndReminder(pianoId: string): Promise<void> {
  const now = Date.now();
  const piano = await db.pianos.get(pianoId);
  if (!piano) return;

  if (piano.state !== '停用') {
    const pending = await db.voicings
      .where('pianoId')
      .equals(pianoId)
      .filter((item) => item.state !== '已完成')
      .count();
    const nextState = pending > 0 ? '待修' : '正常';
    if (piano.state !== nextState) {
      await db.pianos.update(pianoId, { state: nextState, updatedAt: now } as never);
    }
  }

  const lastTuning = (await db.tunings.where('pianoId').equals(pianoId).toArray()).sort((a, b) =>
    b.date.localeCompare(a.date)
  )[0];
  const reminder = await db.reminders.where('pianoId').equals(pianoId).first();
  if (lastTuning) {
    const cycleMonths = reminder?.cycleMonths ?? 6;
    const nextDueDate = addMonths(lastTuning.date, cycleMonths);
    const state = deriveReminderState(nextDueDate);
    if (reminder) {
      await db.reminders.update(reminder.id, {
        lastTuningDate: lastTuning.date,
        nextDueDate,
        state,
        updatedAt: now
      } as never);
    } else {
      await db.reminders.put({
        id: createId('rm'),
        pianoId,
        cycleMonths: 6,
        lastTuningDate: lastTuning.date,
        nextDueDate,
        state,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      });
    }
  }
}

/**
 * 落库一次对账结果。全程单个可读写事务：
 * 任何一步失败（含校验阶段抛错）Dexie 都会回滚，本地数据恢复成对账前的样子。
 */
export async function commitWarrantyReconcile(plan: ReconcilePlan): Promise<{
  batchId: string;
  updatedPianoCount: number;
  createdPlanCount: number;
  diffCount: number;
}> {
  const now = Date.now();
  const batchId = createId('wb');
  const affectedPianoIds = Array.from(new Set(plan.matched.map((item) => item.pianoId)));

  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.reminders, db.warrantyBatches, db.warrantyDiffs],
    async () => {
      // 1) 鉴定结论 / 建议部件写回钢琴档案
      for (const { pianoId, patch } of plan.pianoPatches) {
        await db.pianos.update(pianoId, { ...patch, updatedAt: now } as never);
      }

      // 2) 该换的部件生成维修计划
      for (const voicingPlan of plan.newVoicings) {
        await db.voicings.put(stampVoicing(voicingPlan, batchId));
      }

      // 3) 对不上的调律 / 维修两边都留，登记差异等人确认
      for (const item of plan.diffs) {
        await db.warrantyDiffs.put({
          id: createId('wd'),
          batchId,
          pianoId: item.pianoId,
          serialNo: item.serialNo,
          kind: item.kind,
          detail: item.detail,
          localValue: item.localValue,
          receiptValue: item.receiptValue,
          ...(item.receiptWork ? { receiptWork: item.receiptWork } : {}),
          status: '待确认',
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        });
      }

      // 4) 档案一更新就重算维修状态与下次建议日期
      for (const pianoId of affectedPianoIds) {
        await recalcPianoAndReminder(pianoId);
      }

      // 5) 批次留档
      const batch: WarrantyBatchRow = {
        id: batchId,
        receiptNo: plan.receipt.receiptNo ?? '',
        issuedAt: plan.receipt.issuedAt ?? '',
        manufacturer: plan.receipt.manufacturer ?? '',
        importedAt: nowIso(),
        itemCount: plan.receipt.items.length,
        matchedCount: plan.matched.length,
        updatedPianoCount: plan.pianoPatches.length,
        createdPlanCount: plan.newVoicings.length,
        diffCount: plan.diffs.length,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      };
      await db.warrantyBatches.put(batch);
    }
  );

  return {
    batchId,
    updatedPianoCount: plan.pianoPatches.length,
    createdPlanCount: plan.newVoicings.length,
    diffCount: plan.diffs.length
  };
}

/** 标记差异确认状态（人工核对后点确认；两边原值仍保留） */
export async function setWarrantyDiffStatus(
  id: string,
  status: WarrantyDiff['status']
): Promise<void> {
  await db.warrantyDiffs.update(id, {
    status,
    ...(status === '已确认' ? { confirmedAt: nowIso() } : { confirmedAt: '' }),
    updatedAt: Date.now()
  } as never);
}

/**
 * 把「维修条目仅回执有」的差异采纳为本地维修计划（两边都留的前提下补登本地）。
 * 采纳后重算该琴的维修状态与下次建议日期；同样在事务内完成，失败即回滚。
 */
export async function adoptReceiptWorkDiff(diffId: string): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', [db.warrantyDiffs, db.voicings, db.pianos, db.tunings, db.reminders], async () => {
    const diffRow = await db.warrantyDiffs.get(diffId);
    if (!diffRow) throw new Error('差异记录不存在');
    const work = diffRow.receiptWork;
    if (!work) throw new Error('该差异不附带回执维修条目，无法采纳');
    const type = canonicalType(work.type);
    const part = canonicalPart(work.part);
    if (!type || !part) {
      throw new Error(`回执条目「${work.type} / ${work.part}」无法映射为本地维修类型 / 部件，请在维修页手工补登`);
    }

    await db.voicings.put({
      id: createId('vo'),
      pianoId: diffRow.pianoId,
      type,
      parts: part,
      material: work.material ?? '厂家回执补登',
      date: work.date || today(),
      operator: work.operator ?? '厂家回执',
      state: '计划',
      source: 'warranty',
      warrantyBatchId: diffRow.batchId,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    });
    await db.warrantyDiffs.update(diffId, { status: '已确认', confirmedAt: nowIso(), updatedAt: now } as never);
    await recalcPianoAndReminder(diffRow.pianoId);
  });
}

export async function removeWarrantyDiff(id: string): Promise<void> {
  await db.warrantyDiffs.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  pianos: Piano[];
  tunings: Tuning[];
  voicings: Voicing[];
  environments: Environment[];
  reminders: Reminder[];
  warrantyBatches: WarrantyBatch[];
  warrantyDiffs: WarrantyDiff[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [pianos, tunings, voicings, environments, reminders, warrantyBatches, warrantyDiffs] = await Promise.all([
    db.pianos.toArray(),
    db.tunings.toArray(),
    db.voicings.toArray(),
    db.environments.toArray(),
    db.reminders.toArray(),
    db.warrantyBatches.toArray(),
    db.warrantyDiffs.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    pianos: pianos.map(stripRow),
    tunings: tunings.map(stripRow),
    voicings: voicings.map(stripRow),
    environments: environments.map(stripRow),
    reminders: reminders.map(stripRow),
    warrantyBatches: warrantyBatches.map(stripRow),
    warrantyDiffs: warrantyDiffs.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.warrantyBatches, db.warrantyDiffs],
    async () => {
      await Promise.all([
        db.pianos.clear(),
        db.tunings.clear(),
        db.voicings.clear(),
        db.environments.clear(),
        db.reminders.clear(),
        db.warrantyBatches.clear(),
        db.warrantyDiffs.clear()
      ]);
      await db.pianos.bulkPut(snapshot.pianos.map(stamp));
      await db.tunings.bulkPut(snapshot.tunings.map(stamp));
      await db.voicings.bulkPut(snapshot.voicings.map(stamp));
      await db.environments.bulkPut(snapshot.environments.map(stamp));
      await db.reminders.bulkPut(snapshot.reminders.map(stamp));
      // 兼容旧版备份（无对账表字段）
      if (Array.isArray(snapshot.warrantyBatches)) {
        await db.warrantyBatches.bulkPut(snapshot.warrantyBatches.map(stamp));
      }
      if (Array.isArray(snapshot.warrantyDiffs)) {
        await db.warrantyDiffs.bulkPut(snapshot.warrantyDiffs.map(stamp));
      }
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.warrantyBatches, db.warrantyDiffs],
    async () => {
      await Promise.all([
        db.pianos.clear(),
        db.tunings.clear(),
        db.voicings.clear(),
        db.environments.clear(),
        db.reminders.clear(),
        db.warrantyBatches.clear(),
        db.warrantyDiffs.clear()
      ]);
    }
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [pianos, tunings, voicings, environments, reminders, warrantyBatches, warrantyDiffs] = await Promise.all([
    db.pianos.count(),
    db.tunings.count(),
    db.voicings.count(),
    db.environments.count(),
    db.reminders.count(),
    db.warrantyBatches.count(),
    db.warrantyDiffs.count()
  ]);
  return { pianos, tunings, voicings, environments, reminders, warrantyBatches, warrantyDiffs };
}

/**
 * 厂家保修回执对账 store：维护最近一次导入的对账报告与错误状态。
 * 页面只读 store 并调用动作函数，落库 / 回滚 / 差异解决都在 utils 层。
 */
import { writable, type Writable } from 'svelte/store';
import type { WarrantyReceipt } from '$lib/types/warranty';
import type { ReconcileReport } from '$lib/types/reconciliation';
import type { ReconciliationRow } from '$lib/utils/db';
import {
  applyReconcileReport,
  buildReconcileReport,
  resolveDiscrepancy as resolveDiscrepancyRow
} from '$lib/utils/reconcile';
import {
  removeReconciliation as removeReconciliationRow,
  type PianoRow,
  type ReminderRow,
  type TuningRow,
  type VoicingRow
} from '$lib/utils/db';

/** 解析并预览后的报告（尚未落库） */
export const draftReport: Writable<ReconcileReport | null> = writable(null);
/** 导入 / 差异处理过程中的错误 */
export const warrantyError: Writable<string | null> = writable(null);
/** 是否正在执行导入事务 */
export const warrantyBusy: Writable<boolean> = writable(false);
/** 最近一次成功导入的对账留档 */
export const lastImported: Writable<ReconciliationRow | null> = writable(null);

interface LocalTables {
  pianos: PianoRow[];
  tunings: TuningRow[];
  voicings: VoicingRow[];
  reminders: ReminderRow[];
}

/** 纯预览：回执 × 本地档案 → 对账报告（不写库） */
export function previewReceipt(receipt: WarrantyReceipt, local: LocalTables): ReconcileReport {
  const report = buildReconcileReport(receipt, local);
  draftReport.set(report);
  return report;
}

export function clearDraft(): void {
  draftReport.set(null);
  warrantyError.set(null);
}

/**
 * 正式导入：单事务落库。中途任何失败都由 Dexie 整体回滚，
 * 档案恢复成对账前的样子，错误抛给页面展示。
 */
export async function importReceipt(report: ReconcileReport): Promise<ReconciliationRow> {
  warrantyBusy.set(true);
  warrantyError.set(null);
  try {
    const saved = await applyReconcileReport(report);
    lastImported.set(saved);
    draftReport.set(null);
    return saved;
  } catch (error) {
    warrantyError.set(error instanceof Error ? error.message : '导入失败，已恢复成对账前的数据');
    throw error;
  } finally {
    warrantyBusy.set(false);
  }
}

/** 人工处理差异：adopt 采纳厂家并新增本地记录，keep 保留本地 */
export async function resolveDiscrepancy(
  reconciliationId: string,
  discrepancyId: string,
  action: 'adopt' | 'keep'
): Promise<void> {
  warrantyBusy.set(true);
  warrantyError.set(null);
  try {
    await resolveDiscrepancyRow(reconciliationId, discrepancyId, action);
  } catch (error) {
    warrantyError.set(error instanceof Error ? error.message : '差异处理失败');
    throw error;
  } finally {
    warrantyBusy.set(false);
  }
}

export async function deleteReconciliation(id: string): Promise<void> {
  await removeReconciliationRow(id);
}

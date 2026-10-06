/**
 * 厂家保修回执对账 store：解析回执 → 纯函数对账规划 → 事务落库。
 * 页面只读 diffs / batches store 并调用动作函数；失败时持久化层事务整体回滚。
 */
import { writable, type Writable } from 'svelte/store';
import type { WarrantyDiffKind, WarrantyDiffStatus, WarrantyReceipt } from '$lib/types/warranty';
import type { ReconcilePlan } from '$lib/utils/warrantyReconcile';
import {
  adoptReceiptWorkDiff,
  commitWarrantyReconcile,
  removeWarrantyDiff,
  setWarrantyDiffStatus
} from '$lib/utils/db';
import { parseWarrantyReceipt } from '$lib/utils/warrantyReceipt';
import { planWarrantyReconcile, type LocalPianoSnapshot } from '$lib/utils/warrantyReconcile';

/** 最近一次导入结果提示（成功统计 / 失败信息），页面顶部展示 */
export interface WarrantyImportNotice {
  tone: 'success' | 'error';
  text: string;
}

/** 差异筛选：按种类与状态 */
export interface WarrantyDiffFilters {
  kinds: WarrantyDiffKind[];
  statuses: WarrantyDiffStatus[];
  keyword: string;
}

export const warrantyDiffFilters: Writable<WarrantyDiffFilters> = writable({
  kinds: [],
  statuses: [],
  keyword: ''
});

export function setWarrantyDiffFilters(next: WarrantyDiffFilters): void {
  warrantyDiffFilters.set(next);
}

export function resetWarrantyDiffFilters(): void {
  warrantyDiffFilters.set({ kinds: [], statuses: [], keyword: '' });
}

/**
 * 导入回执文本并对账：
 * 先在内存里解析 + 对账，再由持久化层单事务落库；
 * 任一步抛错都不会改动本地数据（事务回滚），错误信息回传页面。
 */
export async function importWarrantyReceipt(
  text: string,
  snapshots: LocalPianoSnapshot[]
): Promise<{ plan: ReconcilePlan; batchId: string }> {
  // 解析校验失败直接抛出，尚未触碰数据库
  const receipt: WarrantyReceipt = parseWarrantyReceipt(text);
  // 对账规划为纯函数，序列号重复等结构性错误在这里抛出，同样不落库
  const plan = planWarrantyReconcile(receipt, snapshots);
  const result = await commitWarrantyReconcile(plan);
  return { plan, batchId: result.batchId };
}

/** 人工核对完一条差异：两边原值保留，仅标记确认 */
export async function confirmWarrantyDiff(id: string): Promise<void> {
  await setWarrantyDiffStatus(id, '已确认');
}

/** 撤销确认（重新挂起） */
export async function reopenWarrantyDiff(id: string): Promise<void> {
  await setWarrantyDiffStatus(id, '待确认');
}

/** 把「维修条目仅回执有」的差异采纳为本地维修计划 */
export async function adoptWarrantyWork(id: string): Promise<void> {
  await adoptReceiptWorkDiff(id);
}

export async function deleteWarrantyDiff(id: string): Promise<void> {
  await removeWarrantyDiff(id);
}

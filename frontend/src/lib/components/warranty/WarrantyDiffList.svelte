<script lang="ts">
  /**
   * WarrantyDiffList：厂家回执对账差异清单。
   * 对不上的调律日期 / 维修条目两边原值并排展示，等人确认；
   * 「维修条目仅回执有」的差异可顺手采纳为本地维修计划。
   */
  import type { WarrantyDiffRow, PianoRow, WarrantyBatchRow } from '$lib/utils/db';
  import { WARRANTY_DIFF_KINDS, WARRANTY_DIFF_LABELS, type WarrantyDiffKind } from '$lib/types/warranty';

  let {
    diffs,
    batches,
    pianos,
    onconfirm,
    onreopen,
    onadopt,
    ondelete,
    busy = false
  }: {
    diffs: WarrantyDiffRow[];
    batches: WarrantyBatchRow[];
    pianos: PianoRow[];
    onconfirm: (id: string) => void;
    onreopen: (id: string) => void;
    onadopt: (id: string) => void;
    ondelete: (id: string) => void;
    busy?: boolean;
  } = $props();

  const KIND_ORDER: WarrantyDiffKind[] = WARRANTY_DIFF_KINDS;

  const KIND_TONE: Record<WarrantyDiffKind, string> = {
    'serial-not-found': 'bg-rose-100 text-rose-700',
    'tuning-date-mismatch': 'bg-amber-100 text-amber-700',
    'tuning-date-receipt-only': 'bg-amber-100 text-amber-700',
    'work-item-receipt-only': 'bg-amber-100 text-amber-700',
    'work-item-local-only': 'bg-stone-200 text-stone-700',
    'work-date-mismatch': 'bg-amber-100 text-amber-700',
    'part-unmappable': 'bg-rose-100 text-rose-700'
  };

  const kindOf = (kind: string): WarrantyDiffKind => (KIND_ORDER.includes(kind as WarrantyDiffKind) ? (kind as WarrantyDiffKind) : 'serial-not-found');

  function pianoLabel(diff: WarrantyDiffRow): string {
    if (!diff.pianoId) return '—';
    const piano = pianos.find((item) => item.id === diff.pianoId);
    return piano ? `${piano.brand} ${piano.model}` : '钢琴已删除';
  }

  function batchLabel(diff: WarrantyDiffRow): string {
    const batch = batches.find((item) => item.id === diff.batchId);
    if (!batch) return diff.batchId.slice(0, 10);
    return `${batch.receiptNo || '无编号'} · ${batch.importedAt.slice(0, 10)}`;
  }
</script>

{#if diffs.length === 0}
  <div class="card text-sm text-stone-500">没有符合条件的对账差异。</div>
{:else}
  <div class="card overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
        <tr>
          <th class="py-2">状态</th>
          <th class="py-2">种类</th>
          <th class="py-2">钢琴 / 序列号</th>
          <th class="py-2">本地原值</th>
          <th class="py-2">回执原值</th>
          <th class="py-2">说明 / 批次</th>
          <th class="py-2">操作</th>
        </tr>
      </thead>
      <tbody>
        {#each diffs as diff (diff.id)}
          {@const kind = kindOf(diff.kind)}
          <tr class="border-b border-stone-100 align-top {diff.status === '待确认' ? '' : 'opacity-60'}">
            <td class="py-2">
              <span
                class="rounded-full px-2 py-0.5 text-xs {diff.status === '待确认'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-emerald-100 text-emerald-700'}">{diff.status}</span
              >
            </td>
            <td class="py-2">
              <span class="rounded-full px-2 py-0.5 text-xs {KIND_TONE[kind]}">{WARRANTY_DIFF_LABELS[kind]}</span>
            </td>
            <td class="py-2">
              <div>{pianoLabel(diff)}</div>
              <div class="text-xs text-stone-400">{diff.serialNo || '—'}</div>
            </td>
            <td class="py-2 text-xs text-stone-600">{diff.localValue || '（无）'}</td>
            <td class="py-2 text-xs text-stone-600">{diff.receiptValue || '（无）'}</td>
            <td class="py-2">
              <div class="text-xs text-stone-500">{diff.detail}</div>
              <div class="mt-1 text-[11px] text-stone-400">{batchLabel(diff)}</div>
            </td>
            <td class="py-2 whitespace-nowrap">
              {#if diff.status === '待确认'}
                {#if kind === 'work-item-receipt-only'}
                  <button type="button" class="btn mr-2" disabled={busy} onclick={() => onadopt(diff.id)}>采纳为维修计划</button>
                {/if}
                <button type="button" class="btn mr-2" disabled={busy} onclick={() => onconfirm(diff.id)}>确认保留两边</button>
                <button type="button" class="btn-danger" disabled={busy} onclick={() => ondelete(diff.id)}>删除</button>
              {:else}
                <button type="button" class="btn mr-2" disabled={busy} onclick={() => onreopen(diff.id)}>重新挂起</button>
                <button type="button" class="btn-danger" disabled={busy} onclick={() => ondelete(diff.id)}>删除</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

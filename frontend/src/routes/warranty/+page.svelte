<script lang="ts">
  /** /warranty 厂家保修鉴定回执对账：导入回执 → 按序列号认琴 → 写档 / 出计划 / 差异待确认 */
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import WarrantyImportPanel from '$lib/components/warranty/WarrantyImportPanel.svelte';
  import WarrantyDiffList from '$lib/components/warranty/WarrantyDiffList.svelte';
  import WarrantyBatchHistory from '$lib/components/warranty/WarrantyBatchHistory.svelte';
  import {
    db,
    type PianoRow,
    type TuningRow,
    type VoicingRow,
    type WarrantyBatchRow,
    type WarrantyDiffRow
  } from '$lib/utils/db';
  import { WARRANTY_DIFF_KINDS, WARRANTY_DIFF_LABELS, WARRANTY_DIFF_STATUSES } from '$lib/types/warranty';
  import {
    adoptWarrantyWork,
    confirmWarrantyDiff,
    deleteWarrantyDiff,
    importWarrantyReceipt,
    reopenWarrantyDiff,
    resetWarrantyDiffFilters,
    setWarrantyDiffFilters,
    warrantyDiffFilters,
    type WarrantyImportNotice
  } from '$lib/stores/warrantyStore';
  import type { LocalPianoSnapshot } from '$lib/utils/warrantyReconcile';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings);
  const voicings = useIdbTable<VoicingRow>(db.voicings);
  const batches = useIdbTable<WarrantyBatchRow>(db.warrantyBatches, (a, b) =>
    b.importedAt.localeCompare(a.importedAt)
  );
  const diffs = useIdbTable<WarrantyDiffRow>(db.warrantyDiffs);

  let importing = $state(false);
  let importError = $state<string | null>(null);
  let notice = $state<WarrantyImportNotice | null>(null);
  let busy = $state(false);

  const pendingCount = $derived($diffs.filter((item) => item.status === '待确认').length);
  const confirmedCount = $derived($diffs.length - pendingCount);

  function toggleKind(kind: (typeof WARRANTY_DIFF_KINDS)[number]): void {
    const current = $warrantyDiffFilters.kinds;
    const next = current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind];
    setWarrantyDiffFilters({ ...$warrantyDiffFilters, kinds: next });
  }

  function toggleStatus(status: (typeof WARRANTY_DIFF_STATUSES)[number]): void {
    const current = $warrantyDiffFilters.statuses;
    const next = current.includes(status) ? current.filter((item) => item !== status) : [...current, status];
    setWarrantyDiffFilters({ ...$warrantyDiffFilters, statuses: next });
  }

  function onKeyword(event: Event): void {
    const keyword = (event.currentTarget as HTMLInputElement).value;
    setWarrantyDiffFilters({ ...$warrantyDiffFilters, keyword });
  }

  const filteredDiffs = $derived.by(() =>
    $diffs.filter((diff) => {
      const keyword = String($warrantyDiffFilters.keyword ?? '').trim().toLowerCase();
      const kinds = $warrantyDiffFilters.kinds;
      const statuses = $warrantyDiffFilters.statuses;
      if (kinds.length > 0 && !kinds.includes(diff.kind)) return false;
      if (statuses.length > 0 && !statuses.includes(diff.status)) return false;
      if (keyword) {
        const piano = $pianos.find((item) => item.id === diff.pianoId);
        const label =
          `${diff.serialNo} ${diff.detail} ${diff.localValue} ${diff.receiptValue} ${piano?.brand ?? ''} ${piano?.model ?? ''}`.toLowerCase();
        if (!label.includes(keyword)) return false;
      }
      return true;
    })
  );

  function buildSnapshots(): LocalPianoSnapshot[] {
    return $pianos.map((piano) => ({
      piano,
      tunings: $tunings.filter((item) => item.pianoId === piano.id),
      voicings: $voicings.filter((item) => item.pianoId === piano.id)
    }));
  }

  async function handleImport(text: string): Promise<void> {
    importing = true;
    importError = null;
    notice = null;
    try {
      const { plan, batchId } = await importWarrantyReceipt(text, buildSnapshots());
      notice = {
        tone: 'success',
        text:
          `批次 ${batchId.slice(0, 10)} 对账完成：回执 ${plan.receipt.items.length} 条，认到 ${plan.matched.length} 台琴，` +
          `写回档案 ${plan.pianoPatches.length} 份，生成维修计划 ${plan.newVoicings.length} 条，` +
          `产生差异 ${plan.diffs.length} 条（${plan.diffs.length > 0 ? '请在下方逐条确认' : '全部对得上'}）。`
      };
    } catch (error) {
      // 解析或事务任一步失败：未落库 / 已回滚，本地仍是对账前的数据
      importError = error instanceof Error ? error.message : '导入失败，本地数据未改动';
      notice = { tone: 'error', text: '导入失败，已恢复成对账前的样子，本地数据没有任何改动。' };
    } finally {
      importing = false;
    }
  }

  async function guard(action: () => Promise<void>): Promise<void> {
    busy = true;
    try {
      await action();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '操作失败');
    } finally {
      busy = false;
    }
  }

  function onConfirm(id: string): void {
    void guard(() => confirmWarrantyDiff(id));
  }
  function onReopen(id: string): void {
    void guard(() => reopenWarrantyDiff(id));
  }
  function onAdopt(id: string): void {
    if (!window.confirm('把这条回执维修条目补登为本地维修计划？补登后该琴维修状态会重算。')) return;
    void guard(() => adoptWarrantyWork(id));
  }
  function onDelete(id: string): void {
    if (!window.confirm('删除这条差异记录？两边的原始档案数据不受影响。')) return;
    void guard(() => deleteWarrantyDiff(id));
  }
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">厂家保修鉴定回执对账</h2>
      <p class="page-subtitle">
        琴行把钢琴档案交厂家保修鉴定后，在这里导入回执：按序列号认琴，鉴定结论与建议部件写回档案，该换的部件顺手生成维修计划。
      </p>
    </div>
  </div>

  <div class="badge-row">
    <StatBadge label="对账批次" value={$batches.length} suffix="次" tone="walnut" icon="📩" />
    <StatBadge label="差异总数" value={$diffs.length} suffix="条" tone="brass" icon="⇄" />
    <StatBadge label="待确认" value={pendingCount} suffix="条" tone="amber" icon="!" />
    <StatBadge label="已确认" value={confirmedCount} suffix="条" tone="green" icon="✓" />
    <StatBadge label="在保琴档" value={$pianos.filter((p) => p.warrantyConclusion).length} suffix="台" tone="slate" icon="🛡" />
  </div>

  {#if notice}
    <div
      class="mb-4 rounded-lg border px-4 py-2 text-sm {notice.tone === 'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-rose-200 bg-rose-50 text-rose-700'}"
    >
      {notice.text}
    </div>
  {/if}

  <WarrantyImportPanel {importing} {importError} onimport={(text) => void handleImport(text)} onclearerror={() => (importError = null)} />

  <div class="mt-6">
    <div class="card-title mb-3">
      <span>对账差异（两边原值都留，等人确认）</span>
      <span class="muted">调律日期 / 维修条目对不上时在此核对</span>
    </div>

    <div class="card mb-4 flex flex-wrap items-center gap-2">
      <input
        class="field max-w-xs"
        type="search"
        placeholder="搜索序列号 / 钢琴 / 差异内容…"
        value={$warrantyDiffFilters.keyword}
        oninput={onKeyword}
      />
      <span class="text-xs text-stone-500">种类：</span>
      {#each WARRANTY_DIFF_KINDS as kind (kind)}
        <button
          type="button"
          class="rounded-full border px-2.5 py-1 text-xs transition {$warrantyDiffFilters.kinds.includes(kind)
            ? 'border-walnut bg-walnut text-white'
            : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50'}"
          onclick={() => toggleKind(kind)}
        >
          {WARRANTY_DIFF_LABELS[kind]}
        </button>
      {/each}
      <span class="ml-2 text-xs text-stone-500">状态：</span>
      {#each WARRANTY_DIFF_STATUSES as status (status)}
        <button
          type="button"
          class="rounded-full border px-2.5 py-1 text-xs transition {$warrantyDiffFilters.statuses.includes(status)
            ? 'border-walnut bg-walnut text-white'
            : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50'}"
          onclick={() => toggleStatus(status)}
        >
          {status}
        </button>
      {/each}
      <button type="button" class="btn ml-auto" onclick={resetWarrantyDiffFilters}>清空筛选</button>
    </div>

    <WarrantyDiffList
      diffs={filteredDiffs}
      batches={$batches}
      pianos={$pianos}
      busy={busy}
      onconfirm={onConfirm}
      onreopen={onReopen}
      onadopt={onAdopt}
      ondelete={onDelete}
    />
  </div>

  <div class="mt-6">
    <WarrantyBatchHistory batches={$batches} />
  </div>
</div>

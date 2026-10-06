<script lang="ts">
  /** /warranty 厂家保修鉴定回执对账：按序列号认琴、写鉴定结论与建议部件、顺手生成维修计划、列差异等人确认 */
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import {
    db,
    type PianoRow,
    type ReconciliationRow,
    type ReminderRow,
    type TuningRow,
    type VoicingRow
  } from '$lib/utils/db';
  import {
    buildSampleReceipt,
    parseWarrantyReceipt,
    readReceiptFile
  } from '$lib/utils/warranty';
  import { canAdopt, conclusionBadgeClass } from '$lib/utils/reconcile';
  import {
    clearDraft,
    deleteReconciliation,
    draftReport,
    importReceipt,
    previewReceipt,
    resolveDiscrepancy,
    warrantyBusy,
    warrantyError
  } from '$lib/stores/warrantyStore';
  import type {
    ReconcileDiscrepancy,
    ReconcileItemResult,
    ServiceMissingDiscrepancyPayload,
    ServiceMismatchDiscrepancyPayload,
    TuningDateDiscrepancyPayload
  } from '$lib/types/reconciliation';
  import { downloadJson } from '$lib/utils/export';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));
  const voicings = useIdbTable<VoicingRow>(db.voicings, (a, b) => b.date.localeCompare(a.date));
  const reminders = useIdbTable<ReminderRow>(db.reminders);
  const history = useIdbTable<ReconciliationRow>(db.reconciliations, (a, b) => b.importedAt.localeCompare(a.importedAt));

  let pasteText = $state('');
  let parseError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let expandedId = $state<string | null>(null);

  const pendingCount = $derived(
    $history.reduce((sum, record) => sum + record.discrepancies.filter((item) => item.status === '待确认').length, 0)
  );
  const draftPlanCount = $derived(
    $draftReport?.results.reduce((sum, item) => sum + item.parts.filter((part) => part.type !== null).length, 0) ?? 0
  );

  const DISCREPANCY_LABELS: Record<ReconcileDiscrepancy['type'], string> = {
    serial_not_found: '序列号未匹配',
    tuning_date_missing: '调律日期缺失',
    service_missing: '维修条目缺失',
    service_mismatch: '维修条目冲突',
    part_unmapped: '部件无法归类',
    conclusion_unknown: '结论待确认'
  };

  function pianoOf(pianoId: string): PianoRow | null {
    return $pianos.find((item) => item.id === pianoId) ?? null;
  }

  function pianoLabel(pianoId: string): string {
    const piano = pianoOf(pianoId);
    return piano ? `${piano.brand} ${piano.model}（${piano.serialNo}）` : '钢琴已删除';
  }

  function discrepancyLabel(type: ReconcileDiscrepancy['type']): string {
    return DISCREPANCY_LABELS[type];
  }

  function openFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void handleText(readReceiptFile(file), file.name);
    };
    input.click();
  }

  async function handleText(textPromise: Promise<string>, source: string): Promise<void> {
    parseError = null;
    notice = null;
    try {
      const text = await textPromise;
      const receipt = parseWarrantyReceipt(text);
      previewReceipt(receipt, { pianos: $pianos, tunings: $tunings, voicings: $voicings, reminders: $reminders });
      notice = `已解析「${source}」，请核对下方对账预览，确认无误后再写入档案。`;
    } catch (error) {
      clearDraft();
      parseError = error instanceof Error ? error.message : '回执解析失败';
    }
  }

  function previewPasted(): void {
    if (!pasteText.trim()) {
      parseError = '请先粘贴回执 JSON 内容';
      return;
    }
    void handleText(Promise.resolve(pasteText), '粘贴的回执');
  }

  function downloadSample(): void {
    const receipt = buildSampleReceipt();
    downloadJson('厂家保修鉴定回执-示例.json', JSON.stringify(receipt, null, 2));
  }

  async function confirmImport(): Promise<void> {
    const draft = $draftReport;
    if (!draft) return;
    if (!window.confirm('将把鉴定结论与厂家建议部件写入对应琴档，并为该换的部件生成维修计划。是否继续？')) return;
    try {
      await importReceipt(draft);
      notice = '回执已导入：档案与维修状态、下次建议日期均已重算。';
      pasteText = '';
    } catch {
      notice = null;
    }
  }

  async function onResolve(record: ReconciliationRow, discrepancy: ReconcileDiscrepancy, action: 'adopt' | 'keep'): Promise<void> {
    const label = action === 'adopt' ? '采纳厂家数据并新增一条本地记录（本地原记录保留）' : '保留本地数据';
    if (!window.confirm(`确认对该差异「${label}」？`)) return;
    try {
      await resolveDiscrepancy(record.id, discrepancy.id, action);
      expandedId = record.id;
      notice = '差异已处理，维修状态与下次建议日期已重算。';
    } catch {
      // 错误展示在 warrantyError
    }
  }

  async function removeHistory(record: ReconciliationRow): Promise<void> {
    if (!window.confirm('删除这份对账留档？不会回退已写入琴档的鉴定结论与维修计划。')) return;
    await deleteReconciliation(record.id);
    if (expandedId === record.id) expandedId = null;
  }

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  function resultParts(result: ReconcileItemResult): string {
    return result.parts.map((part) => part.partName).filter(Boolean).join('、') || '无';
  }

  /* 模板里按差异类型取双方数据（联合类型收窄用） */
  function tuningPayload(discrepancy: ReconcileDiscrepancy): TuningDateDiscrepancyPayload {
    return discrepancy.payload as TuningDateDiscrepancyPayload;
  }
  function serviceEntryOf(discrepancy: ReconcileDiscrepancy): ServiceMissingDiscrepancyPayload | ServiceMismatchDiscrepancyPayload {
    return discrepancy.payload as ServiceMissingDiscrepancyPayload | ServiceMismatchDiscrepancyPayload;
  }
  function mismatchPayload(discrepancy: ReconcileDiscrepancy): ServiceMismatchDiscrepancyPayload {
    return discrepancy.payload as ServiceMismatchDiscrepancyPayload;
  }
  function partPayload(discrepancy: ReconcileDiscrepancy) {
    return discrepancy.payload as Extract<ReconcileDiscrepancy['payload'], { partName: string; material: string; note: string }>;
  }
  function conclusionPayload(discrepancy: ReconcileDiscrepancy) {
    return discrepancy.payload as Extract<ReconcileDiscrepancy['payload'], { rawConclusion: string }>;
  }
  function serialPayload(discrepancy: ReconcileDiscrepancy) {
    return discrepancy.payload as Extract<ReconcileDiscrepancy['payload'], { serialNo: string }>;
  }
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">厂家保修回执对账</h2>
      <p class="page-subtitle">
        按序列号把厂家鉴定回执认到钢琴：结论与建议更换部件写进档案，该换的部件顺手生成维修计划；
        调律日期或维修条目对不上时两边都保留，列差异等人确认。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn" onclick={downloadSample}>下载示例回执</button>
      <button type="button" class="btn-primary" onclick={openFile}>导入回执文件</button>
    </div>
  </div>

  <div class="badge-row">
    <StatBadge label="琴档" value={$pianos.length} suffix="台" tone="walnut" icon="🎹" />
    <StatBadge label="对账批次" value={$history.length} suffix="份" tone="brass" icon="📥" />
    <StatBadge label="待确认差异" value={pendingCount} suffix="条" tone="rose" icon="‼" />
    <StatBadge
      label="累计维修计划"
      value={$history.reduce((sum, item) => sum + item.createdPlans, 0)}
      suffix="条"
      tone="amber"
      icon="🛠️"
    />
    <StatBadge
      label="已写鉴定结论"
      value={$history.reduce((sum, item) => sum + item.appliedConclusions, 0)}
      suffix="台"
      tone="green"
      icon="✓"
    />
  </div>

  {#if parseError || $warrantyError}
    <div class="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
      {parseError ?? $warrantyError}
    </div>
  {/if}
  {#if notice}
    <div class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</div>
  {/if}

  <div class="card mb-4">
    <div class="card-title mb-3">
      <span>导入厂家回执</span>
      <span class="muted">JSON · 导入中途失败会整体回滚，恢复成对账前的样子</span>
    </div>
    <textarea
      class="field h-32 font-mono text-xs"
      bind:value={pasteText}
      placeholder="也可以直接把回执 JSON 粘贴到这里，再点「解析预览」"
    ></textarea>
    <div class="mt-3 flex flex-wrap gap-2">
      <button type="button" class="btn" onclick={previewPasted}>解析预览</button>
      <button type="button" class="btn" onclick={openFile}>选择文件…</button>
    </div>
  </div>

  {#if $draftReport}
    {@const draft = $draftReport}
    <div class="card mb-4 border-l-4 border-l-brass">
      <div class="card-title mb-3">
        <span>对账预览 · {draft.receiptTitle}</span>
        <span class="muted">
          {draft.manufacturer || '厂家未署名'} · 回执 {draft.receiptNo || '—'} · 出具 {draft.issuedDate || '—'}
        </span>
      </div>
      <div class="mb-3 grid gap-2 text-xs text-stone-600 sm:grid-cols-4">
        <div class="rounded-lg bg-stone-50 px-3 py-2">回执条目：{draft.totalItems} 台</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">认到本地：{draft.matchedItems} 台</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">将写结论：{draft.appliedConclusions} 台</div>
        <div class="rounded-lg bg-stone-50 px-3 py-2">将生成维修计划：{draftPlanCount} 条</div>
      </div>

      <div class="space-y-4">
        {#each draft.results as result (result.pianoId)}
          {@const piano = pianoOf(result.pianoId)}
          <div class="rounded-xl border border-stone-200 p-3">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <span class="font-semibold">{piano ? `${piano.brand} ${piano.model}` : '钢琴已删除'}</span>
              <span class="text-xs text-stone-500">序列号 {result.serialNo}</span>
              {#if result.conclusion}
                <span class="rounded-full px-2 py-0.5 text-xs {conclusionBadgeClass(result.conclusion)}">{result.conclusion}</span>
              {:else}
                <span class="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">结论待确认：{result.conclusionRaw}</span>
              {/if}
            </div>
            <div class="grid gap-2 text-xs text-stone-600 md:grid-cols-2">
              <div class="rounded-lg bg-stone-50 px-3 py-2">
                建议更换部件：
                {#if result.parts.length === 0}
                  <span class="text-stone-400">无</span>
                {:else}
                  {#each result.parts as part, i (part.partName + i)}
                    <div class:mt-1={i > 0}>
                      <span class={part.type === null ? 'text-rose-600' : ''}>{part.partName}</span>
                      {#if part.type === null}
                        <span class="ml-1 rounded bg-rose-100 px-1 text-rose-700">无法归类，待确认</span>
                      {:else}
                        <span class="ml-1 rounded bg-emerald-100 px-1 text-emerald-700">将建{part.type}计划</span>
                      {/if}
                      {#if part.material}<span class="ml-1 text-stone-400">{part.material}</span>{/if}
                    </div>
                  {/each}
                {/if}
              </div>
              <div class="rounded-lg bg-stone-50 px-3 py-2">
                <div>鉴定日期：{result.checkedDate || '—'} · 报告编号：{result.reportNo || '—'}</div>
                <div>导入后维修状态：<b>{result.nextPianoState}</b></div>
                <div>重算下次建议日期：<b>{result.nextDueDate ?? '—'}</b></div>
                {#if result.remark}<div class="mt-1 text-stone-500">厂家备注：{result.remark}</div>{/if}
              </div>
            </div>
          </div>
        {/each}

        {#if draft.discrepancies.length > 0}
          <div class="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
            <div class="mb-2 text-sm font-semibold text-rose-700">
              发现 {draft.discrepancies.length} 条差异，导入后两边数据都保留，可在历史批次里逐条确认
            </div>
            <ul class="space-y-1 text-xs text-stone-700">
              {#each draft.discrepancies as discrepancy (discrepancy.id)}
                <li>· [{discrepancyLabel(discrepancy.type)}] {discrepancy.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn" onclick={() => clearDraft()}>取消</button>
        <button type="button" class="btn-primary" onclick={confirmImport} disabled={$warrantyBusy}>
          {$warrantyBusy ? '导入中…' : '确认写入档案'}
        </button>
      </div>
    </div>
  {/if}

  <div class="card-title mb-3 mt-6">
    <span>历史对账批次</span>
    <span class="muted">留档含厂家回执原文与差异处理记录</span>
  </div>

  {#if $history.length === 0}
    <EmptyPanel
      title="还没有导入过厂家回执"
      description="导入厂家保修鉴定回执后，这里会保留每一批次的对账结果、差异与处理记录。可先下载示例回执体验。"
      createText="下载示例回执"
      oncreate={downloadSample}
    />
  {:else}
    <div class="space-y-3">
      {#each $history as record (record.id)}
        {@const open = expandedId === record.id}
        {@const pending = record.discrepancies.filter((item) => item.status === '待确认').length}
        <div class="card">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <button type="button" class="flex flex-1 flex-wrap items-center gap-2 text-left" onclick={() => toggle(record.id)}>
              <span class="font-semibold">{record.receiptTitle}</span>
              <span class="muted">{record.receiptNo || '—'} · {record.importedAt.slice(0, 16).replace('T', ' ')}</span>
              <span class="rounded-full bg-stone-100 px-2 py-0.5 text-xs">{record.matchedItems}/{record.totalItems} 台认到</span>
              <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">生成计划 {record.createdPlans}</span>
              {#if pending > 0}
                <span class="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">待确认差异 {pending}</span>
              {:else if record.discrepancies.length > 0}
                <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">差异已全部处理</span>
              {/if}
            </button>
            <div class="flex gap-2">
              <button type="button" class="btn" onclick={() => toggle(record.id)}>{open ? '收起' : '展开'}</button>
              <button type="button" class="btn-danger" onclick={() => removeHistory(record)}>删除留档</button>
            </div>
          </div>

          {#if open}
            <div class="mt-4 space-y-4">
              {#each record.results as result (result.pianoId)}
                <div class="rounded-xl border border-stone-200 p-3 text-xs">
                  <div class="mb-1 flex flex-wrap items-center gap-2">
                    <span class="text-sm font-semibold">{pianoLabel(result.pianoId)}</span>
                    {#if result.conclusion}
                      <span class="rounded-full px-2 py-0.5 {conclusionBadgeClass(result.conclusion)}">{result.conclusion}</span>
                    {:else}
                      <span class="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">原文结论：{result.conclusionRaw || '—'}</span>
                    {/if}
                  </div>
                  <div class="text-stone-600">
                    建议部件：{resultParts(result)} · 维修状态 {result.nextPianoState} · 下次建议 {result.nextDueDate ?? '—'}
                  </div>
                </div>
              {/each}

              {#if record.discrepancies.length === 0}
                <div class="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">本批次没有差异。</div>
              {:else}
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
                      <tr>
                        <th class="py-2">钢琴 / 序列号</th>
                        <th class="py-2">差异</th>
                        <th class="py-2">两边数据</th>
                        <th class="py-2">状态</th>
                        <th class="py-2">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each record.discrepancies as discrepancy (discrepancy.id)}
                        <tr class="border-b border-stone-100 align-top">
                          <td class="py-2">
                            {#if discrepancy.pianoId}
                              {pianoLabel(discrepancy.pianoId)}
                            {:else}
                              <span class="text-rose-600">未认到琴：{discrepancy.serialNo}</span>
                            {/if}
                          </td>
                          <td class="py-2">
                            <span class="inline-block rounded bg-stone-100 px-1.5 py-0.5 text-[11px]">
                              {discrepancyLabel(discrepancy.type)}
                            </span>
                            <div class="mt-1 text-xs text-stone-600">{discrepancy.message}</div>
                          </td>
                          <td class="py-2 text-xs text-stone-600">
                            {@render discrepancyDetail(discrepancy)}
                          </td>
                          <td class="py-2">
                            <span
                              class="rounded-full px-2 py-0.5 text-xs {discrepancy.status === '待确认'
                                ? 'bg-rose-100 text-rose-700'
                                : discrepancy.status === '已采纳厂家'
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-emerald-100 text-emerald-700'}">{discrepancy.status}</span
                            >
                          </td>
                          <td class="py-2">
                            {#if discrepancy.status === '待确认'}
                              {#if canAdopt(discrepancy)}
                                <button
                                  type="button"
                                  class="btn mr-2"
                                  disabled={$warrantyBusy}
                                  onclick={() => onResolve(record, discrepancy, 'adopt')}>采纳厂家</button
                                >
                              {/if}
                              <button
                                type="button"
                                class="btn"
                                disabled={$warrantyBusy}
                                onclick={() => onResolve(record, discrepancy, 'keep')}>保留本地</button
                              >
                            {:else}
                              <span class="text-xs text-stone-400">
                                {#if discrepancy.resolvedAt}{discrepancy.resolvedAt.slice(0, 10)}{/if}
                              </span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet discrepancyDetail(discrepancy: ReconcileDiscrepancy)}
  {#if discrepancy.type === 'tuning_date_missing'}
    {@const payload = tuningPayload(discrepancy)}
    <div>厂家：调律 {payload.receiptTuning.date}（{payload.receiptTuning.technician || '—'}）</div>
    <div>本地：{payload.localDates.length > 0 ? payload.localDates.join('、') : '无调律记录'}</div>
  {:else if discrepancy.type === 'service_missing'}
    {@const entry = serviceEntryOf(discrepancy).receiptEntry}
    <div>厂家：{entry.date} {entry.type} / {entry.partName}（{entry.operator || '—'}，{entry.status || '—'}）</div>
    <div>本地：无对应维修条目</div>
  {:else if discrepancy.type === 'service_mismatch'}
    {@const payload = mismatchPayload(discrepancy)}
    <div>厂家：{payload.receiptEntry.date} {payload.receiptEntry.type} / {payload.receiptEntry.partName}</div>
    <div>本地：{payload.localDate} {payload.localType} / {payload.localParts}（{payload.localOperator}）</div>
  {:else if discrepancy.type === 'part_unmapped'}
    {@const payload = partPayload(discrepancy)}
    <div>厂家：{payload.partName}（{payload.material || '无规格'}）</div>
    <div>本地：无对应部件枚举，建议手工补录维修事项</div>
  {:else if discrepancy.type === 'conclusion_unknown'}
    <div>厂家原文：{conclusionPayload(discrepancy).rawConclusion}</div>
  {:else if discrepancy.type === 'serial_not_found'}
    {@const payload = serialPayload(discrepancy)}
    <div>厂家：{payload.serialNo} · 结论 {payload.rawConclusion || '—'} · 鉴定 {payload.receiptDate || '—'}</div>
    <div>本地：无此序列号琴档（请先建档或核对序列号）</div>
  {/if}
{/snippet}

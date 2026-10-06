<script lang="ts">
  /** WarrantyImportPanel：粘贴 / 读取厂家保修鉴定回执 JSON，导入后触发对账 */
  import { downloadJson } from '$lib/utils/export';
  import { warrantyReceiptTemplate } from '$lib/utils/warrantyReceipt';

  let {
    importing = false,
    importError = null,
    onimport,
    onclearerror
  }: {
    importing?: boolean;
    importError?: string | null;
    onimport: (text: string) => void;
    onclearerror?: () => void;
  } = $props();

  let receiptText = $state('');

  function handleFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      receiptText = typeof reader.result === 'string' ? reader.result : '';
      onclearerror?.();
    };
    reader.onerror = () => {
      receiptText = '';
    };
    reader.readAsText(file, 'utf-8');
    input.value = '';
  }

  function submit(): void {
    if (!receiptText.trim()) return;
    onimport(receiptText);
  }

  function downloadTemplate(): void {
    downloadJson('厂家保修鉴定回执-模板.json', warrantyReceiptTemplate());
  }
</script>

<div class="card">
  <div class="card-title mb-3">
    <span>导入厂家保修鉴定回执</span>
    <span class="muted">按序列号认琴 · 鉴定结论写档 · 建议部件生成维修计划</span>
  </div>

  {#if importError}
    <div class="mb-3 whitespace-pre-line rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
      {importError}
    </div>
  {/if}

  <textarea
    class="field h-52 font-mono text-xs"
    bind:value={receiptText}
    placeholder="把厂家回执 JSON 粘贴到这里，或点下方「选择回执文件」读取 .json 文件"
    oninput={() => onclearerror?.()}
  ></textarea>

  <div class="mt-3 flex flex-wrap items-center gap-2">
    <label class="btn cursor-pointer">
      选择回执文件
      <input type="file" accept=".json,application/json" class="hidden" onchange={handleFile} />
    </label>
    <button type="button" class="btn" onclick={downloadTemplate}>下载回执模板</button>
    <button type="button" class="btn-primary ml-auto" onclick={submit} disabled={importing || !receiptText.trim()}>
      {importing ? '对账导入中…' : '导入并对账'}
    </button>
  </div>

  <p class="mt-3 text-xs leading-5 text-stone-500">
    回执的调律日期或维修条目与本地对不上时，<b>两边原值都会保留</b>并在下方列为差异等人确认；
    导入中途任一步失败都会整体回滚，本地数据恢复成对账前的样子。
  </p>
</div>

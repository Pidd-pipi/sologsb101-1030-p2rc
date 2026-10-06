<script lang="ts">
  /** WarrantyBatchHistory：厂家回执导入批次留档（回执号、条目数、认琴数、计划数、差异数） */
  import type { WarrantyBatchRow } from '$lib/utils/db';

  let { batches = [] }: { batches?: WarrantyBatchRow[] } = $props();
</script>

<div class="card">
  <div class="card-title mb-3">
    <span>对账批次记录</span>
    <span class="muted">每次回执导入留一档</span>
  </div>
  {#if batches.length === 0}
    <p class="text-sm text-stone-500">还没有导入过厂家回执。</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
          <tr>
            <th class="py-2">导入时间</th>
            <th class="py-2">回执编号 / 厂家</th>
            <th class="py-2">出具日期</th>
            <th class="py-2">回执条目</th>
            <th class="py-2">认到琴</th>
            <th class="py-2">更新档案</th>
            <th class="py-2">生成计划</th>
            <th class="py-2">差异</th>
          </tr>
        </thead>
        <tbody>
          {#each batches as batch (batch.id)}
            <tr class="border-b border-stone-100">
              <td class="py-2 tabular-nums">{batch.importedAt.slice(0, 16).replace('T', ' ')}</td>
              <td class="py-2">
                <div>{batch.receiptNo || '—'}</div>
                <div class="text-xs text-stone-400">{batch.manufacturer || '—'}</div>
              </td>
              <td class="py-2">{batch.issuedAt || '—'}</td>
              <td class="py-2 tabular-nums">{batch.itemCount}</td>
              <td class="py-2 tabular-nums">{batch.matchedCount}</td>
              <td class="py-2 tabular-nums">{batch.updatedPianoCount}</td>
              <td class="py-2 tabular-nums">{batch.createdPlanCount}</td>
              <td class="py-2 tabular-nums">
                <span class="{batch.diffCount > 0 ? 'font-semibold text-amber-700' : 'text-stone-500'}">
                  {batch.diffCount}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

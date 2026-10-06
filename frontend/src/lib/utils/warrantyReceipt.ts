/**
 * 厂家保修鉴定回执的解析、校验与模板生成（纯函数，不依赖 IndexedDB）。
 * 对账核心逻辑见 utils/warrantyReconcile.ts。
 */
import type { WarrantyReceipt, WarrantyReceiptItem, WarrantyPartSuggestion, WarrantyWorkItem } from '$lib/types/warranty';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日期是否为合法 YYYY-MM-DD */
export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const time = new Date(`${value}T00:00:00`).getTime();
  return !Number.isNaN(time);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalDate(value: unknown, label: string, errors: string[]): string {
  const text = asString(value);
  if (!text) return '';
  if (!isValidDate(text)) errors.push(`${label}日期格式应为 YYYY-MM-DD：${text}`);
  return text;
}

/** 解析并严格校验回执 JSON；不合法时抛出带可读信息的错误 */
export function parseWarrantyReceipt(text: string): WarrantyReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  const root = asRecord(parsed);
  if (!root) throw new Error('回执根节点必须是对象');
  if (!Array.isArray(root.items)) throw new Error('回执缺少 items 数组字段');

  const items: WarrantyReceiptItem[] = [];
  const errors: string[] = [];

  root.items.forEach((raw, index) => {
    const row = asRecord(raw);
    const prefix = `items[${index + 1}]`;
    if (!row) {
      errors.push(`${prefix} 必须是对象`);
      return;
    }
    const serialNo = asString(row.serialNo);
    if (!serialNo) errors.push(`${prefix} 缺少序列号 serialNo`);
    const conclusion = asString(row.conclusion);
    if (!conclusion) errors.push(`${prefix}（序列号 ${serialNo || '未知'}）缺少鉴定结论 conclusion`);

    const lastTuningDate = asOptionalDate(row.lastTuningDate, `${prefix} 调律`, errors);

    const suggestedParts: WarrantyPartSuggestion[] = [];
    if (row.suggestedParts !== undefined) {
      if (!Array.isArray(row.suggestedParts)) {
        errors.push(`${prefix} suggestedParts 必须是数组`);
      } else {
        row.suggestedParts.forEach((partRaw, partIndex) => {
          const partRow = asRecord(partRaw);
          if (!partRow) {
            errors.push(`${prefix}.suggestedParts[${partIndex + 1}] 必须是对象`);
            return;
          }
          const part = asString(partRow.part);
          if (!part) {
            errors.push(`${prefix}.suggestedParts[${partIndex + 1}] 缺少部件名 part`);
            return;
          }
          suggestedParts.push({
            part,
            ...(asString(partRow.type) ? { type: asString(partRow.type) } : {}),
            ...(asString(partRow.material) ? { material: asString(partRow.material) } : {})
          });
        });
      }
    }

    const workItems: WarrantyWorkItem[] = [];
    if (row.workItems !== undefined) {
      if (!Array.isArray(row.workItems)) {
        errors.push(`${prefix} workItems 必须是数组`);
      } else {
        row.workItems.forEach((workRaw, workIndex) => {
          const workRow = asRecord(workRaw);
          if (!workRow) {
            errors.push(`${prefix}.workItems[${workIndex + 1}] 必须是对象`);
            return;
          }
          const type = asString(workRow.type);
          const part = asString(workRow.part);
          const date = asOptionalDate(workRow.date, `${prefix}.workItems[${workIndex + 1}] 维修`, errors);
          if (!type) errors.push(`${prefix}.workItems[${workIndex + 1}] 缺少维修类型 type`);
          if (!part) errors.push(`${prefix}.workItems[${workIndex + 1}] 缺少部件 part`);
          if (type && part) {
            workItems.push({
              type,
              part,
              date,
              ...(asString(workRow.operator) ? { operator: asString(workRow.operator) } : {}),
              ...(asString(workRow.material) ? { material: asString(workRow.material) } : {})
            });
          }
        });
      }
    }

    if (serialNo && conclusion) {
      items.push({
        serialNo,
        conclusion,
        ...(lastTuningDate ? { lastTuningDate } : {}),
        ...(suggestedParts.length > 0 ? { suggestedParts } : {}),
        ...(workItems.length > 0 ? { workItems } : {})
      });
    }
  });

  if (items.length === 0) {
    errors.push('回执没有任何有效条目（每条至少需要序列号与鉴定结论）');
  }
  const issuedAt = asString(root.issuedAt) ? asOptionalDate(root.issuedAt, '回执出具', errors) : '';
  if (errors.length > 0) {
    throw new Error(`回执校验失败：\n${errors.map((item) => `· ${item}`).join('\n')}`);
  }

  return {
    ...(asString(root.name) ? { name: asString(root.name) } : {}),
    ...(asString(root.receiptNo) ? { receiptNo: asString(root.receiptNo) } : {}),
    ...(issuedAt ? { issuedAt } : {}),
    ...(asString(root.manufacturer) ? { manufacturer: asString(root.manufacturer) } : {}),
    items
  };
}

/** 空回执模板（供页面下载，告诉琴行回执该长什么样） */
export function warrantyReceiptTemplate(): string {
  const template: WarrantyReceipt = {
    name: '厂家保修鉴定回执',
    receiptNo: 'W-2026-0001',
    issuedAt: new Date().toISOString().slice(0, 10),
    manufacturer: '示例钢琴制造有限公司',
    items: [
      {
        serialNo: 'U1-6132457',
        conclusion: '在保，击弦机磨损属保修范围，建议更换联动杆并做整音',
        lastTuningDate: '2026-09-12',
        suggestedParts: [{ part: '联动杆', type: '击弦机调整', material: '原厂联动杆 · 间隙 0.2mm' }],
        workItems: [{ type: '击弦机调整', part: '联动杆', date: '2026-09-12', operator: '厂家技师' }]
      }
    ]
  };
  return JSON.stringify(template, null, 2);
}

/**
 * 标签值工具
 *
 * 解析、格式化带类型值的会话标签条目。
 * 会话标签存为扁平字符串："bug"（布尔）或 "priority::3"（带值）。
 * :: 分隔符把标签 ID 和值分开，值在解析时推断类型。
 *
 * 类型推断顺序：
 * 1. ISO 日期（YYYY-MM-DD）→ Date
 * 2. 有限数字 → number
 * 3. 其他 → string
 */

import type { ParsedLabelEntry } from './types.ts';

/** 会话标签条目中 ID 与值之间的分隔符 */
const VALUE_SEPARATOR = '::';

/** ISO 日期模式：YYYY-MM-DD（仅日期，严格格式） */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 日期时间模式：YYYY-MM-DDTHH:mm（日期+时间，无秒） */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 简单十进制数：可选负号、数字、可选小数部分 */
const DECIMAL_NUMBER_REGEX = /^-?\d+(\.\d+)?$/;

/**
 * 把一条会话标签字符串解析成结构化对象。
 * 只在第一个 :: 处切分（值本身可能包含 ::）。
 *
 * 示例：
 *   "bug"                  → { id: "bug" }
 *   "priority::3"          → { id: "priority", rawValue: "3", value: 3 }
 *   "due::2026-01-30"      → { id: "due", rawValue: "2026-01-30", value: Date }
 *   "url::https://a::b"    → { id: "url", rawValue: "https://a::b", value: "https://a::b" }
 */
export function parseLabelEntry(entry: string): ParsedLabelEntry {
  const separatorIndex = entry.indexOf(VALUE_SEPARATOR);

  // 没有分隔符 → 布尔标签
  if (separatorIndex === -1) {
    return { id: entry };
  }

  const id = entry.substring(0, separatorIndex);
  const rawValue = entry.substring(separatorIndex + VALUE_SEPARATOR.length);

  return {
    id,
    rawValue,
    value: inferTypedValue(rawValue),
  };
}

/**
 * 把标签 ID 和可选值格式化为存储字符串。
 * 对 Date 会序列化为 ISO 日期字符串（YYYY-MM-DD）。
 *
 * 示例：
 *   formatLabelEntry("bug")              → "bug"
 *   formatLabelEntry("priority", 3)      → "priority::3"
 *   formatLabelEntry("due", new Date())  → "due::2026-01-23"
 *   formatLabelEntry("link", "https://") → "link::https://"
 */
export function formatLabelEntry(id: string, value?: string | number | Date): string {
  if (value === undefined) {
    return id;
  }

  // 把 Date 序列化为 ISO 字符串；若非 UTC 午夜则保留时间部分
  if (value instanceof Date) {
    const hours = value.getUTCHours();
    const minutes = value.getUTCMinutes();
    const hasTime = hours !== 0 || minutes !== 0;
    const serialized = hasTime
      ? `${value.toISOString().split('T')[0]}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      : value.toISOString().split('T')[0];
    return `${id}${VALUE_SEPARATOR}${serialized}`;
  }

  return `${id}${VALUE_SEPARATOR}${String(value)}`;
}

/**
 * 快速从条目中提取标签 ID。
 * 只想要 ID 时（如校验/过滤）用这个方法，避免完整解析的开销。
 *
 * "priority::3" → "priority"
 * "bug"         → "bug"
 */
export function extractLabelId(entry: string): string {
  const separatorIndex = entry.indexOf(VALUE_SEPARATOR);
  return separatorIndex === -1 ? entry : entry.substring(0, separatorIndex);
}

/**
 * 在会话标签列表中切换一个标签。返回新数组。
 *
 * - 如果列表中已有该基础 ID（无论布尔或带值），则移除所有匹配条目
 *   （因此切换 "priority" 会移除 "priority::3"）。
 * - 否则把 labelId 作为布尔条目追加。
 *
 * 用于菜单组件的乐观 UI 状态：把上次结果快速回传，在快速切换时
 * 能正确叠加，不会因为拿到过期快照而丢失前面的更新。
 */
export function toggleLabelInList(labels: string[], labelId: string): string[] {
  const isApplied = labels.some(entry => extractLabelId(entry) === labelId);
  if (isApplied) {
    return labels.filter(entry => extractLabelId(entry) !== labelId);
  }
  return [...labels, labelId];
}

/**
 * 检查 rawValue 是否符合声明的 valueType。
 *
 * - string —— 总是合法
 * - link   —— 总是合法（只是 URL 字符串；协议安全在打开时校验）
 * - number —— 匹配 DECIMAL_NUMBER_REGEX（拒绝十六进制/八进制/科学计数法）
 * - date   —— ISO 日期（YYYY-MM-DD）或日期时间（YYYY-MM-DDTHH:mm），
 *            并通过往返检查，避免 "2026-02-29" 被静默钳位。
 *
 * resolveSessionLabels 用它拒绝像 "priority::high" 这样的值
 * 当标签配置为 valueType: "number" 时。
 */
export function validateLabelValue(
  rawValue: string,
  valueType: 'string' | 'number' | 'date' | 'link',
): boolean {
  switch (valueType) {
    case 'string':
    case 'link':
      // link 按 string 校验；URL/协议安全由渲染器的 shell:openUrl IPC 在打开时保证
      //（仅允许 http/https/mailto）。
      return true;
    case 'number':
      return DECIMAL_NUMBER_REGEX.test(rawValue);
    case 'date': {
      if (ISO_DATETIME_REGEX.test(rawValue)) {
        const d = new Date(rawValue + ':00Z');
        return !isNaN(d.getTime());
      }
      if (ISO_DATE_REGEX.test(rawValue)) {
        const d = new Date(rawValue + 'T00:00:00Z');
        return !isNaN(d.getTime()) && d.toISOString().split('T')[0] === rawValue;
      }
      return false;
    }
  }
}

/**
 * 把原始标签值格式化为人类可读的显示字符串。
 * 日期会按 locale 格式化（如 "Jan 30, 2026"）；
 * 链接会去掉 scheme（如 "example.com/x"）；
 * 数字和字符串原样返回。
 * UI badge 组件用它在圆点后渲染值部分。
 */
export function formatDisplayValue(rawValue: string, valueType?: 'string' | 'number' | 'date' | 'link'): string {
  if (valueType === 'date') {
    // 解析 date-only 或 datetime 字符串（与 parseLabelEntry 中的存储格式对应）
    const date = new Date(rawValue.includes('T') ? rawValue + ':00Z' : rawValue + 'T00:00:00Z');
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }
  if (valueType === 'link') {
    // 去掉 scheme 和末尾斜杠，让标签更干净。
    // 例如 "https://example.com/x/" → "example.com/x"。
    // rawValue 仍作为可打开的 href（见 openLabelLink），这里只影响展示。
    return rawValue.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }
  return rawValue;
}

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 从原始字符串推断有类型的值。
 * 顺序很重要：先检查日期（某些日期也会被解析成数字），
 * 再检查数字，最后回退为字符串。
 */
function inferTypedValue(raw: string): string | number | Date {
  // 1. 检查 ISO 日期时间格式（YYYY-MM-DDTHH:mm）—— 必须在 date-only 之前检查
  if (ISO_DATETIME_REGEX.test(raw)) {
    const date = new Date(raw + ':00Z');
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // 2. 检查 ISO 日期格式（YYYY-MM-DD）
  if (ISO_DATE_REGEX.test(raw)) {
    const date = new Date(raw + 'T00:00:00Z');
    // 通过往返校验确保日期真实：防止 JS Date 把非法日期（如 2026-02-29 → 2026-03-01）静默钳位
    const roundTrip = date.toISOString().split('T')[0];
    if (roundTrip === raw) {
      return date;
    }
  }

  // 3. 检查是否为简单十进制数字（拒绝十六进制、八进制、二进制、科学计数法）
  if (DECIMAL_NUMBER_REGEX.test(raw)) {
    return Number(raw);
  }

  // 4. 回退：普通字符串
  return raw;
}

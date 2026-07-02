/**
 * View Custom Functions
 *
 * 这里注册的是 Filtrex 的 extraFunctions（额外函数），可在视图表达式里和内置数学函数一起用。
 * 所有函数都是纯函数、无副作用，并对边界情况做安全处理。
 */

import { extractLabelId } from '../labels/values';

/**
 * 计算从某个时间戳（毫秒）到现在过去了多少天。
 * 如果时间戳为假值，或在将来，则返回 0。
 * @example daysSince(lastUsedAt) > 7
 */
function daysSince(timestamp: number): number {
  if (!timestamp || typeof timestamp !== 'number') return 0;
  const diff = Date.now() - timestamp;
  return diff > 0 ? diff / (1000 * 60 * 60 * 24) : 0;
}

/**
 * 计算从某个时间戳（毫秒）到现在过去了多少小时。
 * 如果时间戳为假值，或在将来，则返回 0。
 * @example hoursSince(lastUsedAt) > 24
 */
function hoursSince(timestamp: number): number {
  if (!timestamp || typeof timestamp !== 'number') return 0;
  const diff = Date.now() - timestamp;
  return diff > 0 ? diff / (1000 * 60 * 60) : 0;
}

/**
 * 判断数组或字符串是否包含某个值。
 * 对标签数组会同时按“原始值”和“提取后的 label ID”匹配，
 * 所以 contains(labels, "priority") 能匹配到 "priority::3" 这类条目。
 * @example contains(labels, 'bug')
 * @example contains(name, 'feat')
 */
function contains(collection: unknown, value: unknown): boolean {
  if (Array.isArray(collection)) {
    return collection.some(item =>
      item === value ||
      (typeof item === 'string' && typeof value === 'string' && extractLabelId(item) === value)
    );
  }
  if (typeof collection === 'string' && typeof value === 'string') {
    return collection.includes(value);
  }
  return false;
}

/**
 * 返回数组或字符串的长度。
 * 如果不是数组或字符串，返回 0。
 * @example length(labels) > 3
 * @example length(name) > 20
 */
function length(value: unknown): number {
  if (Array.isArray(value) || typeof value === 'string') {
    return value.length;
  }
  return 0;
}

/**
 * 判断字符串是否以某个前缀开头。
 * @example startsWith(name, 'feat')
 */
function startsWith(str: unknown, prefix: unknown): boolean {
  if (typeof str === 'string' && typeof prefix === 'string') {
    return str.startsWith(prefix);
  }
  return false;
}

/**
 * 把字符串转成小写，用于大小写不敏感比较。
 * @example lower(model) == 'opus'
 */
function lower(str: unknown): string {
  if (typeof str === 'string') {
    return str.toLowerCase();
  }
  return '';
}

/**
 * 所有要注册给 Filtrex 的自定义函数。
 * 对象的 key 就是表达式里可用的函数名。
 *
 * Record<string, Function> 表示“一个对象，键是字符串，值是函数”，
 * 类似 Golang 的 map[string]func(...any) any，只是 TS 用 Function 类型更宽松。
 */
export const VIEW_FUNCTIONS: Record<string, Function> = {
  daysSince,
  hoursSince,
  contains,
  length,
  startsWith,
  lower,
};

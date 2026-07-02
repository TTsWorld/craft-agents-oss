/**
 * 可读会话 ID 生成器
 *
 * 生成格式：YYMMDD-adjective-noun，例如 260111-swift-river
 * - 按日期前缀排序
 * - 人类可读、易记
 * - 每天约 2 万种组合
 * - 冲突时追加数字后缀
 */

import { ADJECTIVES, NOUNS } from './word-lists.ts';

/**
 * 生成 YYMMDD 格式的日期前缀。
 */
export function generateDatePrefix(date: Date = new Date()): string {
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * 使用 crypto.getRandomValues 从数组中随机取一个元素。
 *
 * <T> 是泛型，和 Go 的泛型类似，让函数可以处理任意类型的数组。
 * readonly T[] 表示只读数组，调用方不会被修改。
 */
function getRandomElement<T>(array: readonly T[]): T {
  const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0]! % array.length;
  return array[randomIndex]!;
}

/**
 * 生成随机的形容词-名词组合 slug。
 */
export function generateHumanSlug(): string {
  const adjective = getRandomElement(ADJECTIVES);
  const noun = getRandomElement(NOUNS);
  return `${adjective}-${noun}`;
}

/**
 * 生成唯一的会话 ID，遇到冲突会自动追加后缀。
 *
 * @param existingIds - workspace 中已有的会话 ID 集合（Set 或数组）
 * @param date - 日期前缀，默认当前时间
 * @returns 唯一会话 ID，例如 "260111-swift-river" 或 "260111-swift-river-2"
 */
export function generateUniqueSessionId(
  existingIds: Set<string> | string[],
  date: Date = new Date()
): string {
  // 统一转成 Set，方便 O(1) 查找；和 Go 的 map[string]struct{} 类似
  const existingSet = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const datePrefix = generateDatePrefix(date);

  // 最多尝试 100 次找唯一 slug
  for (let attempt = 0; attempt < 100; attempt++) {
    const slug = generateHumanSlug();
    const baseId = `${datePrefix}-${slug}`;

    // 基础 ID 可用就直接返回
    if (!existingSet.has(baseId)) {
      return baseId;
    }

    // 否则尝试追加数字后缀
    for (let suffix = 2; suffix <= 99; suffix++) {
      const suffixedId = `${baseId}-${suffix}`;
      if (!existingSet.has(suffixedId)) {
        return suffixedId;
      }
    }
  }

  // 兜底：追加随机 16 进制后缀（几乎不会发生）
  const fallbackSuffix = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16).slice(0, 4);
  return `${datePrefix}-${generateHumanSlug()}-${fallbackSuffix}`;
}

/**
 * 解析会话 ID，提取日期、slug、后缀等组件。
 *
 * @param sessionId - 如 "260111-swift-river" 或旧版 UUID
 * @returns 解析结果；如果不是可读格式则返回 null
 */
export function parseSessionId(sessionId: string): {
  datePrefix: string;
  date: Date;
  slug: string;
  suffix?: number;
} | null {
  // 匹配 YYMMDD-word-word 或 YYMMDD-word-word-N
  const match = sessionId.match(/^(\d{6})-([a-z]+-[a-z]+)(?:-(\d+))?$/);
  if (!match) {
    return null;
  }

  // match[1]、match[2]、match[3] 分别对应正则里的三个捕获组
  const [, datePrefix, slug, suffixStr] = match;
  if (!datePrefix || !slug) {
    return null;
  }

  // 从 YYMMDD 解析日期
  const year = 2000 + parseInt(datePrefix.slice(0, 2), 10);
  const month = parseInt(datePrefix.slice(2, 4), 10) - 1;
  const day = parseInt(datePrefix.slice(4, 6), 10);
  const date = new Date(year, month, day);

  return {
    datePrefix,
    date,
    slug,
    suffix: suffixStr ? parseInt(suffixStr, 10) : undefined,
  };
}

/**
 * 判断会话 ID 是否为新的人类可读格式。
 */
export function isHumanReadableId(sessionId: string): boolean {
  return parseSessionId(sessionId) !== null;
}

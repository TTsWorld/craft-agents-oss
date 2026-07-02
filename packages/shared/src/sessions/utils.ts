/**
 * 会话工具函数
 *
 * 提供一些不直接操作磁盘的小工具，供 jsonl.ts、storage.ts 等使用。
 */

import { SESSION_PERSISTENT_FIELDS, type SessionPersistentField } from './types.js';

/**
 * 从类似会话的对象中提取需要持久化的字段。
 *
 * 为什么需要这个函数：持久化字段列表保存在 SESSION_PERSISTENT_FIELDS 中，
 * 新增字段时只要改这个列表，就能自动同步到读写逻辑，不用到处改代码。
 *
 * @param source - 包含会话字段的对象
 * @returns 只包含 source 中存在的持久化字段的对象
 */
export function pickSessionFields<T extends object>(
  source: T
): Partial<Record<SessionPersistentField, unknown>> {
  const result: Partial<Record<SessionPersistentField, unknown>> = {};
  for (const field of SESSION_PERSISTENT_FIELDS) {
    // TS 提示：source 是泛型 T，这里临时把它当成 Record 来按 key 取值
    if (field in source && (source as Record<string, unknown>)[field] !== undefined) {
      result[field] = (source as Record<string, unknown>)[field];
    }
  }
  return result;
}

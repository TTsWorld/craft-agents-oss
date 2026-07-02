/**
 * 标签校验
 *
 * 会话级别的标签引用校验。
 * 检查会话中的标签 ID 是否存在于 workspace 的标签树中。
 * 无效 ID 会被静默过滤（优雅处理已删除标签）。
 */

import { isValidLabelId } from './storage.ts';
import { extractLabelId } from './values.ts';

/**
 * 校验会话的标签数组。
 * 过滤掉 workspace 配置中已不存在的标签 ID。
 * 对带值条目（如 "priority::3"）会先提取 ID 再检查。
 * 返回清理后的数组（无效 ID 被静默移除，保留原有值）。
 *
 * @param workspaceRootPath - workspace 根目录路径
 * @param labels - 待校验的标签条目数组（可能包含 :: 值）
 * @returns 仅包含有效标签条目的数组
 */
export function validateSessionLabels(
  workspaceRootPath: string,
  labels: string[] | undefined
): string[] {
  if (!labels || labels.length === 0) {
    return [];
  }

  // 先从条目中提取标签 ID（"priority::3" → "priority"），
  // 再校验 ID 是否在配置中存在。保留完整原始条目字符串。
  return labels.filter(entry => isValidLabelId(workspaceRootPath, extractLabelId(entry)));
}

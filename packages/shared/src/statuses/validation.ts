/**
 * 状态校验
 *
 * 运行时校验 session 的状态 ID，确保 session 总是引用有效的状态。
 */

import { isValidStatusId } from './storage.ts';

/**
 * 校验并归一化 session 的状态
 *
 * 如果状态无效或没有提供，返回兜底值 'todo'。
 *
 * @param workspaceRootPath - workspace 根目录路径
 * @param sessionStatus - 要校验的状态 ID
 * @returns 有效的状态 ID（或 'todo'）
 */
export function validateSessionStatus(
  workspaceRootPath: string,
  sessionStatus: string | undefined
): string {
  // 未提供状态时默认返回 'todo'
  if (!sessionStatus) {
    return 'todo';
  }

  // 检查该状态是否存在于 workspace 配置中
  if (isValidStatusId(workspaceRootPath, sessionStatus)) {
    return sessionStatus;
  }

  // 状态无效：输出警告并回退到 'todo'
  console.warn(
    `[validateSessionStatus] Invalid status '${sessionStatus}' for workspace, ` +
    `falling back to 'todo'. The status may have been deleted.`
  );

  return 'todo';
}

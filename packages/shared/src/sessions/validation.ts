/**
 * 会话 ID 校验
 *
 * 防止路径遍历（path traversal）攻击的安全工具。
 * 会话 ID 只允许字母、数字、连字符和下划线。
 */

import { basename } from 'path';

/**
 * 合法的会话 ID 正则。
 * 匹配：字母、数字、连字符、下划线
 * 示例："260202-swift-river"、"my_session_1"、"abc123"
 */
const SESSION_ID_PATTERN = /^[\w-]+$/;

/**
 * 校验会话 ID 是否可以安全地用于文件路径。
 * 如果包含路径穿越字符会抛出错误。
 *
 * @param sessionId - 待校验的会话 ID
 * @throws 校验失败时抛出 Security Error
 */
export function validateSessionId(sessionId: string): void {
  // 检查 null/undefined/空字符串
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Security Error: Session ID is required');
  }

  // 路径遍历检查：basename 会去掉目录层级，如果结果变了说明有穿越
  const sanitized = basename(sessionId);
  if (sanitized !== sessionId) {
    throw new Error('Security Error: Invalid session ID - path traversal detected');
  }

  // 格式检查
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Security Error: Invalid session ID format');
  }
}

/**
 * 去掉会话 ID 中的路径成分，仅保留 basename。
 * 这是纵深防御措施，真正的校验应该先调用 validateSessionId。
 *
 * @param sessionId - 待清理的会话 ID
 * @returns 清理后的会话 ID
 */
export function sanitizeSessionId(sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    return '';
  }
  return basename(sessionId);
}

/**
 * 非抛出式的会话 ID 校验。
 *
 * @param sessionId - 待校验的会话 ID
 * @returns 合法返回 true，否则返回 false
 */
export function isValidSessionId(sessionId: string): boolean {
  try {
    validateSessionId(sessionId);
    return true;
  } catch {
    return false;
  }
}

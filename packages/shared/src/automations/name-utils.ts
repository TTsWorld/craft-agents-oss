/**
 * 自动化名称工具（浏览器安全）
 *
 * 从 matcher 中提取人类可读的名称。文件故意不使用 Node.js API
 *（process、fs、crypto、shell），以便服务端和渲染进程共用。
 */

import type { AutomationMatcher } from './types.ts';

/**
 * 从 matcher 派生一个人类可读的自动化名称。
 *
 * 优先级：
 * 1. matcher 显式指定的 name
 * 2. 第一个 prompt 动作里的 @mention → "<mention> prompt"
 * 3. 第一个 prompt 动作的 prompt 文本（截断到 40 字符）
 * 4. 第一个 webhook 动作的 URL（截断到 40 字符）
 * 5. 事件名兜底
 */
export function deriveAutomationName(event: string, matcher: AutomationMatcher): string {
  if (matcher.name) return matcher.name;

  const firstAction = matcher.actions[0];
  if (!firstAction) return event;

  if (firstAction.type === 'webhook') {
    const label = `Webhook ${firstAction.method ?? 'POST'} ${firstAction.url}`;
    return label.length > 40 ? label.slice(0, 40) + '...' : label;
  }

  // 提取 @skill/@source 引用
  const mentionMatch = firstAction.prompt.match(/@(\S+)/);
  if (mentionMatch) return `${mentionMatch[1]} prompt`;

  return firstAction.prompt.length > 40
    ? firstAction.prompt.slice(0, 40) + '...'
    : firstAction.prompt;
}

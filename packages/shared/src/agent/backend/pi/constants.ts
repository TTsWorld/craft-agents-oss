/**
 * Pi Backend 共享常量
 *
 * 这里集中放置 Pi agent 及其事件适配器共享的常量，避免 pi-agent.ts 与
 * event-adapter.ts 之间相互引用造成循环依赖（类似 Go 中把常量放到独立的
 * const 包）。
 */

import type { ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ThinkingLevel } from '../../thinking-levels.ts';

/**
 * 把 Craft 的 {@link ThinkingLevel} 映射到 Pi SDK 的 `ThinkingLevel`。
 * 所有等级原样 1:1 透传 —— Pi 会在内部按模型做钳制（pi-ai 中的
 * `clampThinkingLevel`），因此 `max` 在没有原生 max 支持的模型上会降级到
 * 该模型的上限（例如 GPT-5.6 原生支持 max，旧版 GPT-5.x 回退到 xhigh）。
 *
 * TS 说明：`Record<K, V>` 类似 Go 的 `map[K]V`，但这里键是字面量联合类型，
 * 编译期就能校验所有 key 都已覆盖。
 */
export const THINKING_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Pi SDK 使用小写工具名（如 'read'、'bash'），但本仓库的权限系统
 * （ALWAYS_ALLOWED_TOOLS / shouldAllowToolInMode）使用 PascalCase（'Read'、'Bash'）。
 * 此映射在权限判定与事件归一化时使用。
 *
 * 类比：Go 中 strings.ToTitle 之类，这里只是按表查名做大小写/命名归一。
 */
export const PI_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Find',
  ls: 'Ls',
  // 兼容 Pi 可能出现的其它工具名拼写
  multi_edit: 'MultiEdit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  notebook_edit: 'NotebookEdit',
  glob: 'Glob',
  task: 'Task',
};

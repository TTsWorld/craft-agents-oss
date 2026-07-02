/**
 * Pi Session 工具代理定义
 *
 * 对 `@craft-agent/session-tools-core` 中规范工具定义的薄包装：
 * 给工具名加上 Pi SDK 期望的 `mcp__session__` 前缀。
 * （Pi 内部把 MCP-style 工具按 `<server>__<tool>` 解析命名空间。）
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';

// 直接复用 core 包的 JsonSchemaToolDef 类型（用 JSON Schema 描述工具入参）
export type SessionToolProxyDef = JsonSchemaToolDef;

// 透传 session 工具名常量，方便调用方按名引用
export { SESSION_TOOL_NAMES };

/**
 * 构造给 Pi 子进程使用的 session 工具定义列表。
 * 加 `mcp__session__` 前缀以符合 Pi SDK 的工具命名约定。
 */
export function getSessionToolProxyDefs(): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
  });
}

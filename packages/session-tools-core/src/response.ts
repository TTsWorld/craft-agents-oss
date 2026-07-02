/**
 * session-tools-core 的响应辅助函数
 *
 * 用于创建标准化 tool 响应的辅助函数。
 * Claude 和 Codex 的实现都会用到。
 */

import type { ToolResult, TextContent } from './types.ts';

/**
 * 创建成功的文本响应
 */
export function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: {},
    isError: false,
  };
}

/**
 * 创建错误响应。
 *
 * 重要 —— OpenAI Responses API 的限制（2025-02 发现）：
 * `function_call_output` 输入项只有 `type`、`call_id` 和 `output`（纯字符串），
 * 没有 `success`、`status` 或 `error` 字段。我们的 Codex fork 在
 * FunctionCallOutputPayload 里有 `success: bool` 字段，但它的自定义
 * Serialize 实现（codex-rs/protocol/src/models.rs）会把它完全丢弃 ——
 * 只有 content 字符串会被序列化到 API。
 *
 * 这意味着 `isError: true` 对模型不可见。为了让错误能与成功区分开，
 * 我们在输出文本前加上 "[ERROR]" 前缀。模型看到前缀后就能知道 tool 调用失败了。
 *
 * 这覆盖了所有 session MCP tool 错误（source_test、config_validate、
 * skill_validate、SubmitPlan、credential_prompt、oauth 触发器等）。
 *
 * 另见 packages/shared/src/agent/mode-manager.ts 里的 blockWithReason()，
 * 它对 permission-mode 阻塞也使用同样的前缀。
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `[ERROR] ${message}` }],
    structuredContent: {},
    isError: true,
  };
}

/**
 * 创建一个文本内容块
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}

/**
 * 创建多段文本响应（例如包含多个章节）
 */
export function multiBlockResponse(texts: string[], isError?: boolean): ToolResult {
  return {
    content: texts.map(text => ({ type: 'text' as const, text })),
    structuredContent: {},
    isError,
  };
}

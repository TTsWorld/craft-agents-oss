import type { AgentSession } from '@earendil-works/pi-coding-agent';

/**
 * 把 system prompt 强制写入 Pi AgentSession。
 *
 * Pi SDK 0.72.1 没有公开的逐轮 system prompt API。直接设置 `state.systemPrompt`
 * 会在每次 `session.prompt()` 调用时被覆盖（agent-session.js 约 L796：
 * `state.systemPrompt = _baseSystemPrompt`），而 `_baseSystemPrompt` 本身也可能在
 * 工具变更（`setActiveToolsByName`）或扩展重载时由 SDK 的资源加载器重新生成。
 *
 * 本函数把 `state.systemPrompt`、`_baseSystemPrompt`、`_rebuildSystemPrompt` 三个
 * 内部字段都覆盖掉，让我们的 prompt 能在所有重置路径下存活。
 *
 * 写法与 OpenClaw 的 `applySystemPromptOverrideToSession`（同一 SDK、同一约束）一致：
 * https://github.com/openclaw/openclaw/blob/main/src/agents/pi-embedded-runner/system-prompt.ts
 *
 * 待 SDK 提供公开的逐轮 system prompt API 后可移除。
 */
export function applySystemPromptOverride(session: AgentSession, prompt: string): void {
  session.agent.state.systemPrompt = prompt;
  const mutable = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutable._baseSystemPrompt = prompt;
  mutable._rebuildSystemPrompt = () => prompt;
}

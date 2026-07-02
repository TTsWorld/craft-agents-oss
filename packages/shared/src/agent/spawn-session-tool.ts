/**
 * Spawn Session 工具（spawn_session）
 *
 * Session-scoped tool（会话级工具）：让主 agent 可以创建独立运行的子 session，
 * 可自定义连接（connection）、模型（model）、source（数据源）以及初始 prompt。
 *
 * 类比 Go：相当于一个"派生 goroutine + 独立上下文"的 RPC handler，子 session 跑在
 * 后台，主 session 不阻塞等待。
 *
 * 两种调用模式：
 * - help=true：返回可用的 connections / models / sources 元信息（不创建 session）
 * - 默认：创建 session 并把 prompt 发出去（fire-and-forget，发完即忘）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';

/**
 * 创建子 session 的回调签名。
 * 主进程在 SessionManager 里实现并注册到 session 级回调表，工具在执行时通过 lazy getter 拿到。
 */
export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

// 工具返回值类型 —— 与 Claude SDK 期望的 ToolResult 结构对齐
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** 构造一个标准的错误返回（isError=true，content 里写 Error: 前缀） */
function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * 取得 spawn session 回调的 lazy resolver。
   * 在工具真正被调用时才从 session 级 callback registry 里取最新回调，
   * 这样后注入或替换回调无需重建工具实例也能立刻生效。
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

/**
 * 工厂函数：构造一个名为 spawn_session 的 Claude SDK 工具。
 *
 * 类比 Go：相当于把一个 handler 注册到 SDK 的 tool table 里，schema 由 z 描述，
 * 第三参是真正的 async handler。
 */
export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return tool(
    'spawn_session',
    `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: model, llmConnection, permissionMode, thinkingLevel, enabledSourceSlugs, labels, workingDirectory. Omitted fields inherit from the spawning session or the workspace default.

thinkingLevel is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns available connections, models, and sources instead of creating a session'),
      prompt: z.string().optional()
        .describe('Instructions for the new session (required when not in help mode)'),
      name: z.string().optional()
        .describe('Session name'),
      llmConnection: z.string().optional()
        .describe('Connection slug (e.g., "anthropic-api", "codex")'),
      model: z.string().optional()
        .describe('Model ID override'),
      enabledSourceSlugs: z.array(z.string()).optional()
        .describe('Source slugs to enable in the new session'),
      permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional()
        .describe('Permission mode for the new session'),
      thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
        .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
      labels: z.array(z.string()).optional()
        .describe('Labels for the new session'),
      workingDirectory: z.string().optional()
        .describe('Working directory for the new session'),
      projectId: z.string().optional()
        .describe('Workspace project id to bind the new session to. Inherits the project working directory unless overridden.'),
      attachments: z.array(z.object({
        path: z.string().describe('Absolute file path on disk'),
        name: z.string().optional().describe('Display name (defaults to file basename)'),
      })).optional()
        .describe('Files to include with the prompt'),
    },
    async (args) => {
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}

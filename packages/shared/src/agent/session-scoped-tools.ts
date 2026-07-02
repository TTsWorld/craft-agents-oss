/**
 * Session 级（Session-Scoped）工具集
 *
 * "Session 级工具"指绑定到具体某个 session 的工具。每个 session 会拥有自己的
 * 工具实例，并注入该 session 专属的回调和状态。
 *
 * Agent / 工具调用概念速记（给刚接触 TS/Agent 的同学）：
 *   - Tool：模型可以调用的函数，类比 Golang 里通过 RPC 注册的 handler。
 *   - MCP（Model Context Protocol）：暴露工具/资源给模型的协议；本文件用
 *     `createSdkMcpServer` 把多个工具打包成一个 MCP server，由 Claude SDK 调用。
 *   - Session：一段对话的会话状态；session-scoped 工具的可用性与回调绑定到它。
 *
 * 本文件是一个轻量适配层（adapter），把来自 `@craft-agent/session-tools-core`
 * 的共享 handler 包装成 Claude SDK 可用的形式。
 *
 * 所有工具的真正定义、参数 schema、handler 都位于 session-tools-core；
 * 本适配层只负责：
 *   - Session 回调注册表（每个 session 的 onPlanSubmitted / onAuthRequest / queryFn 等）
 *   - Plan（计划）状态管理
 *   - 用 Claude SDK 的 tool() 包装工具，并把 DOC_REF 写入工具描述
 *   - call_llm（后端特定，不在注册表中）
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { getSessionPlansPath, getSessionPath } from '../sessions/storage.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createClaudeContext } from './claude-context.ts';
import { basename } from 'node:path';

// 从 session-tools-core 导入：注册表 + schema + 基础描述
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  getSessionToolDefs,
  TOOL_DESCRIPTIONS as BASE_DESCRIPTIONS,
  // 类型
  type ToolResult,
  type AuthRequest,
} from '@craft-agent/session-tools-core';
import { createLLMTool, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { createSpawnSessionTool, type SpawnSessionFn } from './spawn-session-tool.ts';
import { createBrowserTools, type BrowserPaneFns } from './browser-tools.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { getBrowserToolEnabled } from '../config/storage.ts';

// 类型再导出，保持向后兼容（外部消费者已用旧路径引用这些类型）
export type {
  CredentialInputMode,
  AuthRequestType,
  AuthRequest,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  GoogleService,
  SlackService,
  MicrosoftService,
} from '@craft-agent/session-tools-core';

// 给 session manager 装配用的 browser pane 类型再导出
export type { BrowserPaneFns } from './browser-tools.ts';

// ============================================================
// Session 级工具回调（从专门的 registry 模块再导出）
// ============================================================

// 给所有下游消费者（index.ts、claude-agent.ts、pi-agent.ts 等）再导出
export {
  type SessionScopedToolCallbacks,
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';

// 本文件 factory 内部使用
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

/** Claude 适配层目前支持的后端执行型 session 工具集合。 */
export const CLAUDE_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  'spawn_session',
  'browser_tool',
]);

/**
 * 一致性护栏：确保 Claude 适配层装配的后端工具与 session-tools-core 声明的
 * 后端模式工具保持一致。在装配阶段就快速失败（fail fast），避免运行时漂移。
 */
function assertClaudeBackendSessionToolParity(): void {
  const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
    (name) => !CLAUDE_BACKEND_SESSION_TOOL_NAMES.has(name),
  );

  if (missing.length > 0) {
    throw new Error(
      `Claude session tools missing backend adapter implementations: ${missing.join(', ')}`,
    );
  }
}

// ============================================================
// Plan（计划文件）状态管理
// ============================================================

// sessionId → 最近一次提交的 plan 文件路径；用于提交后检索
const sessionPlanFilePaths = new Map<string, string>();

/** 获取某个 session 最近一次提交的 plan 文件路径（无则 null）。 */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/** 记录某个 session 最近一次提交的 plan 文件路径。 */
export function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/** 清除某个 session 的 plan 文件状态。 */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

// ============================================================
// Plan 路径相关辅助函数
// ============================================================

/** 获取某个 session 的 plans 目录路径。 */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/** 判断某个路径是否位于给定 session 的 plans 目录之内。 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// 工具结果转换
// ============================================================

/**
 * 把共享层 ToolResult 转成 Claude SDK 期望的格式。
 * 主要差别：把每条 content 都映射成 `{ type: 'text', text }`，并按需带 `isError`。
 */
function convertResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: result.content.map(c => ({ type: 'text' as const, text: c.text })),
    ...(result.isError ? { isError: true } : {}),
  };
}

// ============================================================
// Session 级工具的缓存
// ============================================================

// 按 session 缓存工具数组，避免每条消息都重建（构造成本较高）。
// 注意：我们缓存的是 tools 数组（重建昂贵），但【不缓存】MCP server 包装。
// 原因：createSdkMcpServer 返回的 MCP Server 实例持有 transport 状态；
// SDK 的 query() 会调用其 connect() 并设置 _transport。下一次 query() 又会调用
// connect()，但如果上一个 Query 的子进程还没完全退出，_transport 仍然存在，
// connect() 会抛 "Already connected to a transport"。所以每次 query 都新建一个
// server 包装，能规避这个竞态。
const sessionToolsCache = new Map<string, ReturnType<typeof tool>[]>();

/**
 * 失效【所有】 session 的工具缓存（例如 browserToolEnabled 之类的全局开关变化）。
 * 这会强制每个 session 在下一条消息时重建工具。
 */
export function invalidateAllSessionToolsCaches(): void {
  sessionToolsCache.clear();
}

/** 清理某个 session 已缓存的工具（session 结束/销毁时调用）。 */
export function cleanupSessionScopedTools(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of sessionToolsCache.keys()) {
    if (key.startsWith(prefix)) {
      sessionToolsCache.delete(key);
    }
  }
}

// ============================================================
// 工具描述（注册表基础描述 + Claude 专属的 DOC_REF 增强）
// ============================================================

const TOOL_DESCRIPTIONS: Record<string, string> = {
  ...BASE_DESCRIPTIONS,
  // Claude 专属：把对应文档链接拼到描述末尾
  config_validate: BASE_DESCRIPTIONS.config_validate + `\n\n**Reference:** ${DOC_REFS.sources}`,
  skill_validate: BASE_DESCRIPTIONS.skill_validate + `\n\n**Reference:** ${DOC_REFS.skills}`,
  mermaid_validate: BASE_DESCRIPTIONS.mermaid_validate + `\n\n**Reference:** ${DOC_REFS.mermaid}`,
  source_test: BASE_DESCRIPTIONS.source_test + `\n\n**Reference:** ${DOC_REFS.sources}`,
};

// ============================================================
// 主工厂函数
// ============================================================

/**
 * 获取（或创建）某个 session 的 session 级工具集。
 * 返回一个已注册了所有 session 级工具的 MCP server。
 *
 * 工具都来自 session-tools-core 中的权威注册表 SESSION_TOOL_DEFS，
 * 唯一例外是 call_llm —— 它是后端特定的（每个后端实现不同）。
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
  workspaceId?: string
): ReturnType<typeof createSdkMcpServer> {
  const cacheKey = `${sessionId}::${workspaceRootPath}`;

  // 命中缓存就复用工具数组；但每次都必须新建一个 MCP server 包装（见上面缓存注释）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tools: any[] | undefined = sessionToolsCache.get(cacheKey);
  if (!tools) {
    // 构造 Claude 上下文（带完整能力）
    const ctx = createClaudeContext({
      sessionId,
      workspacePath: workspaceRootPath,
      workspaceId: workspaceId || basename(workspaceRootPath) || '',
      onPlanSubmitted: (planPath: string) => {
        // plan 提交时：记录路径 + 转发给该 session 注册的回调
        setLastPlanFilePath(sessionId, planPath);
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        callbacks?.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        // 鉴权请求：转发给该 session 注册的回调
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        callbacks?.onAuthRequest?.(request as AuthRequest);
      },
    });

    // 装配 session 自管理绑定（懒加载 getter，从回调注册表取值）
    attachSessionSelfManagementBindings(ctx, sessionId);

    // 用权威注册表构造工具的小助手。
    // 这里的 `as any` 是为了绕开 Zod 的泛型协变问题：
    // 当 .shape 类型（ZodType<string>）流入 Record<string, ZodType<unknown>> 时
    // TS 会报错，这里强制桥接一下。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function registryTool(name: string, schema: any) {
      const def = SESSION_TOOL_REGISTRY.get(name)!;
      return tool(name, TOOL_DESCRIPTIONS[name] || def.description, schema, async (args: any) => {
        const result = await def.handler!(ctx, args);
        return convertResult(result);
      }, def.readOnly ? { annotations: { readOnlyHint: true } } : undefined);
    }

    // 校验后端模式工具装配与 core 中的元数据一致（避免后端漂移）
    assertClaudeBackendSessionToolParity();

    // 从权威注册表批量构造工具 —— 凡是有 handler 的都装上。
    // 工具的可见性在 session-tools-core 中统一过滤，避免各后端各自为政。
    tools = getSessionToolDefs({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback })
      .filter(def => def.handler !== null) // 跳过后端特定工具（如 call_llm）
      .map(def => registryTool(def.name, def.inputSchema.shape));

    // 追加 call_llm —— 后端特定（注册表里没它的 handler）
    const sessionPath = getSessionPath(workspaceRootPath, sessionId);
    tools.push(
      createLLMTool({
        sessionId,
        sessionPath,
        getQueryFn: () => {
          // 懒取：每次实际调用时再去注册表里取，避免拿到旧的回调闭包
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.queryFn;
        },
      }),
    );

    // 追加 spawn_session —— 后端特定
    tools.push(
      createSpawnSessionTool({
        sessionId,
        getSpawnSessionFn: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.spawnSessionFn;
        },
      }),
    );

    // 追加 browser_* 系列工具 —— 后端特定（需要 Electron 里的 BrowserPaneManager）
    // 受"Built-in browser"开关控制：如果用户已用 Playwright/Puppeteer 等外部
    // 浏览器工具，可以关闭内置浏览器工具。
    if (getBrowserToolEnabled()) {
      tools.push(
        ...createBrowserTools({
          sessionId,
          getBrowserPaneFns: () => {
            const callbacks = getSessionScopedToolCallbacks(sessionId);
            return callbacks?.browserPaneFns;
          },
        }),
      );
    }

    sessionToolsCache.set(cacheKey, tools);
  }

  // 始终新建 MCP server 包装，避免连续 query 时出现
  // "Already connected to a transport" 的竞态（见上方缓存注释）。
  return createSdkMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });
}

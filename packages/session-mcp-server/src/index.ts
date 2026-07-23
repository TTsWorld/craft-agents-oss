#!/usr/bin/env node
/**
 * Session MCP Server
 *
 * 这个 MCP server 通过 stdio 传输向 Codex 提供会话级工具。
 * 复用 @craft-agent/session-tools-core 里的共享 handler，确保与 Claude 的会话级工具功能对齐。
 *
 * 回调通信：
 * 需要与 Electron 主进程通信的工具（例如 SubmitPlan 触发计划展示、OAuth 触发暂停执行），
 * 会以 "__CALLBACK__" 前缀向 stderr 发送结构化 JSON 消息。主进程监听 stderr 并处理这些回调。
 *
 * 用法：
 *   node session-mcp-server.js --session-id <id> --workspace-root <path> --plans-folder <path>
 *
 * 参数：
 *   --session-id: 唯一会话标识
 *   --workspace-root: workspace 文件夹路径（~/.craft-agent/workspaces/{id}）
 *   --plans-folder: 会话的 plans 文件夹路径
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeveloperFeedbackEnabled } from '@craft-agent/shared/feature-flags';
// 从 session-tools-core 导入
import {
  type SessionToolContext,
  type CallbackMessage,
  type AuthRequest,
  type SourceConfig,
  type LoadedSource,
  type CredentialManagerInterface,
  // Registry
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  // Helpers
  loadSourceConfig as loadSourceConfigFromHelpers,
  errorResponse,
} from '@craft-agent/session-tools-core';

// ============================================================
// 类型
// ============================================================

interface SessionConfig {
  sessionId: string;
  workspaceRootPath: string;
  plansFolderPath: string;
  callbackPort?: string;
}

const CALLBACK_TOOL_TIMEOUT_MS = 120000;

// ============================================================
// 回调通信
// ============================================================

/**
 * 通过 stderr 向主进程发送回调消息。
 * 主进程解析这些消息以触发 UI 动作。
 */
function sendCallback(callback: CallbackMessage): void {
  // 以单行 JSON 写到 stderr（主进程会解析它）
  console.error(`__CALLBACK__${JSON.stringify(callback)}`);
}

// ============================================================
// 凭证缓存访问
// ============================================================

/**
 * 凭证缓存条目格式（与主进程格式一致）。
 * 由 Electron 主进程写入，本 server 读取。
 */
interface CredentialCacheEntry {
  value: string;
  expiresAt?: number;
}

/**
 * 获取某个 source 的凭证缓存文件路径。
 * 主进程把解密后的凭证写入这些文件。
 */
function getCredentialCachePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
}

/**
 * 从某个 source 的缓存文件读取凭证。
 * 缓存不存在或已过期时返回 null。
 */
function readCredentialCache(workspaceRootPath: string, sourceSlug: string): string | null {
  const cachePath = getCredentialCachePath(workspaceRootPath, sourceSlug);

  try {
    if (!existsSync(cachePath)) {
      return null;
    }

    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as CredentialCacheEntry;

    // 设置了过期时间时检查是否过期
    if (cache.expiresAt && Date.now() > cache.expiresAt) {
      return null;
    }

    return cache.value || null;
  } catch {
    return null;
  }
}

/**
 * 创建一个从凭证缓存文件读取的凭证管理器。
 * 这样 session-mcp-server 无需访问 keychain 也能获取凭证。
 */
function createCredentialManager(workspaceRootPath: string): CredentialManagerInterface {
  return {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const token = readCredentialCache(workspaceRootPath, source.config.slug);
      return token !== null;
    },

    getToken: async (source: LoadedSource): Promise<string | null> => {
      return readCredentialCache(workspaceRootPath, source.config.slug);
    },

    refresh: async (_source: LoadedSource): Promise<string | null> => {
      // 子进程无法刷新——需要主进程才能做
      return null;
    },
  };
}

// ============================================================
// Codex Context 工厂
// ============================================================

/**
 * 为 Codex MCP server 创建 SessionToolContext。
 * 为所有 handler 提供所需的上下文。
 */
function createCodexContext(config: SessionConfig): SessionToolContext {
  const { sessionId, workspaceRootPath, plansFolderPath } = config;

  // 文件系统实现
  const fs = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // 基于 stderr 的回调实现
  const callbacks = {
    onPlanSubmitted: (planPath: string) => {
      sendCallback({
        __callback__: 'plan_submitted',
        sessionId,
        planPath,
      });
    },
    onAuthRequest: (request: AuthRequest) => {
      sendCallback({
        __callback__: 'auth_request',
        ...request,
      });
    },
  };

  // 创建从缓存文件读取的凭证管理器
  const credentialManager = createCredentialManager(workspaceRootPath);

  // transform_data / render_template 使用的会话路径
  const sessionsDir = join(workspaceRootPath, 'sessions', sessionId);
  const sessionDataDir = join(sessionsDir, 'data');

  // 构建 context
  return {
    sessionId,
    workspacePath: workspaceRootPath,
    get sourcesPath() { return join(workspaceRootPath, 'sources'); },
    get skillsPath() { return join(workspaceRootPath, 'skills'); },
    plansFolderPath,
    sessionPath: sessionsDir,
    dataPath: sessionDataDir,
    callbacks,
    fs,
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      return loadSourceConfigFromHelpers(workspaceRootPath, sourceSlug);
    },

    // 凭证管理器从主进程写入的缓存文件读取
    credentialManager,

    // 偏好设置：直接写入 preferences.json
    updatePreferences: (updates: Record<string, unknown>) => {
      // 从 config 目录（workspaces 目录的父目录）解析 preferences 路径
      // workspaceRootPath = ~/.craft-agent/workspaces/{id}
      // preferencesPath = ~/.craft-agent/preferences.json
      const configDir = join(workspaceRootPath, '..', '..');
      const prefsPath = join(configDir, 'preferences.json');
      try {
        let current: Record<string, unknown> = {};
        if (existsSync(prefsPath)) {
          current = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        }
        const merged = {
          ...current,
          ...updates,
          location: updates.location
            ? { ...(current.location as Record<string, unknown> || {}), ...(updates.location as Record<string, unknown>) }
            : current.location,
          updatedAt: Date.now(),
        };
        writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to update preferences:', err);
      }
    },

    // 开发者反馈：每条写一个 JSON 文件到 {configDir}/feedback/
    submitFeedback: (feedback) => {
      const configDir = process.env.CRAFT_CONFIG_DIR || join(workspaceRootPath, '..', '..');
      const feedbackDir = join(configDir, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
    },

    // 注意：saveSourceConfig、validators、renderMermaid
    // 在 Codex context 里不可用（需要 Electron 内部能力）
  };
}

// ============================================================
// 工具定义（来自规范注册表）
// ============================================================

function createSessionTools(includeDeveloperFeedback: boolean): Tool[] {
  return getToolDefsAsJsonSchema({
    includeDeveloperFeedback,
  }).map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as Tool['inputSchema'],
  }));
}

// ============================================================
// Craft Agents Docs 上游代理
// ============================================================

const DOCS_MCP_URL = 'https://agents.craft.do/docs/mcp';

/** 缓存的上游 client + 工具列表 */
let docsClient: Client | null = null;
let docsTools: Tool[] = [];

/**
 * 连接 craft-agents-docs MCP server 并获取其工具定义。
 * server 不可达时优雅降级（工具列表会是空的）。
 */
async function connectDocsUpstream(): Promise<void> {
  try {
    const client = new Client(
      { name: 'craft-agent-session-proxy', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(DOCS_MCP_URL));
    await client.connect(transport);

    const result = await client.listTools();
    docsTools = (result.tools || []) as Tool[];
    docsClient = client;

    console.error(`Craft Agents Docs proxy connected: ${docsTools.length} tools`);
  } catch (err) {
    console.error(`Craft Agents Docs proxy connection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    docsClient = null;
    docsTools = [];
  }
}

/**
 * 把工具调用路由到上游 docs client。
 */
async function callDocsUpstream(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!docsClient) {
    return errorResponse(`Craft Agents Docs server is not connected. Tool '${name}' unavailable.`);
  }

  try {
    const result = await docsClient.callTool({ name, arguments: args });
    // 把 MCP 结果转换成我们的格式
    const textContent = (result.content as Array<{ type: string; text?: string }> || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => ({ type: 'text' as const, text: c.text! }));

    return {
      content: textContent.length > 0 ? textContent : [{ type: 'text', text: '(No response from docs server)' }],
      isError: result.isError as boolean | undefined,
    };
  } catch (err) {
    return errorResponse(`Docs tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 判断某工具名是否属于 docs 上游 */
function isDocsUpstreamTool(name: string): boolean {
  return docsTools.some(t => t.name === name);
}

// ============================================================
// call_llm 处理器（后端专属）
// ============================================================

async function handleCallLlm(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // 主路径：PreToolUse 拦截注入 _precomputedResult（在 Codex 上生效）。
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`call_llm failed: ${parsed.error}`);
      }
      if (parsed.text !== undefined) {
        return {
          content: [{ type: 'text' as const, text: parsed.text || '(Model returned empty response)' }],
        };
      }
      return errorResponse('call_llm: _precomputedResult has unexpected format (missing text field).');
    } catch {
      return errorResponse(`call_llm: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // 兜底路径：对 agent 发 HTTP 回调（适用于 MCP 工具上 PreToolUse 不触发的 Copilot）。
  // callbackPort 取自 CLI 参数（--callback-port）或环境变量（CRAFT_LLM_CALLBACK_PORT）。
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/call-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as { text?: string; model?: string; error?: string };
      if (result.error) {
        return errorResponse(`call_llm failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: result.text || '(Model returned empty response)' }],
      };
    } catch (err) {
      return errorResponse(`call_llm callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'call_llm requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// spawn_session 处理器（后端专属）
// ============================================================

async function handleSpawnSession(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // 主路径：PreToolUse 拦截注入 _precomputedResult（在 Codex 上生效）。
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`spawn_session failed: ${parsed.error}`);
      }
      // 返回完整结果（可能是帮助信息或 spawn 结果）
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch {
      return errorResponse(`spawn_session: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // 兜底路径：对 agent 发 HTTP 回调（适用于 MCP 工具上 PreToolUse 不触发的 Copilot）。
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as Record<string, unknown>;
      if (result.error) {
        return errorResponse(`spawn_session failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(`spawn_session callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'spawn_session requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// MCP Server 设置
// ============================================================

function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    console.error(`Session MCP Server received ${signal}, shutting down gracefully`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in session MCP server:', reason);
  });
}

async function main() {
  setupSignalHandlers();

  // 解析命令行参数
  const args = process.argv.slice(2);
  let sessionId: string | undefined;
  let workspaceRootPath: string | undefined;
  let plansFolderPath: string | undefined;
  let callbackPort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    } else if (args[i] === '--workspace-root' && args[i + 1]) {
      workspaceRootPath = args[i + 1];
      i++;
    } else if (args[i] === '--plans-folder' && args[i + 1]) {
      plansFolderPath = args[i + 1];
      i++;
    } else if (args[i] === '--callback-port' && args[i + 1]) {
      callbackPort = args[i + 1];
      i++;
    }
  }

  if (!sessionId || !workspaceRootPath || !plansFolderPath) {
    console.error('Usage: session-mcp-server --session-id <id> --workspace-root <path> --plans-folder <path>');
    process.exit(1);
  }

  const config: SessionConfig = {
    sessionId,
    workspaceRootPath,
    plansFolderPath,
    // CLI 参数优先，环境变量兜底（Copilot CLI 可能不把 env 透传给子进程）
    callbackPort: callbackPort || process.env.CRAFT_LLM_CALLBACK_PORT,
  };

  // 创建 Codex context
  const ctx = createCodexContext(config);

  const includeDeveloperFeedback = isDeveloperFeedbackEnabled();
  const sessionToolRegistry = getSessionToolRegistry({ includeDeveloperFeedback });

  // 创建 MCP server
  const server = new Server(
    {
      name: 'craft-agent-session',
      version: '0.3.1',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 连接上游 docs server（非阻塞，尽力而为）
  await connectDocsUpstream();

  // 处理工具列表 —— session 工具 + docs 上游工具
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...createSessionTools(includeDeveloperFeedback), ...docsTools],
  }));

  // 处理工具调用 —— 经规范注册表、call_llm 或 docs 上游路由
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    try {
      // call_llm 有后端专属执行逻辑（预计算结果 / HTTP 回调）
      if (name === 'call_llm') {
        return await handleCallLlm(toolArgs as Record<string, unknown>, config);
      }

      // spawn_session 有后端专属执行逻辑（预计算结果 / HTTP 回调）
      if (name === 'spawn_session') {
        return await handleSpawnSession(toolArgs as Record<string, unknown>, config);
      }

      // 先查规范的 session 工具注册表（已按 feature 过滤）
      const def = sessionToolRegistry.get(name);
      if (def?.handler) {
        return await def.handler(ctx, toolArgs);
      }

      // 若是 docs 工具则路由到 docs 上游
      if (isDocsUpstreamTool(name)) {
        return await callDocsUpstream(name, toolArgs as Record<string, unknown>);
      }

      return errorResponse(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResponse(
        `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // 以 stdio 传输启动 server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Session MCP Server started for session ${sessionId} (developerFeedback=${includeDeveloperFeedback})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

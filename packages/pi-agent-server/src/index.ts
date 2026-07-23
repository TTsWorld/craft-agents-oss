#!/usr/bin/env node
/**
 * Pi Agent Server —— 通过 stdio JSONL 与主进程通信的进程外 Pi agent 服务。
 *
 * 封装 @earendil-works/pi-coding-agent SDK，用行分隔 JSON 协议与
 * Electron 主进程通信。
 *
 * 主进程把它作为子进程拉起。所有 Pi SDK 交互（会话创建、提示、工具执行、权限）
 * 都在这里完成，事件回传给主进程以渲染 UI。
 *
 * 这种设计把 Pi SDK 的 ESM + 重依赖隔离到独立进程，避免 Electron 主进程的打包问题。
 */

import http from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Pi SDK
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
  createReadToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  AuthCredential,
  CreateAgentSessionOptions,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// Pi AI types
import type { TextContent as PiTextContent } from '@earendil-works/pi-ai';

// 预注册 Bedrock provider 模块，避免 Pi SDK 在打包产物里动态 import
// "./amazon-bedrock.js"——bun 把所有东西打进单文件后这会失败。
// pi-ai 已去重（单一提升副本），所以一次注册就能覆盖 pi-ai 和
// pi-agent-core 两个模块作用域。
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
setBedrockProviderModule(bedrockProviderModule);

// 模型解析（抽离出来便于测试 + 自定义 endpoint 优先级）
import { resolvePiModel, isDeniedMiniModelId, isModelNotFoundError } from './model-resolution.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  type CustomEndpointModelEntry,
  type CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';

// 从 shared 直接导入源码（由 bun build 打包）
import { handleLargeResponse, estimateTokens, tokenLimitFor } from '../../shared/src/utils/large-response.ts';
import { getSessionPlansPath, getSessionPath } from '../../shared/src/sessions/storage.ts';
import { buildCallLlmRequest, withTimeout, LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { PI_TOOL_NAME_MAP, THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { allowCraftMetadataProperties, stripCraftMetadata } from './craft-metadata-schema.ts';
import { applySystemPromptOverride } from './system-prompt-override.ts';

// ============================================================
// 类型 —— JSONL 协议
// ============================================================

/** init 和 token_update 消息里使用的凭证联合类型 */
type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

/** 自定义 endpoint 协议——决定 Pi SDK 使用哪个流式适配器 */
type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/** 来自主进程的 init 消息——配置 Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  piAuth?: { provider: string; credential: PiCredential };
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

/** 来自主进程的消息（stdin） */
type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' };

/** 来自主进程的代理工具定义 */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 在 Pi 工具开始事件里透传的规范化工具元数据 */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type OutboundAgentEvent = AgentSessionEvent | EnrichedToolExecutionStartEvent;

/** 发往主进程的消息（stdout） */
interface OutboundReady { type: 'ready'; sessionId: string | null; callbackPort: number }
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface OutboundToolExecReq { type: 'tool_execute_request'; requestId: string; toolName: string; args: Record<string, unknown> }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * 设置后，向主进程表明同一 code 的通用 `error` 也已发到 error 通道
   * （用于集中式的鉴权刷新检测）。
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  errorMessage?: string;
}
interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }
interface OutboundError { type: 'error'; message: string; code?: string }

type OutboundMessage =
  | OutboundReady
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundSessionIdUpdate
  | OutboundError;

// ============================================================
// 状态
// ============================================================

let piSession: AgentSession | null = null;
let piModelRegistry: PiModelRegistry | null = null;
let moduleAuthStorage: PiAuthStorage | null = null;
let unsubscribeEvents: (() => void) | null = null;

// init 配置（收到 'init' 消息时设置）
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

// 可变状态
let currentUserMessage = '';

// 异步握手的待处理 Promise
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, { resolve: (result: { content: string; isError: boolean }) => void }>();

// 用于完成检测的待处理 session MCP 工具调用
const pendingSessionToolCalls = new Map<string, { toolName: string; arguments: Record<string, unknown> }>();

// 来自主进程的代理工具定义
let proxyToolDefs: ProxyToolDef[] = [];

// 只读工具的投机性预取（让 Pi SDK 顺序循环下也能并行执行）。
// 当 LLM 在单条消息里发出多个 call_llm 工具调用时，我们在 message_end 就并行向
// 主进程发出所有请求（早于 executeToolCalls 的顺序遍历）。
// 之后每个代理工具的 execute() 直接命中缓存，不再发新请求。
const PREFETCHABLE_TOOLS = new Set(['call_llm']);
const prefetchCache = new Map<string, Promise<{ content: string; isError: boolean }>>();

function isPrefetchableTool(toolName: string): boolean {
  const stripped = toolName.replace(/^(mcp__session__|session__)/, '');
  return PREFETCHABLE_TOOLS.has(stripped);
}

// 标记：自上次创建会话以来代理工具发生了变化——会话需要重建
let toolsChanged = false;

// call_llm 的回调服务器
let callbackServer: http.Server | null = null;
let callbackPort = 0;

// ============================================================
// JSONL 输入输出
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // 把调试信息写到 stderr，避免干扰 JSONL 协议
  process.stderr.write(`[pi-server] ${message}\n`);
}

/** 在目录里查找最近修改的 .jsonl 会话文件。 */
function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

// ============================================================
// 回调服务器（供 session MCP server 的 call_llm 使用）
// ============================================================

async function startCallbackServer(): Promise<void> {
  if (callbackServer) return;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/call-llm') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      debugLog('Received call_llm request via callback server');
      const result = await preExecuteCallLlm(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`call_llm via callback failed: ${msg}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
      debugLog(`Callback server listening on 127.0.0.1:${callbackPort}`);
      resolve();
    });
    server.on('error', reject);
  });

  callbackServer = server;
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackPort = 0;
  }
}

// ============================================================
// Pi 会话管理
// ============================================================

function resolvedCwd(): string {
  const wd = initConfig?.cwd || initConfig?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

// 辅助函数：根据 init 配置推导 preferCustomEndpoint 标志
function shouldPreferCustomEndpoint(): boolean {
  return Boolean(initConfig?.customEndpoint && initConfig?.baseUrl?.trim());
}

/**
 * 把当前 Pi 模型的 API/provider/base URL 暴露给拦截器进程。
 * 给拦截器一个稳健的路由线索（而非脆弱的纯 URL 匹配）。
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.CRAFT_PI_MODEL_API;
    delete process.env.CRAFT_PI_MODEL_PROVIDER;
    delete process.env.CRAFT_PI_MODEL_BASE_URL;
    return;
  }

  process.env.CRAFT_PI_MODEL_API = model.api || '';
  process.env.CRAFT_PI_MODEL_PROVIDER = model.provider || '';
  process.env.CRAFT_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.CRAFT_PI_MODEL_API || '-'} provider=${process.env.CRAFT_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.CRAFT_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * 解析自定义 endpoint 鉴权用的 API key。
 * 对于不需要鉴权的本地 endpoint（Ollama 等）返回空字符串。
 */
function resolveCustomEndpointApiKey(): string {
  if (initConfig?.piAuth?.credential?.type === 'api_key') {
    return initConfig.piAuth.credential.key;
  }
  const key = initConfig?.apiKey || '';
  if (!key && initConfig?.baseUrl) {
    if (isLocalhostUrl(initConfig.baseUrl)) {
      // 本地 endpoint（Ollama、LM Studio）不需要鉴权。
      // Pi SDK 注册模型时要求一个真值的 apiKey，所以用占位符。
      return 'not-needed';
    }
    debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

/** 当前注册在 custom-endpoint provider 下的 model ID */
let customEndpointModelIds: Set<string> = new Set();

/**
 * 用给定模型注册（或重新注册）custom-endpoint provider。
 * 注意：registerProvider 会整体替换 provider，所以我们用一个 Set 维护所有已知
 * model ID，每次都传完整集合。
 */
const customModelOverrides = new Map<string, CustomEndpointModelOverrides>();

function registerCustomEndpointModels(
  registry: PiModelRegistry,
  api: CustomEndpointApi,
  baseUrl: string,
  models: CustomEndpointModelEntry[],
): void {
  for (const m of models) {
    customEndpointModelIds.add(m.id);
    if (m.contextWindow || m.supportsImages !== undefined) {
      customModelOverrides.set(m.id, {
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
      });
    }
  }
  const allIds = [...customEndpointModelIds];
  registry.registerProvider('custom-endpoint', {
    baseUrl,
    apiKey: resolveCustomEndpointApiKey(),
    api,
    authHeader: true,
    models: allIds.map(id => buildCustomEndpointModelDef(
      id,
      { supportsImages: initConfig?.customEndpoint?.supportsImages === true },
      customModelOverrides.get(id),
    )),
  });
  debugLog(`Registered custom endpoint: ${baseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * 创建一个预加载用户凭证的内存 auth storage，以及基于它的 model registry。
 * 主会话和临时 queryLlm 会话都使用它。
 */
function createAuthenticatedRegistry(): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
} {
  // 复用模块级 authStorage（若已创建），以便 token_update 能修改它。
  // 只在首次调用或 re-init 之后才新建。
  if (!moduleAuthStorage) {
    moduleAuthStorage = PiAuthStorage.inMemory();
  }
  const authStorage = moduleAuthStorage;
  if (initConfig?.piAuth) {
    const { provider, credential } = initConfig.piAuth;
    // Pi SDK 0.70.0 的 AuthCredential 联合（ApiKeyCredential | OAuthCredential）
    // 没有把 'iam' 作为一等成员，但 auth storage 在运行时接受它——
    // Bedrock provider 模块直接读 AWS 环境变量；这个 `set` 让 Pi SDK 内部的
    // provider 追踪与凭证形态无关地保持一致。
    authStorage.set(provider, credential as unknown as AuthCredential);
    debugLog(`Injected ${credential.type} credential for provider: ${provider}`);
  } else if (initConfig?.apiKey) {
    authStorage.set('anthropic', { type: 'api_key', key: initConfig.apiKey });
    debugLog('Injected API key into auth storage (legacy fallback)');
  }

  const modelRegistry = PiModelRegistry.inMemory(authStorage);

  // 通过 Pi SDK 的 registerProvider API 动态注册自定义 endpoint 模型。
  // 这样就能让任意 OpenAI/Anthropic 兼容的 endpoint 借助合成的 Model<Api> 对象
  // 跑通 Pi SDK。
  const hasCustomEndpoint = !!initConfig?.baseUrl?.trim();
  if (hasCustomEndpoint && initConfig?.customEndpoint) {
    const { api } = initConfig.customEndpoint;
    const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
      ? initConfig.customModels
      : [initConfig.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    customEndpointModelIds = new Set();  // 新建注册表时重置
    registerCustomEndpointModels(modelRegistry, api, initConfig.baseUrl!.trim(), modelEntries);
  } else if (hasCustomEndpoint && !initConfig?.customEndpoint) {
    debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
  }

  return { authStorage, modelRegistry };
}

async function ensureSession(): Promise<AgentSession> {
  if (piSession) return piSession;
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const cwd = resolvedCwd();

  const { authStorage, modelRegistry } = createAuthenticatedRegistry();
  // 存到模块作用域，供 set_model handler 使用
  piModelRegistry = modelRegistry;

  // 构建工具：编码工具 + 带权限钩子的 web 工具 + 代理工具。
  // 搜索 provider 按用户的 LLM 连接选择：
  //   - OpenAI/OpenRouter → Responses API 内置的 web_search
  //   - ChatGPT Plus (openai-codex) → ChatGPT 后端 responses endpoint
  //   - Google → 带 googleSearch grounding 的 Gemini API
  //   - 其他 → DuckDuckGo 兜底
  //
  // 重要：每次搜索调用都动态解析，这样 token_update 刷新无需重建会话即可生效。
  const searchProvider = {
    get name() {
      return resolveSearchProvider(initConfig?.piAuth).name;
    },
    async search(query: string, count: number) {
      return resolveSearchProvider(initConfig?.piAuth).search(query, count);
    },
  };
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const webTools = [searchTool, webFetchTool];

  // Pi SDK 0.70.0 注册契约：
  //   - `customTools` 接受 ToolDefinition[]——我们包了钩子的工具对象放这里
  //   - `tools` 是 string[] 名字白名单——必须包含每一个想启用的工具，
  //     否则 Pi SDK 会默认使用内置的 [read, bash, edit, write] 集合并静默过滤掉其他。
  //     名字与内置工具同名的自定义工具会在 _refreshToolRegistry 里覆盖 SDK 的原始实现，
  //     于是我们的钩子版本（权限 + 大响应摘要）生效。
  //   - 不要把工具*对象*传给 `tools`——`allowedToolNames = new Set(options.tools)`
  //     之后对每个字符串 `.has(name)` 都返回 false → 一个工具都不会启用。
  const builtinDefs = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const proxyTools = buildProxyTools();
  const wrappedAll = wrapToolsWithHooks([...builtinDefs, ...webTools, ...proxyTools]);
  const toolAllowlist = wrappedAll.map(t => t.name);
  debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyTools.length} proxy = ${wrappedAll.length} total`);

  // 构建会话选项
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    authStorage,
    modelRegistry,
    customTools: wrappedAll,
    tools: toolAllowlist,
  };

  // 扩展隔离：把 agentDir 设为会话路径下的临时目录，
  // 防止从 ~/.pi/agent 加载全局 Pi 扩展
  if (initConfig.sessionPath) {
    const agentDir = initConfig.agentDir || join(initConfig.sessionPath, '.pi-agent');
    mkdirSync(agentDir, { recursive: true });
    sessionOptions.agentDir = agentDir;

    // 会话恢复：使用每个 Craft 会话独立的目录，让 Pi SDK 能在子进程重启后
    // 持久化并恢复自己的会话。
    // continueRecent() 会加载已存在的会话，不存在则新建——
    // 所以首启和恢复两种场景都覆盖了。
    const sessionDir = join(initConfig.sessionPath, '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    if (initConfig.branchFromSessionPath) {
      // 分支：从父会话的 Pi 会话文件 fork 出来。
      // 分支绝不能静默退化为全新会话。
      const parentPiSessionDir = join(initConfig.branchFromSessionPath, '.pi-sessions');
      const parentPiSessionFile = findMostRecentSessionFile(parentPiSessionDir);
      if (!parentPiSessionFile) {
        throw new Error(`Pi branch preflight failed: no parent Pi session file found in ${parentPiSessionDir}`);
      }

      debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
      const forkedSessionManager = PiSessionManager.forkFrom(parentPiSessionFile, cwd, sessionDir);

      // 严格分支截断：若提供了父条目，则把叶子移动到选中的父条目。
      // 这是 Pi 里等价于 Claude resumeSessionAt 的实现。
      if (initConfig.branchFromSdkTurnId) {
        const anchorId = initConfig.branchFromSdkTurnId;
        const anchorEntry = forkedSessionManager.getEntry(anchorId);
        if (!anchorEntry) {
          throw new Error(`Pi branch preflight failed: branch anchor not found: ${anchorId}`);
        }
        forkedSessionManager.branch(anchorId);
        debugLog(`Applied Pi branch cutoff at entry: ${anchorId}`);
      }

      sessionOptions.sessionManager = forkedSessionManager;
    } else {
      sessionOptions.sessionManager = PiSessionManager.continueRecent(cwd, sessionDir);
    }

  }

  // 指定时设置模型
  if (initConfig.model) {
    try {
      const piModel = resolvePiModel(modelRegistry, initConfig.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (piModel) {
        // 校验解析出的模型 provider 与已鉴权 provider 是否兼容。
        // 没有这层校验，解析到不同 provider 的模型（例如以 github-copilot 鉴权时
        // 却解析到 azure-openai-responses）会在运行时报 "No API key found"。
        const resolvedProvider = (piModel as any)?.provider;
        const isCompatible = !initConfig.piAuth ||
          resolvedProvider === initConfig.piAuth.provider ||
          resolvedProvider === 'custom-endpoint';
        if (isCompatible) {
          sessionOptions.model = piModel;
          setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
        } else {
          debugLog(`Model ${initConfig.model} resolved to incompatible provider ${resolvedProvider} (expected ${initConfig.piAuth!.provider}), skipping`);
          setInterceptorApiHints(undefined);
        }
      } else {
        setInterceptorApiHints(undefined);
      }
    } catch {
      debugLog(`Could not resolve Pi model: ${initConfig.model}`);
      setInterceptorApiHints(undefined);
    }
  } else {
    setInterceptorApiHints(undefined);
  }

  // 设置 thinking 级别
  const piThinkingLevel = THINKING_TO_PI[initConfig.thinkingLevel as keyof typeof THINKING_TO_PI];
  if (piThinkingLevel) {
    sessionOptions.thinkingLevel = piThinkingLevel;
  }

  // 创建会话——工具通过 customTools + 白名单传递（见上方注释）。
  const { session } = await createAgentSession(sessionOptions);
  piSession = session;

  toolsChanged = false;
  debugLog(`Created Pi session: ${session.sessionId} (${wrappedAll.length} tools)`);

  // 通知主进程会话 ID
  send({ type: 'session_id_update', sessionId: session.sessionId });

  return session;
}


// ============================================================
// 工具包装（权限校验 + 大响应摘要）
// ============================================================

/**
 * 编码工具和代理工具共享的权限校验。
 * 检查 mode-manager 规则，Ask 模式下通过待处理权限握手提示用户。拒绝或拦截时抛错。
 */
/**
 * 向主进程发送 pre_tool_use_request 并等待响应。
 * 批准时返回（可能被修改过的）input，拦截时抛错。
 * 所有权限检查、变换、source 激活都在主进程里完成。
 */
async function requestPreToolUseApproval(
  sdkToolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: sdkToolName,
    ...(toolCallId ? { toolCallId } : {}),
    input,
  });

  const response = await new Promise<{ action: string; input?: Record<string, unknown>; reason?: string }>((resolve) => {
    pendingPreToolUse.set(requestId, { resolve });
  });

  if (response.action === 'block') {
    throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
  }

  return response.action === 'modify' && response.input ? response.input : input;
}

function wrapToolsWithHooks(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map(tool => wrapSingleTool(tool));
}

function makeErrorResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}

function wrapSingleTool(tool: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const originalExecute = tool.execute;
  const parameters = allowCraftMetadataProperties(tool.parameters);

  const wrappedExecute: ToolDefinition<any, any>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    let inputObj: Record<string, unknown> = { ...(params as Record<string, unknown>) };

    // 在主进程剥除元数据前先提取 intent（用于摘要）
    const intent = typeof inputObj._intent === 'string' ? inputObj._intent : undefined;

    // 归一化 Pi SDK 参数名：path → file_path
    if ((sdkToolName === 'Write' || sdkToolName === 'Edit' || sdkToolName === 'MultiEdit' || sdkToolName === 'NotebookEdit')
        && typeof inputObj.path === 'string' && !inputObj.file_path) {
      inputObj = { ...inputObj, file_path: inputObj.path };
    }

    // 发给主进程做权限检查 + 变换
    inputObj = await requestPreToolUseApproval(sdkToolName, inputObj, toolCallId);

    // 元数据仅供 Craft UI 使用。这里再做一次防御性剥除，确保上游 Pi 工具实现
    // 总能收到干净的可执行参数，即便未来某条 pre-tool-use 路径在 `allow` 时
    // 不做修改也能兜住。
    inputObj = stripCraftMetadata(inputObj);

    // 用（可能被修改过的）input 执行原始工具
    const result = await originalExecute(toolCallId, inputObj, signal, onUpdate, ctx);

    // --- 执行后：大响应摘要 ---

    const resultText = result.content
      .filter((c): c is PiTextContent => c.type === 'text')
      .map(c => c.text)
      .join('');

    // 每次调用都取当前模型的 contextWindow，让阈值随会话中的 set_model 动态变化，
    // 而不是锁定在创建会话时的模型。模型尚未设置时回退到固定默认值。
    const modelContextWindow = piSession?.agent.state.model?.contextWindow;
    if (estimateTokens(resultText) > tokenLimitFor(modelContextWindow) && initConfig) {
      try {
        const sessionPath = getSessionPath(
          initConfig.workspaceRootPath,
          initConfig.sessionId,
        );

        const largeResult = await handleLargeResponse({
          text: resultText,
          sessionPath,
          context: {
            toolName: sdkToolName,
            input: inputObj,
            intent,
            userRequest: currentUserMessage,
          },
          summarize: runMiniCompletion,
          contextWindow: modelContextWindow,
        });

        if (largeResult) {
          return {
            content: [{ type: 'text', text: largeResult.message }],
            details: result.details,
          };
        }
      } catch (error) {
        debugLog(
          `Large response handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  };

  return {
    ...tool,
    parameters,
    execute: wrappedExecute,
  };
}

// ============================================================
// 代理工具（在主进程中执行的工具）
// ============================================================

function buildProxyTools(): ToolDefinition<any, any>[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map<ToolDefinition<any, any>>(def => ({
    name: def.name,
    label: def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    description: def.description,
    // Pi SDK 会把没有 promptSnippet 的工具从 system prompt 的
    // "Available tools" 段落里省略，导致 LLM 看不到它们。
    // 从 description 派生一个 snippet，让代理工具能被列出。
    promptSnippet: def.description.length > 200
      ? def.description.slice(0, 197) + '...'
      : def.description,
    parameters: def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<any>> => {
      // 先查投机预取缓存（call_llm 并行优化）。
      // 如果该工具在 message_end 已被预取，请求已在途——直接 await 结果即可，
      // 不必再发重复请求。
      const prefetched = prefetchCache.get(toolCallId);
      if (prefetched) {
        prefetchCache.delete(toolCallId);
        debugLog(`Prefetch cache hit for ${def.name} (toolCallId: ${toolCallId})`);
        const result = await prefetched;
        return {
          content: [{ type: 'text', text: result.content }],
          details: result.isError ? { isError: true } : undefined,
        };
      }

      const inputObj = params as Record<string, unknown>;

      // 通过主进程做权限检查
      const approvedInput = await requestPreToolUseApproval(def.name, inputObj, toolCallId);

      // 通过主进程执行
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        args: approvedInput,
      });

      const result = await new Promise<{ content: string; isError: boolean }>((resolve) => {
        pendingToolExecutions.set(requestId, { resolve });
      });

      return {
        content: [{ type: 'text', text: result.content }],
        details: result.isError ? { isError: true } : undefined,
      };
    },
  }));
}

// ============================================================
// LLM 查询（用于 call_llm + mini 补全的临时会话）
// ============================================================

async function queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
  if (!initConfig) throw new Error('Cannot run queryLlm: init not received');

  debugLog('[queryLlm] Starting');

  // 选 mini 模型。如果配置的 miniModel 用的 provider 与用户鉴权的 provider 不同
  // （例如只有 anthropic 凭证却配了 gemini-2.5-pro），则回退到默认摘要模型——
  // 它用的是同一 provider 家族。
  let model = request.model ?? initConfig.miniModel ?? getDefaultSummarizationModel();

  // 提前创建带鉴权的注册表——provider 守卫和临时会话都会用到它。
  const { authStorage, modelRegistry } = createAuthenticatedRegistry();

  const piAuthProvider = initConfig.piAuth?.provider;

  // piAuth 已设置时，确保 mini 模型用同一 provider。
  // 模型若需要不同 provider，Pi SDK 会报 "No API key found"。
  // 例外：'custom-endpoint' provider 永远兼容，因为它通过 resolveCustomEndpointApiKey()
  // 配了自己的 API key，不走 authStorage。
  if (initConfig.piAuth) {
    const authProvider = initConfig.piAuth.provider;
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(modelRegistry, bareModel, authProvider, shouldPreferCustomEndpoint());
    const resolvedProvider = (resolved as any)?.provider;
    const isCompatible = resolvedProvider === authProvider || resolvedProvider === 'custom-endpoint';
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, piAuthProvider)) {
      // Anthropic：保留 Haiku（便宜/快的 mini）。其他 provider 下 Haiku 无法解析，
      // 所以遍历 PI_PREFERRED_DEFAULTS 找一个在用户鉴权下真能用的模型。
      const providerDefault = authProvider === 'anthropic'
        ? undefined
        : pickProviderAppropriateMiniModel(authProvider, modelRegistry, shouldPreferCustomEndpoint());
      const fallback = providerDefault ?? getDefaultSummarizationModel();
      debugLog(`[queryLlm] Model ${bareModel} incompatible with ${authProvider} (resolved: ${resolvedProvider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    debugLog(`[queryLlm] Using model: ${modelId}`);

    // 解析模型——无法解析时立刻失败，避免让 Pi SDK 回退到自己的内部默认
    // （那可能要求一个用户没鉴权过的 provider，表现为误导性的
    // "No API key found for <provider>" 错误）。
    const piModel = resolvePiModel(modelRegistry, modelId, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${initConfig!.piAuth?.provider ?? '(unknown)'}"`,
      );
    }

    // 创建最小化临时会话
    const ephemeralOptions: CreateAgentSessionOptions = {
      cwd: resolvedCwd(),
      authStorage,
      modelRegistry,
      tools: [],
      sessionManager: PiSessionManager.inMemory(),
      model: piModel,
    };

    const { session: ephemeralSession } = await createAgentSession(ephemeralOptions);

    // Pi SDK 对临时会话会忽略 options.model（与 options.tools 同一问题）。
    // 创建后显式设置模型，确保用的是 mini 模型。
    try {
      await ephemeralSession.setModel(piModel);
    } catch {
      debugLog(`[queryLlm] Failed to set model on ephemeral session, proceeding with default`);
    }

    debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);

    // 强制设置 system prompt——直接赋值给 `state.systemPrompt` 无法在
    // `session.prompt()` 后存活，原因见 system-prompt-override.ts。
    const promptForSession =
      request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.';
    applySystemPromptOverride(ephemeralSession, promptForSession);

    // 从事件中收集响应文本和错误
    let result = '';
    let lastError = '';
    let completionResolve: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });

    const unsub = ephemeralSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end') {
        // 只捕获 assistant 消息——Pi SDK 对 user 消息也会发 message_end
        const msg = event.message as {
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
        };
        if (msg.role !== 'assistant') return;

        // 从 message_end 捕获 API 错误（例如鉴权失败、模型错误）
        if (msg.stopReason === 'error' && msg.errorMessage) {
          lastError = msg.errorMessage;
          debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
        }

        if (typeof msg.content === 'string') {
          result = msg.content;
        } else if (Array.isArray(msg.content)) {
          result = msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('');
        }
      }
      if (event.type === 'agent_end') {
        completionResolve();
      }
    });

    try {
      await ephemeralSession.prompt(request.prompt);
      await withTimeout(
        completionPromise,
        LLM_QUERY_TIMEOUT_MS,
        `queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`
      );
      debugLog(`[queryLlm] Result length: ${result.trim().length}`);

      // 如果没拿到文本但捕获到了错误，抛出让调用方看到真正的问题
      if (!result.trim() && lastError) {
        throw new Error(lastError);
      }

      return result.trim();
    } finally {
      unsub();
      ephemeralSession.dispose();
    }
  };

  const fallbackCandidates = [
    // 已移除 'pi/gpt-5.1-codex-mini'（#596）——在多个 OpenAI catalog 上已失效。
    // 连接配置的 miniModel 仍会通过 `initConfig.miniModel` 尝试。
    'pi/gpt-5-mini',
    initConfig.miniModel,
    getDefaultSummarizationModel(),
  ].filter((candidate): candidate is string => !!candidate && !isDeniedMiniModelId(candidate, piAuthProvider));

  const triedModels = new Set<string>();
  let currentModel = model;

  while (true) {
    triedModels.add(currentModel);
    try {
      const text = await runQueryWithModel(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const shouldRetry = isModelNotFoundError(errorMsg);

      if (!shouldRetry) {
        throw error;
      }

      const retryModel = fallbackCandidates.find(candidate => {
        if (triedModels.has(candidate)) return false;
        try {
          const resolved = resolvePiModel(modelRegistry, candidate, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
          if (!resolved) return false;
          if (initConfig!.piAuth) {
            const rp = (resolved as any).provider;
            if (rp !== initConfig!.piAuth.provider && rp !== 'custom-endpoint') {
              return false;
            }
          }
          return true;
        } catch {
          return false;
        }
      });

      if (!retryModel) {
        throw error;
      }

      debugLog(`[queryLlm] Model ${currentModel} not found, retrying with ${retryModel}`);
      currentModel = retryModel;
    }
  }
}

async function preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
  const sessionPath = initConfig
    ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId)
    : undefined;
  const request = await buildCallLlmRequest(input, { backendName: 'Pi', sessionPath });
  return queryLlm(request);
}

async function runMiniCompletion(prompt: string): Promise<string | null> {
  try {
    const result = await queryLlm({ prompt });
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// 事件处理
// ============================================================

function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
  if (!args) return undefined;

  const intent = typeof args._intent === 'string' ? args._intent : undefined;
  const displayName = typeof args._displayName === 'string' ? args._displayName : undefined;

  if (!intent && !displayName) return undefined;

  return {
    intent,
    displayName,
    source: 'interceptor',
  };
}

function handleSessionEvent(event: AgentSessionEvent): void {
  let forwardedEvent: OutboundAgentEvent = event;

  // 记录 API 错误用于调试，并附上 provider 原生的轮次锚点用于分支截断。
  if (event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.stopReason === 'error') {
      debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
    }

    if (msg?.role === 'assistant' && piSession) {
      // 关键：这里不要读 `getLeafId()`。
      //
      // Pi SDK 在调用 `appendMessage(event.message)` 之前同步触发 `message_end`
      // （见 `agent-session.js:_processAgentEvent`）。此时 assistant 条目还没写入
      // SessionManager——`leafId` 还指向*上一个*叶子，对纯文本轮次而言就是触发
      // 响应的 user 消息。把这个错误的锚点记下来再用于 `branch()`，会让下一轮变成
      // assistant 消息的兄弟节点，把 assistant 回复从 LLM 的历史视图里丢掉
      // （craft-agents-oss#782）。
      //
      // 改为把 SDK 的 message id 附到转发事件上，让主进程能关联这一轮；
      // 然后排队一个 microtask，在 `appendMessage` 执行后再读正确的叶子。
      // microtask 会在后续任何 SDK 事件分发前排空，因此后续的
      // `pi_turn_anchor` 事件会按正确顺序投递给主进程
      // （在本条 `message_end` 之后、下一个事件之前）。
      const sdkMessageId = (msg as { id?: string }).id;
      if (sdkMessageId) {
        forwardedEvent = {
          ...(event as Record<string, unknown>),
          sdkMessageId,
        } as unknown as OutboundAgentEvent;

        const sessionManagerSnapshot = piSession.sessionManager;
        queueMicrotask(() => {
          // 防御性处理：message_end 触发到 microtask 排空之间，会话可能已被释放。
          if (!piSession || piSession.sessionManager !== sessionManagerSnapshot) {
            return;
          }
          const sdkTurnAnchor = sessionManagerSnapshot.getLeafId();
          if (!sdkTurnAnchor) return;
          send({
            type: 'event',
            event: {
              type: 'pi_turn_anchor',
              sdkMessageId,
              sdkTurnAnchor,
            } as unknown as OutboundAgentEvent,
          });
        });
      }

      // 投机预取：如果 assistant 消息包含 2 个及以上可预取的工具调用，
      // 现在就并行向主进程发出所有请求，早于 executeToolCalls 的顺序遍历。
      // 每个代理工具的 execute() 之后会命中缓存。
      const content = (msg as { content?: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content;
      if (Array.isArray(content)) {
        const prefetchableToolCalls = content.filter(
          (c) => c.type === 'toolCall' && c.name && isPrefetchableTool(c.name),
        );
        if (prefetchableToolCalls.length >= 2) {
          debugLog(`Prefetching ${prefetchableToolCalls.length} parallel ${prefetchableToolCalls[0].name} calls`);
          for (const tc of prefetchableToolCalls) {
            const requestId = `prefetch-${tc.id}`;
            const promise = new Promise<{ content: string; isError: boolean }>((resolve) => {
              pendingToolExecutions.set(requestId, { resolve });
            });
            send({
              type: 'tool_execute_request',
              requestId,
              toolName: tc.name!,
              args: (tc.arguments ?? {}) as Record<string, unknown>,
            });
            prefetchCache.set(tc.id!, promise);
          }
        }
      }
    }
  }

  // 检测 session MCP 工具完成 + 给工具开始事件附上规范化元数据
  if (event.type === 'tool_execution_start') {
    const toolName = event.toolName;
    if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
      const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
      pendingSessionToolCalls.set(event.toolCallId, {
        toolName: mcpToolName,
        arguments: (event.args ?? {}) as Record<string, unknown>,
      });
    }

    const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
    if (toolMetadata) {
      forwardedEvent = {
        ...event,
        toolMetadata,
      };
    }
  }

  if (event.type === 'tool_execution_end') {
    const pending = pendingSessionToolCalls.get(event.toolCallId);
    if (pending) {
      pendingSessionToolCalls.delete(event.toolCallId);
      send({
        type: 'session_tool_completed',
        toolName: pending.toolName,
        args: pending.arguments,
        isError: !!event.isError,
      });
    }
  }

  // 把所有事件转发给主进程
  send({ type: 'event', event: forwardedEvent });
}

// ============================================================
// 命令处理器
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  // 清理上一次 init 遗留的会话
  if (piSession) {
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    piSession.dispose();
    piSession = null;
    moduleAuthStorage = null; // 重置，让 createAuthenticatedRegistry() 重新创建存储
    debugLog('Cleaned up existing session for re-init');
  }

  initConfig = msg;

  // Azure OpenAI 需要租户专属的 endpoint URL。
  // Pi SDK（经 Vercel AI SDK）从 env 读取 AZURE_OPENAI_BASE_URL。
  if (msg.piAuth?.provider === 'azure-openai-responses' && msg.baseUrl) {
    process.env.AZURE_OPENAI_BASE_URL = msg.baseUrl;
    debugLog(`Set AZURE_OPENAI_BASE_URL=${msg.baseUrl}`);
  }

  // 启动 call_llm 回调服务器（幂等——已运行则跳过）
  await startCallbackServer();

  send({
    type: 'ready',
    sessionId: null,
    callbackPort,
  });
}

/**
 * 在发送 prompt 或启动另一次压缩前，等待任何进行中的压缩完成。
 * 避免 Pi SDK 里并发 _runAutoCompaction 在共享 AbortController 上崩溃的竞态
 * （见 craft-agents-oss#464）。默认超时与 PiAgent.requestCompact 的 RPC
 * 压缩超时一致（300 s），因为 GPT 压缩合理情况下可能要 60–120 s。
 */
async function waitForCompaction(session: { isCompacting: boolean }, timeoutMs = 300_000): Promise<void> {
  if (!session.isCompacting) return;
  debugLog('Waiting for in-flight compaction to finish before prompt...');
  const start = Date.now();
  while (session.isCompacting) {
    if (Date.now() - start > timeoutMs) {
      debugLog(`Compaction wait timed out after ${Math.floor(timeoutMs / 1000)}s, proceeding anyway`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (Date.now() - start < timeoutMs) {
    debugLog('Compaction finished, proceeding with prompt');
  }
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  currentUserMessage = msg.message;

  try {
    // 若自上次创建会话以来代理工具发生了变化，则销毁并重建。
    // 这样避免为动态工具更新去调 _buildRuntime()——而是用 continueRecent()
    // 新建一个已知全部工具的会话。
    if (toolsChanged && piSession) {
      debugLog('Recreating session due to tool changes');
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      piSession.dispose();
      piSession = null;
    }

    const session = await ensureSession();

    // 把 Craft 构建的 system prompt 强制写入 Pi 会话。直接赋值给
    // `state.systemPrompt` 会在每次 `session.prompt()` 调用时被 Pi SDK 覆盖
    // （见 system-prompt-override.ts）。
    if (msg.systemPrompt) {
      applySystemPromptOverride(session, msg.systemPrompt);
    }

    // 绑定事件处理器
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    unsubscribeEvents = session.subscribe(handleSessionEvent);

    // 等待任何进行中的自动压缩，避免竞态（craft-agents-oss#464）
    await waitForCompaction(session);

    // 发起 prompt——会话已在流式输出时用 followUp，把消息排队，
    // 而不是抛 "Agent is already processing"。
    await session.prompt(msg.message, {
      images: msg.images && msg.images.length > 0 ? msg.images : undefined,
      streamingBehavior: 'followUp',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // 这里不做 wrapper 侧的溢出恢复。Pi SDK 的 _checkCompaction 已在溢出时
    // 调用 `_runAutoCompaction("overflow", true)` 并调 agent.continue() 重试一次。
    // 我们自己再跑 session.compact() 会与 SDK 并发竞争，这正是
    // `_runAutoCompaction` 中 AbortController 崩溃的文档化成因（见
    // plans/fix-pi-gpt-compaction.md）。PiEventAdapter 会在 SDK 恢复流程期间
    // 保持 Craft 事件队列打开，让恢复后的轮次能到达 UI。

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // 发送合成的 agent_end，让主进程事件队列解除阻塞。
    // willRetry: false——这是终结错误路径，不会再重试。
    send({ type: 'event', event: { type: 'agent_end', messages: [], willRetry: false } });
  }
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  // 合并：按名字替换已有工具，添加新工具
  const incoming = new Map(msg.tools.map(t => [t.name, t]));
  proxyToolDefs = [
    ...proxyToolDefs.filter(t => !incoming.has(t.name)),
    ...msg.tools,
  ];
  debugLog(`Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);

  // 会话已存在时，标记下次 prompt 时重建。
  // 不在生成中途销毁——该标志在 handlePrompt() 里检查。
  if (piSession) {
    toolsChanged = true;
    debugLog('Proxy tools changed — session will be recreated on next prompt');
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ action: msg.action, input: msg.input, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

async function handleAbort(): Promise<void> {
  if (piSession) {
    try {
      await piSession.abort();
    } catch (error) {
      debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 拒绝所有待处理的 pre-tool-use 请求
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Aborted' });
  }
  pendingPreToolUse.clear();

  // 清空投机预取缓存——在途的预取会 resolve 但永远不会被消费
  prefetchCache.clear();
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // 直接调用 queryLlm（不走 runMiniCompletion），让鉴权错误以 'error' 消息上抛，
  // 而不是被吞掉返回 null。runMiniCompletion 保留给摘要回调，那里 null 是可接受的。
  try {
    const result = await queryLlm({ prompt: msg.prompt });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'mini_completion_error' });
  }
}

// 不变式：完整的 LLMQueryRequest 形状必须原样通过这个 RPC。
// 给 LLMQueryRequest 加了字段？这里不用改——我们把 `msg.request` 原样传给 queryLlm()。
// 但要确认 queryLlm() 确实用到了新字段；请求透传与请求生效是两回事（见 #596）。
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  try {
    const result = await queryLlm(msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
    // 双发：通用 `error` 通道驱动主进程的 OAuth 鉴权刷新检测（集中在 PiAgent），
    // 定向的 `llm_query_result` 则 reject 本次调用对应的 pending Promise。
    send({ type: 'error', message: errorMsg, code: 'llm_query_error' });
    send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
  }
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const session = await ensureSession();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: session.sessionId || null,
  });
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  try {
    const session = await ensureSession();
    // 把手动 /compact 串行化在所有进行中的自动压缩之后。公开的
    // session.compact() 会调 agent.abort() 并用自己的 controller；若在
    // _runAutoCompaction 挂起期间运行，agent 状态会反复变化，扩大 SDK 的竞态面。
    // 等自动压缩排空后再启动手动压缩。waitForCompaction 有自己的超时兜底，
    // 不会因卡住的子进程而死锁。
    await waitForCompaction(session);
    const result = await session.compact(msg.customInstructions);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[compact] Failed: ${errorMsg}`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  try {
    const session = await ensureSession();
    session.setAutoCompactionEnabled(msg.enabled);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: session.autoCompactionEnabled,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: false,
      enabled: msg.enabled,
      errorMessage: errorMsg,
    });
  }
}

async function handleUpdateRuntimeConfig(msg: RuntimeConfigUpdateMessage): Promise<void> {
  try {
    if (!initConfig) {
      throw new Error('Runtime config update received before init');
    }

    initConfig = {
      ...initConfig,
      model: msg.model,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    };

    if (piModelRegistry && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
      const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
        ? initConfig.customModels
        : [initConfig.model || 'default']
      ).map(normalizeCustomEndpointModelEntry);

      customEndpointModelIds = new Set();
      customModelOverrides.clear();
      registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), modelEntries);
    }

    if (piSession && piModelRegistry) {
      let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (!piModel && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
        const bareId = stripPiPrefix(msg.model);
        registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), [{ id: bareId }]);
        piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
        debugLog(`[runtime_config] Dynamically registered custom endpoint model: ${bareId}`);
      }

      if (!piModel) {
        throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
      }

      await piSession.setModel(piModel);
      setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
      debugLog(`[runtime_config] Updated runtime config and active model: ${piModel.provider}/${piModel.id}`);
    } else {
      debugLog('[runtime_config] Stored update; no active session/model registry yet');
    }

    send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[runtime_config] Failed: ${errorMsg}`);
    send({ type: 'update_runtime_config_result', id: msg.id, success: false, updated: false, errorMessage: errorMsg });
  }
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!piSession || !piModelRegistry) {
    debugLog(`[set_model] No active session or model registry, ignoring`);
    return;
  }
  let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig?.piAuth?.provider, shouldPreferCustomEndpoint());

  // 自定义 endpoint 下，动态注册未知模型，让会话中途切换模型可用。
  // 用 registerCustomEndpointModels，它会把模型累加进已有集合
  // （registerProvider 是整体替换，所以我们追踪所有 ID 再整体注册）。
  if (!piModel && initConfig?.baseUrl?.trim() && initConfig?.customEndpoint) {
    const bareId = stripPiPrefix(msg.model);
    registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl!.trim(), [{ id: bareId }]);
    piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
    debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}`);
  }

  if (!piModel) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    return;
  }
  try {
    await piSession.setModel(piModel);
    setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
  }
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!piSession) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  try {
    piSession.setThinkingLevel(piLevel);
    debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_thinking_level] Failed to set thinking level: ${errorMsg}`);
  }
}

function handleShutdown(): void {
  debugLog('Shutdown requested');

  // 取消事件订阅
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }

  // 释放会话
  if (piSession) {
    piSession.dispose();
    piSession = null;
  }

  // 停止回调服务器
  stopCallbackServer();

  // reject 待处理的 Promise
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();

  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();

  process.exit(0);
}

// ============================================================
// 主 JSONL 读取循环
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await handleSetModel(msg);
      break;

    case 'set_thinking_level':
      await handleSetThinkingLevel(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'update_runtime_config':
      await handleUpdateRuntimeConfig(msg);
      break;

    case 'steer':
      if (piSession) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await piSession.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update':
      if (moduleAuthStorage) {
        const { provider, credential } = msg.piAuth;
        // 见首次 `authStorage.set` 调用处的注释——同样的形态原因。
        moduleAuthStorage.set(provider, credential as unknown as AuthCredential);
        if (initConfig) {
          initConfig.piAuth = msg.piAuth;
        }
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog('token_update received but no authStorage initialized');
      }
      break;

    case 'shutdown':
      handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

function main(): void {
  debugLog('Pi agent server starting');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    handleShutdown();
  });

  // 处理未捕获错误——发生这些错误后进程状态已不可靠，
  // 因此先尝试上报再立即退出。
  // send() 包了 try/catch，因为 stdout 本身可能已坏
  // （例如管道关闭导致的 EFAULT），不能让错误上报再触发一次
  // uncaughtException（会死循环）。
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout 可能已坏——吞掉，避免再次触发
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout 可能已坏——吞掉，避免再次触发
    }
    process.exit(1);
  });
}

main();

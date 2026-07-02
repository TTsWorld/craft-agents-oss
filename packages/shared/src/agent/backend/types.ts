/**
 * 【文件级注释】后端抽象类型：定义所有 AI 后端必须实现的统一接口
 *
 * 在 Agent 后端架构中的位置：
 *   - 位于 backend 层的最顶端，是 facade 模式中的 "统一门面接口"。
 *   - 无论底层是 Claude（Anthropic SDK）还是 Pi（@earendil-works/pi-ai），
 *     上层 SessionManager / CraftAgent 只依赖 AgentBackend 接口，
 *     从而实现 provider 切换而不用改上层代码。
 *
 * 类比 Golang：
 *   - 相当于定义了一个 Go interface，例如 `type AgentBackend interface { ... }`，
 *     所有具体后端（ClaudeAgent、PiAgent）都实现这个接口。
 *   - `AsyncGenerator<AgentEvent>` 可以理解为返回 `chan AgentEvent` 的方法，
 *     上层用 `for event := range backend.chat(...)` 读取流式事件。
 *
 * TypeScript 特性速览：
 *   - `interface`：描述对象形状，可多继承（extends），可合并声明。
 *   - `type`：类型别名，常用于联合类型、交叉类型、函数签名。
 *   - `?` 可选属性、`readonly` 只读属性：比 Go struct tag 更灵活的元数据。
 *   - `AsyncGenerator<T>`：带类型的异步生成器，TS 泛型让事件流有编译期类型保证。
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../../utils/files.ts';
import type { ThinkingLevel } from '../thinking-levels.ts';
import type { PermissionMode } from '../mode-manager.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { AuthRequest } from '../session-scoped-tools.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { Workspace } from '../../config/storage.ts';
import type { SessionConfig as Session } from '../../sessions/storage.ts';
import type { SourceManager } from '../core/source-manager.ts';

// 从 core 模块导入 AbortReason 与 RecoveryMessage（单一事实来源）
import { AbortReason, type RecoveryMessage } from '../core/index.ts';
export { AbortReason, type RecoveryMessage };

import type { ModelProvider } from '../../config/models.ts';

// 导入 LLM 连接类型，用于鉴权相关字段
import type { LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';
export type { LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';

export interface BackendRuntimeUpdate {
  model: string;
  providerType?: LlmProviderType;
  authType?: LlmAuthType;
  runtime?: {
    baseUrl?: string;
    piAuthProvider?: string;
    customEndpoint?: { api: string; supportsImages?: boolean };
    customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
    [key: string]: unknown;
  };
}
import type { AutomationSystem } from '../../automations/index.ts';

/**
 * AI 后端的 provider 标识。
 * @deprecated 请改用 config/models.ts 中的 ModelProvider
 */
export type AgentProvider = ModelProvider;


// ============================================================
// 回调类型
// ============================================================

/**
 * 不同工具类别的权限提示类型。
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';

/**
 * 权限请求回调签名。
 * 当某个工具在执行前需要用户授权时调用。
 */
export type PermissionCallback = (request: {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}) => void;

/**
 * 计划提交回调签名。
 * 当 agent 提交计划供用户审阅时调用。
 */
export type PlanCallback = (planPath: string) => void;

/**
 * 鉴权请求回调签名。
 * 当某个 source 需要鉴权时调用。
 */
export type AuthCallback = (request: AuthRequest) => void;

/**
 * Source 变更回调签名。
 * 当 source 被激活、停用或修改时调用。
 */
export type SourceChangeCallback = (slug: string, source: LoadedSource | null) => void;

/**
 * Source 激活请求回调。
 * 返回 true 表示 source 激活成功。
 */
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>;

// ============================================================
// 生命周期类型
// ============================================================

/**
 * 后端构造后初始化（post-initialization）的结果，包含鉴权注入、配置设置等状态。
 * 由 postInit() 返回，供 session 层展示警告信息。
 */
export interface PostInitResult {
  /** 鉴权凭据是否成功注入 */
  authInjected: boolean;
  /** 可选的 UI 警告信息 */
  authWarning?: string;
  /** 警告的严重级别 */
  authWarningLevel?: 'error' | 'warning' | 'info';
}

/**
 * 会话进行中应用 bridge / 配置更新的上下文。
 * 在 source 变化、token 刷新或鉴权完成时使用。
 */
export interface BridgeUpdateContext {
  /** 会话目录路径 */
  sessionPath: string;
  /** 当前已启用的 sources */
  enabledSources: LoadedSource[];
  /** 预构建的 MCP server 配置 */
  mcpServers: Record<string, SdkMcpServerConfig>;
  /** 会话 ID */
  sessionId: string;
  /** 工作区根目录路径 */
  workspaceRootPath: string;
  /** 用于日志描述的上下文（例如 'token refresh'、'source enable'） */
  context: string;
  /** McpPoolServer HTTP 端点 URL */
  poolServerUrl?: string;
}

/**
 * 由应用外壳（Electron/CLI 等）传入的 host runtime 上下文。
 * 故意保持与 provider 无关；backend driver 内部据此解析 provider 专属路径。
 */
export interface BackendHostRuntimeContext {
  /** 应用根路径（打包后的 app 路径，或开发时的仓库根） */
  appRootPath: string;
  /** 可选的 resources 路径（打包后的 Windows 运行时解析需要） */
  resourcesPath?: string;
  /** 宿主应用是否以打包构建运行 */
  isPackaged: boolean;
  /** 可选的 Node/Bun 可执行文件覆盖路径 */
  nodeRuntimePath?: string;
  /** 可选的拦截器 bundle 覆盖路径（通过 --require 加载的 CJS bundle） */
  interceptorBundlePath?: string;
}

/**
 * session 层使用的、与 provider 无关的后端配置。
 * provider 专属的运行时细节由 backend driver 内部解析。
 */
export interface CoreBackendConfig {
  /** 工作区配置 */
  workspace: Workspace;

  /** Session 配置（用于恢复会话） */
  session?: Session;

  /** 初始模型 ID */
  model?: string;

  /** 小型/utility 模型，用于摘要、标题生成、mini-completion */
  miniModel?: string;

  /** 初始 thinking 等级 */
  thinkingLevel?: ThinkingLevel;

  /** Headless 模式标志（禁用交互式工具） */
  isHeadless?: boolean;

  /** 跳过 agent 级配置文件监听（server 已持有 workspace 级 watcher） */
  skipConfigWatcher?: boolean;

  /** 调试模式配置 */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };

  /** system prompt 预设（'default' | 'mini' | 自定义字符串） */
  systemPromptPreset?: 'default' | 'mini' | string;

  /** 工作区级别的自动化系统，用于用户自定义自动化（automations.json） */
  automationSystem?: AutomationSystem;

  /**
   * 每 session 覆盖 SDK 子进程的环境变量。
   * 在 backend 专属选项构建器里按 `...process.env, ...envOverrides` 展开。
   */
  envOverrides?: Record<string, string>;

  /**
   * 集中式 MCP 客户端池，用于执行 source 工具。
   * 在主进程中持有所有 MCP source 连接。
   */
  mcpPool?: McpClientPool;

  /**
   * 本 session 对应的 McpPoolServer HTTP 端点 URL。
   * 外部 SDK 子进程连到这里以使用 pool 托管的 MCP 工具。
   */
  poolServerUrl?: string;

  /** SDK session ID 被捕获/更新时调用 */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** SDK session ID 被清除时调用（例如恢复失败后） */
  onSdkSessionIdCleared?: () => void;

  /**
   * 当 agent 判断持久化的 branch-fork 元数据
   *（branchFromSdkSessionId / branchFromSdkCwd / branchFromSdkTurnId）
   * 在当前机器上无法恢复时调用 —— 通常因为父 session 的 sdk cwd 在本地不存在
   *（跨机器导入 session）或 SDK fork 在建立子 session 前就失败了。
   *
   * 实现必须原子性地清除并持久化全部四个字段（包括 sdkSessionId）。
   * 仅调用 `onSdkSessionIdCleared` 不够，因为它只清 sdkSessionId；
   * branch 字段下次启动会从磁盘重新加载并再次触发失败。
   */
  onBranchForkInvalidated?: () => void;

  /** 获取最近消息，用于恢复上下文 */
  getRecoveryMessages?: () => RecoveryMessage[];

  /**
   * 获取分支 fork 兜底所需的全部父消息（不限于 6 条）。
   * 当 SDK 级别的 branch fork 失败、需要通过 mini completion 注入父对话摘要时调用。
   * 非分支 session 返回空数组。
   */
  getBranchFallbackMessages?: () => RecoveryMessage[];

  /**
   * 获取分支种子消息（到分支截断点为止），用于 seeded branch 模式的首次用户轮。
   * 若提供且非空，BaseAgent 会在首次用户轮之前注入一个隐藏上下文块。
   */
  getBranchSeedMessages?: () => RecoveryMessage[];

  /** 分支种子上下文注入后调用 */
  markBranchSeedApplied?: () => void;

  /** 在 transferred session 的第一次轮次注入的一次性隐藏摘要 */
  getTransferredSessionSummary?: () => string | null;

  /** transferred session 摘要注入后调用 */
  markTransferredSessionSummaryApplied?: () => void;

  /**
   * 可选回调：把过大的图片缩小以符合 API 限制。
   * 当 PreToolUse 读取的图片超过 base64 大小限制时调用。
   * 返回缩放后的临时文件路径；若无法缩放则返回 null。
   * 由宿主应用提供（Electron 用 nativeImage，server 可用 sharp 等）。
   */
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;

  /** 为当前 Opus 模型启用 1M 上下文窗口。默认 true；设为 false 则使用 200K 以节省用量配额。 */
  enable1MContext?: boolean;

  /**
   * 初始 setup 时预计算好的 source 配置。
   * 构造时传入，backend 可在 postInit() 中据此设置 sources。
   */
  initialSources?: {
    enabledSources: LoadedSource[];
    mcpServers: Record<string, SdkMcpServerConfig>;
    apiServers: Record<string, unknown>;
    enabledSlugs: string[];
  };
}

// ============================================================
// Backend 接口
// ============================================================

/**
 * chat 方法的选项。
 */
export interface ChatOptions {
  /** 重试标志（session 恢复时内部使用） */
  isRetry?: boolean;
  /** 仅本次消息覆盖 thinking 等级 */
  thinkingOverride?: ThinkingLevel;
}

/**
 * 与 SDK 兼容的 MCP server 配置。
 * 支持 HTTP/SSE（远程）与 stdio（本地子进程）两种传输方式。
 */
export type SdkMcpServerConfig =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      /** 存放 bearer token 的环境变量名（Codex 专用） */
      bearerTokenEnvVar?: string;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      /** 要设置的环境变量（字面量值） */
      env?: Record<string, string>;
      /** 要从父进程透传的环境变量名（Codex 专用） */
      envVars?: string[];
      /** server 进程的工作目录（Codex 专用） */
      cwd?: string;
    };

/**
 * 核心后端接口 —— 所有 AI provider 都必须实现。
 *
 * 设计目标：
 * 1. 屏蔽 provider 差异（Claude SDK vs OpenAI Responses API 等）
 * 2. 让 CraftAgent 可以使用 facade 模式
 * 3. 通过 AsyncGenerator 支持流式事件
 * 4. 允许基于能力的 UI 自适应
 */
export interface AgentBackend {
  // ============================================================
  // Chat 与生命周期
  // ============================================================

  /**
   * 发送一条消息并流式返回事件。
   * 这是核心的 agentic 循环：处理工具执行、权限检查等。
   *
   * @param message - 用户消息文本
   * @param attachments - 可选的文件附件
   * @param options - 可选的 chat 配置
   * @yields AgentEvent 流
   */
  chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent>;

  /**
   * 中止当前查询（用户停止或内部中止）。
   *
   * @param reason - 可选的中止原因（用于日志/调试）
   */
  abort(reason?: string): Promise<void>;

  /**
   * 强制中止，并给出具体原因。
   * 用于真正的硬停止语义：用户停止、redirect fallback、销毁等。
   *
   * @param reason - AbortReason 枚举值
   */
  forceAbort(reason: AbortReason): void;

  /**
   * WS2：在 keep-alive 模式下，为 turn 之间到达（此时没有 chat() 生成器在消费）的
   * 后台任务事件注册一个 sink。没有持久跨 turn 查询的后端可以不实现。
   */
  setBackgroundEventSink?(sink: ((event: AgentEvent) => void) | null): void;

  /**
   * 因为控制权要交还给 UI，中断当前 turn。
   *
   * 用于计划提交、鉴权请求等暂停点：session 需要干净地停下来，
   * 但不必动用 backend 最强的 abort 原语。
   *
   * @param reason - handoff 边界的 AbortReason 枚举值
   */
  interruptForHandoff(reason: AbortReason): void;

  /**
   * 在流式响应中途用一条新用户消息重定向 agent。
   * 当 agent 仍在处理时用户又发了新消息，会调用此方法。
   *
   * 各 backend 自行决定策略：
   * - 支持原生 steering 的后端（如 Pi）把消息注入当前流并返回 true ——
   *   事件继续走现有生成器，无需 abort。
   * - 不支持 steering 的后端内部调用 forceAbort(Redirect) 并返回 false ——
   *   session 层把消息排队后重发。
   *
   * @param message - 新的用户消息
   * @returns true 表示已 steering（事件继续走现有流）；
   *          false 表示已 abort（session 层需要排队重发）
   */
  redirect(message: string): boolean;

  /**
   * 使用 backend 的鉴权基础设施运行简单文本补全。
   * 用于连接测试、标题生成、摘要等。
   */
  runMiniCompletion(prompt: string): Promise<string | null>;

  /**
   * 清理资源（MCP 连接、watcher 等）。
   */
  destroy(): void;

  /**
   * destroy() 的别名，保持 API 风格一致。
   */
  dispose(): void;

  /**
   * 构造后初始化。
   * 处理鉴权注入、初始配置生成等。
   * 在构造完成、回调接好之后、第一次 chat() 之前调用。
   */
  postInit(): Promise<PostInitResult>;

  /**
   * 在会话进行中应用 bridge / 配置更新。
   * 在 source 变化、token 刷新或鉴权完成时调用。
   * 各 backend 自行实现策略：
   * - Codex：重新生成 config.toml 并排期重连
   * - Copilot：写入 bridge-config.json 与 credential cache
   * - Claude/Pi：no-op（它们不使用 bridge-mcp-server）
   */
  applyBridgeUpdates(context: BridgeUpdateContext): Promise<void>;

  /**
   * 在首条用户消息前确保分支 session 在后端已就绪。
   * 在创建分支时调用，避免产生“只复制了会话历史但没有实际 backend 分支上下文”的假分支。
   *
   * 对不需要预检的 provider，默认可以是 no-op。
   */
  ensureBranchReady(): Promise<void>;

  /**
   * 检查当前是否正在处理查询。
   */
  isProcessing(): boolean;

  // ============================================================
  // 模型与 Thinking 配置
  // ============================================================

  /** 获取当前模型 ID */
  getModel(): string;

  /** 设置模型（建议按能力表校验） */
  setModel(model: string): void;

  /**
   * 不重建 backend 的前提下更新影响运行时的 provider 配置。
   * 当更新无法就地应用时 backend 返回 false，session manager 应回退到 idle restart。
   */
  updateRuntimeConfig?(update: BackendRuntimeUpdate): Promise<boolean>;

  /**
   * idle backend restart 前释放资源。带子进程的后端可以在这里等待子进程退出，
   * 避免瞬时的进程泄漏。
   */
  disposeForRestart?(): Promise<void>;

  /** 获取当前 thinking 等级 */
  getThinkingLevel(): ThinkingLevel;

  /** 设置 thinking 等级 */
  setThinkingLevel(level: ThinkingLevel): void;

  // ============================================================
  // 权限模式
  // ============================================================

  /** 获取当前权限模式 */
  getPermissionMode(): PermissionMode;

  /** 设置权限模式 */
  setPermissionMode(mode: PermissionMode): void;

  /** 切换到下一个权限模式 */
  cyclePermissionMode(): PermissionMode;

  // ============================================================
  // 状态
  // ============================================================

  /** 获取 SDK session ID（用于恢复；无 session 则返回 null） */
  getSessionId(): string | null;

  /** 该 backend 是否支持 session 分支 */
  readonly supportsBranching: boolean;

  // ============================================================
  // Source 管理
  // ============================================================

  /**
   * 为 sources 设置 MCP server 配置。
   * facade 在 source 被激活/停用时调用。
   *
   * @param mcpServers 已预构建并带鉴权头的 MCP server 配置
   * @param apiServers 用于 REST API 的进程内 MCP server
   * @param intendedSlugs 应被视为 active 的 source slug 列表
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): void | Promise<void>;

  /**
   * 获取当前活跃的 source slug 列表。
   */
  getActiveSourceSlugs(): string[];

  /**
   * 获取当前 turn 的原始用户消息（turn 之间会被清空）。
   * SessionManager.activateSourceInSessionFn 用它捕获 source_test 触发的
   * 自动重启后应该重发的消息。
   */
  getCurrentTurnUserMessage(): string | null;

  /**
   * 安排一次 source 激活后的自动重启。由 backend 事件循环在下一个 tool_result
   * 后消费：产出 `source_activated` 并用 `forceAbort` 结束当前 turn。
   * SessionManager 的 `source_activated` 处理函数随后会调度服务端重发，
   * 并带上 "[{slug} activated]" 后缀（craft-agents-oss#804）。
   * 由 SessionManager 在 mid-turn 激活成功（source_test 自动启用）后设置。
   */
  setPendingSourceActivationRestart(pending: { sourceSlug: string; userMessage: string }): void;

  /**
   * 获取所有 source（用于上下文注入）。
   */
  getAllSources(): LoadedSource[];

  /**
   * 设置所有 source（用于上下文注入）。
   */
  setAllSources(sources: LoadedSource[]): void;

  /**
   * 把某个 source 标记为未见过（会再次显示介绍文本）。
   */
  markSourceUnseen(sourceSlug: string): void;

  /**
   * 获取一个已绑定的 summarize 回调，传给 API tool builder 使用。
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null>;

  // ============================================================
  // Session 与 Workspace 状态
  // ============================================================

  /** 更新工作目录 */
  updateWorkingDirectory(path: string): void;

  /** 更新 SDK cwd（transcript 存储位置） */
  updateSdkCwd(path: string): void;

  /** 设置工作区配置 */
  setWorkspace(workspace: Workspace): void;

  /** 设置会话 ID */
  setSessionId(sessionId: string | null): void;

  /** 获取 SourceManager 以进行高级查询 */
  getSourceManager(): SourceManager;

  /** 根据用户消息生成会话标题 */
  generateTitle(message: string, options?: { language?: string }): Promise<string | null>;

  /** 根据最近对话重新生成会话标题 */
  regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: { language?: string }): Promise<string | null>;

  // ============================================================
  // 权限判定
  // ============================================================

  /**
   * 响应一个待处理的权限请求。
   *
   * @param requestId - 权限请求 ID
   * @param allowed - 是否授予权限
   * @param alwaysAllow - 是否在本 session 内记住该权限
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;

  // ============================================================
  // 回调（由 facade 在构造后设置）
  // ============================================================

  /** 当工具需要权限时调用 */
  onPermissionRequest: PermissionCallback | null;

  /** 当 agent 提交计划时调用 */
  onPlanSubmitted: PlanCallback | null;

  /** 当 source 需要鉴权时调用 */
  onAuthRequest: AuthCallback | null;

  /** 当 source 配置变化时调用 */
  onSourceChange: SourceChangeCallback | null;

  /** 当权限模式变化时调用 */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null;

  /** 当收到调试消息时调用 */
  onDebug: ((message: string) => void) | null;

  /** 当 source 工具被使用但 source 未激活时调用 */
  onSourceActivationRequest: SourceActivationCallback | null;

  /**
   * 当后端特定鉴权被需要时调用。
   * 替代各后端独立的回调（onChatGptAuthRequired、onGithubAuthRequired）。
   * session 层把它接到 UI 上展示鉴权警告。
   */
  onBackendAuthRequired: ((reason: string) => void) | null;

  /** 当 agent 请求派生新 session 时调用 */
  onSpawnSession: ((request: import('../base-agent.ts').SpawnSessionRequest) => Promise<import('../base-agent.ts').SpawnSessionResult>) | null;
}

/**
 * 创建 backend 的配置。
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * 当前 backend 使用的 Provider/SDK。
   * 决定实例化哪个 agent 类：
   * - 'anthropic' → ClaudeAgent（Anthropic SDK）
   * - 'pi' → PiAgent（通过 @earendil-works/pi-coding-agent）
   */
  provider: AgentProvider;

  /**
   * 来自 LLM connection 的完整 provider type。
   * 包含兼容变体与云端 provider；用于路由校验、凭据查找等。
   */
  providerType?: LlmProviderType;

  /**
   * 来自 LLM connection 的鉴权机制。
   * 决定如何取回并传递凭据给后端。
   */
  authType?: LlmAuthType;

  /**
   * @deprecated 请改用 authType。保留用于向后兼容。
   */
  legacyAuthType?: 'api_key' | 'oauth_token';

  /** MCP token 覆盖（用于测试） */
  mcpToken?: string;

  /**
   * 用于凭据路由的连接 slug。
   * 由 factory 在从 connection 创建 backend 时设置；
   * 用于在正确的 key 下读写凭据。
   */
  connectionSlug?: string;

  /** 工作区级别的自动化系统，用于用户自定义 SDK hooks（automations.json） */
  automationSystem?: AutomationSystem;

  /**
   * 由 backend driver 解析的不透明运行时载荷。
   * 这样可以把 provider 专属的运行时细节隔离在公共配置表面之外。
   */
  runtime?: Record<string, unknown>;
}

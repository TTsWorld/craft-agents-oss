/**
 * 文件：BaseAgent 抽象基类
 *
 * 在 Agent 架构里的角色：
 * 类似于 Go 中用一个 interface + base service 封装公共逻辑，BaseAgent 把所有后端
 *（Claude、Pi 等）都要做的事统一起来：模型/thinking 配置、权限模式、Source 管理、
 * 规划启发、配置热重载、用量统计。具体聊天/中断/能力由各子类实现。
 *
 * 重点概念：
 * - PermissionManager：每个 session 独立的权限状态，Explore/Ask/Execute 三种模式。
 * - SourceManager：跟踪 source 的激活/未激活状态，给上下文注入提供信息。
 * - session-scoped tools：SubmitPlan / auth / call_llm 等工具的回调注册在 BaseAgent
 *   进程里；外部 MCP 子进程找不到这些回调，所以 PiAgent 检测到完成后要调用这里的
 *   handleSessionMcpToolCompletion()。
 * - Source 激活 drain：当 session-scoped source_test 在当前 turn 内激活了新 source，
 *   因为当前 query 的 MCP server 列表已冻结，需要记录 pendingSourceActivationRestart，
 *   等本轮 tool_result 流完再自动重发用户原消息并带上 "[{slug} activated]" 后缀。
 */

/**
 * BaseAgent 抽象类（英文别名说明）
 *
 * 所有 AI agent 后端（ClaudeAgent、PiAgent）共享的基类。提取公共能力：
 * - 模型 / thinking 配置
 * - 权限模式管理（通过 PermissionManager）
 * - Source 管理（通过 SourceManager）
 * - 规划启发（通过 PlanningAdvisor）
 * - 配置热重载（通过 ConfigWatcherManager）
 * - 用量统计（通过 UsageTracker）
 *
 * 后端专属行为（chat / abort / capabilities）由子类实现。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import { expandPath } from '../utils/paths.ts';
import { buildTransferredSessionContext } from './conversation-summary.ts';
import type { ThinkingLevel } from './thinking-levels.ts';
import { DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from './thinking-levels.ts';
import type { PermissionMode } from './mode-manager.ts';
import type { LoadedSource } from '../sources/types.ts';
import { buildCallLlmRequest, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { getLlmConnections, getDefaultLlmConnection } from '../config/storage.ts';
import { loadAllSources } from '../sources/storage.ts';
import type { ApiServerConfig } from '../mcp/mcp-pool.ts';

import type {
  AgentBackend,
  ChatOptions,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  SdkMcpServerConfig,
  BackendConfig,
  PostInitResult,
  BridgeUpdateContext,
  RecoveryMessage,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import type { AuthRequest } from './session-scoped-tools.ts';
import type { Workspace } from '../config/storage.ts';

// Core modules
import { PermissionManager } from './core/permission-manager.ts';
import { SourceManager } from './core/source-manager.ts';
import { PromptBuilder } from './core/prompt-builder.ts';
import { PathProcessor } from './core/path-processor.ts';
import { ConfigWatcherManager, type ConfigWatcherManagerCallbacks } from './core/config-watcher-manager.ts';
import { UsageTracker, type UsageUpdate } from './core/usage-tracker.ts';
import { PrerequisiteManager } from './core/prerequisite-manager.ts';

// Automation system for agent events
import type { AutomationSystem } from '../automations/automation-system.ts';
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from '../automations/types.ts';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../sessions/storage.ts';
import { getMiniAgentSystemPrompt } from '../prompts/system.ts';
import { buildTitlePrompt, buildRegenerateTitlePrompt, validateTitle } from '../utils/title-generator.ts';

// Skill extraction for Codex/Copilot backends (Claude uses native SDK Skill tool)
import { parseMentions, resolveSkillMentions, resolveSourceMentions, resolveFileMentions } from '../mentions/index.ts';
import { loadAllSkills } from '../skills/storage.ts';

// ============================================================
// Mini Agent Configuration  // Mini Agent 配置
// ============================================================

/**
 * Mini agent 配置 —— 所有后端共用。
 * 集中放在这里，避免 Claude/Codex agent 各写一份。
 *
 * TS 提示：interface 用来描述对象形状（类似 Go 的 struct，但只描述类型不实现）。
 * readonly 表示只读属性/数组，编译期防止意外修改。
 */
export interface MiniAgentConfig {
  /** 是否启用 mini agent 模式 */
  enabled: boolean;
  /** mini agent 模式下允许使用的工具白名单 */
  tools: readonly string[];
  /** 需要保留的 MCP server key（其余会被过滤掉） */
  mcpServerKeys: readonly string[];
  /** 是否最小化 thinking/reasoning（节省 token） */
  minimizeThinking: boolean;
}

// ============================================================
// Spawn Session Types  // 派生子 session 的请求/响应类型
// ============================================================

/**
 * 创建（spawn）新 session 的请求体。
 * `?` 表示可选字段（类似 Go 中通过指针/omitempty 表达「可空」）。
 */
export interface SpawnSessionRequest {
  prompt: string;
  name?: string;                       // session 名称
  llmConnection?: string;              // LLM 连接 slug
  model?: string;                      // 模型 id
  enabledSourceSlugs?: string[];       // 启用的 source slug 列表
  permissionMode?: PermissionMode;     // 权限模式（safe/ask/allow-all）
  thinkingLevel?: ThinkingLevel;       // thinking 等级
  labels?: string[];                   // 标签
  workingDirectory?: string;           // 工作目录
  /** 要把派生 session 绑定到的 workspace project id */
  projectId?: string;
  attachments?: Array<{ path: string; name?: string }>; // 附件
}

/** spawn session 的成功返回结果 */
export interface SpawnSessionResult {
  sessionId: string;
  name: string;
  status: 'started';                   // 字面量类型：只能是字符串 'started'
  connection?: string;
  model?: string;
}

/** spawn session 的 help 模式返回：列出可用连接、source、默认值 */
export interface SpawnSessionHelpResult {
  connections: Array<{
    slug: string;
    name: string;
    isDefault: boolean;
    providerType: string;
    models: string[];
    defaultModel?: string;
  }>;
  sources: Array<{
    slug: string;
    name: string;
    type: string;
    enabled: boolean;
  }>;
  defaults: {
    defaultConnection: string | null;  // `| null` 表示可能是 null 或字符串（联合类型）
    permissionMode: string;
  };
}

/** mini agent 允许使用的工具列表 —— 仅用于快速编辑配置 */
export const MINI_AGENT_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'] as const;

/** mini agent 使用的 MCP server —— 最小集合（docs 工具已内置于 session） */
export const MINI_AGENT_MCP_KEYS = ['session'] as const;

// ============================================================
// BaseAgent Abstract Class  // BaseAgent 抽象基类
// ============================================================

/**
 * agent 后端的抽象基类。
 *
 * 提供：
 * - 公共状态管理（model、thinking、workspace、session）
 * - 核心模块委派（PermissionManager / SourceManager 等）
 * - 给 UI 接线的回调声明
 *
 * 子类必须实现（abstract 方法类比 Go 接口中未实现的方法）：
 * - backendName：错误信息中显示的后端名（'Claude'、'Codex' 等）
 * - chat()：后端专属的 agent 主循环
 * - abort()：后端专属的中断处理
 * - capabilities()：后端能力声明
 * - respondToPermission()：后端权限响应
 * - destroy()：后端资源清理
 * - runMiniCompletion()：用后端 auth 跑一次纯文本补全
 *
 * TS 提示：`abstract class` 不能直接 new，只能被子类继承；
 * `abstract` 方法只声明签名不写实现，等价于 Go interface 的方法签名。
 * `implements AgentBackend` 表示同时满足 AgentBackend 接口约束。
 */
export abstract class BaseAgent implements AgentBackend {
  // ============================================================
  // Backend Identity  // 后端身份标识
  // ============================================================
  /** 后端显示名，子类必须赋值（如 'Claude' / 'Codex'）。protected 表示仅本类及子类可见 */
  protected abstract backendName: string;

  /** 当前后端是否支持 session 分支（branching）。子类可覆盖 */
  protected _supportsBranching = true;
  /** getter：读取是否支持分支。类似 Go 的字段访问但走方法 */
  get supportsBranching(): boolean { return this._supportsBranching; }

  // ============================================================
  // Configuration  // 配置（protected 让子类可访问）
  // ============================================================
  protected config: BackendConfig;
  protected workingDirectory: string;
  protected _sessionId: string;

  // ============================================================
  // Model Configuration  // 模型配置（protected 让子类可访问）
  // ============================================================
  protected _model: string;
  protected _thinkingLevel: ThinkingLevel;

  // ============================================================
  // Core Modules  // 核心模块（protected 让子类可访问）
  // ============================================================
  protected permissionManager: PermissionManager;
  protected sourceManager: SourceManager;
  protected promptBuilder: PromptBuilder;
  protected pathProcessor: PathProcessor;
  /** 配置热重载管理器，仅在非 headless 模式启动；可能为 null */
  protected configWatcherManager: ConfigWatcherManager | null = null;
  protected usageTracker: UsageTracker;
  protected prerequisiteManager: PrerequisiteManager;
  /** 工作区级别的 automation 系统（可选） */
  protected automationSystem?: AutomationSystem;

  // ============================================================
  // Additional State  // 其他状态（protected 让子类可访问）
  // ============================================================
  /** 临时澄清文本，注入 prompt 但不持久化；可能为 null */
  protected temporaryClarifications: string | null = null;

  // ============================================================
  // Source activation auto-retry (routed through the existing source_activated
  // + forceAbort + auto_retry pipeline used for tool-call errors).
  //
  // When a session-scoped tool (source_test) successfully activates a new source
  // mid-turn, the Claude SDK's mcpServers is already frozen for the current query
  // (and Pi's tool registry is only refreshed between turns). The only way to
  // expose the new tools is to end the current turn and auto-resend the user's
  // original message with a "[{slug} activated]" suffix — same as what happens
  // when a model directly calls an unknown tool on an inactive source.
  //
  // activateSourceInSessionFn in SessionManager sets this; the per-backend event
  // loop consumes it after yielding the source_test tool_result.
  // ============================================================
  protected _pendingSourceActivationRestart: { sourceSlug: string; userMessage: string } | null = null;
  protected _currentTurnUserMessage: string | null = null;

  /**
   * 设置待处理的 source 激活重试描述。
   *
   * 在并行调用 `mcp__session__source_test` 时采用「先写者胜」策略。
   * 覆盖竞态本身无害（每次激活独立执行都会成功），但存活下来的 slug
   * 会作为 renderer 上自动重发消息 "[{slug} activated]" 后缀展示给用户。
   * 保留第一个写者能给出稳定的用户可见标签，不必强制所有 source_test 串行化。
   * 参见 issue #790。
   */
  setPendingSourceActivationRestart(pending: { sourceSlug: string; userMessage: string }): void {
    if (this._pendingSourceActivationRestart) {
      this.debug(
        `source-activation restart already pending (${this._pendingSourceActivationRestart.sourceSlug}); ignoring overlapping activation of "${pending.sourceSlug}"`,
      );
      return;
    }
    this._pendingSourceActivationRestart = pending;
  }

  /** 读取并清空待处理的 source 激活重试描述（一次性消费） */
  consumePendingSourceActivationRestart(): { sourceSlug: string; userMessage: string } | null {
    const pending = this._pendingSourceActivationRestart;
    this._pendingSourceActivationRestart = null;
    return pending;
  }

  /** 获取当前 turn 的用户原始消息（用于 source 激活重试时重发） */
  getCurrentTurnUserMessage(): string | null {
    return this._currentTurnUserMessage;
  }

  /** 设置当前 turn 的用户原始消息（chat() 入口处捕获） */
  protected setCurrentTurnUserMessage(message: string | null): void {
    this._currentTurnUserMessage = message;
  }

  // ============================================================
  // Callbacks  // 给上层 facade 接线的回调（public 以便外部赋值）
  // TS 提示：`(arg) => void` 是函数类型；`| null` 表示可空。
  // ============================================================
  /** 权限请求回调：模型要执行需审批的操作时触发 */
  onPermissionRequest: PermissionCallback | null = null;
  /** 计划提交回调：模型调用 SubmitPlan 时触发 */
  onPlanSubmitted: PlanCallback | null = null;
  /** 鉴权请求回调：source OAuth/credential 流程触发 */
  onAuthRequest: AuthCallback | null = null;
  /** 单个 source 配置变更回调（文件热重载） */
  onSourceChange: SourceChangeCallback | null = null;
  /** source 列表整体变更回调 */
  onSourcesListChange: ((sources: LoadedSource[]) => void) | null = null;
  /** 配置文件校验错误回调 */
  onConfigValidationError: ((file: string, errors: string[]) => void) | null = null;
  /** 权限模式变更回调 */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;
  /** 调试日志回调 */
  onDebug: ((message: string) => void) | null = null;
  /** source 激活请求回调（auto-activation 用） */
  onSourceActivationRequest: SourceActivationCallback | null = null;
  /** token 用量更新回调 */
  onUsageUpdate: ((update: UsageUpdate) => void) | null = null;
  /** 后端需要重新认证时触发 */
  onBackendAuthRequired: ((reason: string) => void) | null = null;
  /** spawn 子 session 的回调（由 SessionManager 注入实现） */
  onSpawnSession: ((request: SpawnSessionRequest) => Promise<SpawnSessionResult>) | null = null;

  // ============================================================
  // Constructor  // 构造函数
  // ============================================================

  /**
   * 构造函数。
   *
   * @param config 后端配置（含 workspace、session、mcpPool 等）
   * @param defaultModel 默认模型 id（当 config.model 为空时使用）
   * @param contextWindow 上下文窗口大小（可选，用于 UsageTracker）
   *
   * TS 提示：`?.` 是可选链，遇到 null/undefined 短路返回 undefined；
   * `??` 是空值合并，左侧为 null/undefined 时取右侧；`||` 是逻辑或（假值都走右）。
   */
  constructor(config: BackendConfig, defaultModel: string, contextWindow?: number) {
    this.config = config;
    // 优先用 session 的工作目录（用户可改），其次 workspace 根目录，最后进程 cwd
    this.workingDirectory = config.session?.workingDirectory ?? config.workspace.rootPath ?? process.cwd();
    this._sessionId = config.session?.id || `agent-${Date.now()}`;
    this._model = config.model || defaultModel;
    this._thinkingLevel = normalizeThinkingLevel(config.thinkingLevel) ?? DEFAULT_THINKING_LEVEL;

    // 初始化核心模块
    // PermissionManager：权限评估、模式管理、命令白名单
    this.permissionManager = new PermissionManager({
      workspaceId: config.workspace.id,
      sessionId: this._sessionId,
      workingDirectory: this.workingDirectory,
      plansFolderPath: getSessionPlansPath(config.workspace.rootPath, this._sessionId),
      dataFolderPath: getSessionDataPath(config.workspace.rootPath, this._sessionId),
    });

    // SourceManager：跟踪 source 激活状态，并格式化给上下文注入用
    this.sourceManager = new SourceManager({
      onDebug: (msg) => this.debug(msg),
    });

    // PromptBuilder：构造用户消息中的上下文块（日期、工作目录、source 状态等）
    this.promptBuilder = new PromptBuilder({
      workspace: config.workspace,
      session: config.session,
      debugMode: config.debugMode,
      systemPromptPreset: config.systemPromptPreset,
      isHeadless: config.isHeadless,
    });

    // PathProcessor：展开 ~ 与路径规范化
    this.pathProcessor = new PathProcessor();

    // UsageTracker：token 用量与上下文窗口跟踪
    this.usageTracker = new UsageTracker({
      contextWindow,
      onUsageUpdate: (update) => this.onUsageUpdate?.(update),
      onDebug: (msg) => this.debug(msg),
    });

    // PrerequisiteManager：在模型读完 guide.md 前阻止 source 工具调用
    this.prerequisiteManager = new PrerequisiteManager({
      workspaceRootPath: config.workspace.rootPath,
      onDebug: (msg) => this.debug(msg),
    });

    // AutomationSystem：工作区级 automation（来自 automations.json）
    this.automationSystem = config.automationSystem;
  }

  // ============================================================
  // Config Watcher Management
  // ============================================================

  /**
   * Start the config file watcher for hot-reloading changes.
   * Called by subclass constructor in non-headless mode.
   */
  protected startConfigWatcher(): void {
    if (this.configWatcherManager) {
      return; // Already running
    }
    if (this.config.skipConfigWatcher) {
      this.debug('Config watching skipped (managed by server)');
      return;
    }

    const callbacks: ConfigWatcherManagerCallbacks = {
      onSourceChange: (slug, source) => {
        this.debug(`Source changed: ${slug} ${source ? 'updated' : 'deleted'}`);
        this.onSourceChange?.(slug, source);
      },
      onSourcesListChange: (sources) => {
        this.debug(`Sources list changed: ${sources.length} sources`);
        this.onSourcesListChange?.(sources);
      },
      onValidationError: (file, errors) => {
        this.debug(`Config validation error: ${file}`);
        this.onConfigValidationError?.(file, errors);
      },
    };

    this.configWatcherManager = new ConfigWatcherManager(
      {
        workspaceRootPath: this.config.workspace.rootPath,
        isHeadless: this.config.isHeadless,
        onDebug: (msg) => this.debug(msg),
      },
      callbacks
    );
    this.configWatcherManager.start();
    this.debug('Config watcher started');
  }

  /**
   * Stop the config file watcher.
   */
  protected stopConfigWatcher(): void {
    if (this.configWatcherManager) {
      this.configWatcherManager.stop();
      this.configWatcherManager = null;
      this.debug('Config watcher stopped');
    }
  }

  // ============================================================
  // Debug Logging (protected for subclass override)
  // ============================================================

  /**
   * Log a debug message. Override in subclass to add prefix.
   */
  protected debug(message: string): void {
    this.onDebug?.(message);
  }

  /**
   * Fire an automation agent event (from automations.json) via AutomationSystem.
   * Catches all errors — automations must never break the agent flow.
   *
   * Non-Claude backends call this directly. ClaudeAgent uses SDK's buildSdkHooks() instead.
   *
   * @param signal - Optional AbortSignal for cancelling automation execution on abort
   */
  protected async emitAutomationEvent(event: AutomationAgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<void> {
    try {
      await this.automationSystem?.executeAgentEvent(event, input, signal);
    } catch (err) {
      this.debug(`Automation event ${event} failed: ${err}`);
    }
  }

  // ============================================================
  // Session MCP Tool Completion Handling
  // ============================================================

  /**
   * Handle successful completion of a session MCP tool (SubmitPlan, auth tools).
   *
   * WHY THIS IS ON BaseAgent:
   * -------------------------
   * Session-scoped tools (SubmitPlan, source_oauth_trigger, etc.) run in an
   * EXTERNAL MCP server subprocess (packages/session-mcp-server). That subprocess
   * has its own process memory, so when it calls getSessionScopedToolCallbacks(),
   * the callback registry is empty — it was populated in THIS process, not the subprocess.
   *
   * Instead, PiAgent detects session MCP tool completions from its own event
   * stream and calls THIS shared method to fire the appropriate callback.
   *
   * ClaudeAgent doesn't need this — its session-scoped tools run in-process
   * via Claude Agent SDK, so the callback registry works directly.
   *
   * CALLBACKS FIRED:
   * - SubmitPlan → this.onPlanSubmitted(planPath)
   *   → Electron reads plan file, shows plan card, calls interruptForHandoff(PlanSubmitted)
   * - Auth tools → this.onAuthRequest(authRequest)
   *   → Electron shows auth dialog, calls interruptForHandoff(AuthRequest)
   */
  protected handleSessionMcpToolCompletion(
    toolName: string,
    args: Record<string, unknown>
  ): void {
    // SubmitPlan — trigger plan view in the UI.
    // The Electron SessionManager's onPlanSubmitted callback will:
    //   1. Read the plan file content
    //   2. Create a plan message (role: 'plan')
    //   3. Send plan_submitted event to renderer
    //   4. Call interruptForHandoff(AbortReason.PlanSubmitted) → turn terminates
    if (toolName === 'SubmitPlan' && args.planPath) {
      this.debug(`SubmitPlan completed: ${args.planPath}`);
      this.onPlanSubmitted?.(args.planPath as string);
      return;
    }

    // Auth tools — trigger auth request in the UI.
    // Maps MCP tool names to auth request types.
    const authToolTypes: Record<string, string> = {
      'source_oauth_trigger': 'oauth',
      'source_google_oauth_trigger': 'oauth-google',
      'source_slack_oauth_trigger': 'oauth-slack',
      'source_microsoft_oauth_trigger': 'oauth-microsoft',
      'source_credential_prompt': 'credential',
    };

    const authType = authToolTypes[toolName];
    if (authType && args.sourceSlug && this.onAuthRequest) {
      const sourceSlug = args.sourceSlug as string;
      const source = this.sourceManager.getAllSources().find(s => s.config.slug === sourceSlug);
      const sourceName = source?.config.name || sourceSlug;
      this.debug(`Auth tool completed: ${toolName} for ${sourceSlug}`);
      this.onAuthRequest({
        type: authType,
        requestId: `${Date.now()}-auth`,
        sessionId: this.config.session?.id || '',
        sourceSlug,
        sourceName,
        ...(authType === 'credential' && {
          mode: (args.mode as string) || 'bearer',
          labels: args.labels as Record<string, string> | undefined,
          description: args.description as string | undefined,
          hint: args.hint as string | undefined,
        }),
      } as AuthRequest);
    }
  }

  // ============================================================
  // Model & Thinking Configuration (AgentBackend interface)
  // ============================================================

  getModel(): string {
    return this._model;
  }

  setModel(model: string): void {
    this._model = model;
  }

  getThinkingLevel(): ThinkingLevel {
    return this._thinkingLevel;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this._thinkingLevel = level;
    this.debug(`Thinking level set to: ${level}`);
  }

  // ============================================================
  // Permission Mode (delegated to PermissionManager)
  // ============================================================

  getPermissionMode(): PermissionMode {
    return this.permissionManager.getPermissionMode();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionManager.setPermissionMode(mode);
    this.onPermissionModeChange?.(mode);
  }

  cyclePermissionMode(): PermissionMode {
    const newMode = this.permissionManager.cyclePermissionMode();
    this.onPermissionModeChange?.(newMode);
    return newMode;
  }

  /**
   * Check if currently in safe mode (read-only exploration).
   */
  isInSafeMode(): boolean {
    return this.permissionManager.getPermissionMode() === 'safe';
  }

  // ============================================================
  // Workspace & Session (AgentBackend interface)
  // ============================================================

  getWorkspace(): Workspace {
    return this.config.workspace;
  }

  setWorkspace(workspace: Workspace): void {
    this.config.workspace = workspace;
    // Subclasses should clear session-specific state
  }

  getSessionId(): string | null {
    return this._sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this._sessionId = sessionId || `agent-${Date.now()}`;
  }

  /**
   * Clear conversation history and start fresh.
   * Subclasses should override to clear provider-specific state.
   */
  clearHistory(): void {
    this.usageTracker.reset();
    this.prerequisiteManager.resetReadState();
    this.debug('History cleared');
  }

  /**
   * Reset prerequisite read state (e.g., on context compaction).
   * After compaction the LLM no longer has guide content in context,
   * so it must re-read before using source tools.
   * Also resets seen sources so guide paths re-appear in source introductions.
   */
  resetPrerequisiteState(): void {
    this.prerequisiteManager.resetReadState();
    this.sourceManager.resetSeenSources();
  }

  /**
   * Update the working directory.
   * Also updates PermissionManager and persists to session config.
   */
  updateWorkingDirectory(path: string): void {
    this.workingDirectory = path;
    // Persist to session config for storage and consistency with ClaudeAgent
    if (this.config.session) {
      this.config.session.workingDirectory = path;
    }
    this.permissionManager.updateWorkingDirectory(path);
    this.debug(`Working directory updated: ${path}`);
  }

  /**
   * Update the SDK cwd (used for transcript storage location).
   *
   * This should only be called when it's safe to update - i.e., before any
   * SDK interaction has occurred. The SessionManager checks this condition
   * before calling this method.
   *
   * This updates the session config so the agent uses the new path for
   * SDK operations going forward.
   */
  updateSdkCwd(path: string): void {
    if (this.config.session) {
      this.config.session.sdkCwd = path;
    }
    this.debug(`SDK cwd updated: ${path}`);
  }

  // ============================================================
  // Source Management (delegated to SourceManager)
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   * Called by facade when sources are activated/deactivated.
   *
   * Subclasses may override to handle provider-specific MCP setup.
   */
  async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): Promise<void> {
    // Update SourceManager state (common tracking)
    this.sourceManager.updateActiveState(
      Object.keys(mcpServers),
      Object.keys(apiServers),
      intendedSlugs
    );

    // Sync the centralized MCP client pool (if available)
    // Both MCP sources and API sources are routed through the pool.
    if (this.config.mcpPool) {
      try {
        await this.config.mcpPool.sync(mcpServers, apiServers as Record<string, ApiServerConfig>);
      } catch (err) {
        this.debug(`Failed to sync MCP pool: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getActiveSourceSlugs(): string[] {
    return Array.from(this.sourceManager.getIntendedSlugs());
  }

  getAllSources(): LoadedSource[] {
    return this.sourceManager.getAllSources();
  }

  /**
   * Set all sources (for context injection).
   * Uses SourceManager for state tracking.
   */
  setAllSources(sources: LoadedSource[]): void {
    this.sourceManager.setAllSources(sources);
  }

  /**
   * Mark a source as unseen (will show introduction text again).
   */
  markSourceUnseen(sourceSlug: string): void {
    this.sourceManager.markSourceUnseen(sourceSlug);
  }

  /**
   * Check if a source server is currently active.
   */
  isSourceServerActive(serverName: string): boolean {
    return this.sourceManager.isSourceActive(serverName);
  }

  /**
   * Get the set of active source server names.
   */
  getActiveSourceServerNames(): Set<string> {
    return new Set(this.sourceManager.getActiveSlugs());
  }

  /**
   * Set temporary clarifications for context injection.
   * These are injected into prompts but not yet persisted.
   */
  setTemporaryClarifications(text: string | null): void {
    this.temporaryClarifications = text;
  }

  // ============================================================
  // Manager Accessors (for advanced queries)
  // ============================================================

  /**
   * Get SourceManager for advanced source state queries.
   */
  getSourceManager(): SourceManager {
    return this.sourceManager;
  }

  /**
   * Get PermissionManager for advanced permission queries.
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * Get PromptBuilder for context building.
   */
  getPromptBuilder(): PromptBuilder {
    return this.promptBuilder;
  }

  // ============================================================
  // Mini Agent Mode (centralized for all backends)
  // ============================================================

  /**
   * Check if running in mini agent mode.
   * Centralized detection used by all backends.
   */
  isMiniAgent(): boolean {
    return this.config.systemPromptPreset === 'mini';
  }

  /**
   * Get mini agent configuration for provider-specific application.
   * Returns centralized config that each backend interprets appropriately:
   * - ClaudeAgent: Uses tools array, mcpServers filter, maxThinkingTokens: 0
   * - PiAgent: Applies tool filter + minimizeThinking via runtime config
   */
  getMiniAgentConfig(): MiniAgentConfig {
    const enabled = this.isMiniAgent();
    return {
      enabled,
      tools: enabled ? MINI_AGENT_TOOLS : [],
      mcpServerKeys: enabled ? MINI_AGENT_MCP_KEYS : [],
      minimizeThinking: enabled,
    };
  }

  /**
   * Get the mini agent system prompt.
   * Shared across backends for consistency.
   * Uses workspace root path for config file locations.
   */
  getMiniSystemPrompt(): string {
    return getMiniAgentSystemPrompt(this.config.workspace.rootPath);
  }

  /**
   * Filter MCP servers for mini agent mode.
   * Only includes servers whose keys are in the allowed list.
   *
   * @param servers - Full set of MCP servers
   * @param allowedKeys - Keys to include (from getMiniAgentConfig().mcpServerKeys)
   * @returns Filtered servers object
   */
  filterMcpServersForMiniAgent<T>(
    servers: Record<string, T>,
    allowedKeys: readonly string[]
  ): Record<string, T> {
    const filtered: Record<string, T> = {};
    for (const key of allowedKeys) {
      if (servers[key]) {
        filtered[key] = servers[key];
      }
    }
    return filtered;
  }

  // ============================================================
  // Session Recovery (unified across backends)
  // ============================================================

  /**
   * Build recovery context from previous messages when session resume fails.
   * Called when we detect an empty response or thread not found during resume.
   * Injects previous conversation context so the agent can continue naturally.
   *
   * @returns Formatted string to prepend to the user message, or null if no context available.
   */
  protected buildRecoveryContext(): string | null {
    const messages = this.config.getRecoveryMessages?.();
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block the agent can understand
    const formattedMessages = messages
      .map((m) => {
        const role = m.type === 'user' ? 'User' : 'Assistant';
        // Truncate very long messages to avoid bloating context (max ~1000 chars each)
        const content =
          m.content.length > 1000
            ? m.content.slice(0, 1000) + '...[truncated]'
            : m.content;
        return `[${role}]: ${content}`;
      })
      .join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  /**
   * Build one-time branch seed context for sessions branched from an earlier message.
   * Ensures the first turn in the new branch only sees transcript up to the selected branch point.
   */
  protected buildBranchSeedContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) return null;

    // Keep seed payload bounded to avoid oversized first-turn prompts.
    const bounded = messages.slice(-24);

    const formattedMessages = bounded
      .map((m) => {
        const role = m.type === 'user' ? 'User' : 'Assistant';
        const content =
          m.content.length > 1200
            ? m.content.slice(0, 1200) + '...[truncated]'
            : m.content;
        return `[${role}]: ${content}`;
      })
      .join('\n\n');

    return `<branch_seed_context>
This is a branched conversation. The context below is the parent transcript up to the selected branch point.
Ignore and do not assume any parent messages that came after this cutoff.

${formattedMessages}
</branch_seed_context>`;
  }

  /**
   * Clear session ID and notify callbacks.
   * Called when session resume fails and we need to start fresh.
   */
  protected clearSessionForRecovery(): void {
    this.config.onSdkSessionIdCleared?.();
    this.debug('Session cleared for recovery');
  }

  // ============================================================
  // Path Helpers
  // ============================================================

  /**
   * Get the session storage path for this agent's session.
   * Convenience wrapper around getSessionPath() with null-checking.
   *
   * @returns Session path, or undefined if session/workspace not configured
   */
  protected getSessionStoragePath(): string | undefined {
    if (!this.config.session?.id || !this.config.workspace.rootPath) return undefined;
    return getSessionPath(this.config.workspace.rootPath, this.config.session.id);
  }

  // ============================================================
  // Lifecycle (postInit, applyBridgeUpdates)
  // ============================================================

  /**
   * Post-construction initialization.
   * Default: no-op (auth already handled for Claude/Pi API-key).
   * Override in backends that need post-construction auth injection.
   */
  async postInit(): Promise<PostInitResult> {
    return { authInjected: true };
  }

  /**
   * Apply bridge/config updates mid-session.
   * Default: no-op for backends that don't use bridge-mcp-server (Claude, Pi).
   * Override in Codex/Copilot to regenerate config or write bridge files.
   */
  async applyBridgeUpdates(_context: BridgeUpdateContext): Promise<void> {
    // No-op by default
  }

  /**
   * Ensure branch sessions are backend-ready before first user message.
   * Default implementation is a no-op.
   */
  async ensureBranchReady(): Promise<void> {
    // No-op by default
  }

  // ============================================================
  // Cleanup (common base, subclasses extend)
  // ============================================================

  /**
   * Alias for destroy() for consistency.
   */
  dispose(): void {
    this.destroy();
  }

  /**
   * Base cleanup - clears common resources.
   * Subclasses MUST call super.destroy() and add provider-specific cleanup.
   */
  destroy(): void {
    this.stopConfigWatcher();
    this.permissionManager.clearWhitelists();
    this.sourceManager.resetSeenSources();
    this.usageTracker.reset();

    // Disconnect MCP pool to avoid connection leaks
    if (this.config.mcpPool) {
      this.config.mcpPool.disconnectAll().catch(err => {
        this.debug(`Failed to disconnect MCP pool: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    this.debug('Base agent destroyed');
  }

  // ============================================================
  // Skill Path Resolution (shared across backends)
  // ============================================================

  /**
   * Extract skill mentions from a message and resolve their SKILL.md paths.
   *
   * Parses [skill:slug] or [skill:workspaceId:slug] mentions, resolves the
   * corresponding SKILL.md file paths. Does NOT read the files — the model
   * must read them itself (enforced by PrerequisiteManager).
   *
   * @param message - The user message containing potential skill mentions
   * @returns Object with:
   *   - skillPaths: Map of slug → resolved SKILL.md absolute path
   *   - cleanMessage: Message with mentions stripped, or default directive
   *   - missingSkills: Array of skill slugs that were mentioned but not found
   */
  protected extractSkillPaths(message: string): {
    skillPaths: Map<string, string>;
    cleanMessage: string;
    missingSkills: string[];
  } {
    const workspaceRoot = this.config.workspace?.rootPath ?? this.workingDirectory;
    const projectRoot = this.config.session?.workingDirectory;
    const skills = loadAllSkills(workspaceRoot, projectRoot);
    const skillSlugs = skills.map(s => s.slug);

    this.debug(`[extractSkillPaths] Available skills: ${skillSlugs.join(', ')}`);

    const parsed = parseMentions(message, skillSlugs, []);
    this.debug(`[extractSkillPaths] Parsed skills: ${JSON.stringify(parsed.skills)}`);
    if (parsed.invalidSkills && parsed.invalidSkills.length > 0) {
      this.debug(`[extractSkillPaths] Invalid skills: ${JSON.stringify(parsed.invalidSkills)}`);
    }

    // Resolve SKILL.md paths for matched skills
    const skillPaths = new Map<string, string>();
    for (const slug of parsed.skills) {
      const skill = skills.find(s => s.slug === slug);
      if (skill) {
        const skillMdPath = join(skill.path, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          skillPaths.set(slug, skillMdPath);
          this.debug(`[extractSkillPaths] Resolved skill ${slug} → ${skillMdPath}`);
        } else {
          this.debug(`[extractSkillPaths] SKILL.md not found: ${skillMdPath}`);
        }
      }
    }

    // Resolve mentions to semantic markers (like file mentions) instead of stripping them.
    // This preserves sentence structure: "find the bug in [skill:datadog-api]"
    // becomes "find the bug in [Mentioned skill: Datadog API (slug: datadog-api)]"
    const skillNames = new Map(skills.map(s => [s.slug, s.metadata.name]));
    const withSkills = resolveSkillMentions(message, skillNames);
    const withSources = resolveSourceMentions(withSkills);
    const workDir = this.config.session?.workingDirectory ?? this.workingDirectory;
    const resolved = resolveFileMentions(withSources, workDir).trim();

    // If user sent only skill mentions with no other text, add a directive
    const cleanMessage = (!resolved && skillPaths.size > 0)
      ? 'Follow the skill instructions from the files listed above.'
      : resolved;

    this.debug(`[extractSkillPaths] Clean message: "${cleanMessage.slice(0, 100)}...", skills: ${skillPaths.size}`);

    return {
      skillPaths,
      cleanMessage,
      missingSkills: parsed.invalidSkills || []
    };
  }

  /**
   * Format a directive telling the model to read skill SKILL.md files before proceeding.
   * Called from chat() — all agents get the same directive prepended to their message.
   */
  protected formatSkillDirective(skillPaths: Map<string, string>): string {
    if (skillPaths.size === 0) return '';
    const pathList = [...skillPaths.entries()]
      .map(([slug, path]) => `- ${path} (skill: ${slug})`)
      .join('\n');
    return `Before proceeding with the user's request, you MUST read the following skill instruction files using the Read tool or \`cat\` via Bash:\n${pathList}\n\nDo not take any other action until you have read these files.`;
  }

  // ============================================================
  // Chat entry point (template method)
  // ============================================================

  /**
   * Send a message and stream back events.
   * Validates skill mentions, registers prerequisites, prepends read directive,
   * then delegates to chatImpl. All skill logic is handled here — chatImpl
   * never sees skill paths.
   */
  async *chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    const { skillPaths, cleanMessage, missingSkills } = this.extractSkillPaths(message);
    if (missingSkills.length > 0) {
      yield { type: 'error', message: `Skill(s) not found: ${missingSkills.join(', ')}` };
      yield { type: 'complete' };
      return;
    }

    // Register skill prerequisites — blocks all tools until SKILL.md files are read.
    if (skillPaths.size > 0) {
      this.prerequisiteManager.registerSkillPrerequisites([...skillPaths.values()]);
    }

    // Prepend branch seed context (for seeded branch sessions) and transferred-session summary.
    const branchSeedContext = this.buildBranchSeedContext(this.config.getBranchSeedMessages?.());
    if (branchSeedContext) {
      this.config.markBranchSeedApplied?.();
    }

    const transferredSessionSummary = this.config.getTransferredSessionSummary?.();
    const transferredSessionContext = transferredSessionSummary
      ? buildTransferredSessionContext(transferredSessionSummary)
      : null;
    if (transferredSessionContext) {
      this.config.markTransferredSessionSummaryApplied?.();
    }

    // Prepend read directive to the message so the model reads SKILL.md first.
    const directive = this.formatSkillDirective(skillPaths);
    const messageParts = [branchSeedContext, transferredSessionContext, directive, cleanMessage].filter(Boolean);
    const effectiveMessage = messageParts.join('\n\n');

    // Capture the raw user message for source-activation auto-retry. `cleanMessage`
    // has skill paths stripped but otherwise matches what the user typed — exactly
    // what we want to resend when an activation forces a turn restart.
    this.setCurrentTurnUserMessage(cleanMessage);
    try {
      yield* this.chatImpl(effectiveMessage, attachments, options);
    } finally {
      this.setCurrentTurnUserMessage(null);
    }
  }

  // ============================================================
  // Abstract Methods (provider-specific, must be implemented)
  // ============================================================

  /**
   * Provider-specific chat implementation.
   * Called by chat() after skill validation, prerequisite registration,
   * and directive injection. The message already contains any skill
   * read directives — subclasses don't handle skills at all.
   *
   * @param message - User message (may have skill read directive prepended)
   * @param attachments - File attachments
   * @param options - Chat options (resume, retry, etc.)
   */
  protected abstract chatImpl(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent>;

  /**
   * Abort current query (user stop or internal abort).
   */
  abstract abort(reason?: string): Promise<void>;

  /**
   * Force abort with specific reason.
   * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
   */
  abstract forceAbort(reason: AbortReason): void;

  /**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Default implementation delegates to forceAbort(); backends can override
   * when handoff semantics differ from hard abort semantics.
   */
  interruptForHandoff(reason: AbortReason): void {
    this.forceAbort(reason);
  }

  /**
   * Redirect the agent mid-stream. Default: abort and let session layer re-send.
   * Override in backends that support native steering (e.g., Pi's steer()).
   */
  redirect(_message: string): boolean {
    this.forceAbort(AbortReason.Redirect);
    return false;
  }

  /**
   * Check if currently processing a query.
   */
  abstract isProcessing(): boolean;

  /**
   * Respond to a pending permission request.
   */
  abstract respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;

  /**
   * Run a simple text completion using the agent's auth infrastructure.
   * No tools, no system prompt - just text in → text out.
   * Each backend implements using its own SDK (Claude SDK query() or Codex app-server).
   *
   * @param prompt - The prompt to send
   * @returns The model's response text, or null if completion fails
   */
  abstract runMiniCompletion(prompt: string): Promise<string | null>;

  /**
   * Execute an LLM query using the agent's auth infrastructure.
   * Used by call_llm tool (via queryFn callback) and potentially by runMiniCompletion.
   *
   * Each backend implements this using its own SDK/session mechanism:
   * - ClaudeAgent: SDK query() with OAuth
   * - PiAgent: One-shot completion via Pi SDK in the subprocess
   *
   * @param request - The query request (prompt, model, systemPrompt, etc.)
   * @returns The model's response text and optional token usage
   */
  abstract queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult>;

  /**
   * Pre-execute a call_llm request: resolve attachments, validate model, run query.
   * Shared across all backends. Codex overrides validateCallLlmModel() for provider filtering.
   */
  protected async preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
    const sessionPath = getSessionPath(this.config.workspace.rootPath, this._sessionId);
    const request = await buildCallLlmRequest(input, {
      backendName: this.backendName,
      sessionPath,
      validateModel: this.validateCallLlmModel?.bind(this),
    });
    return this.queryLlm(request);
  }

  /**
   * Optional model validation hook for call_llm.
   * Override in subclasses to filter models (e.g., Codex rejects non-OpenAI models).
   * Return undefined to fall back to miniModel.
   */
  protected validateCallLlmModel?(modelId: string): string | undefined;

  /**
   * Pre-execute a spawn_session request: handle help mode or delegate to onSpawnSession.
   * Shared across all backends.
   */
  protected async preExecuteSpawnSession(
    input: Record<string, unknown>
  ): Promise<SpawnSessionResult | SpawnSessionHelpResult> {
    // Help mode — return available config info
    if (input.help) {
      return this.getSpawnSessionHelp();
    }

    // Spawn mode — validate and delegate
    const prompt = input.prompt as string | undefined;
    if (!prompt?.trim()) {
      throw new Error('prompt is required when not in help mode. Call with help=true to see available options.');
    }

    if (!this.onSpawnSession) {
      throw new Error('spawn_session is not available in this context.');
    }

    const request: SpawnSessionRequest = {
      prompt,
      name: input.name as string | undefined,
      llmConnection: input.llmConnection as string | undefined,
      model: input.model as string | undefined,
      enabledSourceSlugs: input.enabledSourceSlugs as string[] | undefined,
      permissionMode: input.permissionMode as SpawnSessionRequest['permissionMode'],
      thinkingLevel: input.thinkingLevel as SpawnSessionRequest['thinkingLevel'],
      labels: input.labels as string[] | undefined,
      workingDirectory: typeof input.workingDirectory === 'string' && input.workingDirectory
        ? expandPath(input.workingDirectory)
        : undefined,
      projectId: input.projectId as string | undefined,
      attachments: input.attachments as SpawnSessionRequest['attachments'],
    };

    return this.onSpawnSession(request);
  }

  /**
   * Get available connections, models, and sources for spawn_session help mode.
   */
  protected getSpawnSessionHelp(): SpawnSessionHelpResult {
    const connections = getLlmConnections();
    const defaultConnectionSlug = getDefaultLlmConnection();
    const allSources = loadAllSources(this.config.workspace.rootPath);
    const activeSlugs = this.sourceManager.getActiveSlugs();

    return {
      connections: connections.map(c => ({
        slug: c.slug,
        name: c.name,
        isDefault: c.slug === defaultConnectionSlug,
        providerType: c.providerType,
        models: (c.models || []).map(m => typeof m === 'string' ? m : m.id),
        defaultModel: c.defaultModel,
      })),
      sources: allSources.map(s => ({
        slug: s.config.slug,
        name: s.config.name,
        type: s.config.type,
        enabled: activeSlugs.has(s.config.slug),
      })),
      defaults: {
        defaultConnection: defaultConnectionSlug,
        permissionMode: this.permissionManager.getPermissionMode(),
      },
    };
  }

  // ============================================================
  // Title Generation (shared implementation using runMiniCompletion)
  // ============================================================

  /**
   * Generate a session title from a user message.
   * Uses runMiniCompletion with the same auth as the main agent.
   *
   * @param message - The user's message to generate a title from
   * @param options.language - Preferred language for the title
   * @returns Generated title (2-5 words), or null if generation fails
   */
  async generateTitle(message: string, options?: { language?: string }): Promise<string | null> {
    try {
      const prompt = buildTitlePrompt(message, options);
      const result = await this.runMiniCompletion(prompt);
      return validateTitle(result);
    } catch (error) {
      this.debug(`[generateTitle] Failed: ${error}`);
      return null;
    }
  }

  /**
   * Regenerate a session title based on recent conversation context.
   * Uses a spread of messages (first, middle, last) to capture the session's purpose.
   *
   * @param recentUserMessages - Spread of user messages
   * @param lastAssistantResponse - The most recent assistant response
   * @param options.language - Preferred language for the title
   * @returns Generated title (2-5 words), or null if generation fails
   */
  async regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: { language?: string }): Promise<string | null> {
    try {
      const prompt = buildRegenerateTitlePrompt(recentUserMessages, lastAssistantResponse, options);
      const result = await this.runMiniCompletion(prompt);
      return validateTitle(result);
    } catch (error) {
      this.debug(`[regenerateTitle] Failed: ${error}`);
      return null;
    }
  }

  /**
   * Get a bound summarize callback for passing to API tool builders.
   * This allows MCP servers to summarize using the agent's auth infrastructure.
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null> {
    return this.runMiniCompletion.bind(this);
  }
}

// Re-export for convenience
export { AbortReason };

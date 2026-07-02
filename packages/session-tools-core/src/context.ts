/**
 * session-tools-core 的上下文接口
 *
 * 定义了 Claude（同进程）和 Codex（子进程）两种实现都必须提供的抽象上下文接口。
 * 一套 tool handler 只需写一份，就能在两个环境里复用。
 */

import type {
  AuthRequest,
  ToolResult,
  SourceConfig,
  GoogleService,
  SlackService,
  MicrosoftService,
  McpSourceConfig,
} from './types.ts';

// ============================================================
// Source 凭证类型
// ============================================================

/**
 * 已加载的 source，包含凭证操作所需的上下文。
 * 注意：guide 字段被省略了，因为 credential manager 不会用到它。
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// 回调接口
// ============================================================

/**
 * session tool 的回调接口。
 * Claude 和 Codex 会以不同方式实现这个接口：
 * - Claude：直接通过 registry 调用函数
 * - Codex：通过 stderr 发送 JSON 消息
 */
export interface SessionToolCallbacks {
  /**
   * 提交计划时调用。
   * Claude：调用 onPlanSubmitted 回调
   * Codex：向 stderr 发送 __CALLBACK__ 消息
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * 需要认证时调用。
   * Claude：调用 onAuthRequest 回调 + forceAbort
   * Codex：向 stderr 发送 __CALLBACK__ 消息
   */
  onAuthRequest(request: AuthRequest): void;
}

// ============================================================
// 文件系统接口
// ============================================================

/**
 * 可移植的文件系统抽象。
 * 方便在测试里 mock，也允许不同运行环境使用不同实现。
 */
export interface FileSystemInterface {
  /** 判断文件/目录是否存在 */
  exists(path: string): boolean;

  /** 以 UTF-8 字符串读取文件 */
  readFile(path: string): string;

  /** 以 Buffer 读取文件（用于二进制/图片） */
  readFileBuffer(path: string): Buffer;

  /** 写入文件 */
  writeFile(path: string, content: string): void;

  /** 判断路径是否为目录 */
  isDirectory(path: string): boolean;

  /** 列出目录内容 */
  readdir(path: string): string[];

  /** 获取文件状态 */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// 凭证管理器接口
// ============================================================

/**
 * 凭证管理器抽象。
 * Claude 拥有完整的凭证存储访问权限；
 * Codex 可能只有受限或没有访问权限（依赖主进程）。
 */
export interface CredentialManagerInterface {
  /** 检查某个 source 是否有有效且未过期的凭证 */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /** 获取 source 当前的 access token（过期或缺失时返回 null） */
  getToken(source: LoadedSource): Promise<string | null>;

  /** 刷新 source 的 access token */
  refresh(source: LoadedSource): Promise<string | null>;
}

// ============================================================
// 校验器接口
// ============================================================

/**
 * 配置校验接口。
 * Claude 使用 packages/shared 里的完整 Zod 校验器；
 * Codex 使用 session-tools-core 里的简化校验器。
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import('./types.js').ValidationResult;
  validateAllSources(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateStatuses(workspaceRootPath: string): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

// ============================================================
// Session Tool 上下文
// ============================================================

/**
 * session tool 的主上下文接口。
 *
 * Claude 和 Codex 会各自实现这个接口：
 * - Claude：createClaudeContext()，直接访问 Electron 内部
 * - Codex：createCodexContext()，通过 IPC 回调，能力受限
 */
export interface SessionToolContext {
  // ============================================================
  // Session 信息
  // ============================================================

  /** 当前 session 的唯一标识 */
  sessionId: string;

  /** workspace 文件夹的绝对路径（~/.craft-agent/workspaces/{id}） */
  workspacePath: string;

  /** workspace 内 sources 目录的路径 */
  get sourcesPath(): string;

  /** workspace 内 skills 目录的路径 */
  get skillsPath(): string;

  /** 当前 session 的 plans 目录路径 */
  plansFolderPath: string;

  /** session 的工作目录（项目根目录），如果已设置 */
  workingDirectory?: string;

  // ============================================================
  // 回调（与传输方式无关）
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // 文件系统
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // 校验器（可选，可能使用基础或完整版本）
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // 可选能力
  // ============================================================

  /**
   * 获取用于 source 认证检查的 credential manager。
   * 仅在 Claude 中可用（能访问钥匙串）。
   */
  credentialManager?: CredentialManagerInterface;

  /** 从 workspace 加载一个 source 的配置 */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /** 把一个 source 的配置保存到 workspace */
  saveSourceConfig?(source: SourceConfig): void;

  /** 从 URL 推断 Google 服务类型 */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /** 从 URL 推断 Slack 服务类型 */
  inferSlackService?(url?: string): SlackService | undefined;

  /** 从 URL 推断 Microsoft 服务类型 */
  inferMicrosoftService?(url?: string): MicrosoftService | undefined;

  /** 检查 Google OAuth 是否已配置 */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // 图标管理（供 source_test 使用）
  // ============================================================

  /** 判断一个值是否可以作为图标的 URL */
  isIconUrl?(value: string): boolean;

  /**
   * 从 URL 下载图标并缓存到 source 目录。
   * 返回缓存图标的本地路径，下载失败则返回 null。
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /** 从 source 配置推导服务 URL（用于获取 favicon） */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /** 从服务 URL 获取高质量 logo URL */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /** 把图标下载到指定目标路径 */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP 连接校验（供 source_test 使用）
  // ============================================================

  /** 通过 spawn 命令验证 stdio MCP 连接。 */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /** 验证 HTTP/SSE MCP 连接。 */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  // ============================================================
  // API 测试（供 source_test 使用）
  // ============================================================

  /** 测试 API source 的连接，包含完整的凭证处理。 */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /** 测试 Google source（OAuth token 校验）。 */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // 用户偏好（供 update_user_preferences 使用）
  // ============================================================

  /**
   * 提交开发者反馈。由各后端注入：
   * - Claude：写入 ~/.craft-agent/feedback/ 的 JSON 文件
   * - Codex/Pi：可以通过 IPC 发送或直接写入
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * 更新用户偏好。由各后端注入：
   * - Claude：调用 config/preferences.ts 的 updatePreferences()
   * - Codex/session-mcp-server：直接写入 preferences.json
   * - Pi：调用 config/preferences.ts 的 updatePreferences()
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session 自我管理（供 set_session_labels 等使用）
  // ============================================================

  /** 为 session 设置标签。未传 ID 时默认当前 session。由各后端注入。 */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** 为 session 设置状态。未传 ID 时默认当前 session。由各后端注入。 */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /** 获取某个 session 的详细信息。未传 ID 时默认当前 session。由各后端注入。 */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** 分页列出 workspace 中的 session。由各后端注入。 */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /**
   * 从主进程注册表列出某个 session 的后台任务（运行中 + 最近终止的）。
   * 未传 ID 时默认当前 session。由各后端（SessionManager）注入。
   * 在不跟踪后台任务的后端中返回 []。
   */
  listBackgroundTasks?(sessionId?: string): BackgroundTaskInfo[];

  /** 将标签显示名解析为 ID。由各后端注入。 */
  resolveLabels?(labels: string[]): ResolvedLabelsResult;

  /** 将状态显示名解析为 ID。由各后端注入。 */
  resolveStatus?(status: string): ResolvedStatusResult;

  // ============================================================
  // 跨 Session 消息
  // ============================================================

  /**
   * 向另一个 session 发送消息。由各后端（SessionManager）注入。
   * resolve 后返回消息的接收方式，让调用方给模型一个真实的确认（立即送达 vs.
   * 排在忙碌的 turn 后面），而不是无条件返回"消息已发送"。
   */
  sendAgentMessage?(sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>): Promise<SendAgentMessageResult>;

  /**
   * 在运行中的 session 里激活一个 source：加入 enabledSourceSlugs，
   * 构建其 MCP/API server，并应用到 agent。
   *
   * 仅在挨着 SessionManager 运行的后端里可用（Claude 同进程、Pi 子进程）。
   * Codex 等后端不会实现这个函数——调用方应优雅降级（需要重启 session）。
   *
   * `availability` 成功时总是 `'next-turn'`：Claude SDK 的 `mcpServers`
   * 在 `query()` 开始时冻结，Pi 子进程会在下一次 `handlePrompt` 重新加载代理 tool，
   * 两者都需要当前 turn 结束后新 tool 才能被调用。后端通过已有的
   * source_activated + auto_retry 机制处理：当前 turn 被中止，renderer 会用
   * `[{slug} activated]` 后缀重新发送用户原消息。
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // 消息网关（供 list/unbind messaging channels 使用）
  // ============================================================

  /** 获取某个 session 的消息绑定。仅在配置了消息网关时由各后端注入。 */
  getMessagingBindings?(sessionId: string): Array<{
    platform: string;
    channelId: string;
    /** Telegram 超级群论坛话题 ID；DM 或非 Telegram 场景为 undefined。 */
    threadId?: number;
    channelName?: string;
    enabled: boolean;
  }>;

  /** 解除 session 的消息通道绑定。返回被移除的绑定数量。 */
  unbindMessagingChannel?(sessionId: string, platform?: string): number;

  // ============================================================
  // Session 路径（供 transform_data / render_template 使用）
  // ============================================================

  /** session 目录的绝对路径。transform_data 用它解析输入文件。 */
  sessionPath?: string;

  /** session 数据目录的绝对路径。transform_data 和 render_template 用它输出文件。 */
  dataPath?: string;
}

// ============================================================
// Session 自我管理类型 —— 解析结果
// ============================================================

/** 将标签名/ID 解析为配置标签后的结果。 */
export interface ResolvedLabelsResult {
  /** 已解析出的标签 ID（可直接存储） */
  resolved: string[];
  /** 无法匹配到任何配置标签的输入 */
  unknown: string[];
  /** 所有有效标签 ID（用于报错提示） */
  available: string[];
  /**
   * 按原始输入字符串记录的拒绝原因（可选）。
   * 由 `@craft-agent/shared/labels` 的 `resolveSessionLabels()` 填充。
   * handler 用它生成更清晰的错误，例如“标签 X 不接受取值”。
   */
  reasons?: Record<string, string>;
}

/** 将状态名/ID 解析为配置状态后的结果。 */
export interface ResolvedStatusResult {
  /** 匹配到的状态 ID，未知则为 null */
  resolved: string | null;
  /** 所有有效状态 ID（用于报错提示） */
  available: string[];
  /**
   * Category of the matched status ('open' | 'closed'), when resolved. Lets the
   * status tool reject agent-driven *closed* transitions (the human owns closure)
   * while still allowing open ones like `needs-review`.
   */
  category?: 'open' | 'closed';
}

// ============================================================
// Session 自我管理类型
// ============================================================

/** 单个 session 的完整元数据（get_session_info 返回）。 */
export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
}

/** session 的精简摘要（list_sessions 返回）。 */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
}

/** list_sessions 的过滤与分页选项。 */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/** list_sessions 的分页结果。 */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

/**
 * Result of delivering a cross-session message (send_agent_message).
 * Lets the sender report the truth instead of an unconditional "sent".
 */
export interface SendAgentMessageResult {
  /**
   * - `delivered`: the target was idle, so it will start processing the message now.
   * - `queued`: the target was mid-turn; the message is enqueued and will be
   *   processed after the current turn finishes.
   */
  delivery: 'delivered' | 'queued';
  /** Whether the target session was processing a turn when the message arrived. */
  targetBusy: boolean;
}

/**
 * A background task tracked by the main process (returned by
 * list_background_tasks). This is the cross-subprocess source of truth: the
 * SDK's in-subprocess task tools only see tasks launched in the CURRENT
 * subprocess, so they cannot report a task from a prior turn's (torn-down)
 * subprocess. `status: 'orphaned'` means the owning turn ended before a terminal
 * notification arrived — the task most likely died with its subprocess.
 */
export interface BackgroundTaskInfo {
  taskId: string;
  intent?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';
  /** ms timestamp when the task was backgrounded */
  startTime: number;
  /** seconds elapsed since start (derived at query time) */
  elapsedSeconds: number;
  /** ms timestamp when the task reached a terminal/orphaned status, if any */
  completedAt?: number;
}

// ============================================================
// MCP 校验类型
// ============================================================

/** stdio MCP 连接校验的配置。 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * HTTP/SSE MCP 连接校验的配置。
 * 从 McpSourceConfig 派生，保持同步（DRY）。
 *
 * `accessToken` 是凭证仓库中解析出的 OAuth / bearer token，
 * 用于那些凭证存在凭证存储且没有 `headerNames` 的 source。
 * probe 会把它透传给底层实现，由后者组装成 `Authorization: Bearer …` header，
 * 与运行时路径保持一致。
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>>
  & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>
  & { accessToken?: string };

/** stdio MCP 校验结果。 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/** HTTP MCP 校验结果。 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/** API source 测试结果。 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}

// ============================================================
// 上下文工厂辅助函数
// ============================================================

/** 使用 Node.js fs 创建一个基础文件系统实现。 */
export function createNodeFileSystem(): FileSystemInterface {
  // 动态引入，以便在两种环境里都能工作
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}

/**
 * session-tools-core 的类型定义
 *
 * 供 Claude（同进程）和 Codex（子进程）两种实现共享的 session 级 tool 类型。
 */

// ============================================================
// 凭证输入模式
// ============================================================

/**
 * 不同认证类型对应的凭证输入模式
 */
export type CredentialInputMode = 'bearer' | 'basic' | 'header' | 'query' | 'multi-header';

// ============================================================
// 服务类型（为可移植性做了简化）
// ============================================================

/**
 * Google OAuth 服务类型
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

/**
 * Slack OAuth 服务类型
 */
export type SlackService = 'messaging' | 'channels' | 'users' | 'files' | 'full';

/**
 * Microsoft OAuth 服务类型
 * 注意：'microsoft-calendar' 用于和 Google calendar 区分
 */
export type MicrosoftService = 'outlook' | 'microsoft-calendar' | 'onedrive' | 'teams' | 'sharepoint';

// ============================================================
// 认证请求类型
// ============================================================

/**
 * 认证请求的类型标签（discriminator）
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'oauth-slack'
  | 'oauth-microsoft';

/**
 * 所有认证类型共用的基础字段
 */
export interface BaseAuthRequest {
  requestId: string;
  sessionId: string;
  sourceSlug: string;
  sourceName: string;
}

/**
 * 凭证认证请求 —— 提示用户输入 API key、bearer token 等
 */
export interface CredentialAuthRequest extends BaseAuthRequest {
  type: 'credential';
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  headerName?: string;
  /** 多 header 认证的 header 名（如 ["DD-API-KEY", "DD-APPLICATION-KEY"]） */
  headerNames?: string[];
  /** source URL/域名，用于密码管理器匹配凭证（1Password 等） */
  sourceUrl?: string;
  /** basic 认证是否必须填密码。为兼容旧行为，默认 true。 */
  passwordRequired?: boolean;
}

/**
 * MCP OAuth 认证请求 —— 标准 OAuth 2.0 + PKCE
 */
export interface McpOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth';
}

/**
 * Google OAuth 认证请求 —— Google 专用 OAuth
 */
export interface GoogleOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-google';
  service?: GoogleService;
}

/**
 * Slack OAuth 认证请求 —— Slack 专用 OAuth
 */
export interface SlackOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-slack';
  service?: SlackService;
}

/**
 * Microsoft OAuth 认证请求 —— Microsoft 专用 OAuth
 */
export interface MicrosoftOAuthAuthRequest extends BaseAuthRequest {
  type: 'oauth-microsoft';
  service?: MicrosoftService;
}

/**
 * 所有认证请求类型的联合类型
 */
export type AuthRequest =
  | CredentialAuthRequest
  | McpOAuthAuthRequest
  | GoogleOAuthAuthRequest
  | SlackOAuthAuthRequest
  | MicrosoftOAuthAuthRequest;

/**
 * 认证结果 —— 认证完成后发回给 agent
 */
export interface AuthResult {
  requestId: string;
  sourceSlug: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
  // 成功后的附加信息
  email?: string;      // Google/Microsoft OAuth
  workspace?: string;  // Slack OAuth
}

// ============================================================
// 开发者反馈
// ============================================================

/**
 * agent 发给开发团队的自由格式反馈。
 * 以独立 JSON 文件持久化，方便后续批量查看/发送。
 */
export interface DeveloperFeedback {
  id: string;
  timestamp: string;
  sessionId: string;
  message: string;
}

// ============================================================
// 回调消息（IPC）
// ============================================================

/**
 * 与主进程进行 IPC 的回调消息。
 * Codex 子进程通过 stderr 发送这类消息。
 */
export interface CallbackMessage {
  __callback__: string;
  [key: string]: unknown;
}

// ============================================================
// Tool 结果类型
// ============================================================

/**
 * tool 响应中的文本内容块
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * 标准 tool 结果类型，兼容 SDK 和 MCP 两种模式
 */
export interface ToolResult {
  content: TextContent[];
  /**
   * 给 MCP 客户端用的结构化负载。
   * 保持为对象（不要设为 null），以兼容严格的 tool_result 解析器。
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ============================================================
// 校验结果类型
// ============================================================

/**
 * 单条校验问题
 */
export interface ValidationIssue {
  path: string;
  message: string;
  suggestion?: string;
}

/**
 * 校验操作的结果
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ============================================================
// Source 配置类型（为 core 包做了简化）
// ============================================================

/**
 * source 类型标签
 */
export type SourceType = 'mcp' | 'api' | 'local';

/**
 * MCP 传输类型
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * MCP 认证类型
 */
export type McpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API 认证类型
 */
export type ApiAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * MCP source 配置块
 */
export interface McpSourceConfig {
  transport?: McpTransport;
  url?: string;
  authType?: McpAuthType;
  clientId?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** 凭证仓库认证使用的 header 名（如 ["X-API-Key"]） */
  headerNames?: string[];
}

/**
 * API source 配置块
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: ApiAuthType;
  headerName?: string;
  /** 多 header 认证使用的 header 名（如 ["DD-API-KEY", "DD-APPLICATION-KEY"]） */
  headerNames?: string[];
  queryParam?: string;
  authScheme?: string;
  testEndpoint?: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  // Google OAuth 配置
  googleService?: GoogleService;
  googleScopes?: string[];
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  // Slack OAuth 配置
  slackService?: SlackService;
  // Microsoft OAuth 配置
  microsoftService?: MicrosoftService;
  // 通用 OAuth 配置（authType 为 'oauth' 且不是 google/slack/microsoft 时）
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    audience?: string;
    extraParams?: Record<string, string>;
  };
}

/**
 * Local source 配置块
 */
export interface LocalSourceConfig {
  path: string;
  format?: string;
}

/**
 * source 的连接状态
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'unknown';

/**
 * 完整的 source 配置（core 包使用的简化版本）
 */
export interface SourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  isAuthenticated?: boolean;
  lastTestedAt?: number; // 毫秒时间戳
  createdAt?: number;
  updatedAt?: number;
  // 展示字段
  tagline?: string;
  icon?: string; // URL、emoji，或省略表示本地文件
  // 连接追踪
  connectionStatus?: ConnectionStatus;
  connectionError?: string;
}

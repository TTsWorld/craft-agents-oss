/**
 * Source Types
 *
 * Source（数据源）是 Agent 连接外部系统的抽象，比如 MCP 服务器、REST API、本地文件/应用。
 * 它用文件夹来组织配置：每个 source 对应一个目录，里面有 config.json 和 guide.md。
 *
 * TS 小知识：
 * - `export type ...` 是给类型起别名，类似 Go 的 `type xxx = ...`。
 * - `export interface ...` 定义对象结构约束，类似 Go 的 interface（但这里是“结构必须长这样”）。
 *
 * 文件结构：
 * ~/.craft-agent/workspaces/{workspaceId}/sources/{sourceSlug}/
 *   ├── config.json   - Source 配置
 *   └── guide.md      - 使用说明 + 缓存数据（YAML frontmatter）
 */

/**
 * Source 类型：连接方式
 * - 'mcp': 通过 MCP 协议连接远程/本地服务器
 * - 'api': 普通 REST API
 * - 'local': 本地文件系统或应用
 */
export type SourceType = 'mcp' | 'api' | 'local';

/**
 * MCP source 的认证类型（针对单个 source 连接）
 * 注意：这和 workspace 级别的 McpAuthType 不同，后者用 'workspace_oauth' | 'workspace_bearer' | 'public'。
 */
export type SourceMcpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API 认证类型
 * - bearer: Authorization: Bearer <token>
 * - header: 自定义请求头
 * - query: URL 查询参数
 * - basic: HTTP Basic Auth
 * - oauth: OAuth 2.0
 * - none: 公开接口，无需认证
 */
export type ApiAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * Google 服务类型，用于 OAuth scope 选择
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

/**
 * Slack 服务类型，用于 OAuth scope 选择
 */
export type SlackService = 'messaging' | 'channels' | 'users' | 'files' | 'full';

/**
 * Microsoft 服务类型，用于 OAuth scope 选择
 */
export type MicrosoftService = 'outlook' | 'microsoft-calendar' | 'onedrive' | 'teams' | 'sharepoint';

/**
 * 从 API baseUrl 推断 Google 服务类型。
 * 如果 URL 不匹配已知 Google API 模式，返回 undefined。
 *
 * 这里用 URL 解析而不是简单的字符串匹配，避免路径里的巧合字符造成误判。
 */
export function inferGoogleServiceFromUrl(baseUrl: string | undefined): GoogleService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // 按主机名匹配（最可靠）
  if (hostname === 'calendar.googleapis.com') return 'calendar';
  if (hostname === 'drive.googleapis.com') return 'drive';
  if (hostname === 'gmail.googleapis.com') return 'gmail';
  if (hostname === 'docs.googleapis.com') return 'docs';
  if (hostname === 'sheets.googleapis.com') return 'sheets';
  if (hostname === 'youtube.googleapis.com') return 'youtube';
  if (hostname === 'searchconsole.googleapis.com' || hostname === 'webmasters.googleapis.com') return 'searchconsole';

  // 兜底：只在 googleapis.com 域名下按路径匹配
  if (hostname === 'www.googleapis.com' || hostname === 'googleapis.com') {
    if (pathname.startsWith('/calendar/')) return 'calendar';
    if (pathname.startsWith('/drive/')) return 'drive';
    if (pathname.startsWith('/gmail/')) return 'gmail';
    if (pathname.startsWith('/v1/documents') || pathname.startsWith('/documents/')) return 'docs';
    if (pathname.startsWith('/v4/spreadsheets') || pathname.startsWith('/spreadsheets/')) return 'sheets';
    if (pathname.startsWith('/youtube/')) return 'youtube';
    if (pathname.startsWith('/webmasters/')) return 'searchconsole';
  }

  return undefined;
}

/**
 * 从 API baseUrl 推断 Slack 服务类型。
 * 如果 URL 匹配 Slack API 模式，默认返回 'full'。
 */
export function inferSlackServiceFromUrl(baseUrl: string | undefined): SlackService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }

  // 匹配 Slack API 主机名
  if (hostname === 'slack.com' || hostname === 'api.slack.com') {
    return 'full'; // Slack 默认用 full service
  }

  return undefined;
}

/**
 * 从 API baseUrl 推断 Microsoft 服务类型。
 * Microsoft Graph API 所有服务都共用 graph.microsoft.com，所以主要靠路径区分。
 * 如果无法从 URL 路径判断，返回 undefined，需要用户在配置里显式指定 microsoftService。
 */
export function inferMicrosoftServiceFromUrl(baseUrl: string | undefined): MicrosoftService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // Microsoft Graph API 主机名
  if (hostname === 'graph.microsoft.com') {
    // 按路径推断服务
    if (pathname.includes('/me/messages') || pathname.includes('/me/mailfolders') || pathname.includes('/mail')) {
      return 'outlook';
    }
    if (pathname.includes('/me/calendar') || pathname.includes('/me/events')) {
      return 'microsoft-calendar';
    }
    if (pathname.includes('/me/drive') || pathname.includes('/drives')) {
      return 'onedrive';
    }
    if (pathname.includes('/teams') || pathname.includes('/chats')) {
      return 'teams';
    }
    if (pathname.includes('/sites')) {
      return 'sharepoint';
    }
    // 通用 Graph URL 无法判断，要求显式配置
    return undefined;
  }

  // 旧版 Outlook API（仍在使用）
  if (hostname === 'outlook.office.com' || hostname === 'outlook.office365.com') {
    return 'outlook';
  }

  return undefined;
}

/**
 * 已知 provider：需要特殊处理 OAuth 流程、图标等的来源。
 * 这些 provider 有标准的 OAuth 端点或特殊行为。
 */
export type KnownProvider =
  | 'google' // Google API - 使用 Google OAuth
  | 'microsoft' // Microsoft API - 使用 Microsoft OAuth
  | 'linear' // Linear - 标准 MCP OAuth
  | 'github' // GitHub - 标准 MCP OAuth
  | 'notion' // Notion - 标准 MCP OAuth
  | 'slack' // Slack - 标准 MCP OAuth
  | 'exa'; // Exa 搜索 API

/**
 * 使用 OAuth 认证的 API provider 白名单。
 * 这些 provider 的凭证存为 source_oauth，由 SourceCredentialManager 管理。
 */
export const API_OAUTH_PROVIDERS = ['google', 'microsoft', 'slack'] as const;

/**
 * 从上面数组中推导出具体 provider 类型。
 * `typeof API_OAUTH_PROVIDERS[number]` 是 TS 用法：取只读数组元素的联合类型。
 */
export type ApiOAuthProvider = typeof API_OAUTH_PROVIDERS[number];

/**
 * 类型守卫：判断某个 provider 是否属于 OAuth API provider。
 * `provider is ApiOAuthProvider` 是 TS 自定义类型守卫，返回 true 时 TS 会把它窄化为该类型。
 */
export function isApiOAuthProvider(provider: string | undefined): provider is ApiOAuthProvider {
  return API_OAUTH_PROVIDERS.includes(provider as ApiOAuthProvider);
}

/**
 * 判断 source 是否使用 OAuth 认证（用于主动刷新 token）。
 *
 * 返回 true 的情况：
 * - MCP source 且 authType 为 'oauth'
 * - API source 且 provider 是 google/slack/microsoft
 * - API source 且是 generic OAuth
 */
export function isOAuthSource(source: LoadedSource): boolean {
  // MCP OAuth source
  if (source.config.type === 'mcp') {
    return source.config.mcp?.authType === 'oauth';
  }

  // API OAuth source（Google、Slack、Microsoft）
  if (source.config.type === 'api') {
    if (isApiOAuthProvider(source.config.provider)) return true;
    // 通用 OAuth API source（例如 GitHub、Linear）
    if (isGenericOAuthSource(source)) return true;
  }

  return false;
}

/**
 * 判断 source 是否使用 generic OAuth（非 Google/Slack/Microsoft 这种 provider-specific OAuth）。
 * 匹配 API source 中 authType 为 'oauth' 的情况：可以是显式配置了 oauth 块，也可以是从 baseUrl 自动发现。
 */
export function isGenericOAuthSource(source: LoadedSource): boolean {
  return (
    source.config.type === 'api' &&
    source.config.api?.authType === 'oauth' &&
    !isApiOAuthProvider(source.config.provider)
  );
}

/**
 * 判断 API source 是否配置了 token 续期端点。
 */
export function hasRenewEndpoint(source: LoadedSource): boolean {
  return source.config.type === 'api' && !!source.config.api?.renewEndpoint?.path;
}

/**
 * 判断 source 是否可以自动刷新 token。
 * 返回 true 当：OAuth source 或配置了 renewEndpoint。
 *
 * 推荐用这一个函数代替散落在各处的 provider/authType/renewEndpoint 判断。
 */
export function isRefreshableSource(source: LoadedSource): boolean {
  return isOAuthSource(source) || hasRenewEndpoint(source);
}

/**
 * MCP 传输类型
 * - 'http': 基于 HTTP 的 MCP 服务器
 * - 'sse': 基于 Server-Sent Events 的 MCP 服务器
 * - 'stdio': 本地子进程 MCP 服务器（通过命令启动）
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

/**
 * MCP source 专属配置。
 * 支持 HTTP/SSE 远程服务器和 stdio 本地子进程两种形式。
 */
export interface McpSourceConfig {
  /**
   * 传输类型。不填时默认 'http'。
   */
  transport?: McpTransport;

  // === HTTP/SSE 传输字段 ===
  /**
   * HTTP 或 SSE 的服务端 URL。
   * transport 为 'http'/'sse'（或未指定）时必填。
   */
  url?: string;

  /**
   * HTTP/SSE 服务器的认证类型。
   */
  authType?: SourceMcpAuthType;

  /**
   * OAuth client ID（存在 config.json 里，不是密钥）。
   */
  clientId?: string;

  // === stdio 传输字段 ===
  /**
   * stdio 传输要启动的命令。
   * transport 为 'stdio' 时必填。
   */
  command?: string;

  /**
   * 传给命令的参数。
   */
  args?: string[];

  /**
   * 子进程环境变量。
   */
  env?: Record<string, string>;

  // === HTTP/SSE 自定义请求头 ===
  /**
   * 每次 MCP 请求都带的自定义请求头。
   * 当 authType 启用时，Authorization 等认证头会在这些头之上合并。
   */
  headers?: Record<string, string>;

  /**
   * 从凭证库读取的 header 名称列表（例如 ["X-API-Key"]）。
   * 凭证值以 JSON 形式存在凭证库里，和 API multi-header 认证共用同一套存储。
   * 优先级：静态 headers < 凭证库 headerNames < Authorization bearer。
   */
  headerNames?: string[];
}

/**
 * API 连通性测试端点配置
 */
export interface ApiTestEndpoint {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>; // POST 请求体
  headers?: Record<string, string>; // 测试请求的自定义头
}

/**
 * API source 的通用 OAuth 2.0 配置。
 * 有了它，任何 OAuth 2.0 provider 都可以在 config.json 里直接配置，
 * 不需要 MCP 服务器，也不需要用户手动填 PAT。
 */
export interface ApiOAuthConfig {
  /** OAuth 授权端点 URL（必填） */
  authorizationUrl: string;
  /** OAuth token 交换端点 URL（必填） */
  tokenUrl: string;
  /** OAuth client ID（必填） */
  clientId: string;
  /** OAuth client secret（PKCE 公开客户端可省略） */
  clientSecret?: string;
  /** 请求的 OAuth scope */
  scopes?: string[];
  /** Auth0 风格的 audience 参数 */
  audience?: string;
  /** 授权 URL 中附加的额外参数 */
  extraParams?: Record<string, string>;
}

/**
 * 非 OAuth API source 的 token 续期端点配置。
 * 让一些自定义 bearer-token API 通过调用 provider 自己的续期端点来自动续期（不是标准 OAuth）。
 *
 * MVP 范围：仅支持 access-token 续期。当前 access token 会通过 Authorization 头
 * 或 {{token}} 占位符发送到 body/headers 里。
 */
export interface ApiRenewEndpoint {
  /** 续期 URL：相对路径（会拼到 baseUrl）或绝对 URL */
  path: string;
  /** HTTP 方法（默认 POST） */
  method?: 'GET' | 'POST';
  /** 请求体 —— 字符串叶子节点里的 {{token}} 会被替换为当前 access token。
   *  支持嵌套对象（递归替换字符串叶子）。 */
  body?: Record<string, unknown>;
  /** 续期请求的额外请求头 —— 同样支持 {{token}} 替换。
   *  会覆盖 defaultHeaders。Authorization 头默认会发送，除非在这里显式覆盖。 */
  headers?: Record<string, string>;
  /** 响应里新 access token 的 JSON 字段名（默认 "access_token"） */
  tokenField?: string;
  /** 响应里过期秒数的 JSON 字段名（默认 "expires_in"） */
  expiresInField?: string;
  /** 响应没有过期时间时的兜底 TTL（秒，可选）。
   *  不填的话，每次会话启动都会触发刷新（安全但吵闹）。 */
  fallbackTtlSecs?: number;
}

/**
 * API source 专属配置
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: ApiAuthType;
  headerName?: string; // 'header' 认证时使用，例如 "X-API-Key"
  headerNames?: string[]; // multi-header 认证，例如 ["DD-API-KEY", "DD-APPLICATION-KEY"]
  queryParam?: string; // 'query' 认证时使用，例如 "api_key"
  authScheme?: string; // 'bearer' 认证时使用，默认 "Bearer"，也可以是 "Token"
  defaultHeaders?: Record<string, string>; // 每次请求都带的头
  testEndpoint?: ApiTestEndpoint; // 连通性测试端点
  renewEndpoint?: ApiRenewEndpoint; // 非 OAuth source 的可选续期端点

  // Google OAuth 字段（provider 为 'google' 时使用）
  googleService?: GoogleService; // 预定义服务，用于选择 scope
  googleScopes?: string[]; // 自定义 scope（覆盖 googleService）
  // 用户自建的 Google Cloud 项目 OAuth 凭据
  googleOAuthClientId?: string; // 用户 Google OAuth Client ID
  googleOAuthClientSecret?: string; // 用户 Google OAuth Client Secret

  // Slack OAuth 字段（provider 为 'slack' 时使用）
  // 使用 user_scope，以用户身份发帖（不是 bot）
  slackService?: SlackService; // 预定义服务，用于选择 scope
  slackUserScopes?: string[]; // 自定义 user scope（覆盖 slackService）

  // Microsoft OAuth 字段（provider 为 'microsoft' 时使用）
  microsoftService?: MicrosoftService; // 预定义服务，用于选择 scope
  microsoftScopes?: string[]; // 自定义 scope（覆盖 microsoftService）

  // 通用 OAuth 配置（authType 为 'oauth' 且 provider 不是 google/slack/microsoft 时使用）
  oauth?: ApiOAuthConfig;
}

/**
 * 本地文件系统/应用配置
 */
export interface LocalSourceConfig {
  path: string;
  format?: string; // 可选提示：'filesystem' | 'obsidian' | 'git' | 'sqlite' 等
}

/**
 * Source 连接状态
 * - 'connected': 已连接且可用
 * - 'needs_auth': 需要认证
 * - 'failed': 连接失败并带错误信息
 * - 'untested': 还没测试过
 * - 'local_disabled': stdio source 被禁用（本地 MCP 服务器关闭）
 */
export type SourceConnectionStatus = 'connected' | 'needs_auth' | 'failed' | 'untested' | 'local_disabled';

// ============================================================================
// Source 品牌/主题
// ============================================================================

/**
 * Source 的 UI 品牌主题。
 * 使用 EntityColor 系统支持亮色/暗色模式。
 */
export interface SourceBrand {
  /** 主品牌色 —— 用于 source 相关的 UI 元素。
   *  可以是系统颜色名（"accent"、"info"）或自定义 { light, dark } 值。
   *  不填默认 "accent"。 */
  color?: import('../colors/types').EntityColor;
}

// ============================================================================
// 主 Source 配置
// ============================================================================

/**
 * 主 source 配置（存在 config.json 里）
 */
export interface FolderSourceConfig {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;

  // provider 是自由标签，例如 "linear"、"todoist"、"my-custom-api"
  provider: string;

  // type 决定使用哪个配置块
  type: SourceType;

  // 类型专属配置（通常只会有一个存在）
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;

  // 图标：emoji 或 URL
  // config 是图标唯一来源。本地图标文件只在 icon 未定义时自动发现。
  // 优先级：emoji > URL > 本地文件（自动发现）
  icon?: string;

  // 给 agent 上下文的简短描述，例如 "Issue tracking, bugs, tasks, sprints"
  // 不填时从 guide.md 第一段提取
  tagline?: string;

  // 该 source UI 元素的品牌主题
  brand?: SourceBrand;

  // 状态记录
  isAuthenticated?: boolean;
  connectionStatus?: SourceConnectionStatus;
  connectionError?: string; // status 为 'failed' 时的错误信息
  lastTestedAt?: number;

  // 元数据（手动创建的配置可能没有）
  createdAt?: number;
  updatedAt?: number;
}

/**
 * 解析后的 guide.md 内容，包含嵌入缓存
 */
export interface SourceGuide {
  // 完整原始 markdown
  raw: string;

  // 解析出的章节（通过正则/解析提取）
  scope?: string;
  guidelines?: string;
  context?: string;
  apiNotes?: string;

  // 嵌入缓存数据（来自 YAML frontmatter）
  cache?: Record<string, unknown>;
}

/**
 * 完全加载后的 source，包含所有文件信息
 */
export interface LoadedSource {
  config: FolderSourceConfig;
  guide: SourceGuide | null;

  /** source 文件夹绝对路径（用于解析相对图标路径） */
  folderPath: string;

  /** workspace 文件夹绝对路径，例如 ~/.craft-agent/workspaces/xxx */
  workspaceRootPath: string;

  /**
   * 该 source 所属 workspace。
   * 用于凭证查找：source_oauth::{workspaceId}::{sourceSlug}
   */
  workspaceId: string;

  /**
   * 是否为内置 source（例如 craft-agents-docs）。
   * 内置 source 始终可用，且不在 sources UI 列表中显示。
   */
  isBuiltin?: boolean;

  /**
   * 预计算的本地图标文件路径（icon.svg、icon.png 等）。
   * 在加载 source 时就算好，渲染层不需要再访问文件系统。
   */
  iconPath?: string;
}

/**
 * 创建 source 时的输入（不含自动生成字段）
 */
export interface CreateSourceInput {
  name: string;
  provider: string;
  type: SourceType;
  mcp?: McpSourceConfig;
  api?: ApiSourceConfig;
  local?: LocalSourceConfig;
  icon?: string; // emoji 或 URL（会自动下载）
  enabled?: boolean;
}

/**
 * API source 的 REST API 配置
 * api-tools.ts 用它创建动态 API tool
 */
export interface ApiConfig {
  name: string;
  baseUrl: string;
  auth?: {
    type: 'none' | 'header' | 'bearer' | 'query' | 'basic';
    headerName?: string;
    headerNames?: string[]; // multi-header 认证，例如 ["DD-API-KEY", "DD-APPLICATION-KEY"]
    queryParam?: string;
    authScheme?: string;
    credentialLabel?: string;
    secretLabel?: string;
  };
  headers?: Record<string, string>;
  documentation?: string;
  docsUrl?: string;
  defaultHeaders?: Record<string, string>;
  logo?: string;
  workspaceId?: string;
}

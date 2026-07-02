/**
 * 凭证存储相关的类型定义
 *
 * 定义安全凭证存储所用的类型，数据使用 AES-256-GCM 加密。
 * 支持全局（global）和 source 作用域两种凭证。
 *
 * 凭证 key 的格式："{type}::{scope...}"
 *
 * 示例：
 *   - anthropic_api_key::global
 *   - claude_oauth::global
 *   - source_oauth::{workspaceId}::{sourceId}
 *   - source_bearer::{workspaceId}::{sourceId}
 *
 * 注意：用 "::" 作为分隔符，避免和 URL/路径中的 "/" 冲突。
 */

/** 我们支持存储的凭证类型 */
export type CredentialType =
  // 全局凭证（历史遗留，保持向后兼容）
  | 'anthropic_api_key'  // 供 Claude 使用的 Anthropic API key
  | 'claude_oauth'       // Claude OAuth token（Max 订阅）
  // LLM 连接凭证（用 connection slug 作为 key）
  | 'llm_api_key'        // LLM 连接的 API key
  | 'llm_oauth'          // LLM 连接的 OAuth token
  | 'llm_iam'            // AWS IAM 凭证（accessKeyId + secretAccessKey）
  | 'llm_service_account' // GCP 服务账号 JSON
  // Workspace 凭证
  | 'workspace_oauth'    // Workspace MCP OAuth token
  // Source 凭证（存储在 ~/.craft-agent/workspaces/{ws}/sources/{slug}/）
  | 'source_oauth'       // MCP/API source 的 OAuth token
  | 'source_bearer'      // Bearer token
  | 'source_apikey'      // API keys
  | 'source_basic'       // Basic 认证（base64 编码的 user:pass）
  // 消息网关凭证（用 workspaceId + platform 作为 key）
  | 'messaging_bearer';  // 平台 token（例如 Telegram bot token）

/** 用于校验的合法凭证类型列表 */
const VALID_CREDENTIAL_TYPES: readonly CredentialType[] = [
  'anthropic_api_key',
  'claude_oauth',
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
  'workspace_oauth',
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
  'messaging_bearer',
] as const;

/** 判断字符串是否是合法的 CredentialType */
function isValidCredentialType(type: string): type is CredentialType {
  return VALID_CREDENTIAL_TYPES.includes(type as CredentialType);
}

/**
 * 凭证标识（CredentialId），决定凭证在存储中的 key。
 * 类似 Golang 里一个带标签的 struct，这里用 interface 描述对象形状。
 */
export interface CredentialId {
  type: CredentialType;

  // LLM connection 作用域格式
  /** llm_api_key/llm_oauth 凭证所需的 LLM connection slug */
  connectionSlug?: string;

  // Workspace 作用域格式
  /** workspace 作用域凭证所需的 Workspace ID */
  workspaceId?: string;
  /** source 凭证所需的 Source ID */
  sourceId?: string;
  /** server 名或 API 名 */
  name?: string;
}

/**
 * 加密文件中存储的凭证值。
 *
 * 这是一个泛化类型，覆盖所有凭证类型（OAuth、bearer token、API key、IAM、服务账号）。
 * 除 value 外其他字段都是可选的，因为不同凭证类型不一定用到它们。
 *
 * 注意：这里的 clientId 是可选的，而 OAuthCredentials（在 storage.ts 中）要求必填，
 * 因为 StoredCredential 还要覆盖 bearer token、API key 等没有 clientId 的类型。
 */
export interface StoredCredential {
  /** 真正的秘密值（API key、access token 或主凭证） */
  value: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** OAuth token 过期时间（Unix 时间戳，毫秒） */
  expiresAt?: number;
  /** OAuth client ID（刷新 token 时需要） */
  clientId?: string;
  /** OAuth client secret（Google 刷新 token 时需要 ID 和 secret） */
  clientSecret?: string;
  /** Token 类型，例如 "Bearer" */
  tokenType?: string;
  /** 凭证来源：'native'（我们自己的 OAuth）、'cli'（Claude CLI 导入） */
  source?: 'native' | 'cli';
  /**
   * OIDC id_token（携带用户身份声明的 JWT）。
   * OpenAI/Codex 会同时返回 id_token 和 access_token。
   * value 字段存 access_token，这个字段存 id_token。
   */
  idToken?: string;

  // --- AWS IAM 凭证（对应 llm_iam 类型） ---

  /** AWS Access Key ID（IAM 凭证） */
  awsAccessKeyId?: string;
  /** AWS Secret Access Key（IAM 凭证）——存在 value 字段里 */
  // awsSecretAccessKey is stored in the `value` field
  /** AWS Region（IAM 凭证） */
  awsRegion?: string;
  /** AWS Session Token（临时凭证） */
  awsSessionToken?: string;

  // --- GCP 服务账号（对应 llm_service_account 类型） ---

  /** GCP Project ID（服务账号） */
  gcpProjectId?: string;
  /** GCP Region（服务账号） */
  gcpRegion?: string;
  /** 服务账号邮箱（用于识别） */
  serviceAccountEmail?: string;
  // 完整服务账号 JSON 存在 value 字段里
}

// 用 "::" 作为分隔符而不是 "/"，因为 server 名和 API 名可能包含 "/"
//（例如 URL "https://api.example.com"）
const CREDENTIAL_DELIMITER = '::';

/** source 凭证类型集合 */
export const SOURCE_CREDENTIAL_TYPES = [
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
] as const;

/** 消息网关凭证类型集合 */
const MESSAGING_CREDENTIAL_TYPES = [
  'messaging_bearer',
] as const;

/** 判断类型是否属于消息网关凭证 */
function isMessagingCredential(type: CredentialType): boolean {
  return (MESSAGING_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** LLM 连接凭证类型集合 */
const LLM_CREDENTIAL_TYPES = [
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
] as const;

/** 判断类型是否属于 source 凭证 */
function isSourceCredential(type: CredentialType): boolean {
  return (SOURCE_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** 判断类型是否属于 LLM 连接凭证 */
function isLlmCredential(type: CredentialType): boolean {
  return (LLM_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** 把 CredentialId 转换成凭证仓库里的 account 字符串（即存储 key） */
export function credentialIdToAccount(id: CredentialId): string {
  const parts: string[] = [id.type];

  // LLM connection 作用域格式：
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(id.type) && id.connectionSlug) {
    parts.push(id.connectionSlug);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Workspace 作用域格式（不含 source）：
  // workspace_oauth::{workspaceId}
  if (id.type === 'workspace_oauth' && id.workspaceId) {
    parts.push(id.workspaceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Source 作用域格式：
  // source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(id.type) && id.workspaceId && id.sourceId) {
    parts.push(id.workspaceId);
    parts.push(id.sourceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Messaging 作用域格式：
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(id.type) && id.workspaceId && id.name) {
    parts.push(id.workspaceId);
    parts.push(id.name);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  parts.push('global');
  return parts.join(CREDENTIAL_DELIMITER);
}

// ============================================================
// 凭证健康检查相关类型
// ============================================================

/** 启动时检测到的凭证健康问题类型 */
export type CredentialHealthIssueType =
  | 'file_corrupted'         // 凭证文件存在但无法解析
  | 'decryption_failed'      // 文件存在但无法解密（通常是换机器了）
  | 'no_default_credentials' // 默认连接没有凭证

/** 单个凭证健康问题 */
export interface CredentialHealthIssue {
  type: CredentialHealthIssueType
  /** 人类可读的错误信息 */
  message: string
  /** 原始错误信息（如果有） */
  error?: string
}

/** 凭证仓库健康检查结果 */
export interface CredentialHealthStatus {
  /** 凭证仓库是否健康可用 */
  healthy: boolean
  /** 发现的问题列表（健康时为空数组） */
  issues: CredentialHealthIssue[]
}

/** 把凭证仓库的 account 字符串解析回 CredentialId；格式不合法时返回 null */
export function accountToCredentialId(account: string): CredentialId | null {
  const parts = account.split(CREDENTIAL_DELIMITER);
  const typeStr = parts[0];

  // 校验类型是否合法
  if (!typeStr || !isValidCredentialType(typeStr)) {
    return null;
  }

  const type = typeStr;

  // LLM connection 作用域格式：
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(type) && parts.length === 2) {
    return { type, connectionSlug: parts[1] };
  }

  // Workspace 作用域格式（不含 source）：
  // workspace_oauth::{workspaceId}
  if (type === 'workspace_oauth' && parts.length === 2) {
    return { type, workspaceId: parts[1] };
  }

  // Source 作用域格式：
  // source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], sourceId: parts[2] };
  }

  // Messaging 作用域格式：
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], name: parts[2] };
  }

  if (parts.length === 2 && parts[1] === 'global') {
    return { type };
  }

  // 未知格式
  return null;
}

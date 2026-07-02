/**
 * 工作区（Workspace）与认证类型定义。
 *
 * Workspace 是 Craft Agent 里"项目"的抽象，每个工作区有自己的：
 * - 本地根目录（rootPath）
 * - 会话集合
 * - MCP/AI provider 配置
 */

/**
 * MCP Server 在工作区级别的认证方式。
 *
 * 注意：和单个 Source 的 SourceMcpAuthType（'oauth' | 'bearer' | 'none'）不同，
 * 这里描述的是整个工作区如何向 MCP Server 认证。
 */
export type McpAuthType = 'workspace_oauth' | 'workspace_bearer' | 'public';

/**
 * 远程 Craft Agent Server 配置。
 *
 * 当工作区配置了远程服务器后，该工作区的 handler 调用会通过 WebSocket 代理到远程。
 * 类似 Golang 里的 gRPC/HTTP 反向代理配置。
 */
export interface RemoteServerConfig {
  url: string;              // ws://host:port 或 wss://host:port
  token: string;            // 远程服务器认证 token
  remoteWorkspaceId: string; // 远程服务器上的工作区 ID
}

/**
 * 客户端可见的工作区 DTO（RPC 安全，不含本地文件系统路径）。
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;              // 由 rootPath 的 basename 计算出的短标识
  lastAccessedAt?: number;
  iconUrl?: string;
  mcpUrl?: string;
  mcpAuthType?: McpAuthType;
  remoteServer?: RemoteServerConfig;
}

/**
 * 完整工作区（包含服务器内部细节）。
 *
 * 仅供 server 代码和本地 Electron renderer（LOCAL_ONLY 通道）使用，
 * 不要通过 RPC 发给远程客户端，避免泄露本地路径。
 */
export interface Workspace extends WorkspaceInfo {
  rootPath: string;        // 本地工作区文件夹绝对路径（存元数据、配置）。远程工作区会自动创建。
  createdAt: number;
}

/**
 * AI provider 的认证类型。
 *
 * - api_key: Anthropic API key
 * - oauth_token: Anthropic Claude Max OAuth
 * - codex_oauth: ChatGPT Plus OAuth（通过 Codex app-server）
 * - codex_api_key: OpenAI API key（兼容 OpenRouter、Vercel AI Gateway）
 */
export type AuthType = 'api_key' | 'oauth_token' | 'codex_oauth' | 'codex_api_key';

/**
 * OAuth 认证流程完成后得到的临时凭证。
 *
 * UI 组件里的临时状态，最终要保存到凭证存储区（keychain/加密文件）。
 */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  tokenType: string;
}

/**
 * 存储在 JSON 文件里的配置（凭证单独存在加密文件，不在这里）。
 */
export interface StoredConfig {
  authType?: AuthType;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // 当前活动会话（主作用域）
  model?: string;
}


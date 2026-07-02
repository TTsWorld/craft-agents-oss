/**
 * Sources Module
 *
 * Source 管理模块的公开导出入口。
 */

// 类型
export type {
  SourceType,
  SourceMcpAuthType,
  ApiAuthType,
  KnownProvider,
  ApiOAuthProvider,
  ApiOAuthConfig,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConnectionStatus,
  FolderSourceConfig,
  SourceGuide,
  LoadedSource,
  CreateSourceInput,
  ApiRenewEndpoint,
} from './types.ts';

// 常量与辅助函数
export {
  API_OAUTH_PROVIDERS,
  isApiOAuthProvider,
  isGenericOAuthSource,
  hasRenewEndpoint,
  isRefreshableSource,
} from './types.ts';

// 存储相关函数
export {
  // 目录工具
  ensureSourcesDir,
  getSourcePath,
  // 配置读写
  loadSourceConfig,
  saveSourceConfig,
  markSourceAuthenticated,
  // guide 读写
  loadSourceGuide,
  saveSourceGuide,
  // 图标操作
  findSourceIcon,
  downloadSourceIcon,
  sourceNeedsIconDownload,
  isIconUrl,
  // 加载操作
  loadSource,
  loadWorkspaceSources,
  loadAllSources,
  getEnabledSources,
  isSourceUsable,
  getSourcesBySlugs,
  // 创建/删除操作
  generateSourceSlug,
  createSource,
  deleteSource,
  sourceExists,
  // 解析工具
  parseGuideMarkdown,
} from './storage.ts';

// 凭证管理器（统一凭证操作）
export {
  SourceCredentialManager,
  getSourceCredentialManager,
  getSourcesNeedingAuth,
} from './credential-manager.ts';
export type {
  AuthResult,
  ApiCredential,
  BasicAuthCredential,
} from './credential-manager.ts';

// Server Builder（从 source 构建 MCP/API server）
export {
  SourceServerBuilder,
  getSourceServerBuilder,
  normalizeMcpUrl,
  SERVER_BUILD_ERRORS,
} from './server-builder.ts';
export type {
  McpServerConfig,
  SourceWithCredential,
  BuiltServers,
} from './server-builder.ts';

// 内置 Source（每个 workspace 默认可用）
export {
  getDocsSource,
  getBuiltinSources,
  isBuiltinSource,
} from './builtin-sources.ts';

// API Tools（类型）
export type { SummarizeCallback } from './api-tools.ts';

// Token Refresh Manager（带速率限制的 OAuth token 刷新）
export {
  TokenRefreshManager,
  createTokenGetter,
} from './token-refresh-manager.ts';
export type {
  TokenRefreshResult,
  RefreshManagerOptions,
} from './token-refresh-manager.ts';

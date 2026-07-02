/**
 * 配置类型（浏览器安全）
 *
 * 这里只放类型定义，不依赖 Node.js API，因此可以在渲染进程使用。
 * 部分类型从 @craft-agent/core 重新导出，保持单一事实来源。
 */

// 从 core 重新导出配置相关类型，避免多处重复定义
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

/** 应用级网络代理配置。类似 Go struct 的 TS interface。 */
export interface NetworkProxySettings {
  /** 是否启用代理 */
  enabled: boolean;
  /** HTTP 代理地址 */
  httpProxy?: string;
  /** HTTPS 代理地址 */
  httpsProxy?: string;
  /** 不走代理的地址列表 */
  noProxy?: string;
}

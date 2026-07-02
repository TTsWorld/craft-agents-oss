/**
 * Claude 认证的共享 OAuth 配置
 *
 * 本文件是 Claude OAuth 所有设置的单一事实来源，
 * 换 token 和刷新 token 都应该用这里的值。
 */

/**
 * Claude OAuth 配置常量。
 * `as const` 让 TS 把每个字段推导为精确字面量类型。
 */
export const CLAUDE_OAUTH_CONFIG = {
  /**
   * Claude OAuth 的客户端 ID
   * 这是 PKCE 流程使用的公共客户端 ID
   */
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',

  /**
   * 授权 URL：用户在这里登录 Claude
   */
  AUTH_URL: 'https://claude.ai/oauth/authorize',

  /**
   * Token URL：用于换 code 和刷新 token
   * 同一个端点既处理 exchange 也处理 refresh
   */
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',

  /**
   * Redirect URI：OAuth 完成后跳转回这里
   * 必须和 OAuth provider 后台配置的完全一致
   */
  REDIRECT_URI: 'https://console.anthropic.com/oauth/code/callback',

  /**
   * OAuth 请求的 scope（权限范围）
   */
  SCOPES: 'org:create_api_key user:profile user:inference',
} as const;

/** Claude OAuth 配置类型 */
export type ClaudeOAuthConfig = typeof CLAUDE_OAUTH_CONFIG;

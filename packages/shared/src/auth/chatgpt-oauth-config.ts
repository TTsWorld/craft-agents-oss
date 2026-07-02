/**
 * ChatGPT / OpenAI OAuth 的共享配置
 *
 * 本文件是 ChatGPT/OpenAI OAuth 设置的单一事实来源，
 * 用于 Codex app-server 里的 `chatgptAuthTokens` 模式。
 *
 * 说明：这些值基于 Codex CLI 使用的 OpenAI OAuth 流程，
 * client_id 就是 Codex 浏览器 OAuth 的公共客户端 ID。
 */

/**
 * ChatGPT OAuth 配置常量对象。
 *
 * `as const` 是 TS 关键字：表示整个对象都是只读字面量，
 * 这样 typeof CHATGPT_OAUTH_CONFIG 可以精确推导出每个字段的字符串值，
 * 类似 Go 里用 const 定义一组字符串常量。
 */
export const CHATGPT_OAUTH_CONFIG = {
  /**
   * ChatGPT OAuth 的客户端 ID
   * 这是 OpenAI 为 Codex CLI 注册的公共客户端 ID
   */
  CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',

  /**
   * 授权 URL：用户在这里用 ChatGPT 账号登录
   * 注意：路径里必须包含 /oauth/
   */
  AUTH_URL: 'https://auth.openai.com/oauth/authorize',

  /**
   * Token URL：用于换 token 和刷新 token
   */
  TOKEN_URL: 'https://auth.openai.com/oauth/token',

  /**
   * Redirect URI：OAuth 完成后跳转回本地
   * 必须和 Codex CLI 在 OpenAI 注册的重定向 URI 一致（端口 1455）
   */
  REDIRECT_URI: 'http://localhost:1455/auth/callback',

  /**
   * OAuth 回调服务器默认端口
   * 必须和 Codex CLI 的端口一致（1455）
   */
  CALLBACK_PORT: 1455,

  /**
   * OAuth 请求的 scope（权限范围）
   * 这些 scope 用于通过 Codex 访问 ChatGPT Plus 功能
   */
  SCOPES: 'openid profile email offline_access',

  /**
   * OpenID Connect issuer，用于校验 token
   */
  ISSUER: 'https://auth.openai.com',

  /**
   * Audience，用于 token 校验
   */
  AUDIENCE: 'https://api.openai.com/v1',

  /**
   * 启用 Codex CLI 简化流程（为了兼容 Codex）
   */
  SIMPLIFIED_FLOW: true,

  /**
   * 在 ID token 中包含组织信息（为了兼容 Codex）
   */
  ADD_ORGANIZATIONS: true,
} as const;

/**
 * ChatGPT OAuth 配置类型：从 CHATGPT_OAUTH_CONFIG 推导而来。
 * 这样写配置类型不用手动重复每个字段。
 */
export type ChatGptOAuthConfig = typeof CHATGPT_OAUTH_CONFIG;

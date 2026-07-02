/**
 * 服务端主导的 OAuth prepare/exchange 流程的共享类型。
 *
 * 一个 OAuth 流程被拆成两半：
 * 1. prepare：服务端生成 authUrl + PKCE。
 * 2. exchange：服务端用授权码去换 token。
 * 客户端只负责打开浏览器并把授权码转发回来。
 */

/** 支持的 OAuth 提供商类型 */
export type OAuthProvider = 'mcp' | 'google' | 'slack' | 'microsoft' | 'generic'

/**
 * 服务端在 prepare 阶段生成的所有信息。
 * 会存入 OAuthFlowStore，后续 exchange 阶段再取出来用。
 */
export interface PreparedOAuthFlow {
  authUrl: string
  state: string
  // PKCE verifier；不使用 PKCE 的提供商（如 Slack）这里是空字符串
  codeVerifier: string
  tokenEndpoint: string
  clientId: string
  // Google 桌面应用需要 client_secret 才能换 token/刷新
  clientSecret?: string
  // 授权和换 token 时使用的回调地址
  redirectUri: string
  provider: OAuthProvider
}

/**
 * 用授权码换 token 时需要的参数。
 * 一部分来自 flow store（prepare 阶段写入），一部分来自客户端回调的 code。
 */
export interface OAuthExchangeParams {
  code: string
  codeVerifier: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  redirectUri: string
}

/**
 * 向提供商换 token 后的原始结果。
 * 这里包含真实 token，只有服务端能看到，不会返回给客户端。
 */
export interface OAuthExchangeResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  /** 用户/工作区标识（Google 邮箱、Slack teamName、Microsoft UPN） */
  email?: string
  /** 存储用的 OAuth client_id（MCP 动态注册时产生） */
  oauthClientId?: string
  /** 存储用的 OAuth client_secret（Google 刷新 token 需要） */
  oauthClientSecret?: string
  error?: string
}

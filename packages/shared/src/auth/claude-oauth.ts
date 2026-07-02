/**
 * 原生 Claude OAuth with PKCE
 *
 * 基于浏览器实现的 PKCE（Proof Key for Code Exchange）流程，
 * 这是公共客户端（桌面/移动应用）的标准安全流程，不需要 client secret。
 *
 * 参考实现：https://github.com/grll/claude-code-login
 */

import { randomBytes, createHash } from 'node:crypto'
import { CLAUDE_OAUTH_CONFIG } from './claude-oauth-config'
import { openUrl } from '../utils/open-url.ts'
import { APP_VERSION } from '../version/index.ts'
import { debug } from '../utils/debug.ts'

// 从共享配置里取出常量
const CLAUDE_CLIENT_ID = CLAUDE_OAUTH_CONFIG.CLIENT_ID
const CLAUDE_AUTH_URL = CLAUDE_OAUTH_CONFIG.AUTH_URL
const CLAUDE_TOKEN_URL = CLAUDE_OAUTH_CONFIG.TOKEN_URL
const REDIRECT_URI = CLAUDE_OAUTH_CONFIG.REDIRECT_URI
const OAUTH_SCOPES = CLAUDE_OAUTH_CONFIG.SCOPES
/** state 有效期：10 分钟 */
const STATE_EXPIRY_MS = 10 * 60 * 1000

/**
 * 从 token 响应里解析出的 Anthropic 身份信息（issue #838）。
 * 如果响应里没有这部分，也不会报错；缺失时 UI 里不展示身份即可。
 */
export interface ClaudeOAuthIdentity {
  account?: {
    uuid?: string
    emailAddress?: string
  }
  organization?: {
    uuid?: string
    name?: string
  }
}

/**
 * Claude token 结果，继承身份信息。
 */
export interface ClaudeTokens extends ClaudeOAuthIdentity {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[]
}

// 一次性守卫：进程内只打印一次 token 响应的 key（绝不打印 value），
// 用于确认 platform.claude.com 真实返回了哪些字段，避免反复重登时刷日志。
let loggedTokenResponseShape = false

/**
 * 把 token 响应里的原始 identity 块解析成 {@link ClaudeOAuthIdentity}。
 *
 * 优先读 `email_address`，没有则回退到 `email`（因为平台具体字段名尚未完全确认）。
 * 如果两个块都没有，返回空对象，这样用展开运算符 `...parseClaudeOAuthIdentity(data)` 时不会污染结果。
 */
export function parseClaudeOAuthIdentity(data: {
  account?: { uuid?: string; email_address?: string; email?: string }
  organization?: { uuid?: string; name?: string }
}): ClaudeOAuthIdentity {
  const identity: ClaudeOAuthIdentity = {}
  if (data.account) {
    identity.account = {
      uuid: data.account.uuid,
      emailAddress: data.account.email_address ?? data.account.email,
    }
  }
  if (data.organization) {
    identity.organization = {
      uuid: data.organization.uuid,
      name: data.organization.name,
    }
  }
  return identity
}

/**
 * 当前 OAuth 流程的状态：state、PKCE verifier、创建和过期时间。
 */
export interface ClaudeOAuthState {
  state: string
  codeVerifier: string
  timestamp: number
  expiresAt: number
}

// 当前 OAuth 流程的内存状态。注意：这不是服务端存储，仅用于单次本地登录。
let currentOAuthState: ClaudeOAuthState | null = null

/**
 * 生成一个密码学安全的 state 参数，防止 CSRF。
 */
function generateState(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 生成 PKCE verifier 和 challenge。
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return { codeVerifier, codeChallenge }
}

/**
 * 准备 OAuth 流程：生成 PKCE、state 和授权 URL。
 * 不打开浏览器——调用方自行决定在哪里打开。
 *
 * 返回的授权 URL 应该在用户机器上的浏览器打开（客户端），而不是服务端。
 */
export function prepareClaudeOAuth(): string {
  const state = generateState()
  const { codeVerifier, codeChallenge } = generatePKCE()

  const now = Date.now()
  currentOAuthState = {
    state,
    codeVerifier,
    timestamp: now,
    expiresAt: now + STATE_EXPIRY_MS,
  }

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })

  return `${CLAUDE_AUTH_URL}?${params.toString()}`
}

/**
 * 启动 OAuth 流程：生成登录 URL 并在本地打开浏览器。
 *
 * @deprecated 推荐用 prepareClaudeOAuth() 在客户端打开浏览器。
 * 本函数在服务端主机打开浏览器，在 remote 模式下会失败。
 */
export async function startClaudeOAuth(
  onStatus?: (message: string) => void
): Promise<string> {
  onStatus?.('Generating authentication URL...')

  const authUrl = prepareClaudeOAuth()

  // 在服务端主机打开浏览器（remote 模式下不可用）
  onStatus?.('Opening browser for authentication...')
  await openUrl(authUrl)

  onStatus?.('Waiting for you to copy the authorization code...')

  return authUrl
}

/**
 * 检查当前是否有未过期的 OAuth 流程在进行中。
 */
export function hasValidOAuthState(): boolean {
  if (!currentOAuthState) return false
  return Date.now() < currentOAuthState.expiresAt
}

/**
 * 获取当前 OAuth 状态（用于调试或展示）。
 */
export function getCurrentOAuthState(): ClaudeOAuthState | null {
  return currentOAuthState
}

/**
 * 清除当前 OAuth 状态。
 */
export function clearOAuthState(): void {
  currentOAuthState = null
}

/**
 * 用授权码换取 token。
 *
 * 在用户登录并从回调页复制授权码后调用。
 */
export async function exchangeClaudeCode(
  authorizationCode: string,
  onStatus?: (message: string) => void
): Promise<ClaudeTokens> {
  // 先校验本地是否有有效的 state
  if (!currentOAuthState) {
    throw new Error('No OAuth state found. Please start the authentication flow again.')
  }

  if (Date.now() > currentOAuthState.expiresAt) {
    clearOAuthState()
    throw new Error('OAuth state expired (older than 10 minutes). Please try again.')
  }

  // 清理授权码，去掉可能附带的 URL fragment 和多余参数
  const cleanedCode = authorizationCode.split('#')[0]?.split('&')[0] ?? authorizationCode

  onStatus?.('Exchanging authorization code for tokens...')

  const params = {
    grant_type: 'authorization_code',
    client_id: CLAUDE_CLIENT_ID,
    code: cleanedCode,
    redirect_uri: REDIRECT_URI,
    code_verifier: currentOAuthState.codeVerifier,
    state: currentOAuthState.state,
  }

  try {
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `CraftAgents/${APP_VERSION}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(params),
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage: string
      try {
        const errorJson = JSON.parse(errorText)
        errorMessage = errorJson.error_description || errorJson.error || errorText
      } catch {
        errorMessage = errorText
      }
      throw new Error(`Token exchange failed: ${response.status} - ${errorMessage}`)
    }

    const data = (await response.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      // 解析出的身份信息（issue #838），可选字段，防御性读取
      account?: { uuid?: string; email_address?: string; email?: string }
      organization?: { uuid?: string; name?: string }
    }

    // 运行时确认（issue #838）：每个进程只打印一次响应 KEY（绝不打印 value），
    // 确认 platform.claude.com 是否返回 account/organization 以及具体字段名。
    // Object.keys 不会泄漏敏感值。
    if (!loggedTokenResponseShape) {
      loggedTokenResponseShape = true
      debug('[claude-oauth] token response keys: ' + Object.keys(data).join(','))
      if (data.account) debug('[claude-oauth] account keys: ' + Object.keys(data.account).join(','))
      if (data.organization) debug('[claude-oauth] organization keys: ' + Object.keys(data.organization).join(','))
    }

    // 成功后清除本地 state
    clearOAuthState()

    onStatus?.('Authentication successful!')

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scopes: data.scope ? data.scope.split(' ') : ['user:inference', 'user:profile'],
      ...parseClaudeOAuthIdentity(data),
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Token exchange failed: ${String(error)}`)
  }
}

/**
 * 便捷函数：把 startClaudeOAuth 和 exchangeClaudeCode 组合起来，
 * 适用于通过回调提供授权码的场景。
 *
 * @deprecated 建议分开调用 startClaudeOAuth 和 exchangeClaudeCode
 */
export async function authenticateWithClaude(options?: {
  onStatus?: (message: string) => void
  getAuthorizationCode: () => Promise<string>
}): Promise<ClaudeTokens> {
  const onStatus = options?.onStatus
  const getAuthorizationCode = options?.getAuthorizationCode

  if (!getAuthorizationCode) {
    throw new Error('getAuthorizationCode callback is required')
  }

  await startClaudeOAuth(onStatus)
  const code = await getAuthorizationCode()
  return exchangeClaudeCode(code, onStatus)
}

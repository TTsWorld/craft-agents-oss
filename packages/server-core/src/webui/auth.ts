/**
 * auth.ts
 *
 * WebUI 的认证模块。职责非常聚焦：
 * - 登录：校验密码 → 签发 JWT → 写入 HttpOnly Cookie；
 * - 鉴权：每个 HTTP 请求和 WebSocket upgrade 都校验 Cookie；
 * - 限流：对 /api/auth 做基于 IP 的滑动窗口限流，防暴力破解。
 *
 * 与 Go 的类比：
 * - `signJwt` / `verifyJwt` 相当于 Go 里用 `github.com/golang-jwt/jwt` 签发/解析 token；
 * - `RateLimiter` 相当于一个内存版 `rate.Limiter`，用 Map 存储每个 IP 的窗口计数。
 *
 * TypeScript 要点：
 * - `export interface JwtPayload` 是类型声明，编译后会被擦除（类似 Go 的接口只在编译期存在）。
 * - `TextEncoder` 来自 Web 标准，Node/Bun 都支持，把字符串转成 Uint8Array 给 jose 用。
 * - `Bun.password.hash/verify` 是 Bun 运行时的内置 API，做 argon2id；
 *   类似 Go 的 `golang.org/x/crypto/argon2` + bcrypt 封装。
 *
 * Agent 开发关键点：
 * - WebUI 面向公网或内网浏览器，必须 HttpOnly + SameSite=Strict，降低 XSS 窃取风险；
 * - `initPasswordHash` 在启动时把明文哈希后只保留哈希，不保留明文；
 * - 限流器记得定期 `cleanup()`，否则长时间运行会积累大量过期 IP 条目。
 */

import { SignJWT, jwtVerify } from 'jose'

// ---------------------------------------------------------------------------
// JWT 辅助函数（基于 jose 库）
// ---------------------------------------------------------------------------

const JWT_EXPIRY_SECONDS = 86_400 // 24 小时

// JWT 载荷类型声明。TS 的 interface 只在编译期存在，类似 Go 的接口。
export interface JwtPayload {
  sub: string // 主题（subject），这里固定为 'webui'
  iat: number // 签发时间（issued at）
  exp: number // 过期时间（expiration）
}

/**
 * 签发 JWT。
 * 使用 HMAC-SHA256（HS256）签名，把 sub 写入 payload。
 */
export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub: payload.sub } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key)
}

/**
 * 校验 JWT。
 * 解析失败（过期、签名不对、格式错误）时返回 null，不抛异常。
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return {
      sub: payload.sub as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    }
  } catch {
    return null
  }
}

/**
 * 创建 WebUI 会话令牌。
 * sub 固定为 'webui'，有效期 24 小时。
 */
export async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ sub: 'webui', iat: now, exp: now + JWT_EXPIRY_SECONDS }, secret)
}

// ---------------------------------------------------------------------------
// Cookie 辅助函数
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'craft_session'

/**
 * 构造登录成功后的 Set-Cookie 头。
 * HttpOnly 防止 JS 读取，SameSite=Strict 降低 CSRF 风险。
 */
export function buildSessionCookie(jwt: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${jwt}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${JWT_EXPIRY_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 构造登出后的清空 Cookie 头。
 * Max-Age=0 让浏览器立即删除该 Cookie。
 */
export function buildLogoutCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 从 Cookie 头中提取会话 JWT。
 * 按分号拆分各键值对，找到 craft_session 对应的值。
 */
export function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE_NAME) return rest.join('=')
  }
  return null
}

// ---------------------------------------------------------------------------
// 密码校验（通过 Bun.password 使用 argon2id）
// ---------------------------------------------------------------------------

// 内存中保存的密码哈希。模块级变量，类似 Go 包级变量。
let hashedPassword: string | null = null

/**
 * 启动时把明文密码哈希后保存在内存中。
 * 必须在任何认证请求之前调用；调用后不再保留明文。
 */
export async function initPasswordHash(plaintext: string): Promise<void> {
  hashedPassword = await Bun.password.hash(plaintext, { algorithm: 'argon2id' })
}

/**
 * 校验用户输入的密码是否与内存中的哈希匹配。
 * 使用 Bun 内置的 argon2id 校验（恒定时间比较）。
 */
export async function verifyPassword(input: string): Promise<boolean> {
  if (!hashedPassword) return false
  return Bun.password.verify(input, hashedPassword)
}

// ---------------------------------------------------------------------------
// 限流器（单 IP + 全局，滑动窗口）
// ---------------------------------------------------------------------------

// 单个 IP 的限流记录
interface RateLimitEntry {
  attempts: number // 当前窗口内尝试次数
  windowStart: number // 窗口开始时间戳
}

export class RateLimiter {
  // Map 相当于 Go 的 map[string]*RateLimitEntry，这里存每个 IP 的计数
  private entries = new Map<string, RateLimitEntry>()
  private readonly maxAttempts: number // 单 IP 窗口内最大尝试次数
  private readonly windowMs: number // 窗口时长（毫秒）
  /** 全局计数器 —— 总失败次数过多时阻断所有 IP（防御 IP 伪造）。 */
  private readonly maxGlobalAttempts: number
  private globalAttempts = 0
  private globalWindowStart = Date.now()

  constructor(maxAttempts = 5, windowMs = 60_000, maxGlobalAttempts = 20) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxGlobalAttempts = maxGlobalAttempts
  }

  /** 返回 true 表示允许请求，false 表示触发限流。 */
  check(ip: string): boolean {
    const now = Date.now()

    // 若全局窗口过期则重置
    if (now - this.globalWindowStart > this.windowMs) {
      this.globalAttempts = 0
      this.globalWindowStart = now
    }

    // 全局限流 —— 总尝试次数过多时阻断所有 IP
    this.globalAttempts++
    if (this.globalAttempts > this.maxGlobalAttempts) return false

    // 单 IP 限流
    const entry = this.entries.get(ip)

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { attempts: 1, windowStart: now })
      return true
    }

    entry.attempts++
    if (entry.attempts > this.maxAttempts) return false
    return true
  }

  /** 定期清理过期条目（需配合定时器调用）。 */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(ip)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 会话校验器（HTTP 和 WebSocket 共用）
// ---------------------------------------------------------------------------

/**
 * 校验 HTTP / WebSocket 请求中的会话 Cookie。
 * 提取 JWT 后用密钥验证，失败返回 null。
 */
export async function validateSession(
  cookieHeader: string | null,
  secret: string,
): Promise<JwtPayload | null> {
  const token = extractSessionCookie(cookieHeader)
  if (!token) return null
  return verifyJwt(token, secret)
}

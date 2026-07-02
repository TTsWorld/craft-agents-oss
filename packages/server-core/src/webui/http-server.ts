/**
 * http-server.ts
 *
 * WebUI 的 HTTP 处理核心。设计目标是“一个 handler，两种部署”：
 * 1. 内嵌模式：通过 `nodeHttpAdapter` 挂到 WsRpcServer 的 HTTPS 服务器上，
 *    HTTP 和 WSS 共享同一端口；
 * 2. 独立模式：用 `Bun.serve({ fetch })` 单独跑一个 HTTP 端口。
 *
 * 核心工厂是 `createWebuiHandler()`，返回 web 标准的 `(Request) => Promise<Response>`。
 * 这种写法不绑定具体运行时，既能在 Bun 跑，也能通过 adapter 在 Node 跑。
 *
 * 与 Go 的类比：
 * - 如果把 `createWebuiHandler` 看作 `http.Handler`，那 `fetch` 就是它的
 *   `ServeHTTP` 等价物；`WebuiHandler` 接口相当于一个带 Dispose 方法的 handler。
 * - `Bun.serve()` 类似 `http.ListenAndServe`；`Response.json()`、`new Response(file)`
 *   类似 `http.Error` / `http.ServeFile`。
 *
 * TypeScript 要点：
 * - `Response` / `Request` / `Headers` 是 Web 标准 API，Bun 和 Node 18+ 都支持。
 * - `Bun.file(path)` 是 Bun 提供的零拷贝文件读取，返回一个 Blob-like 对象。
 * - `options?: WebuiHandlerOptions` 里的 `?` 表示可选参数，类似 Go 中不传指针的区别。
 *
 * Agent 开发关键点：
 * - `/health` 不鉴权，供负载均衡 / 容器探针使用；
 * - `/api/oauth/callback` 用 OAuth state 做 CSRF 保护，而不是 Cookie；
 * - 静态文件 serve 后 fallback 到 `index.html`，这是单页应用（SPA）的标准行为；
 * - `trustedProxies` 控制是否信任 `x-forwarded-*` 头，生产环境必须显式配置，
 *   否则容易被伪造 IP 绕过限流。
 */

import { join, extname } from 'node:path'
import {
  RateLimiter,
  initPasswordHash,
  verifyPassword,
  createSessionToken,
  validateSession,
  buildSessionCookie,
  buildLogoutCookie,
} from './auth'
import { generateCallbackPage } from '@craft-agent/shared/auth'
import type { PlatformServices } from '../runtime/platform'

// ---------------------------------------------------------------------------
// 静态文件服务的 MIME 类型映射
// ---------------------------------------------------------------------------

// Record<string, string> 表示“字符串键到字符串值”的字典，类似 Go 的 map[string]string
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.map': 'application/json',
}

/** 根据文件扩展名返回 MIME 类型；找不到则返回二进制流默认类型。 */
function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 从 RFC 7239 Forwarded 头中解析 proto 或 host。 */
function getForwardedValue(req: Request, key: 'proto' | 'host'): string | null {
  const forwarded = req.headers.get('forwarded')
  if (!forwarded) return null

  const match = forwarded.match(new RegExp(`${key}="?([^;,"]+)"?`, 'i'))
  // `match?.[1]?.trim()` 是可选链：match 为 null 或没有捕获组时短路返回 undefined
  return match?.[1]?.trim() || null
}

/** 判断当前请求协议：优先信任 x-forwarded-proto / Forwarded，否则用 URL 自带协议。 */
function getRequestProto(req: Request): string {
  return req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'proto')
    || new URL(req.url).protocol.replace(/:$/, '')
}

/** 获取请求主机名：优先信任 x-forwarded-host / Forwarded，否则用 host 头。 */
function getRequestHost(req: Request): string | null {
  return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'host')
    || req.headers.get('host')
}

/** 把 host 和 WebSocket 端口组合成带端点的地址；支持 IPv6。 */
function formatHostWithPort(host: string, port: number): string {
  try {
    const parsed = new URL(`http://${host}`)
    const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
    return `${hostname}:${port}`
  } catch {
    const withoutPort = host.replace(/:\d+$/, '')
    return `${withoutPort}:${port}`
  }
}

/**
 * 决定是否给 Cookie 加 Secure 标记。
 * 如果调用方显式传入 secureCookies 则直接采用；否则根据请求协议推断。
 */
export function shouldUseSecureCookies(req: Request, secureCookies?: boolean): boolean {
  if (secureCookies != null) return secureCookies
  return getRequestProto(req) === 'https'
}

export interface ResolveWebSocketUrlOptions {
  publicWsUrl?: string // 浏览器侧 WebSocket URL 覆盖值
  wsProtocol: 'ws' | 'wss' // 回退协议
  wsPort: number // 回退端口
}

/**
 * 解析浏览器应该连接的 WebSocket URL。
 * 如果有 publicWsUrl 直接用；否则根据请求 host 拼接。
 */
export function resolveWebSocketUrl(
  req: Request,
  { publicWsUrl, wsProtocol, wsPort }: ResolveWebSocketUrlOptions,
): string {
  if (publicWsUrl) return publicWsUrl

  const host = getRequestHost(req)
  if (host) {
    return `${wsProtocol}://${formatHostWithPort(host, wsPort)}`
  }

  return `${wsProtocol}://127.0.0.1:${wsPort}`
}

// ---------------------------------------------------------------------------
// Handler 配置（内嵌模式和独立模式共用）
// ---------------------------------------------------------------------------

/** /api/oauth/callback 路由的依赖（服务端完成 OAuth 流程所需）。 */
export interface OAuthCallbackDeps {
  flowStore: { getByState: (state: string) => any; remove: (state: string) => void }
  credManager: { exchangeAndStore: (...args: any[]) => Promise<any> }
  sessionManager: { completeAuthRequest: (...args: any[]) => Promise<void> }
  pushSourcesChanged: (workspaceId: string) => void
}

/** createWebuiHandler 的完整配置项。 */
export interface WebuiHandlerOptions {
  /** 构建后的 Web UI 目录（dist/）路径。 */
  webuiDir: string
  /** 签发 JWT 用的密钥，通常就是 CRAFT_SERVER_TOKEN。 */
  secret: string
  /** 可选的独立 Web UI 密码；未设置时回退用 secret 校验。 */
  password?: string
  /** 显式覆盖 Secure Cookie 标记；未设置时根据请求协议/代理头推断。 */
  secureCookies?: boolean
  /** 反向代理场景下，可覆盖浏览器看到的 WebSocket URL。 */
  publicWsUrl?: string
  /** 构建浏览器侧回退 URL 时使用的 RPC WebSocket 协议。 */
  wsProtocol: 'ws' | 'wss'
  /** 构建浏览器侧回退 URL 时使用的 RPC WebSocket 端口。 */
  wsPort: number
  /** 健康检查函数（由上层服务器注入）。 */
  getHealthCheck: () => { status: string }
  /** 日志器。 */
  logger: PlatformServices['logger']
  /** OAuth 回调依赖；提供后才会启用 /api/oauth/callback 路由。 */
  oauthCallbackDeps?: OAuthCallbackDeps
  /**
   * 可信代理 IP/CIDR 列表。
   * 设置后，仅当来源在这些范围内时才信任 x-forwarded-* 等代理头；
   * 为空/未设置时忽略代理头，限流键使用 'direct'。
   */
  trustedProxies?: string[]
}

// ---------------------------------------------------------------------------
// Handler 工厂 —— 核心请求处理器
// ---------------------------------------------------------------------------

/** createWebuiHandler 返回的对象：一个 Web 标准 fetch handler + 生命周期方法。 */
export interface WebuiHandler {
  /** Web 标准 fetch handler。 */
  fetch: (req: Request) => Promise<Response>
  /** 关闭时调用，释放定时器等资源。 */
  dispose: () => void
  /** 启动后延迟注入 OAuth 回调依赖。 */
  setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => void
}

/**
 * 创建 WebUI 的 Web 标准 fetch handler。
 *
 * 可直接用于 `Bun.serve({ fetch })`，
 * 也可通过 `nodeHttpAdapter()` 适配到 Node 的 HTTP 服务器。
 */
export function createWebuiHandler(options: WebuiHandlerOptions): WebuiHandler {
  const {
    webuiDir,
    secret,
    password,
    secureCookies,
    publicWsUrl,
    wsProtocol,
    wsPort,
    getHealthCheck,
    logger,
    trustedProxies,
  } = options

  const rateLimiter = new RateLimiter(5, 60_000)
  // 每 2 分钟清理一次限流器里的过期 IP 记录，防止内存无限增长
  const cleanupTimer = setInterval(() => rateLimiter.cleanup(), 120_000)

  const loginPassword = password || secret
  const trustedProxySet = new Set(trustedProxies ?? [])

  // 启动时异步哈希登录密码；实际在第一次认证前通常已完成
  const passwordReady = initPasswordHash(loginPassword)

  /** 提取客户端 IP —— 仅在配置了 trustedProxies 时才信任代理头。 */
  function getClientIp(req: Request): string {
    if (trustedProxySet.size > 0) {
      return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('x-real-ip')
        ?? 'direct'
    }
    return 'direct'
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const useSecureCookies = shouldUseSecureCookies(req, secureCookies)

    // ── 健康检查端点（无需鉴权）──
    if (path === '/health') {
      const health = getHealthCheck()
      return Response.json(health, {
        status: health.status === 'ok' ? 200 : 503,
      })
    }

    // ── 登录页（无需鉴权）──
    if (path === '/login' || path === '/login/') {
      const loginFile = Bun.file(join(webuiDir, 'login.html'))
      if (await loginFile.exists()) {
        return new Response(loginFile, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
      return new Response('Login page not found', { status: 404 })
    }

    // ── 登录页所需的静态资源（无需鉴权）──
    if (path === '/favicon.ico' || path.startsWith('/login-assets/')) {
      const file = Bun.file(join(webuiDir, path))
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': getMimeType(path) },
        })
      }
      return new Response('Not Found', { status: 404 })
    }

    // ── 认证端点 ──
    if (path === '/api/auth' && req.method === 'POST') {
      await passwordReady
      const ip = getClientIp(req)

      if (!rateLimiter.check(ip)) {
        logger.warn(`[webui] Rate limited auth attempt from ${ip}`)
        return Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429 },
        )
      }

      let body: { password?: string }
      try {
        // `as` 是 TS 类型断言：告诉编译器 req.json() 的结构符合预期
        body = await req.json() as { password?: string }
      } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
      }

      if (!body.password || typeof body.password !== 'string') {
        return Response.json({ error: 'Password is required' }, { status: 400 })
      }

      if (!await verifyPassword(body.password)) {
        logger.warn(`[webui] Failed auth attempt from ${ip}`)
        return Response.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      const jwt = await createSessionToken(secret)
      logger.info(`[webui] Successful auth from ${ip}`)

      return Response.json({ ok: true }, {
        status: 200,
        headers: {
          'Set-Cookie': buildSessionCookie(jwt, useSecureCookies),
        },
      })
    }

    // ── 登出端点 ──
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return new Response(null, {
        status: 204,
        headers: {
          'Set-Cookie': buildLogoutCookie(useSecureCookies),
        },
      })
    }

    // ── OAuth 回调（不依赖 Cookie 鉴权 —— state 参数用于防御 CSRF）──
    // 接收 relay（或 MCP source 直连 OAuth provider）的 redirect，
    // 在服务端完成 token 交换，并渲染成功/失败页面。
    if (path === '/api/oauth/callback' && req.method === 'GET' && options.oauthCallbackDeps) {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        const flow = state ? options.oauthCallbackDeps.flowStore.getByState(state) : null
        if (flow && state) options.oauthCallbackDeps.flowStore.remove(state)
        const errorMsg = errorDescription || error
        logger.warn(`[webui] OAuth callback error: ${errorMsg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: errorMsg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      if (!code || !state) {
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: 'Missing code or state parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      try {
        const { completeOAuthFlow } = await import('../handlers/rpc/oauth')
        const result = await completeOAuthFlow({
          code,
          state,
          flowStore: options.oauthCallbackDeps.flowStore,
          credManager: options.oauthCallbackDeps.credManager as any,
          sessionManager: options.oauthCallbackDeps.sessionManager,
          pushSourcesChanged: options.oauthCallbackDeps.pushSourcesChanged,
          logger,
          // HTTP 回调不传 clientId/workspaceId，靠 state 做鉴权，跳过所有权检查
        })

        if (result.success) {
          return new Response(generateCallbackPage({ title: 'Authorization Successful', isSuccess: true }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        } else {
          return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: result.error }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Token exchange failed'
        logger.error(`[webui] OAuth callback failed: ${msg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: msg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
    }

    // ── 配置端点（需要会话 Cookie）──
    if (path === '/api/config' && req.method === 'GET') {
      const configSession = await validateSession(req.headers.get('cookie'), secret)
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort }),
      })
    }

    // 返回默认 workspace ID，供 webui 在 WS 握手时使用
    if (path === '/api/config/workspaces' && req.method === 'GET') {
      const configSession = await validateSession(req.headers.get('cookie'), secret)
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const { getActiveWorkspace } = await import('@craft-agent/shared/config/storage')
      const active = getActiveWorkspace()
      return Response.json({
        // `??` 是空值合并运算符：active?.id 为 null/undefined 时返回 null
        defaultWorkspaceId: active?.id ?? null,
      })
    }

    // ── 以下所有路由都需要有效的会话 Cookie ──
    const cookieHeader = req.headers.get('cookie')
    const session = await validateSession(cookieHeader, secret)

    if (!session) {
      const accept = req.headers.get('accept') ?? ''
      if (accept.includes('text/html') || path === '/' || path === '') {
        return Response.redirect('/login', 302)
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── 提供 SPA 静态文件 ──
    if (path !== '/') {
      const file = Bun.file(join(webuiDir, path))
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Type': getMimeType(path) },
        })
      }
    }

    // SPA fallback —— 所有不匹配文件的路由都返回 index.html
    const indexFile = Bun.file(join(webuiDir, 'index.html'))
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not Found', { status: 404 })
  }

  return {
    fetch,
    dispose: () => clearInterval(cleanupTimer),
    setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => {
      options.oauthCallbackDeps = deps
    },
  }
}

// ---------------------------------------------------------------------------
// 独立服务器（向后兼容，使用 Bun.serve）
// ---------------------------------------------------------------------------

export interface WebuiHttpServerOptions extends WebuiHandlerOptions {
  /** 绑定的端口；测试时传 0 表示使用临时端口。 */
  port: number
}

/**
 * 启动独立的 WebUI HTTP 服务器。
 * 基于 Bun.serve，适合不依赖已有 WsRpcServer 的场景。
 */
export async function startWebuiHttpServer(
  options: WebuiHttpServerOptions,
): Promise<{ port: number, stop: () => void }> {
  const { port, logger, ...handlerOpts } = options
  const handler = createWebuiHandler({ ...handlerOpts, logger })

  const server = Bun.serve({
    port,
    fetch: handler.fetch,
  })

  const boundPort = server.port ?? port
  logger.info(`[webui] Web UI server listening on http://0.0.0.0:${boundPort}`)

  return {
    port: boundPort,
    stop: () => {
      handler.dispose()
      server.stop()
    },
  }
}

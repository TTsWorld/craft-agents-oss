/**
 * 无头服务器启动与生命周期管理。
 *
 * 这个文件是 `packages/server/src/index.ts` 的底层支撑，相当于 Golang 项目里的 `internal/bootstrap`：
 * - 校验 server token 熵
 * - 管理启动锁文件，防止多实例冲突
 * - 初始化全局配置
 * - 创建 platform、session manager、WS RPC server
 * - 注册 RPC handler、启动模型刷新服务
 * - 提供 HTTP 健康检查端点
 * - 提供优雅关闭
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { join } from 'node:path'
import { OAuthFlowStore } from '@craft-agent/shared/auth'
import { ensureConfigDir, loadStoredConfig, saveConfig } from '@craft-agent/shared/config'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils'
import { WsRpcServer, type WsRpcTlsOptions } from '../transport/server'
import type { EventSink, RpcServer } from '../transport/types'
import { createHeadlessPlatform } from '../runtime/platform-headless'
import type { PlatformServices } from '../runtime/platform'

/**
 * 模型刷新服务的最小接口。
 *
 * 服务器启动后会调用 startAll()，关闭时调用 stopAll()。
 * 具体实现来自 server-core/model-fetchers。
 */
interface ModelRefreshServiceLike {
  startAll(): void
  stopAll?(): void
}

/**
 * 启动服务器需要的配置项。
 *
 * 用泛型 TSessionManager / THandlerDeps 是为了让 Electron 和无头模式可以复用同一套启动逻辑，
 * 但传入各自不同的 SessionManager 和 handler 依赖。
 */
export interface ServerBootstrapOptions<TSessionManager, THandlerDeps> {
  serverToken?: string
  rpcHost?: string
  rpcPort?: number
  bundledAssetsRoot?: string
  platformFactory?: () => PlatformServices
  applyPlatformToSubsystems?: (platform: PlatformServices) => void
  createSessionManager: () => TSessionManager
  createHandlerDeps: (ctx: {
    sessionManager: TSessionManager
    platform: PlatformServices
    oauthFlowStore: OAuthFlowStore
  }) => THandlerDeps
  registerAllRpcHandlers: (server: RpcServer, deps: THandlerDeps, serverCtx: ServerHandlerContext) => void
  initializeSessionManager: (sessionManager: TSessionManager) => Promise<void>
  setSessionEventSink: (sessionManager: TSessionManager, sink: EventSink) => void
  /**
   * WS RPC server 开始监听后的回调。
   * 通常用来把 server 实例设置给 SessionManager，以激活 client:browser:invoke 远程桥接。
   */
  bindRpcServer?: (sessionManager: TSessionManager, server: RpcServer) => void
  initModelRefreshService: () => ModelRefreshServiceLike
  cleanupSessionManager?: (sessionManager: TSessionManager) => Promise<void> | void
  cleanupClientResources?: (clientId: string) => void
  onClientConnected?: (info: { clientId: string; webContentsId: number | null; workspaceId: string | null; capabilities: string[] }) => void
  serverId?: string
  /** 应用版本，握手时返回给客户端做兼容性检查 */
  serverVersion?: string
  /** TLS 配置，提供后监听 wss:// */
  tls?: WsRpcTlsOptions
  /** WebUI cookie 校验器，用于 WebSocket upgrade 时的认证 */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /**
   * 非 WebSocket HTTP 请求处理器。
   * 提供后 WsRpcServer 会在同一端口上处理 HTTP（如 WebUI）。
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

/**
 * 服务器级 RPC handler 上下文。
 */
export interface ServerHandlerContext {
  getConnectedClientCount: () => number
  serverId: string
  startedAt: number
}

/**
 * bootstrapServer 返回的实例。
 */
export interface ServerInstance<TSessionManager> {
  platform: PlatformServices
  sessionManager: TSessionManager
  wsServer: WsRpcServer
  oauthFlowStore: OAuthFlowStore
  host: string
  port: number
  protocol: 'ws' | 'wss'
  token: string
  serverHandlerContext: ServerHandlerContext
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Token 熵值校验
// ---------------------------------------------------------------------------

/** 可接受的最小 server token 长度；低于此值直接拒绝启动。 */
const MIN_TOKEN_LENGTH = 16

/**
 * 校验 server token 是否足够强。
 *
 * 在服务器接受任何连接前就拒绝弱 token，避免安全问题。
 * 返回 ok/warning/error 三种状态：
 * - ok=false：直接拒绝启动
 * - ok=true + warning：允许启动但给出警告
 * - ok=true：通过
 */
function validateTokenEntropy(token: string): { ok: boolean; warning?: string; error?: string } {
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, error: `Token too short (${token.length} chars, minimum ${MIN_TOKEN_LENGTH}). Use a cryptographically random value.` }
  }

  // 拒绝单个字符重复
  if (new Set(token).size === 1) {
    return { ok: false, error: 'Token has zero entropy (single repeated character).' }
  }

  // 低唯一字符数给出警告（如 "abcabcabc..."）
  const uniqueChars = new Set(token).size
  if (uniqueChars < 8) {
    return { ok: true, warning: `Token has low entropy (${uniqueChars} unique characters). Consider using a stronger token.` }
  }

  return { ok: true }
}

/**
 * 生成服务器认证 token。
 *
 * 使用 Web Crypto API 生成 24 字节随机数，转成 48 位十六进制字符串，
 * 熵值 192 位，足够作为 bearer token。
 */
export function generateServerToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// 启动锁文件（防止同一配置目录下多个 server 实例同时运行）
// ---------------------------------------------------------------------------

/** 启动锁文件路径，放在配置目录下用于防止多实例并发启动。 */
const LOCK_FILE = join(CONFIG_DIR, '.server.lock')

/**
 * 锁文件里存储的信息。
 *
 * 保存 PID 和启动时间，用来判断锁是否来自当前进程、已死亡进程，或被复用的 PID。
 */
interface LockPayload {
  pid: number
  startedAt: number
}

/**
 * 判断进程是否存活。
 *
 * process.kill(pid, 0) 是 POSIX 小技巧：不发送实际信号，只检查进程是否存在。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 解析锁文件内容。
 *
 * 兼容新版 JSON 格式 `{pid, startedAt}` 和旧版纯 PID 格式。
 */
function parseLockContent(raw: string): LockPayload | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
      const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
      if (!isNaN(pid)) return { pid, startedAt }
    } catch { /* 继续按旧版解析 */ }
  }
  const pid = parseInt(trimmed, 10)
  if (!isNaN(pid)) return { pid, startedAt: 0 }
  return null
}

/**
 * 判断锁文件是否来自上一次系统启动之前。
 *
 * 如果锁的 startedAt 早于当前系统启动时间，说明 PID 已被操作系统复用给无关进程。
 */
function isLockFromPreviousBoot(startedAt: number): boolean {
  if (startedAt <= 0) return false
  const bootTime = Date.now() - osUptime() * 1000
  return startedAt < bootTime
}

/**
 * 获取服务器启动锁。
 *
 * 逻辑类似 Golang 的 `flock` 或单例模式：
 * - 锁文件存在且对应进程存活：拒绝启动
 * - 锁文件存在但对应 PID 是容器重启后的复用：覆盖
 * - 锁文件损坏：覆盖
 */
function acquireServerLock(logger: PlatformServices['logger']): void {
  if (existsSync(LOCK_FILE)) {
    try {
      const content = readFileSync(LOCK_FILE, 'utf-8')
      const lock = parseLockContent(content)

      if (lock) {
        // Docker 里 PID 1 会被容器复用，如果锁里就是当前 PID，说明是旧容器残留
        if (lock.pid === process.pid) {
          logger.warn(`[bootstrap] Lock file holds current PID ${lock.pid} (stale from previous container lifecycle), overwriting`)
        } else if (isProcessAlive(lock.pid)) {
          if (isLockFromPreviousBoot(lock.startedAt)) {
            logger.warn(`[bootstrap] Lock PID ${lock.pid} is alive but lock predates current boot (stale due to PID reuse), overwriting`)
          } else {
            throw new Error(
              `Another server instance is already running (PID ${lock.pid}). ` +
              `If this is stale, delete ${LOCK_FILE} and retry. ` +
              `To run a parallel instance (e.g. for dev), set CRAFT_CONFIG_DIR to a different path.`
            )
          }
        } else {
          logger.warn(`[bootstrap] Stale lock file found (PID ${lock.pid}), overwriting`)
        }
      } else {
        logger.warn('[bootstrap] Could not parse lock file, overwriting')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Another server instance')) throw err
      logger.warn('[bootstrap] Could not read lock file, overwriting')
    }
  }

  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() }
  writeFileSync(LOCK_FILE, JSON.stringify(payload), 'utf-8')

  // 意外退出时尽量释放锁（SIGKILL 等无法捕获，尽力而为）
  process.on('exit', () => { releaseServerLock() })
}

/**
 * 释放启动锁。
 *
 * 导出给 Electron 的 before-quit handler 直接调用，不必走 instance.stop()。
 */
export function releaseServerLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const lock = parseLockContent(readFileSync(LOCK_FILE, 'utf-8'))
      if (lock && lock.pid === process.pid) {
        unlinkSync(LOCK_FILE)
      }
    }
  } catch {
    // 尽力清理
  }
}

// ---------------------------------------------------------------------------
// 配置产物初始化
// ---------------------------------------------------------------------------

/**
 * 初始化配置目录相关的产物。
 *
 * 确保配置目录存在，供后续全局配置、锁文件等使用。
 */
function bootstrapConfigArtifacts(platform: PlatformServices): void {
  ensureConfigDir()
  platform.logger.info('[bootstrap] Config artifacts initialized')
}

/**
 * 如果全局配置不存在，写入一份默认空配置。
 *
 * 对应 Golang 里“若配置文件不存在则初始化默认值”的常见做法。
 */
function ensureGlobalConfigExists(platform: PlatformServices): void {
  const config = loadStoredConfig()
  if (config) {
    platform.logger.info('[bootstrap] Global config found')
    return
  }

  saveConfig({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  })
  platform.logger.info('[bootstrap] Initialized missing global config')
}

/**
 * 启动服务器主函数。
 *
 * 流程：
 * 1. 校验 server token
 * 2. 创建 platform（无头模式默认用 headless platform）
 * 3. 设置 bundled assets 根目录
 * 4. 把 platform 注入子系统
 * 5. 初始化配置目录和全局配置
 * 6. 获取启动锁
 * 7. 创建 SessionManager 和模型刷新服务
 * 8. 创建并启动 WsRpcServer
 * 9. 创建 handler 依赖并注册 RPC handler
 * 10. 设置 session 事件 sink
 * 11. 初始化 SessionManager
 * 12. 启动模型刷新服务
 */
export async function bootstrapServer<TSessionManager, THandlerDeps>(
  options: ServerBootstrapOptions<TSessionManager, THandlerDeps>,
): Promise<ServerInstance<TSessionManager>> {
  const serverToken = options.serverToken ?? process.env.CRAFT_SERVER_TOKEN
  if (!serverToken) {
    throw new Error('Server token is required. Pass options.serverToken or set CRAFT_SERVER_TOKEN.')
  }

  const entropy = validateTokenEntropy(serverToken)
  if (!entropy.ok) {
    throw new Error(`Weak server token: ${entropy.error}`)
  }

  const platform = options.platformFactory?.() ?? createHeadlessPlatform({ appVersion: options.serverVersion })

  const bundledAssetsRoot = options.bundledAssetsRoot
    ?? process.env.CRAFT_BUNDLED_ASSETS_ROOT
    ?? process.cwd()
  setBundledAssetsRoot(bundledAssetsRoot)

  if (entropy.warning) {
    platform.logger.warn(`[bootstrap] ${entropy.warning}`)
  }

  options.applyPlatformToSubsystems?.(platform)

  bootstrapConfigArtifacts(platform)
  ensureGlobalConfigExists(platform)
  acquireServerLock(platform.logger)

  const modelRefreshService = options.initModelRefreshService()
  const sessionManager = options.createSessionManager()

  const rpcHost = options.rpcHost ?? process.env.CRAFT_RPC_HOST ?? '127.0.0.1'
  const rpcPortRaw = options.rpcPort ?? parseInt(process.env.CRAFT_RPC_PORT ?? '9100', 10)
  if (!Number.isFinite(rpcPortRaw) || rpcPortRaw < 0 || rpcPortRaw > 65535) {
    throw new Error(`Invalid RPC port: ${rpcPortRaw}`)
  }
  const rpcPort = Math.trunc(rpcPortRaw)

  // 创建 WebSocket RPC 服务器
  const wsServer = new WsRpcServer({
    host: rpcHost,
    port: rpcPort,
    requireAuth: true,
    validateToken: async (t) => t === serverToken,
    validateSessionCookie: options.validateSessionCookie,
    serverId: options.serverId ?? 'headless',
    serverVersion: options.serverVersion,
    tls: options.tls,
    httpHandler: options.httpHandler,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: (clientId) => {
      options.cleanupClientResources?.(clientId)
      // 用 duck typing 通知 SessionManager 断开连接，因为这里是泛型层
      const smWithDisconnect = sessionManager as unknown as { onClientDisconnected?: (id: string) => void }
      if (typeof smWithDisconnect.onClientDisconnected === 'function') {
        try {
          smWithDisconnect.onClientDisconnected(clientId)
        } catch {
          // 清理钩子失败不能破坏传输层
        }
      }
    },
  })

  await wsServer.listen()

  options.bindRpcServer?.(sessionManager, wsServer)

  const oauthFlowStore = new OAuthFlowStore()

  const deps = options.createHandlerDeps({
    sessionManager,
    platform,
    oauthFlowStore,
  })

  const startedAt = Date.now()
  const serverHandlerContext: ServerHandlerContext = {
    getConnectedClientCount: () => wsServer.getConnectedClientCount(),
    serverId: options.serverId ?? 'headless',
    startedAt,
  }

  options.registerAllRpcHandlers(wsServer, deps, serverHandlerContext)

  options.setSessionEventSink(sessionManager, wsServer.push.bind(wsServer))

  await options.initializeSessionManager(sessionManager)

  modelRefreshService.startAll()

  platform.logger.info(`Craft Agent server listening on ${wsServer.protocol}://${rpcHost}:${wsServer.port}`)

  // ---------- 优雅关闭 ----------
  // 用一个标志位保证 stop() 幂等，多次调用只执行一次清理流程。
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    platform.logger.info('Shutting down...')

    // 关闭前通知所有客户端
    try {
      wsServer.push('server:shuttingDown', { to: 'all' }, {
        reason: 'shutdown',
        graceMs: 2000,
        timestamp: Date.now(),
      })
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to send shutdown notification:', error)
    }

    try {
      modelRefreshService.stopAll?.()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to stop model refresh service:', error)
    }

    try {
      await options.cleanupSessionManager?.(sessionManager)
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to clean up session manager:', error)
    }

    try {
      wsServer.close()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to close WS server:', error)
    }

    try {
      oauthFlowStore.dispose()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to dispose OAuth flow store:', error)
    }

    releaseServerLock()
  }

  return {
    platform,
    sessionManager,
    wsServer,
    oauthFlowStore,
    host: rpcHost,
    port: wsServer.port,
    protocol: wsServer.protocol,
    token: serverToken,
    serverHandlerContext,
    stop,
  }
}

// ---------------------------------------------------------------------------
// HTTP 健康检查端点（可选，供负载均衡器 / k8s probe 使用）
// ---------------------------------------------------------------------------

export interface HealthHttpServerOptions {
  port: number
  deps: { sessionManager: { getWorkspaces(): unknown[] } }
  wsServer: WsRpcServer
  platform: PlatformServices
}

/**
 * 启动一个最小 HTTP 健康检查服务。
 *
 * 只有 port > 0 时才启动；返回 stop 函数用于清理。
 * 仅在 Bun 环境下使用 Bun.serve，Node/Electron 不需要 HTTP 健康检查。
 */
export async function startHealthHttpServer(options: HealthHttpServerOptions): Promise<{ stop: () => void } | null> {
  if (options.port <= 0) return null

  const { getHealthCheck } = await import('../handlers/rpc/server')
  const depsLike = { sessionManager: options.deps.sessionManager } as any

  if (typeof globalThis.Bun !== 'undefined') {
    const server = Bun.serve({
      port: options.port,
      fetch(req: Request) {
        const path = new URL(req.url).pathname
        if (path === '/health') {
          const health = getHealthCheck(depsLike)
          return Response.json(health, {
            status: health.status === 'ok' ? 200 : 503,
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    })

    options.platform.logger.info(`[bootstrap] Health endpoint listening on http://0.0.0.0:${options.port}/health`)

    return {
      stop: () => server.stop(),
    }
  }

  return null
}

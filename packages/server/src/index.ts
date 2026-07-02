#!/usr/bin/env bun
/**
 * @craft-agent/server — 独立无头 Craft Agent 服务器入口。
 *
 * 这个文件相当于 Golang 项目里的 `cmd/server/main.go`：
 * 负责解析环境变量、初始化依赖、启动 WebSocket RPC 服务器、WebUI、健康检查等。
 *
 * 桌面端（Electron）有自己的启动流程；这个文件是给"后台服务/远程服务器"模式用的。
 *
 * 用法：
 *   CRAFT_SERVER_TOKEN=<secret> bun run packages/server/src/index.ts
 *
 * 关键环境变量：
 *   CRAFT_SERVER_TOKEN         — 客户端认证必填的 bearer token
 *   CRAFT_RPC_HOST             — 绑定地址（默认 127.0.0.1）
 *   CRAFT_RPC_PORT             — 绑定端口（默认 9100）
 *   CRAFT_RPC_TLS_CERT/KEY     — TLS 证书路径，启用 wss://
 *   CRAFT_WEBUI_DIR            — 构建好的 WebUI 资源路径，启用 WebUI
 *   CRAFT_HEALTH_PORT          — HTTP 健康检查端口
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { version as packageVersion } from '../package.json'
import { enableDebug } from '@craft-agent/shared/utils/debug'
import { bootstrapServer, startHealthHttpServer, generateServerToken } from '@craft-agent/server-core/bootstrap'
import { validateSession, createWebuiHandler, nodeHttpAdapter } from '@craft-agent/server-core/webui'
import type { WebuiHandler } from '@craft-agent/server-core/webui'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getWorkspaces } from '@craft-agent/shared/config'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@craft-agent/messaging-gateway'

// --generate-token: 生成一个加密随机 token 并退出
if (process.argv.includes('--generate-token')) {
  console.log(generateServerToken())
  process.exit(0)
}
import type { WsRpcTlsOptions } from '@craft-agent/server-core/transport'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'

// 设置默认非打包模式
process.env.CRAFT_IS_PACKAGED ??= 'false'

/**
 * 捕获未处理的 Promise 拒绝，避免进程崩溃。
 *
 * Bun 默认会在未处理 rejection 时终止进程（与 Node 不同），
 * 但 SDK 子进程中止可能产生向上传播的未处理 rejection，这里兜底。
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[server] Unhandled rejection (caught, not crashing): ${msg}`)
})

// 开启调试日志
if (process.env.CRAFT_DEBUG === 'true' || process.env.CRAFT_DEBUG === '1') {
  enableDebug()
}

/**
 * 解析可选布尔型环境变量。
 *
 * 支持 '1'/'true'/'yes'/'on' 等常见写法，非法值直接退出进程。
 */
function parseOptionalBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false

  console.error(`Invalid ${name}: expected one of true/false/1/0/yes/no/on/off.`)
  process.exit(1)
}

/**
 * 解析可选 WebSocket URL 环境变量，校验协议必须是 ws:// 或 wss://。
 */
function parseOptionalWebSocketUrl(name: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('must use ws:// or wss://')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Invalid ${name}: ${message}`)
    process.exit(1)
  }
}

/**
 * 资源根目录。
 *
 * 开发模式：从本文件向上回 4 层到仓库根目录。
 * 打包模式：使用 CRAFT_BUNDLED_ASSETS_ROOT 或当前工作目录。
 */
const bundledAssetsRoot = process.env.CRAFT_BUNDLED_ASSETS_ROOT
  ?? join(import.meta.dir, '..', '..', '..', '..')

// ---------- TLS 配置：提供证书则监听 wss:// ----------
let tls: WsRpcTlsOptions | undefined
const tlsCertPath = process.env.CRAFT_RPC_TLS_CERT
const tlsKeyPath = process.env.CRAFT_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    console.error('TLS requires both CRAFT_RPC_TLS_CERT and CRAFT_RPC_TLS_KEY.')
    process.exit(1)
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.CRAFT_RPC_TLS_CA ? { ca: readFileSync(process.env.CRAFT_RPC_TLS_CA) } : {}),
  }
}

// ---------- WebUI 配置 ----------
const webuiDir = process.env.CRAFT_WEBUI_DIR || undefined
const webuiEnabled = webuiDir && existsSync(webuiDir)
const webuiSecureCookies = parseOptionalBooleanEnv('CRAFT_WEBUI_SECURE_COOKIE', process.env.CRAFT_WEBUI_SECURE_COOKIE)
const webuiWsUrl = parseOptionalWebSocketUrl('CRAFT_WEBUI_WS_URL', process.env.CRAFT_WEBUI_WS_URL)
const serverToken = process.env.CRAFT_SERVER_TOKEN

/**
 * 提前创建 WebUI handler，以便嵌入到 WsRpcServer 中。
 *
 * handler 是纯函数，不需要 session manager，健康检查通过 getHealthCheck 延迟注入。
 */
let webuiHandler: WebuiHandler | null = null
let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined

// 健康检查函数延迟注入：bootstrap 完成后 session manager 才就绪
let healthCheckFn: (() => { status: string }) | null = null

if (webuiEnabled && serverToken) {
  const rpcPort = parseInt(process.env.CRAFT_RPC_PORT ?? '9100', 10)
  const rpcProtocol = tls ? 'wss' as const : 'ws' as const

  webuiHandler = createWebuiHandler({
    webuiDir: webuiDir!,
    secret: serverToken,
    password: process.env.CRAFT_WEBUI_PASSWORD || undefined,
    secureCookies: webuiSecureCookies,
    publicWsUrl: webuiWsUrl,
    wsProtocol: rpcProtocol,
    wsPort: rpcPort, // WebUI 和 WS 共用端口
    getHealthCheck: () => healthCheckFn?.() ?? { status: 'starting' },
    logger: { info: console.log, warn: console.warn, error: console.error } as any,
  })

  webuiNodeHandler = nodeHttpAdapter(webuiHandler.fetch)
}

/**
 * WhatsApp worker 路径。
 *
 * worker 是 Node 子进程，Bun 不能直接运行，所以必须显式指定 nodeBin。
 * Electron 里默认 nodeBin = process.execPath，但在 Bun 环境下要传 'node'。
 */
const waWorkerEntry = process.env.CRAFT_MESSAGING_WA_WORKER
  ?? join(bundledAssetsRoot, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs')
const waNodeBin = process.env.CRAFT_MESSAGING_NODE_BIN ?? 'node'

// 在 createHandlerDeps 里创建，bootstrapServer 完成后再绑定 WS publisher
let messagingHandle: MessagingBootstrapHandle | null = null

/**
 * 启动服务器主实例。
 *
 * bootstrapServer 是 server-core 提供的通用启动函数，
 * 这个文件传入具体的平台适配、SessionManager、RPC handler 注册等回调。
 */
const instance = await (async () => {
  try {
    return await bootstrapServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      serverVersion: process.env.CRAFT_VERSION ?? packageVersion,
      tls,

      // 启用 WebUI 时，通过 JWT cookie 校验 WebSocket upgrade 请求
      validateSessionCookie: webuiEnabled && serverToken
        ? async (cookieHeader) => {
            const session = await validateSession(cookieHeader, serverToken)
            return session !== null
          }
        : undefined,

      // 把 WebUI HTTP handler 嵌入到 WS 服务器端口
      httpHandler: webuiNodeHandler,

      /**
       * 把平台能力注入到各个子系统。
       *
       * platform 来自 server-core，包含文件系统、搜索、图像处理、错误上报等抽象。
       * 这里把 platform 设置给 model-fetchers、session、services 等模块。
       */
      applyPlatformToSubsystems: (platform) => {
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {}, // 无头模式不需要 Dock 角标
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
      },

      // 初始化模型刷新服务：从凭证管理器读取每个 provider 的 key/token
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const manager = getCredentialManager()
        const [apiKey, oauth] = await Promise.all([
          manager.getLlmApiKey(slug).catch(() => null),
          manager.getLlmOAuth(slug).catch(() => null),
        ])
        return {
          apiKey: apiKey ?? undefined,
          oauthAccessToken: oauth?.accessToken,
          oauthRefreshToken: oauth?.refreshToken,
          oauthIdToken: oauth?.idToken,
        }
      }),

      createSessionManager: () => new SessionManager(),
      bindRpcServer: (sm, server) => sm.setRpcServer(server),

      // 构造 RPC handler 依赖：包含 session manager、platform、oauth flow store、消息网关注册表
      createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => {
        messagingHandle = createMessagingBootstrap({
          sessionManager,
          credentialManager: getCredentialManager(),
          getMessagingDir: (wsId: string) =>
            join(homedir(), '.craft-agent', 'workspaces', wsId, 'messaging'),
          // 无头模式没有旧版消息目录，工作区都是干净的
          whatsapp: {
            workerEntry: waWorkerEntry,
            nodeBin: waNodeBin,
            pairingMode: 'qr',
          },
        })
        return {
          sessionManager,
          platform,
          oauthFlowStore,
          messagingRegistry: messagingHandle.registry,
        }
      },

      // 注册所有核心 RPC handler
      registerAllRpcHandlers: registerCoreRpcHandlers,

      // 设置 session 事件 sink：消息网关需要包装 sink，把事件也转发给消息平台
      setSessionEventSink: (sessionManager, sink) => {
        if (!messagingHandle) {
          sessionManager.setEventSink(sink)
          return
        }
        sessionManager.setEventSink(messagingHandle.wrapSink(sink))
      },

      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },

      // 关闭前刷新所有会话并清理资源
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          sessionManager.cleanup()
        }
      },

      cleanupClientResources: cleanupSessionFileWatchForClient,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

// ---------------------------------------------------------------------------
// 启动后处理：绑定消息网关 publisher、初始化本地工作区
// ---------------------------------------------------------------------------
// CRAFT_DISABLE_MESSAGING lets a dev/test server share a config dir with a live app
// without both processes fighting over the same Telegram/WhatsApp connections (409s).
const messagingDisabled = process.env.CRAFT_DISABLE_MESSAGING === 'true' || process.env.CRAFT_DISABLE_MESSAGING === '1'
if (messagingHandle !== null && !messagingDisabled) {
  const handle: MessagingBootstrapHandle = messagingHandle
  handle.setPublisher(instance.wsServer.push.bind(instance.wsServer))
  try {
    // 远程工作区（remoteServer）的消息处理在远程服务器上，这里跳过
    const localWorkspaceIds = getWorkspaces()
      .filter((ws) => !ws.remoteServer)
      .map((ws) => ws.id)
    await handle.initializeWorkspaces(localWorkspaceIds)
  } catch (error) {
    console.error('[messaging] Workspace initialization failed:', error)
  }
} else if (messagingDisabled) {
  console.log('[messaging] Disabled via CRAFT_DISABLE_MESSAGING — skipping workspace messaging init')
}

// session manager 就绪后，再绑定延迟健康检查
if (webuiHandler) {
  const { getHealthCheck } = await import('@craft-agent/server-core/handlers/rpc/server')
  const depsLike = { sessionManager: instance.sessionManager } as any
  healthCheckFn = () => getHealthCheck(depsLike)

  // 配置 OAuth 回调依赖，使 /api/oauth/callback 能正常工作
  const { getSourceCredentialManager, loadWorkspaceSources } = await import('@craft-agent/shared/sources')
  const { getWorkspaceByNameOrId } = await import('@craft-agent/shared/config')
  const { pushTyped } = await import('@craft-agent/server-core/transport')
  const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')

  webuiHandler.setOAuthCallbackDeps({
    flowStore: instance.oauthFlowStore,
    credManager: getSourceCredentialManager(),
    sessionManager: instance.sessionManager,
    pushSourcesChanged: (workspaceId: string) => {
      const ws = getWorkspaceByNameOrId(workspaceId)
      const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
      pushTyped(instance.wsServer, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
    },
  })
}

// ---------- 启动 HTTP 健康检查端点 ----------
const healthPort = parseInt(process.env.CRAFT_HEALTH_PORT ?? '0', 10)
const healthServer = await startHealthHttpServer({
  port: healthPort,
  deps: { sessionManager: instance.sessionManager },
  wsServer: instance.wsServer,
  platform: instance.platform,
})

// ---------- 打印服务器地址 ----------
const serverProto = instance.protocol === 'wss' ? 'https' : 'http'
console.log(`CRAFT_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)
if (webuiHandler) {
  console.log(`CRAFT_WEBUI_URL=${serverProto}://0.0.0.0:${instance.port}`)
}

// ---------- 安全校验：禁止非本地地址无 TLS 绑定 ----------
// 否则 token 会明文传输。可用 --allow-insecure-bind 覆盖，但不建议生产使用。
const isLocalBind = instance.host === '127.0.0.1' || instance.host === 'localhost' || instance.host === '::1'
if (!isLocalBind && instance.protocol === 'ws') {
  if (process.argv.includes('--allow-insecure-bind')) {
    console.warn(
      '\n⚠️  WARNING: Server is listening on a network address without TLS.\n' +
      '   Authentication tokens will be sent in cleartext.\n' +
      '   Set CRAFT_RPC_TLS_CERT and CRAFT_RPC_TLS_KEY to enable wss://.\n'
    )
  } else {
    console.error(
      '\n❌  Refusing to bind to a network address without TLS.\n' +
      '   Authentication tokens would be sent in cleartext.\n\n' +
      '   Options:\n' +
      '     1. Set CRAFT_RPC_TLS_CERT and CRAFT_RPC_TLS_KEY to enable wss://\n' +
      '     2. Pass --allow-insecure-bind to override (NOT recommended for production)\n'
    )
    await instance.stop()
    process.exit(1)
  }
}

// ---------- 优雅关闭 ----------
const shutdown = async () => {
  webuiHandler?.dispose()
  healthServer?.stop()
  if (messagingHandle) {
    try {
      await messagingHandle.dispose()
    } catch (error) {
      console.error('[messaging] dispose failed:', error)
    }
  }
  await instance.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

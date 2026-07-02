/**
 * WsRpcServer — 基于 WebSocket 的 RPC 服务器。
 *
 * 这个类负责所有传输层事务：连接生命周期、握手、心跳、可选认证、请求分发、事件推送路由。
 * 本地模式（127.0.0.1，无认证）和远程模式（0.0.0.0，有认证）都用同一个类。
 *
 * 对后端工程师来说，可以把它理解为一个轻量版 gRPC server：
 * - channel = 方法名
 * - handle() = 注册 service
 * - push() = 服务端广播/单播
 * - invokeClient() = 服务端调用客户端能力
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  EVENT_BUFFER_MAX_SIZE,
  EVENT_BUFFER_TTL_MS,
  DISCONNECTED_CLIENT_TTL_MS,
  isErrorCode,
  type MessageEnvelope,
  type PushTarget,
  type ErrorCode,
} from '@craft-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from './types'
import { serializeEnvelope, deserializeEnvelope } from './codec'
import { createLogger } from '@craft-agent/shared/utils'

// ---------------------------------------------------------------------------
// 客户端连接状态
// ---------------------------------------------------------------------------

/** 客户端事件缓冲区里的单条事件（seq + 序列化后的 JSON + 时间戳） */
interface BufferedEvent {
  seq: number
  /** 共享序列化后的 envelope，所有客户端缓冲区复用同一分配 */
  data: string
  timestamp: number
}

/** 已完成握手的客户端连接状态 */
interface ClientConnection {
  id: string
  ws: WebSocket
  workspaceId: string | null
  webContentsId: number | null
  capabilities: Set<string>
  missedPongs: number
  alive: boolean
  /** 最近事件环形缓冲区，用于断线重连后回放 */
  eventBuffer: BufferedEvent[]
  /** 客户端已确认的最高 seq */
  lastAckedSeq: number
  /** 分配给该客户端的最高 seq */
  lastSentSeq: number
}

/** 服务端调用客户端能力时的等待状态 */
interface PendingInvoke {
  clientId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// 服务器选项
// ---------------------------------------------------------------------------

/** WSS 模式下需要的 TLS 配置（cert/key 必传） */
export interface WsRpcTlsOptions {
  /** PEM 编码的证书（字符串或 Buffer） */
  cert: string | Buffer
  /** PEM 编码的私钥（字符串或 Buffer） */
  key: string | Buffer
  /** 可选的 CA 链，用于客户端证书校验 */
  ca?: string | Buffer
  /** 加密私钥的密码 */
  passphrase?: string
}

/** WsRpcServer 构造选项 */
export interface WsRpcServerOptions {
  /** 绑定主机，默认 127.0.0.1 */
  host?: string
  /** 绑定端口，0 表示随机可用端口，默认 0 */
  port?: number
  /** 是否要求握手时提供 bearer token，默认 false */
  requireAuth?: boolean
  /** bearer token 校验函数（requireAuth 为 true 时使用） */
  validateToken?: (token: string) => Promise<boolean>
  /**
   * 可选的基于 cookie 的会话校验（给 WebUI 用）。
   * 当提供时，有效的 session cookie 可作为 bearer token 的替代认证方式。
   */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /** 服务器标识，会出现在下发事件的 envelope.serverId 中，默认 'local' */
  serverId?: string
  /** TLS 配置；提供时监听 wss://，否则监听 ws:// */
  tls?: WsRpcTlsOptions
  /** 服务端版本号，握手时返回给客户端做兼容性检查 */
  serverVersion?: string
  /** 最大并发客户端数，0 表示无限制，默认 50 */
  maxClients?: number
  /** 客户端完成握手后的回调 */
  onClientConnected?: (info: { clientId: string; webContentsId: number | null; workspaceId: string | null; capabilities: string[] }) => void
  /** 客户端断开后的回调 */
  onClientDisconnected?: (clientId: string) => void
  /**
   * 可选的非 WebSocket HTTP 请求处理器。
   * 提供后，普通 HTTP 请求会交给它处理（例如在同一端口上服务 WebUI）。
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

// 传输层日志
const transportLog = createLogger('ws-rpc-server')

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------

export class WsRpcServer implements RpcServer {
  // 底层 server 实例
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private httpsServer: HttpsServer | null = null

  // 客户端与 handler 集合
  private clients = new Map<string, ClientConnection>()
  private handlers = new Map<string, HandlerFn>()
  private pendingInvokes = new Map<string, PendingInvoke>()

  // 运行时状态
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _port = 0
  private _protocol: 'ws' | 'wss' = 'ws'

  /** 断线后保留的客户端，用于重连回放 */
  private disconnectedClients = new Map<string, { client: ClientConnection; timer: ReturnType<typeof setTimeout> }>()

  // 构造时传入的只读配置
  private readonly host: string
  private readonly requestedPort: number
  private readonly requireAuth: boolean
  private readonly validateToken: ((token: string) => Promise<boolean>) | null
  private readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<boolean>) | null
  private readonly serverId: string
  private readonly tlsOptions: WsRpcTlsOptions | null
  private readonly serverVersion: string
  private readonly maxClients: number
  private readonly onClientConnected: WsRpcServerOptions['onClientConnected']
  private readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected']
  private readonly httpHandler: WsRpcServerOptions['httpHandler']

  /** 构造函数：保存配置，不立即监听（调用 listen() 后才会启动服务） */
  constructor(opts?: WsRpcServerOptions) {
    this.host = opts?.host ?? '127.0.0.1'
    this.requestedPort = opts?.port ?? 0
    this.requireAuth = opts?.requireAuth ?? false
    this.validateToken = opts?.validateToken ?? null
    this.validateSessionCookie = opts?.validateSessionCookie ?? null
    this.serverId = opts?.serverId ?? 'local'
    this.serverVersion = opts?.serverVersion ?? ''
    this.tlsOptions = opts?.tls ?? null
    this.maxClients = opts?.maxClients ?? 50
    this.onClientConnected = opts?.onClientConnected
    this.onClientDisconnected = opts?.onClientDisconnected
    this.httpHandler = opts?.httpHandler
  }

  /** 实际监听端口（listen 后才能拿到） */
  get port(): number {
    return this._port
  }

  /** 当前协议：配置 TLS 为 'wss'，否则 'ws' */
  get protocol(): 'ws' | 'wss' {
    return this._protocol
  }

  /** 当前已连接（完成握手）的客户端数量 */
  getConnectedClientCount(): number {
    return this.clients.size
  }

  // -------------------------------------------------------------------------
  // RpcServer 接口实现
  // -------------------------------------------------------------------------

  /**
   * 注册一个 RPC handler。
   * 同一个 channel 不能重复注册（类似 gRPC 服务方法名冲突）。
   */
  handle(channel: string, handler: HandlerFn): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  /**
   * 向指定目标推送事件。
   * target 支持 all / workspace / client，同时会写入断线客户端的缓冲区以便重连回放。
   */
  push(channel: string, target: PushTarget, ...args: any[]): void {
    const timestamp = Date.now()

    // 推送给在线客户端
    for (const client of this.clients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, true)
    }

    // 也推送给断线但仍在保留窗口内的客户端，确保重连后能回放
    for (const { client } of this.disconnectedClients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, false)
    }
  }

  /** 指定客户端是否声明了某项能力 */
  hasClientCapability(clientId: string, capability: string): boolean {
    const client = this.clients.get(clientId)
    return !!client && client.capabilities.has(capability)
  }

  /** 查找所有声明了某能力的在线客户端，可选按 workspaceId 过滤 */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[] {
    const results: string[] = []
    for (const [clientId, client] of this.clients) {
      if (!client.capabilities.has(capability)) continue
      if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId) continue
      results.push(clientId)
    }
    return results
  }

  /**
   * 调用某个客户端的能力（服务端 → 客户端的 RPC）。
   * 如果客户端不在线或未声明该能力，会立即 reject。
   */
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.clients.get(clientId)

      if (!client) {
        const err = new Error(`Client not connected: ${clientId}`)
        ;(err as any).code = 'CLIENT_DISCONNECTED'
        reject(err)
        return
      }

      if (!client.capabilities.has(channel)) {
        const err = new Error(`Client lacks capability: ${channel}`)
        ;(err as any).code = 'CAPABILITY_UNAVAILABLE'
        reject(err)
        return
      }

      const id = randomUUID()
      const timeout = setTimeout(() => {
        this.pendingInvokes.delete(id)
        const err = new Error(`Client request timeout: ${channel} (30000ms)`)
        ;(err as any).code = 'CLIENT_REQUEST_TIMEOUT'
        reject(err)
      }, 30_000)

      this.pendingInvokes.set(id, { clientId, resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
        serverId: this.serverId,
      }
      this.safeSend(client.ws, serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 启动监听：根据配置选择 wss / ws+httpHandler / 纯 ws 模式。
   * 返回 Promise，resolve 表示端口已就绪。
   */
  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.tlsOptions) {
        // TLS 模式：先创建 HTTPS server，再把 WebSocketServer 挂载上去
        this._protocol = 'wss'
        this.httpsServer = createHttpsServer(
          {
            cert: this.tlsOptions.cert,
            key: this.tlsOptions.key,
            ca: this.tlsOptions.ca,
            passphrase: this.tlsOptions.passphrase,
          },
          this.httpHandler,
        )

        this.wss = new WebSocketServer({ server: this.httpsServer })

        this.httpsServer.on('error', (err) => reject(err))

        this.httpsServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpsServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else if (this.httpHandler) {
        // 普通 WS + HTTP handler：共用一个 HTTP server
        this._protocol = 'ws'
        this.httpServer = createHttpServer(this.httpHandler)
        this.wss = new WebSocketServer({ server: this.httpServer })

        this.httpServer.on('error', (err) => reject(err))

        this.httpServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else {
        // 纯 WS 模式
        this._protocol = 'ws'
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.requestedPort,
        })

        this.wss.on('listening', () => {
          const addr = this.wss!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })

        this.wss.on('error', (err) => {
          reject(err)
        })
      }

      this.wss.on('connection', (ws, req) => {
        this.onConnection(ws, req.headers.cookie ?? null)
      })
    })
  }

  /**
   * 关闭服务器：停止心跳、拒绝未完成调用、断开所有客户端、清理缓冲区。
   * 关闭后实例不可再用。
   */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // 关闭前拒绝所有未完成的 invokeClient
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timeout)
      const err = new Error('Server shutting down')
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
    for (const client of this.clients.values()) {
      client.ws.terminate()
    }
    this.clients.clear()
    for (const entry of this.disconnectedClients.values()) {
      clearTimeout(entry.timer)
    }
    this.disconnectedClients.clear()
    this.wss?.close()
    this.wss = null
    this.httpServer?.close()
    this.httpServer = null
    this.httpsServer?.close()
    this.httpsServer = null
  }

  // -------------------------------------------------------------------------
  // 连接处理
  // -------------------------------------------------------------------------

  /**
   * 新 WebSocket 连接入口。
   * 负责容量控制、握手超时、协议版本校验、认证、重连回放、新连接建立，
   * 以及握手后 request/response/sequence_ack 的消息路由。
   */
  private onConnection(ws: WebSocket, upgradeRequestCookie: string | null): void {
    // 容量控制
    if (this.maxClients > 0 && this.clients.size >= this.maxClients) {
      transportLog.warn('Connection rejected: at capacity', {
        maxClients: this.maxClients,
        current: this.clients.size,
      })
      ws.close(4008, 'Server at capacity')
      return
    }

    let handshakeCompleted = false
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null

    // 5 秒内必须完成握手
    handshakeTimeout = setTimeout(() => {
      if (!handshakeCompleted) {
        ws.close(4001, 'Handshake timeout')
      }
    }, 5_000)

    ws.on('message', async (raw) => {
      let envelope: MessageEnvelope
      try {
        envelope = deserializeEnvelope(raw.toString())
      } catch {
        ws.close(4002, 'Invalid JSON')
        return
      }

      if (!handshakeCompleted) {
        if (envelope.type !== 'handshake') {
          ws.close(4003, 'Expected handshake')
          return
        }

        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout)
          handshakeTimeout = null
        }

        // 协议主版本号必须一致
        if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10)
        const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10)
        if (clientMajor !== serverMajor) {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        // 认证：bearer token 或 session cookie
        if (this.requireAuth) {
          let authenticated = false

          if (envelope.token && this.validateToken) {
            authenticated = await this.validateToken(envelope.token)
          }

          if (!authenticated && this.validateSessionCookie && upgradeRequestCookie) {
            authenticated = await this.validateSessionCookie(upgradeRequestCookie)
          }

          if (!authenticated) {
            const reason = envelope.token ? 'Invalid token' : 'Token required'
            this.sendError(ws, envelope.id, 'AUTH_FAILED', reason)
            ws.close(4005, 'Auth failed')
            return
          }
        }

        // ── 重连尝试 ──
        if (envelope.reconnectClientId && envelope.lastSeq != null) {
          const entry = this.disconnectedClients.get(envelope.reconnectClientId)
          if (entry) {
            const prevClient = entry.client

            // 身份必须匹配（workspace + webContentsId）
            const identityMatch =
              prevClient.workspaceId === (envelope.workspaceId ?? null) &&
              prevClient.webContentsId === (envelope.webContentsId ?? null)

            if (identityMatch) {
              clearTimeout(entry.timer)

              prevClient.ws = ws
              prevClient.alive = true
              prevClient.missedPongs = 0
              handshakeCompleted = true

              this.evictBuffer(prevClient)

              const lastSeq = envelope.lastSeq as number
              const hasMissedEvents = lastSeq < prevClient.lastSentSeq
              const firstBufferedSeq = prevClient.eventBuffer[0]?.seq
              const canReplay = !hasMissedEvents
                ? true
                : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1

              if (canReplay) {
                const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq)

                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                // 按顺序回放丢失事件
                for (const event of replayEvents) {
                  this.safeSend(ws, event.data)
                }

                transportLog.info('Client reconnected with replay', {
                  clientId: prevClient.id,
                  replayedCount: replayEvents.length,
                  lastSeq,
                })
              } else {
                // 缓冲区已清理，客户端需要全量刷新
                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                  stale: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                transportLog.info('Client reconnected as stale', {
                  clientId: prevClient.id,
                  lastSeq,
                  firstBufferedSeq,
                  lastSentSeq: prevClient.lastSentSeq,
                })
              }

              // 回放完成后再把客户端从 disconnected 移回 active，避免 push 穿插新事件
              this.disconnectedClients.delete(envelope.reconnectClientId)
              this.clients.set(prevClient.id, prevClient)

              this.setupClientHandlers(ws, prevClient)
              this.onClientConnected?.({
                clientId: prevClient.id,
                webContentsId: prevClient.webContentsId,
                workspaceId: prevClient.workspaceId,
                capabilities: [...prevClient.capabilities],
              })
              return
            }

            transportLog.warn('Reconnect identity mismatch', {
              reconnectClientId: envelope.reconnectClientId,
            })
          }
          // reconnectClientId 找不到或身份不匹配 → 按新连接处理
        }

        // ── 普通新连接 ──
        const clientId = randomUUID()
        const client: ClientConnection = {
          id: clientId,
          ws,
          workspaceId: envelope.workspaceId ?? null,
          webContentsId: envelope.webContentsId ?? null,
          capabilities: new Set(envelope.clientCapabilities ?? []),
          missedPongs: 0,
          alive: true,
          eventBuffer: [],
          lastAckedSeq: 0,
          lastSentSeq: 0,
        }
        this.clients.set(clientId, client)
        handshakeCompleted = true

        const ack: MessageEnvelope = {
          id: envelope.id,
          type: 'handshake_ack',
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.serverVersion || undefined,
          clientId,
          registeredChannels: [...this.handlers.keys()],
        }
        this.safeSend(ws, serializeEnvelope(ack))

        transportLog.info('Client connected', {
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
        })
        this.onClientConnected?.({
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
          capabilities: [...client.capabilities],
        })

        this.setupClientHandlers(ws, client)
        return
      }

      // 握手后：找到这个 ws 对应的 client
      const client = this.findClientByWs(ws)
      if (!client) {
        ws.close(4006, 'Unknown client')
        return
      }

      if (envelope.type === 'request') {
        await this.onRequest(client, envelope)
      } else if (envelope.type === 'response') {
        this.onClientResponse(envelope)
      } else if (envelope.type === 'sequence_ack') {
        const ackSeq = envelope.lastSeq
        if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
          client.lastAckedSeq = ackSeq
          // 清理已确认事件
          const buf = client.eventBuffer
          let removeCount = 0
          while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
            removeCount++
          }
          if (removeCount > 0) {
            buf.splice(0, removeCount)
          }
        }
      }
    })

    ws.on('error', () => {
      // 连接错误由 close 事件处理
    })
  }

  // -------------------------------------------------------------------------
  // 请求分发
  // -------------------------------------------------------------------------

  /** RPC handler 执行超时 */
  private static readonly HANDLER_TIMEOUT_MS = 60_000

  /**
   * 处理客户端发来的 RPC request。
   * 查找 channel 对应的 handler，注入 RequestContext，带 60 秒超时，返回 response。
   */
  private async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope

    if (!channel) {
      this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel')
      return
    }

    const handler = this.handlers.get(channel)
    if (!handler) {
      this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`)
      return
    }

    const ctx: RequestContext = {
      clientId: client.id,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
    }

    try {
      const result = await Promise.race([
        handler(ctx, ...(args ?? [])),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${WsRpcServer.HANDLER_TIMEOUT_MS}ms)`)),
            WsRpcServer.HANDLER_TIMEOUT_MS),
        ),
      ])
      const response: MessageEnvelope = {
        id,
        type: 'response',
        channel,
        result,
      }
      this.safeSend(client.ws, serializeEnvelope(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      this.sendResponseError(client.ws, id, channel, code, message)
    }
  }

  // -------------------------------------------------------------------------
  // 心跳
  // -------------------------------------------------------------------------

  /** 启动心跳：定期 ping 客户端，未收到 pong 超过阈值则强制断开 */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [, client] of this.clients) {
        if (client.ws.readyState !== client.ws.OPEN) continue

        if (!client.alive) {
          client.missedPongs++
          if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
            client.ws.terminate()
            continue
          }
        }
        client.alive = false
        client.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // 辅助函数
  // -------------------------------------------------------------------------

  /** 为 WebSocket ↔ ClientConnection 配对设置 close + pong 处理器 */
  private setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
      transportLog.info('Client disconnected', { clientId: client.id })
      this.clients.delete(client.id)

      // 保留缓冲区以便可能的重连
      const timer = setTimeout(() => {
        this.disconnectedClients.delete(client.id)
      }, DISCONNECTED_CLIENT_TTL_MS)
      this.disconnectedClients.set(client.id, { client, timer })

      // 限制 disconnectedClients 数量，避免无界增长
      if (this.disconnectedClients.size > 50) {
        const oldestKey = this.disconnectedClients.keys().next().value
        if (oldestKey) {
          const oldest = this.disconnectedClients.get(oldestKey)
          if (oldest) clearTimeout(oldest.timer)
          this.disconnectedClients.delete(oldestKey)
        }
      }

      this.rejectPendingInvokesForClient(client.id)
      this.onClientDisconnected?.(client.id)
    })

    ws.on('pong', () => {
      client.alive = true
      client.missedPongs = 0
    })
  }

  /** 分配 seq、保留事件用于回放、按需立即发送 */
  private bufferAndMaybeSendEvent(
    client: ClientConnection,
    channel: string,
    args: any[],
    timestamp: number,
    shouldSend: boolean,
  ): void {
    client.lastSentSeq += 1
    const seq = client.lastSentSeq

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: this.serverId,
      seq,
    }

    const data = serializeEnvelope(envelope)
    client.eventBuffer.push({ seq, data, timestamp })
    this.evictBuffer(client)

    if (shouldSend) {
      this.safeSend(client.ws, data)
    }
  }

  /** 按 TTL 和大小清理客户端事件缓冲区 */
  private evictBuffer(client: ClientConnection): void {
    const buf = client.eventBuffer
    if (buf.length === 0) return

    const now = Date.now()
    let removeCount = 0

    while (removeCount < buf.length &&
           now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
      removeCount++
    }

    const remaining = buf.length - removeCount
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
      removeCount += remaining - EVENT_BUFFER_MAX_SIZE
    }

    if (removeCount > 0) {
      buf.splice(0, removeCount)
    }
  }

  /** 判断某客户端是否匹配 push target（all / workspace / client，支持 exclude） */
  private matchesTarget(client: ClientConnection, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.id !== target.exclude : true
      case 'workspace':
        if (target.exclude && client.id === target.exclude) return false
        return client.workspaceId === target.workspaceId
      case 'client':
        return client.id === target.clientId
      default:
        return false
    }
  }

  /** 更新客户端 workspaceId（切换工作区后调用，保证 push 路由正确） */
  updateClientWorkspace(clientId: string, workspaceId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.workspaceId = workspaceId
    }
  }

  /** 通过 WebSocket 实例查找对应的 ClientConnection */
  private findClientByWs(ws: WebSocket): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  /** handler/request 级错误，以 response 形式返回 */
  private sendResponseError(
    ws: WebSocket, id: string, channel: string | undefined,
    code: ErrorCode, message: string,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** 协议级错误（握手拒绝、版本不匹配），可能关闭连接 */
  private sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** 处理客户端对 invokeClient 的 response，resolve/reject 等待中的 Promise */
  private onClientResponse(envelope: MessageEnvelope): void {
    const pending = this.pendingInvokes.get(envelope.id)
    if (!pending) return

    this.pendingInvokes.delete(envelope.id)
    clearTimeout(pending.timeout)

    if (envelope.error) {
      const err = new Error(envelope.error.message)
      ;(err as any).code = envelope.error.code
      ;(err as any).data = envelope.error.data
      pending.reject(err)
    } else {
      pending.resolve(envelope.result)
    }
  }

  /** 客户端断开时，拒绝所有发给它的未完成 invokeClient */
  private rejectPendingInvokesForClient(clientId: string): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timeout)
      const err = new Error(`Client disconnected: ${clientId}`)
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
  }

  /** 仅在 socket 打开时发送数据；关闭中/已关闭则静默忽略 */
  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(data)
    }
  }
}

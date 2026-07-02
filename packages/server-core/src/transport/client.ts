/**
 * WsRpcClient — 基于 WebSocket 的 RPC 客户端。
 *
 * 同时用于 Electron renderer（浏览器 WebSocket）和 Node.js 环境。
 * 负责握手、请求/响应关联、事件订阅、带指数退避的自动重连。
 *
 * 放在 server-core 而不是 Electron 包里，是为了让子进程、服务、桥接代码
 * 也能作为 RPC 客户端，而不依赖 Electron 应用层。
 */

import {
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  SEQUENCE_ACK_INTERVAL_MS,
  isErrorCode,
  type ErrorCode,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol'
import type { RpcClient } from './types'
import { serializeEnvelope, deserializeEnvelope } from './codec'

// ---------------------------------------------------------------------------
// 待处理请求状态
// ---------------------------------------------------------------------------

/** 等待服务端响应的请求状态（resolve/reject + 超时计时器） */
interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// 连接状态模型
// ---------------------------------------------------------------------------

/** 连接模式：local（本地嵌入）或 remote（远程瘦客户端） */
export type TransportMode = 'local' | 'remote'

/** WebSocket 连接状态机 */
export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

/** 连接错误的分类，用于 UI 展示不同的重连/提示策略 */
export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

/** 连接错误对象，用于状态通知和日志 */
export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

/** WebSocket 关闭信息 */
export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

/** 对外暴露的连接状态快照（UI 可订阅它以显示在线/重连状态） */
export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 客户端选项
// ---------------------------------------------------------------------------

/** WsRpcClient 构造选项 */
export interface WsRpcClientOptions {
  /** 握手时发送的工作区 ID */
  workspaceId?: string
  /** Electron webContents.id，本地客户端握手时发送 */
  webContentsId?: number
  /** 远程认证用的 bearer token */
  token?: string
  /** 单次 RPC 请求超时（毫秒），默认 30_000 */
  requestTimeout?: number
  /** 最大重连退避时间（毫秒），默认 30_000 */
  maxReconnectDelay?: number
  /** 断开后是否自动重连，默认 true */
  autoReconnect?: boolean
  /** 握手/连接超时（毫秒），默认 10_000 */
  connectTimeout?: number
  /** 握手时声明的能力，需通过 handleCapability() 注册 handler */
  clientCapabilities?: string[]
  /** 运行模式：本地嵌入或远程瘦客户端 */
  mode?: TransportMode
  /**
   * wss:// 连接是否校验自签名证书。
   * 默认 true；设为 false 只在 Node.js/Electron main 进程有效。
   */
  tlsRejectUnauthorized?: boolean
}

// ---------------------------------------------------------------------------
// WsRpcClient
// ---------------------------------------------------------------------------

export class WsRpcClient implements RpcClient {
  // 运行时状态
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private capabilityHandlers = new Map<string, (...args: any[]) => Promise<any> | any>()
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private anyEventListeners = new Set<(channel: string, ...args: any[]) => void>()
  private clientId: string | null = null
  private _serverVersion: string | null = null
  private connected = false
  private reconnectAttempt = 0
  private lastSeenSeq = 0
  private ackTimer: ReturnType<typeof setInterval> | null = null
  private pendingReconnect: { clientId: string; lastSeq: number } | null = null
  private currentHandshakeWasReconnect = false
  private manualReconnectRequested = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  /** 服务器发送 shuttingDown 后禁止重连 */
  private permanentlyClosed = false
  private connectStarted = false
  private connectError: Error | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private connectionState: TransportConnectionState
  private serverChannels: Set<string> | null = null

  // 构造时传入的只读配置
  private readonly url: string
  private readonly workspaceId: string | undefined
  private readonly webContentsId: number | undefined
  private readonly token: string | undefined
  private readonly clientCapabilities: string[]
  private readonly requestTimeout: number
  private readonly maxReconnectDelay: number
  private readonly autoReconnect: boolean
  private readonly connectTimeout: number
  private readonly mode: TransportMode
  private readonly tlsRejectUnauthorized: boolean

  /** 构造函数：保存配置、推断运行模式、初始化连接状态 */
  constructor(url: string, opts?: WsRpcClientOptions) {
    this.url = url
    this.workspaceId = opts?.workspaceId
    this.webContentsId = opts?.webContentsId
    this.token = opts?.token
    this.clientCapabilities = opts?.clientCapabilities ?? []
    this.requestTimeout = opts?.requestTimeout ?? REQUEST_TIMEOUT_MS
    this.maxReconnectDelay = opts?.maxReconnectDelay ?? 30_000
    this.autoReconnect = opts?.autoReconnect ?? true
    this.connectTimeout = opts?.connectTimeout ?? 10_000
    this.mode = opts?.mode ?? this.inferMode(url)
    this.tlsRejectUnauthorized = opts?.tlsRejectUnauthorized ?? true

    this.connectionState = {
      mode: this.mode,
      status: 'idle',
      url: this.url,
      attempt: 0,
      updatedAt: Date.now(),
    }
  }

  // -------------------------------------------------------------------------
  // RpcClient 接口实现
  // -------------------------------------------------------------------------

  /**
   * 发起一次 RPC 调用，等待服务端返回结果。
   * 内部会先 ensureConnected()，生成唯一 id，发 request envelope。
   */
  async invoke(channel: string, ...args: any[]): Promise<any> {
    await this.ensureConnected(channel)

    return await new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        reject(new Error(`Not connected (channel: ${channel})`))
        return
      }

      const id = crypto.randomUUID()
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${channel} (${this.requestTimeout}ms)`))
      }, this.requestTimeout)

      this.pending.set(id, { resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
      }

      if (!this.trySendEnvelope(this.ws, envelope)) {
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(new Error(`Not connected (channel: ${channel})`))
      }
    })
  }

  /**
   * 订阅某个 channel 的事件。
   * 返回一个函数，调用即可取消订阅。
   */
  on(channel: string, callback: (...args: any[]) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)

    return () => {
      set!.delete(callback)
      if (set!.size === 0) {
        this.listeners.delete(channel)
      }
    }
  }

  /**
   * 注册客户端能力 handler。
   * 服务端通过 invokeClient 调用该 channel 时，会执行这里注册的函数。
   */
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilityHandlers.set(channel, handler)
  }

  /**
   * 检查服务器是否注册了某 channel 的 handler。
   * 如果服务器握手时没有广播 channels，则默认认为可用（向后兼容）。
   */
  isChannelAvailable(channel: string): boolean {
    if (!this.serverChannels) return true
    return this.serverChannels.has(channel)
  }

  /** 从 handshake_ack 拿到的服务器版本 */
  getServerVersion(): string | null {
    return this._serverVersion
  }

  /**
   * 获取当前连接状态快照。
   * 返回深拷贝，避免外部修改影响内部状态。
   */
  getConnectionState(): TransportConnectionState {
    return {
      ...this.connectionState,
      lastError: this.connectionState.lastError ? { ...this.connectionState.lastError } : undefined,
      lastClose: this.connectionState.lastClose ? { ...this.connectionState.lastClose } : undefined,
    }
  }

  /**
   * 订阅连接状态变化。
   * 首次订阅会立即回调一次当前状态，之后每次状态变化都会回调。
   */
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => {
      this.connectionStateListeners.delete(callback)
    }
  }

  /** 订阅所有 push 事件，不分 channel。RemoteClientBridge 用于事件转发 */
  onAnyEvent(callback: (channel: string, ...args: any[]) => void): () => void {
    this.anyEventListeners.add(callback)
    return () => {
      this.anyEventListeners.delete(callback)
    }
  }

  /**
   * 触发合成的 __transport:reconnected 事件。
   * RoutedClient 切换工作区后用它触发 stale 恢复。
   */
  emitReconnected(isStale: boolean): void {
    const set = this.listeners.get('__transport:reconnected')
    if (set) {
      for (const cb of set) {
        try { cb(isStale) } catch { /* listener 错误不能破坏传输层 */ }
      }
    }
  }

  /** 立即触发重连（用户手动刷新或切换网络后调用） */
  reconnectNow(): void {
    if (this.destroyed) return

    if (this.clientId) {
      this.pendingReconnect = {
        clientId: this.clientId,
        lastSeq: this.lastSeenSeq,
      }
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.connectStarted = false
    this.connectError = null

    if (!this.ws) {
      this.setConnectionState({
        status: 'reconnecting',
        attempt: this.reconnectAttempt,
        nextRetryInMs: undefined,
      })
      this.connect()
      return
    }

    this.manualReconnectRequested = true

    try {
      this.ws.close()
    } catch {
      this.manualReconnectRequested = false
      this.setConnectionState({
        status: 'reconnecting',
        attempt: this.reconnectAttempt,
        nextRetryInMs: undefined,
      })
      this.connect()
    }
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  /**
   * 创建 WebSocket 实例。
   *
   * Node.js/Electron main 进程使用 `ws` 库以支持 TLS 选项；
   * renderer（浏览器）里回退到全局 WebSocket。
   */
  private createWebSocket(url: string): WebSocket {
    const needsTlsOptions = url.startsWith('wss://') && !this.tlsRejectUnauthorized

    if (needsTlsOptions && typeof process !== 'undefined' && process.versions?.node) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { WebSocket: WsWebSocket } = require('ws') as typeof import('ws')
        return new WsWebSocket(url, { rejectUnauthorized: false }) as unknown as WebSocket
      } catch {
        return new WebSocket(url)
      }
    }

    return new WebSocket(url)
  }

  /**
   * 发起 WebSocket 连接（或重连），触发握手流程。
   * 会先清理旧 socket、设置超时、监听 open/message/close/error 事件。
   */
  connect(): void {
    if (this.destroyed) return

    this.connectStarted = true
    this.connectError = null
    this.createReadyPromise()

    const isReconnectAttempt = this.reconnectAttempt > 0 || this.pendingReconnect !== null
    const status: TransportConnectionStatus = isReconnectAttempt ? 'reconnecting' : 'connecting'
    this.setConnectionState({
      status,
      attempt: this.reconnectAttempt,
      nextRetryInMs: undefined,
      lastError: undefined,
    })

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    // 创建新 socket 前清理旧 socket，避免孤立连接和旧事件处理器干扰
    if (this.ws) {
      const oldWs = this.ws
      this.ws = null
      oldWs.onopen = null
      oldWs.onmessage = null
      oldWs.onclose = null
      oldWs.onerror = null
      try { oldWs.close() } catch { /* 尽力而为 */ }
    }

    // 连接超时计时器
    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        const err = this.createConnectionError('timeout', `Connection timeout after ${this.connectTimeout}ms`, 'HANDSHAKE_TIMEOUT')
        this.connectError = err
        this.setConnectionState({
          status: 'failed',
          lastError: this.toErrorState(err),
          attempt: this.reconnectAttempt,
        })
        this.failReady(err)
        this.ws?.close()
      }
    }, this.connectTimeout)

    const ws = this.createWebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return // 旧 socket 事件忽略
      const reconnectSnapshot = this.pendingReconnect
      this.currentHandshakeWasReconnect = reconnectSnapshot !== null

      // 发送握手（包含重连信息）
      const handshake: MessageEnvelope = {
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: this.workspaceId,
        webContentsId: this.webContentsId,
        token: this.token,
        clientCapabilities: this.clientCapabilities.length > 0 ? this.clientCapabilities : undefined,
        reconnectClientId: reconnectSnapshot?.clientId,
        lastSeq: reconnectSnapshot?.lastSeq,
      }
      this.trySendEnvelope(ws, handshake)
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      this.onMessage(typeof event.data === 'string' ? event.data : event.data.toString())
    }

    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.onDisconnect(event)
    }

    ws.onerror = (event: Event | { message?: string; error?: Error }) => {
      if (this.ws !== ws) return
      // 连接阶段捕获更具体的错误状态
      if (!this.connected && !this.connectError) {
        const detail = ('message' in event && event.message)
          || ('error' in event && event.error?.message)
          || undefined
        const message = detail
          ? `WebSocket error: ${detail}`
          : 'WebSocket error during connection setup'
        const err = this.createConnectionError('network', message, 'WS_ERROR')
        this.connectError = err
        this.setConnectionState({
          status: 'failed',
          lastError: this.toErrorState(err),
          attempt: this.reconnectAttempt,
        })
      }
    }
  }

  /**
   * 销毁客户端：清理所有计时器、拒绝待处理请求、关闭连接。
   * 销毁后不能再使用此实例。
   */
  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.ackTimer) {
      clearInterval(this.ackTimer)
      this.ackTimer = null
    }
    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer)
      this.backoffResetTimer = null
    }

    this.manualReconnectRequested = false
    this.currentHandshakeWasReconnect = false
    this.pendingReconnect = null
    this.failReady(new Error('Client destroyed'))

    for (const [id, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
    this.anyEventListeners.clear()

    this.ws?.close()
    this.ws = null
    this.connected = false

    this.setConnectionState({
      status: 'disconnected',
      lastError: {
        kind: 'unknown',
        code: 'CLIENT_DESTROYED',
        message: 'Client destroyed',
      },
      nextRetryInMs: undefined,
    })
  }

  /** 是否已完成握手并处于连接状态 */
  get isConnected(): boolean {
    return this.connected
  }

  // -------------------------------------------------------------------------
  // 消息处理
  // -------------------------------------------------------------------------

  /**
   * 处理收到的 JSON envelope，按类型分发：
   * handshake_ack / response / error / request / event。
   * 非法包直接忽略，避免恶意/损坏数据破坏客户端。
   */
  private onMessage(raw: string): void {
    let envelope: MessageEnvelope
    try {
      envelope = deserializeEnvelope(raw)
    } catch {
      return
    }

    switch (envelope.type) {
      case 'handshake_ack': {
        const wasReconnectAttempt = this.currentHandshakeWasReconnect
        const serverRecognizedReconnect = envelope.reconnected === true

        this.currentHandshakeWasReconnect = false
        this.pendingReconnect = null
        this.clientId = envelope.clientId ?? null
        this._serverVersion = envelope.serverVersion ?? null
        this.serverChannels = envelope.registeredChannels
          ? new Set(envelope.registeredChannels)
          : null
        this.connected = true
        this.connectError = null
        // 稳定连接 10 秒后才重置退避计数，避免刚握手就被断开的抖动导致退避重置
        this.scheduleBackoffReset()

        if (!serverRecognizedReconnect) {
          this.lastSeenSeq = 0
        }

        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.setConnectionState({
          status: 'connected',
          attempt: 0,
          nextRetryInMs: undefined,
          lastError: undefined,
          lastClose: undefined,
        })
        this.startAckTimer()
        this.resolveReady?.()
        this.resolveReady = null
        this.rejectReady = null
        this.readyPromise = null

        // 在 resolveReady 之后通知重连监听器
        if (wasReconnectAttempt) {
          // reconnected=true 表示服务器识别了之前的客户端；否则按 stale 处理
          const isStale = !serverRecognizedReconnect || !!envelope.stale

          const set = this.listeners.get('__transport:reconnected')
          if (set) {
            for (const cb of set) {
              try { cb(isStale) } catch { /* listener 错误不能破坏传输层 */ }
            }
          }
        }
        break
      }

      case 'response': {
        const req = this.pending.get(envelope.id)
        if (req) {
          this.pending.delete(envelope.id)
          clearTimeout(req.timeout)
          if (envelope.error) {
            const err = new Error(envelope.error.message)
            ;(err as any).code = envelope.error.code
            ;(err as any).data = envelope.error.data
            req.reject(err)
          } else {
            req.resolve(envelope.result)
          }
        }
        break
      }

      case 'error': {
        // 协议级错误（握手拒绝、版本不匹配）
        if (envelope.error?.message) {
          const kind = this.classifyErrorKindFromCode(envelope.error.code)
          const err = this.createConnectionError(kind, envelope.error.message, envelope.error.code)
          this.connectError = err
          this.setConnectionState({
            status: 'failed',
            lastError: this.toErrorState(err),
            attempt: this.reconnectAttempt,
          })
          this.failReady(err)
        }
        break
      }

      case 'request': {
        // 服务端调用客户端能力
        if (envelope.channel) {
          this.onServerRequest(envelope)
        }
        break
      }

      case 'event': {
        // 可靠交付：追踪 seq 号
        if (typeof envelope.seq === 'number') {
          if (this.lastSeenSeq > 0 && envelope.seq > this.lastSeenSeq + 1) {
            console.warn(`[WsRpc] Sequence gap: expected ${this.lastSeenSeq + 1}, got ${envelope.seq}`)
          }
          this.lastSeenSeq = envelope.seq
        }

        if (envelope.channel) {
          // 服务器正在关闭 → 停止重连
          if (envelope.channel === 'server:shuttingDown') {
            this.permanentlyClosed = true
            this.setConnectionState({
              status: 'disconnected',
              lastError: { kind: 'server', message: 'Server is shutting down', code: 'SERVER_SHUTDOWN' },
            })
          }

          const set = this.listeners.get(envelope.channel)
          if (set) {
            for (const cb of set) {
              try {
                cb(...(envelope.args ?? []))
              } catch {
                // listener 错误不能破坏客户端
              }
            }
          }
          // 通配 listener（RemoteClientBridge 用于事件转发）
          for (const cb of this.anyEventListeners) {
            try {
              cb(envelope.channel, ...(envelope.args ?? []))
            } catch {
              // listener 错误不能破坏客户端
            }
          }
        }
        break
      }
    }
  }

  /**
   * 处理服务端调用客户端能力的请求。
   * 根据 channel 找到本地 handler，执行后把结果或错误发回服务端。
   */
  private async onServerRequest(envelope: MessageEnvelope): Promise<void> {
    const handler = this.capabilityHandlers.get(envelope.channel!)
    if (!handler) {
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        error: { code: 'CHANNEL_NOT_FOUND', message: `No handler for: ${envelope.channel}` },
      }
      this.trySendEnvelope(this.ws, response)
      return
    }

    try {
      const result = await handler(...(envelope.args ?? []))
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        result,
      }
      this.trySendEnvelope(this.ws, response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        error: { code, message },
      }
      this.trySendEnvelope(this.ws, response)
    }
  }

  // -------------------------------------------------------------------------
  // 重连
  // -------------------------------------------------------------------------

  /**
   * 处理连接断开：保存重连状态、清理计时器、拒绝待处理请求、调度重连。
   * 如果是握手前断开，状态记为 failed；如果是已连接后断开，状态记为 disconnected。
   */
  private onDisconnect(closeEvent?: { code?: number; reason?: string; wasClean?: boolean }): void {
    if (this.clientId) {
      this.pendingReconnect = {
        clientId: this.clientId,
        lastSeq: this.lastSeenSeq,
      }
    }

    const manualReconnect = this.manualReconnectRequested
    this.manualReconnectRequested = false

    const wasConnected = this.connected
    this.connected = false
    this.clientId = null
    this.ws = null

    if (this.ackTimer) {
      clearInterval(this.ackTimer)
      this.ackTimer = null
    }

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer)
      this.backoffResetTimer = null
    }

    const closeInfo: TransportCloseInfo | undefined = closeEvent
      ? {
          code: Number.isFinite(closeEvent.code) ? closeEvent.code : undefined,
          reason: closeEvent.reason || undefined,
          wasClean: closeEvent.wasClean,
        }
      : undefined

    if (!this.connectError && closeInfo?.code) {
      const closeKind = this.classifyErrorKindFromCloseCode(closeInfo.code)
      if (closeKind !== 'unknown') {
        this.connectError = this.createConnectionError(
          closeKind,
          closeInfo.reason || `Connection closed (${closeInfo.code})`,
          `WS_CLOSE_${closeInfo.code}`,
        )
      }
    }

    // 拒绝所有待处理请求
    if (wasConnected) {
      for (const [id, req] of this.pending) {
        clearTimeout(req.timeout)
        req.reject(new Error('Connection lost'))
      }
      this.pending.clear()

      this.setConnectionState({
        status: 'disconnected',
        lastClose: closeInfo,
        attempt: this.reconnectAttempt,
      })
    } else {
      const err = this.connectError ?? new Error('Connection lost before handshake')
      this.failReady(err)

      this.setConnectionState({
        status: 'failed',
        lastError: this.toErrorState(err),
        lastClose: closeInfo,
        attempt: this.reconnectAttempt,
      })
    }

    if (manualReconnect && !this.destroyed) {
      this.connect()
      return
    }

    if (!this.destroyed && !this.permanentlyClosed && this.autoReconnect) {
      this.scheduleReconnect()
    }
  }

  /** 按指数退避调度下一次重连（1s → 2s → 4s …，封顶 maxReconnectDelay） */
  private scheduleReconnect(): void {
    if (this.permanentlyClosed) return

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    )

    this.reconnectAttempt++

    this.setConnectionState({
      status: 'reconnecting',
      attempt: this.reconnectAttempt,
      nextRetryInMs: delay,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** 连接稳定 10 秒后重置退避计数，避免短暂抖动导致退避无限增长 */
  private scheduleBackoffReset(): void {
    if (this.backoffResetTimer) clearTimeout(this.backoffResetTimer)
    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = null
      this.reconnectAttempt = 0
    }, 10_000)
  }

  /** 尽力发送：关闭/关闭中的 socket 会被跳过 */
  private trySendEnvelope(ws: WebSocket | null, envelope: MessageEnvelope): boolean {
    if (!ws || ws.readyState !== ws.OPEN) return false

    try {
      ws.send(serializeEnvelope(envelope))
      return true
    } catch {
      return false
    }
  }

  /** 定期发送 sequence_ack，让服务器可以清理已确认事件 */
  private startAckTimer(): void {
    if (this.ackTimer) clearInterval(this.ackTimer)
    this.ackTimer = setInterval(() => {
      if (this.connected && this.lastSeenSeq > 0) {
        const ack: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'sequence_ack',
          lastSeq: this.lastSeenSeq,
        }
        this.trySendEnvelope(this.ws, ack)
      }
    }, SEQUENCE_ACK_INTERVAL_MS)
  }

  /** 创建并缓存 ready Promise，供 invoke() 等待连接完成 */
  private createReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })

    // 握手失败可能发生在任何 invoke() 等待 ready 之前，挂一个 noop catch 避免未处理 rejection 警告
    this.readyPromise.catch(() => {})
  }

  /** 让当前 ready Promise 失败，并清理引用 */
  private failReady(error: Error): void {
    if (!this.rejectReady) return
    this.rejectReady(error)
    this.resolveReady = null
    this.rejectReady = null
    this.readyPromise = null
  }

  /**
   * 确保已连接：如未连接则触发连接并等待 ready。
   * 并发调用会共享同一个 ready Promise，避免重复建连。
   */
  private async ensureConnected(channel: string): Promise<void> {
    if (this.destroyed) {
      throw new Error(`Client destroyed (channel: ${channel})`)
    }

    if (this.connected && this.ws) return

    // 如果重连已经计划或进行中，等待它而不是取消退避计时器，
    // 这样可以防止并发 RPC 调用重置指数退避。
    if (this.readyPromise || this.reconnectTimer) {
      const ready = this.readyPromise
      if (!ready) {
        throw this.connectError ?? new Error(`Not connected (channel: ${channel})`)
      }
      try {
        await ready
      } catch (error) {
        throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`)
      }
      if (!this.connected || !this.ws) {
        throw new Error(`Not connected (channel: ${channel})`)
      }
      return
    }

    // 没有连接在进行中，主动发起
    this.connect()

    const ready = this.readyPromise
    if (!ready) {
      throw this.connectError ?? new Error(`Not connected (channel: ${channel})`)
    }

    try {
      await ready
    } catch (error) {
      throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`)
    }

    if (!this.connected || !this.ws) {
      throw new Error(`Not connected (channel: ${channel})`)
    }
  }

  // -------------------------------------------------------------------------
  // 内部辅助函数
  // -------------------------------------------------------------------------

  /** 根据 URL 推断本地或远程模式（127.0.0.1/localhost 视为本地） */
  private inferMode(url: string): TransportMode {
    if (url.startsWith('ws://127.0.0.1') || url.startsWith('ws://localhost')) {
      return 'local'
    }
    return 'remote'
  }

  /** 更新内部连接状态并通知所有状态监听器 */
  private setConnectionState(
    partial: Omit<Partial<TransportConnectionState>, 'mode' | 'url' | 'updatedAt'>,
  ): void {
    this.connectionState = {
      ...this.connectionState,
      ...partial,
      mode: this.mode,
      url: this.url,
      updatedAt: Date.now(),
    }

    const snapshot = this.getConnectionState()
    for (const cb of this.connectionStateListeners) {
      try {
        cb(snapshot)
      } catch {
        // listener 失败不能破坏传输层
      }
    }
  }

  /** 构造带 kind/code 的 Error，方便后续错误分类展示 */
  private createConnectionError(kind: TransportConnectionErrorKind, message: string, code?: string): Error {
    const err = new Error(message)
    ;(err as any).kind = kind
    if (code) (err as any).code = code
    return err
  }

  /** 把内部 Error 转成对外暴露的 TransportConnectionError 状态对象 */
  private toErrorState(err: Error): TransportConnectionError {
    const code = (err as any).code ? String((err as any).code) : undefined
    const kind = (err as any).kind as TransportConnectionErrorKind | undefined
      ?? this.classifyErrorKindFromCode(code)

    return {
      kind,
      message: err.message,
      code,
    }
  }

  /** 根据错误 code 推断错误分类（认证/协议/超时/网络/服务端/未知） */
  private classifyErrorKindFromCode(code?: unknown): TransportConnectionErrorKind {
    const normalized = typeof code === 'string' ? code.toUpperCase() : ''

    if (normalized === 'AUTH_FAILED') return 'auth'
    if (normalized === 'PROTOCOL_VERSION_UNSUPPORTED') return 'protocol'
    if (normalized === 'HANDSHAKE_TIMEOUT' || normalized === 'REQUEST_TIMEOUT' || normalized === 'CLIENT_REQUEST_TIMEOUT') {
      return 'timeout'
    }
    if (normalized.startsWith('WS_CLOSE_')) {
      const closeCode = parseInt(normalized.slice('WS_CLOSE_'.length), 10)
      return this.classifyErrorKindFromCloseCode(closeCode)
    }
    if (normalized === 'WS_ERROR') return 'network'
    if (normalized === 'CHANNEL_NOT_FOUND' || normalized === 'HANDLER_ERROR') return 'server'

    return 'unknown'
  }

  /** 根据 WebSocket 关闭 code 推断错误分类 */
  private classifyErrorKindFromCloseCode(code?: number): TransportConnectionErrorKind {
    if (!code) return 'unknown'

    if (code === 4005) return 'auth'
    if (code === 4004) return 'protocol'
    if (code === 4001) return 'timeout'

    // 1006 = 浏览器里的异常关闭/网络中断
    if (code === 1006 || code === 1001) return 'network'

    return 'unknown'
  }
}

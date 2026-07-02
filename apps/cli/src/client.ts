/**
 * CliRpcClient —— 面向 CLI 的最小 WebSocket RPC 客户端。
 *
 * 可以把它理解为 Go 里的一个轻量级 RPC 客户端：只负责“建立连接、发送请求、接收事件、退出”，
 * 没有自动重连、能力协商等复杂逻辑。底层通过 WebSocket 与服务端通信，
 * 用信封（MessageEnvelope）包装请求/响应/事件三种消息。
 */

import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@craft-agent/server-core/transport'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 尚未完成的 RPC 请求记录。类似 Go 里一个带超时和回调的 in-flight request map。 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 构造客户端时的可选配置。TS 中 interface 约等于 Go 的 struct（但不带方法）。 */
export interface CliClientOptions {
  token?: string
  workspaceId?: string
  requestTimeout?: number
  connectTimeout?: number
}

// ---------------------------------------------------------------------------
// 客户端类
// ---------------------------------------------------------------------------

export class CliRpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private _clientId: string | null = null
  private _connected = false
  private _destroyed = false

  private readonly url: string
  private readonly token: string | undefined
  private readonly workspaceId: string | undefined
  private readonly requestTimeout: number
  private readonly connectTimeout: number

  /** 构造函数：保存配置，默认各类超时 10 秒。 */
  constructor(url: string, opts?: CliClientOptions) {
    this.url = url
    this.token = opts?.token
    this.workspaceId = opts?.workspaceId
    this.requestTimeout = opts?.requestTimeout ?? 10_000
    this.connectTimeout = opts?.connectTimeout ?? 10_000
  }

  /** 连接服务端并完成握手，返回服务端分配的 clientId。 */
  async connect(): Promise<string> {
    if (this._destroyed) throw new Error('Client destroyed')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout (${this.connectTimeout}ms)`))
        this.ws?.close()
      }, this.connectTimeout)

      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        const handshake: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: this.workspaceId,
          token: this.token,
        }
        this.ws!.send(serializeEnvelope(handshake))
      }

      this.ws.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        let envelope: MessageEnvelope
        try {
          envelope = deserializeEnvelope(raw)
        } catch {
          return
        }

        if (envelope.type === 'handshake_ack') {
          clearTimeout(timer)
          this._clientId = envelope.clientId ?? null
          this._connected = true
          // 握手成功后切换成普通消息处理器，后续都是 response / event
          this.ws!.onmessage = (e) => {
            this.onMessage(typeof e.data === 'string' ? e.data : String(e.data))
          }
          resolve(this._clientId!)
        } else if (envelope.type === 'error') {
          clearTimeout(timer)
          const err = new Error(envelope.error?.message ?? 'Connection rejected')
          ;(err as any).code = envelope.error?.code
          reject(err)
        }
      }

      this.ws.onerror = () => {
        if (!this._connected) {
          clearTimeout(timer)
          reject(new Error('WebSocket connection error'))
        }
      }

      this.ws.onclose = () => {
        if (!this._connected) {
          clearTimeout(timer)
          reject(new Error('WebSocket closed before handshake'))
        }
        this._connected = false
        for (const [, req] of this.pending) {
          clearTimeout(req.timeout)
          req.reject(new Error('Disconnected'))
        }
        this.pending.clear()
      }
    })
  }

  /** 发送一条 RPC 请求并等待响应，超时会被拒绝。 */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!this._connected || !this.ws) {
      throw new Error(`Not connected (channel: ${channel})`)
    }

    return new Promise((resolve, reject) => {
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
      this.ws!.send(serializeEnvelope(envelope))
    })
  }

  /** 订阅某个频道的服务端推送事件，返回一个取消订阅函数。 */
  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)

    return () => {
      set!.delete(callback)
      if (set!.size === 0) this.listeners.delete(channel)
    }
  }

  /** 关闭连接并拒绝所有未完成的请求。 */
  destroy(): void {
    this._destroyed = true
    for (const [, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
    this.ws?.close()
    this.ws = null
    this._connected = false
  }

  /** 当前是否已连接到服务端。 */
  get isConnected(): boolean {
    return this._connected
  }

  /** 服务端握手成功后分配的 clientId。 */
  get clientId(): string | null {
    return this._clientId
  }

  // -------------------------------------------------------------------------
  // 内部消息路由
  // -------------------------------------------------------------------------

  /** 根据信封类型分发到响应处理或事件回调。 */
  private onMessage(raw: string): void {
    let envelope: MessageEnvelope
    try {
      envelope = deserializeEnvelope(raw)
    } catch {
      return
    }

    switch (envelope.type) {
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

      case 'event': {
        if (envelope.channel) {
          const set = this.listeners.get(envelope.channel)
          if (set) {
            for (const cb of set) {
              try {
                cb(...(envelope.args ?? []))
              } catch {
                // 监听器抛错不应影响客户端整体运行
              }
            }
          }
        }
        break
      }
    }
  }
}

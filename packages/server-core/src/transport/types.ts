/**
 * 基于 WebSocket 的 RPC 传输层接口。
 *
 * 可以把 RpcServer / RpcClient 理解为 gRPC 的 Server/Stub 的简化版：
 * - channel 相当于方法名
 * - invoke 相当于 request/response
 * - push 相当于 server-side streaming / broadcast
 */

import type { PushTarget } from '@craft-agent/shared/protocol'

/**
 * 每次 RPC 调用的上下文。
 *
 * 类似 Golang gRPC 的 ctx，携带客户端身份、当前工作区、WebContents ID 等。
 */
export interface RequestContext {
  clientId: string
  workspaceId: string | null
  webContentsId: number | null
}

/**
 * RPC handler 函数签名。
 *
 * 第一个参数固定是 RequestContext，后面是调用方传入的参数。
 */
export type HandlerFn = (ctx: RequestContext, ...args: any[]) => Promise<any> | any

/**
 * 服务端 RPC 接口。
 *
 * 这是 server-core 中所有 handler 依赖的 RpcServer 抽象，
 * 具体实现是 WsRpcServer（见 server.ts）。
 */
export interface RpcServer {
  /** 注册一个 RPC handler */
  handle(channel: string, handler: HandlerFn): void

  /** 向指定目标推送事件 */
  push(channel: string, target: PushTarget, ...args: any[]): void

  /** 调用某个客户端的能力 */
  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any>

  /** 更新客户端关联的工作区（可选） */
  updateClientWorkspace?(clientId: string, workspaceId: string): void

  /** 客户端是否在握手时声明了某能力 */
  hasClientCapability(clientId: string, capability: string): boolean

  /** 查找声明了某能力的客户端 */
  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[]
}

/**
 * 客户端 RPC 接口。
 *
 * 对应 Electron renderer 或 WebUI 里的 RPC 客户端。
 */
export interface RpcClient {
  /** 向服务端某个 channel 发起 RPC 调用，返回响应结果 */
  invoke(channel: string, ...args: any[]): Promise<any>
  /** 订阅某个 channel 的事件，返回取消订阅的函数 */
  on(channel: string, callback: (...args: any[]) => void): () => void
  /** 注册本地能力 handler，供服务端 invokeClient 调用 */
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void
}

/**
 * 事件 sink 类型。
 *
 * SessionManager 通过 EventSink 把 Agent 事件推送给所有客户端，
 * 不需要关心底层是 WS 还是本地 IPC。
 */
export type EventSink = (channel: string, target: PushTarget, ...args: any[]) => void

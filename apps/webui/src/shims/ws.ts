/**
 * ws 模块的浏览器垫片：浏览器直接使用原生 WebSocket。
 *
 * WsRpcServer 会 import WebSocketServer，但在浏览器里不会真正实例化。
 * 这个垫片只是为了满足打包器的静态分析。
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
export class WebSocketServer {
  constructor(_opts?: any) {
    throw new Error('WebSocketServer is not available in the browser')
  }
  on(_event: string, _fn: Function) { return this }
  close() {}
  address() { return null }
}

// 客户端复用浏览器原生 WebSocket
export const WebSocket = globalThis.WebSocket
export type { WebSocket as default }

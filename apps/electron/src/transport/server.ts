/**
 * 从 @craft-agent/server-core 重新导出 WebSocket RPC 服务端。
 *
 * Electron 主进程里会创建 WsRpcServer 实例，监听本地 WebSocket 端口，
 * 接收来自渲染进程或外部 worker 的 RPC 调用。
 */
export { WsRpcServer, type WsRpcServerOptions } from '@craft-agent/server-core/transport'

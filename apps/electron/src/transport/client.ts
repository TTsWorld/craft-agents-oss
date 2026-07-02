/**
 * 从 @craft-agent/server-core 重新导出 WebSocket RPC 客户端。
 *
 * WsRpcClient 原本写在 Electron 这一层，后来被下沉到 server-core 包里，
 * 这样子进程、服务、桥接层都可以复用，而不需要依赖 Electron 应用层。
 * 这里只是做了一层 re-export，保证旧的 import 路径继续可用。
 *
 * `export { type Xxx }` 里的 type 表示只导出类型，不导出运行时值。
 * 对 Golang 同学来说，这有点像 Go 里把别的包的类型在本包重新暴露出去。
 */
export {
  WsRpcClient,
  type WsRpcClientOptions,
  type TransportMode,
  type TransportConnectionStatus,
  type TransportConnectionErrorKind,
  type TransportConnectionError,
  type TransportCloseInfo,
  type TransportConnectionState,
} from '@craft-agent/server-core/transport'

/**
 * transport 模块入口：把本目录下的服务端、客户端、API 构造器统一导出。
 *
 * 其他代码只需要 `import { WsRpcClient, CHANNEL_MAP } from './transport'`
 * 即可拿到所有需要的内容，避免从各个子文件分别 import。
 * 这在 TS 项目里是很常见的“门面模式”（facade）。
 */
export { WsRpcServer, type WsRpcServerOptions } from './server'
export { WsRpcClient, type WsRpcClientOptions } from './client'
export { buildClientApi, type ChannelMap, type ChannelMapEntry } from './build-api'
export { CHANNEL_MAP } from './channel-map'
export type { RpcServer, RpcClient, RequestContext, HandlerFn, EventSink } from '@craft-agent/server-core/transport'

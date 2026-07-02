/**
 * @craft-agent/server-core 统一导出入口。
 *
 * 这个包是 Craft Agent 的服务端核心，作用类似 Golang 的 `internal/server`：
 * - transport：WebSocket RPC 传输层
 * - runtime：平台抽象（headless / electron）
 * - handlers：RPC handler 注册与依赖
 * - bootstrap：服务器启动、健康检查
 */
export * from './transport/index.ts'
export * from './runtime/index.ts'
export * from './handlers/index.ts'
export * from './bootstrap/index.ts'

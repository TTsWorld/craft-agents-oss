/**
 * webui/index.ts
 *
 * WebUI 模块的对外入口（barrel file）。
 *
 * 作用：把分散在 `http-server.ts`、`node-adapter.ts`、`auth.ts` 里的公共 API
 * 集中导出，让上层代码只需 `import { ... } from '../webui'`。
 *
 * 与 Go 的类比：
 * - 类似 Go 项目里的 `pkg/webui/webui.go`，只做 `export` / `re-export`，
 *   不实现具体逻辑。
 *
 * TypeScript 要点：
 * - `export { ... } from './module'` 是 re-export 语法，编译后不会增加运行时开销；
 * - `type` 关键字在 re-export 时可以显式说明导出的是类型，帮助编译器做 tree-shaking。
 */

export { startWebuiHttpServer, createWebuiHandler, type WebuiHttpServerOptions, type WebuiHandlerOptions, type WebuiHandler } from './http-server'
export { nodeHttpAdapter } from './node-adapter'
export { validateSession, extractSessionCookie } from './auth'

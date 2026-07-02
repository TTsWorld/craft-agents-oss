/**
 * handlers 模块入口。
 *
 * 这里集中导出 RPC handler 的依赖类型和辅助工具：
 * - HandlerDeps：所有 handler 共享的依赖包
 * - 各种接口（ISessionManager、IOAuthFlowStore、IBrowserPaneManager 等）
 * - utils：handler 通用工具函数
 */
export type * from './handler-deps.ts'
export type * from './session-manager-interface.ts'
export type * from './oauth-flow-store-interface.ts'
export type * from './browser-pane-manager-interface.ts'
export type * from './window-manager-interface.ts'
export type * from './messaging-registry-interface.ts'
export * from './utils.ts'

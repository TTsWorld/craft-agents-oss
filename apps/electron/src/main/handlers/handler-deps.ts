/**
 * HandlerDeps —— 所有 IPC 处理函数（handler）的依赖包。
 *
 * 这是 server-core 里通用 HandlerDeps 的 Electron 具体化版本。
 * 可以理解为 Golang 里的一个「服务上下文 / 依赖注入容器」：
 * 把 SessionManager、WindowManager、BrowserPaneManager 等实例打包传给 handler。
 */

import type { HandlerDeps as BaseHandlerDeps } from '@craft-agent/server-core/handlers'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import type { WindowManager } from '../window-manager'
import type { BrowserPaneManager } from '../browser-pane-manager'
import type { OAuthFlowStore } from '@craft-agent/shared/auth'

// type 别名：给 BaseHandlerDeps 填上 Electron 侧需要的四个泛型参数。
// 泛型就像 Go interface{} 或模板，BaseHandlerDeps<...> 把具体类型填进去。
export type HandlerDeps = BaseHandlerDeps<
  SessionManager,
  OAuthFlowStore,
  WindowManager,
  BrowserPaneManager
>

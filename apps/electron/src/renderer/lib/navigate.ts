/**
 * 导航工具
 *
 * 提供统一的 `navigate()` 函数用于应用内部跳转。
 * 实现方式是派发一个自定义事件，由 NavigationContext 监听并处理。
 *
 * 用法：
 *   import { navigate, routes } from '@/lib/navigate'
 *
 *   navigate(routes.tab.settings())
 *   navigate(routes.action.newChat({ agentId: 'claude' }))
 *   navigate(routes.view.allSessions())
 */

import { routes, type Route } from '../../shared/routes'

// 为了使用方便，重新导出 routes
export { routes }
export type { Route }

// 内部导航使用的事件名
export const NAVIGATE_EVENT = 'craft-agent-navigate'

export interface NavigateOptions {
  /** 在新面板中打开目标，而不是在当前面板导航 */
  newPanel?: boolean
  /**
   * 新面板打开时的目标 lane，故意保持通用，不绑定浏览器特性，
   * 方便后续新增 lane 类型复用同一套 API。
   */
  targetLaneId?: 'main'
  /** 跳转到列表视图时自动选中第一项（关闭面板时使用） */
  skipAutoSelect?: boolean
}

/**
 * 跳转到指定路由。
 *
 * 派发一个自定义事件，NavigationContext 会监听并执行实际导航。
 * 可以在应用任何地方调用。
 */
export function navigate(route: Route, options?: NavigateOptions): void {
  const event = new CustomEvent(NAVIGATE_EVENT, {
    detail: { route, ...options },
    bubbles: true,
  })
  window.dispatchEvent(event)
}

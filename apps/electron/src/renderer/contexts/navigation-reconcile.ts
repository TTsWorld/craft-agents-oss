// 面板路由 URL 协调工具
// 作用：当用户通过 URL 刷新或前进/回退回到某个列表页时，自动把它升级成
// 带具体选中项的详情页（例如 allSessions → allSessions/session/{id}）。

import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'
import type { NavigationState } from '../../shared/types'

/**
 * 自动选择解析器类型。
 *
 * 给定当前 NavigationState，返回处理后的 NavigationState。
 * 可以理解为 Go 里的函数签名类型：func(state NavigationState) NavigationState。
 */
export type AutoSelectionResolver = (state: NavigationState) => NavigationState

/**
 * 在 URL 协调阶段对面板路由做规范化。
 *
 * 某些路由只是过滤器/列表（如 allSessions），URL 协调时会按照与普通导航
 * 相同的“自动选择第一条”策略，把它升级成标准的详情路由
 *（如 allSessions/session/{id}）。
 */
export function normalizePanelRouteForReconcile(
  route: ViewRoute,
  resolveAutoSelection: AutoSelectionResolver,
): ViewRoute {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return route

  // 如果 URL 里已经明确带 details，就原样保留，不要自动选择覆盖它。
  if ('details' in navState && navState.details) {
    return route
  }

  const resolved = resolveAutoSelection(navState)
  return buildRouteFromNavigationState(resolved) as ViewRoute
}

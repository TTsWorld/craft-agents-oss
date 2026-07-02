/**
 * 导航辅助函数
 *
 * 针对 `NavigationState` 的小型纯函数工具。保持无状态、不引入 React/Jotai，
 * 既能在 hook（PanelStackContainer）中使用，也能在同步回调（CompactBackButton）中使用。
 */

import type { NavigationState } from '../../shared/types'

/**
 * 判断当前聚焦面板的导航状态是否处于“详情”模式——即用户已经从导航列表钻取到具体项。
 *
 * 紧凑模式布局用它来决定是只显示导航列表，还是只显示内容并叠加返回按钮。
 *
 * 各 navigator 的语义：
 * - sessions：已选中某个 session
 * - settings：已选中某个子页面（纯 settings 路由 → false）
 * - sources / skills / automations：已选中某个详情项
 */
export function isDetailNavState(navState: NavigationState | null): boolean {
  if (!navState) return false
  switch (navState.navigator) {
    case 'sessions':
      return navState.details !== null
    case 'settings':
      return navState.subpage !== null
    case 'sources':
    case 'skills':
    case 'automations':
    case 'projects':
      return navState.details !== null
  }
}

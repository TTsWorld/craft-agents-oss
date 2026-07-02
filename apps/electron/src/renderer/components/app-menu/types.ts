import type { SettingsMenuItem } from '../../../shared/menu-schema'

/** app-menu 目录下 DesktopAppMenu / MobileAppMenu 共享的 props 类型。 */

/**
 * DesktopAppMenu 与 MobileAppMenu 共用的 Props。
 *
 * 该组件只负责 Craft logo 触发器及其下拉菜单/全屏抽屉；
 * 前进/后退导航直接写在 TopBar.tsx 里，不经过这里。
 */
export interface AppMenuProps {
  onNewChat: () => void
  onNewWindow?: () => void
  onOpenSettings: () => void
  /** 打开某一项设置子页面。 */
  onOpenSettingsSubpage: (subpage: SettingsMenuItem['id']) => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onToggleSidebar?: () => void
  onToggleFocusMode?: () => void
}

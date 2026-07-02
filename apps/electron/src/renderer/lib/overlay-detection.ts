import { getDismissibleLayerBridge } from './dismissible-layer-bridge'

/**
 * 浮层检测工具
 *
 * 检测当前是否有浮层（dialog、drawer、menu、popover 等）处于打开状态。
 * 用于防止 Esc 键在浮层应该优先处理时误触发聊天中断。
 */

/**
 * 浮层内容元素的 CSS 选择器。
 * 这些是实际可见的内容元素，不是 portal 或根节点。
 * 使用 UI 组件中 data-slot 属性（shadcn/radix 风格）。
 */
const OVERLAY_SELECTORS = [
  // Dialog（模态框）
  '[data-slot="dialog-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',

  // Drawer（滑入面板）
  '[data-slot="drawer-content"]',

  // Dropdown menu
  '[data-slot="dropdown-menu-content"]',

  // Context menu（右键菜单）
  '[data-slot="context-menu-content"]',

  // Popover
  '[data-slot="popover-content"]',

  // Select 下拉
  '[data-slot="select-content"]',

  // Command palette（在 dialog 内部打开时会被 dialog 选择器捕获；
  // 独立 command 菜单需要：'[data-slot="command"]'

  // 内联菜单（@mention、/slash、#label 自动补全）
  '[data-inline-menu]',

  // @craft-agent/ui Island 原语中的 dialog 模式岛屿
  '[data-ca-island-dialog="true"][data-state="open"]',
]

/**
 * 检查当前 DOM 中是否有打开的浮层。
 * 返回 true 表示检测到浮层，false 表示没有。
 *
 * Esc 键处理程序用它来决定 Esc 应该触发聊天中断，还是交给浮层处理。
 */
export function hasOpenOverlay(): boolean {
  const bridge = getDismissibleLayerBridge()
  if (bridge?.hasOpenLayers()) {
    return true
  }

  const selector = OVERLAY_SELECTORS.join(', ')
  return document.querySelector(selector) !== null
}

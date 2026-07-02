/**
 * panel-constants.ts
 *
 * 定义 AppShell 面板布局的常量：间距、圆角、分隔条（sash）尺寸等。
 * 这些常量被 PanelStackContainer、PanelSlot、PanelResizeSash 等组件共享，
 * 保证侧边栏/导航栏/内容面板之间的缝隙对齐。
 */

import { isMac } from '@/lib/platform'

/** 任意相邻面板之间的间隙（sidebar ↔ navigator ↔ content ↔ right sidebar） */
export const PANEL_GAP = 6

/** 最外层面板到窗口边缘的内边距（右侧、底部、左侧未显示 sidebar 时） */
export const PANEL_EDGE_INSET = 6

/** 面板接触窗口边界处的圆角（macOS 原生圆角更大） */
export const RADIUS_EDGE = isMac ? 14 : 8

/** 面板之间内部拐角的圆角 */
export const RADIUS_INNER = 10

/** 内容面板的最小宽度 */
export const PANEL_MIN_WIDTH = 440

/** 面板堆栈为阴影预留的额外垂直空间 */
export const PANEL_STACK_VERTICAL_OVERFLOW = 8

/**
 * 分隔条（sash）的共享几何参数。
 *
 * 所有缝隙（sidebar、navigator/content、panel/panel）都通过这组常量派生偏移量，
 * 避免写死像素值导致对不齐。
 */
export const PANEL_SASH_HIT_WIDTH = 8

/** 分隔条可见线条的宽度 */
export const PANEL_SASH_LINE_WIDTH = 2

/**
 * 分隔条插入两个 flex item 之间时，flex gap 会被应用两次（item↔sash 和 sash↔item）。
 * 两侧各回退半个 gap，让视觉间距保持正好等于 PANEL_GAP。
 */
export const PANEL_SASH_FLEX_MARGIN = -(PANEL_GAP / 2)

/** 分隔条容器以缝隙为中心时用到的一半命中宽度 */
export const PANEL_SASH_HALF_HIT_WIDTH = PANEL_SASH_HIT_WIDTH / 2

/**
 * StoplightContext（红绿灯补偿上下文）
 *
 * 在 macOS 上，窗口左上角有红/黄/绿三个交通灯按钮。
 * 当应用进入“专注模式”或自定义标题栏时，页面内容可能需要向右缩进，
 * 避免和这三个按钮重叠。
 *
 * 这个 Context 提供一个布尔值，子组件（如 PanelHeader）读取后自动加上左侧内边距。
 * MainContentPanel 用它把专注模式状态广播给所有页面，避免每个页面都手动处理。
 */

import { createContext, useContext } from 'react'

// 创建 Context，默认 false 表示不需要补偿
const StoplightContext = createContext(false)

// 直接导出 Provider，外部用 <StoplightProvider value={true}> 包裹需要补偿的子树
export const StoplightProvider = StoplightContext.Provider

/**
 * 读取是否需要为 macOS 交通灯做左侧缩进补偿
 * 返回 true 时，内容应留出左上角按钮的安全距离。
 */
export function useCompensateForStoplight(): boolean {
  return useContext(StoplightContext)
}

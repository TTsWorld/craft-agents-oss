/**
 * ShikiCodeViewer - 可移植 ShikiCodeViewer 的 Electron 封装层
 *
 * 这个薄封装从 @craft-agent/ui 引入可移植组件，
 * 并把它连接到 Electron 的 ThemeContext 与预设主题。
 */

import * as React from 'react'
import { ShikiCodeViewer as BaseShikiCodeViewer, type ShikiCodeViewerProps as BaseProps } from '@craft-agent/ui'
import { useTheme } from '@/hooks/useTheme'

// 复用基础组件的 props，但去掉 theme / shikiTheme，由当前组件内部决定
export interface ShikiCodeViewerProps extends Omit<BaseProps, 'theme' | 'shikiTheme'> {}

/**
 * ShikiCodeViewer - 带语法高亮和行号的代码查看器
 * 已接入 Electron 的主题上下文与预设主题。
 */
export function ShikiCodeViewer(props: ShikiCodeViewerProps) {
  // 从主题上下文读取当前是深色模式还是浅色模式，以及 Shiki 主题名
  const { isDark, shikiTheme } = useTheme()

  return <BaseShikiCodeViewer {...props} theme={isDark ? 'dark' : 'light'} shikiTheme={shikiTheme} />
}

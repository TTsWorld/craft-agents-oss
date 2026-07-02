/**
 * ShikiDiffViewer - 可移植 ShikiDiffViewer 的 Electron 封装层
 *
 * 把基础组件连接到 Electron 的 ThemeContext，
 * 传入应用当前使用的 Shiki 主题（如 dracula、nord），
 * 让 diff 查看器使用相同的语法高亮主题。
 * 没有配置 Shiki 主题时，会回退到 craft-dark / craft-light（透明背景）。
 */

import * as React from 'react'
import { ShikiDiffViewer as BaseShikiDiffViewer, type ShikiDiffViewerProps as BaseProps } from '@craft-agent/ui'
import { useTheme } from '@/hooks/useTheme'

// 复用基础组件的 props，但去掉 theme / shikiTheme，由当前组件内部决定
export interface ShikiDiffViewerProps extends Omit<BaseProps, 'theme' | 'shikiTheme'> {}

/**
 * ShikiDiffViewer - 基于 Shiki 的 diff 查看组件
 * 已接入 Electron 的主题上下文，会把应用的 Shiki 主题传给底层组件，
 * 使 diff 查看器使用匹配的语法主题（如 dracula、nord）。
 */
export function ShikiDiffViewer(props: ShikiDiffViewerProps) {
  // 从主题上下文读取当前是深色模式还是浅色模式，以及 Shiki 主题名
  const { isDark, shikiTheme } = useTheme()

  return <BaseShikiDiffViewer {...props} theme={isDark ? 'dark' : 'light'} shikiTheme={shikiTheme} />
}

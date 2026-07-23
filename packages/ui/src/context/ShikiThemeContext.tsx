/**
 * ShikiThemeContext - 向代码块提供当前的 Shiki 语法高亮主题
 *
 * 该上下文解决一个主题边界场景：当使用仅暗色的主题（如 Ghostty），
 * 系统模式设为 "auto" 且操作系统处于亮色模式时，DOM 上带有 "light" class，
 * 但代码块仍应使用暗色 shiki 主题（例如 vitesse-dark）。
 *
 * 若无此上下文，CodeBlock 会检查 document.documentElement.classList，
 * 从而错误地使用 github-light 而非主题所配置的 shiki 主题。
 *
 * shikiTheme 的值来自 useTheme()，后者会正确处理：
 * - 主题的 shikiTheme 配置（如 { light: 'github-light', dark: 'vitesse-dark' }）
 * - 主题的 supportedModes（仅暗色主题即便在 "light" 系统模式下也使用暗色 shiki）
 * - Scenic 模式（强制暗色）
 */

import { createContext, useContext, type ReactNode } from 'react'

interface ShikiThemeContextValue {
  /**
   * 当前用于语法高亮的 Shiki 主题名称。
   * 例如：'github-light'、'github-dark'、'vitesse-dark'、'one-dark-pro'
   */
  shikiTheme: string | null
}

const ShikiThemeContext = createContext<ShikiThemeContextValue>({ shikiTheme: null })

export interface ShikiThemeProviderProps {
  children: ReactNode
  /**
   * 来自 useTheme() 的 Shiki 主题名称。传入 null 则使用默认的基于 DOM 的检测。
   */
  shikiTheme: string | null
}

/**
 * ShikiThemeProvider - 包装组件以提供正确的 Shiki 主题
 *
 * 用法：
 * ```tsx
 * const { shikiTheme } = useTheme({ appTheme })
 *
 * <ShikiThemeProvider shikiTheme={shikiTheme}>
 *   <SessionViewer />
 * </ShikiThemeProvider>
 * ```
 */
export function ShikiThemeProvider({ children, shikiTheme }: ShikiThemeProviderProps) {
  return (
    <ShikiThemeContext.Provider value={{ shikiTheme }}>
      {children}
    </ShikiThemeContext.Provider>
  )
}

/**
 * useShikiTheme - 在组件中访问当前的 Shiki 主题
 *
 * 当不存在 Provider 时返回 null，允许 CodeBlock 回退到基于 DOM 的检测以保持向后兼容。
 */
export function useShikiTheme(): string | null {
  const { shikiTheme } = useContext(ShikiThemeContext)
  return shikiTheme
}

export default ShikiThemeContext

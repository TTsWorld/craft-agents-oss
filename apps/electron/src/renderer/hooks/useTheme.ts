import { useMemo } from 'react'
import {
  resolveTheme,
  DEFAULT_THEME,
  type ThemeOverrides,
  type ThemeFile,
  type ShikiThemeConfig,
} from '@config/theme'
import { useTheme as useThemeContext } from '@/context/ThemeContext'

interface UseThemeOptions {
  /**
   * 应用级主题覆盖（来自 ~/.craft-agent/theme.json）。
   * 传入后会与上下文中的预设主题合并。
   */
  appTheme?: ThemeOverrides | null
}

interface UseThemeResult {
  theme: ThemeOverrides
  defaultTheme: ThemeOverrides
  shikiTheme: string
  shikiConfig: ShikiThemeConfig
  presetTheme: ThemeFile | null
  isDark: boolean
  /** 是否为风景模式（带背景图片与玻璃面板） */
  isScenic: boolean
}

/**
 * 读取 ThemeContext 中已解析的主题状态。
 *
 * ThemeProvider 负责加载主题与操作 DOM；本 hook 只读取结果值，
 * 不做异步加载，也不在组件里产生副作用。
 *
 * 可传入 appTheme 与预设主题合并（用于应用级覆盖）。
 *
 * @example
 * ```tsx
 * // 简单用法
 * const { isDark, shikiTheme } = useTheme()
 *
 * // 带应用级覆盖
 * const [appTheme] = useAtom(appThemeAtom)
 * const { theme } = useTheme({ appTheme })
 * ```
 */
export function useTheme({ appTheme }: UseThemeOptions = {}): UseThemeResult {
  const context = useThemeContext()

  // 如果有 appTheme，与预设主题合并；否则直接使用上下文的解析结果
  const theme = useMemo(() => {
    if (appTheme && context.presetTheme) {
      // 合并：预设 + 应用覆盖
      return resolveTheme({ ...context.presetTheme, ...appTheme })
    }
    if (appTheme) {
      // 没有预设，只有应用覆盖
      return resolveTheme(appTheme)
    }
    // 直接使用上下文的解析主题
    return context.resolvedTheme
  }, [context.presetTheme, context.resolvedTheme, appTheme])

  return {
    theme,
    defaultTheme: DEFAULT_THEME,
    shikiTheme: context.shikiTheme,
    shikiConfig: context.shikiConfig,
    presetTheme: context.presetTheme,
    isDark: context.isDark,
    isScenic: context.isScenic,
  }
}

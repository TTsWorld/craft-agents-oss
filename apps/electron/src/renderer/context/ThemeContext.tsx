import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import * as storage from '@/lib/local-storage'
import {
  resolveTheme,
  themeToCSS,
  DEFAULT_THEME,
  DEFAULT_SHIKI_THEME,
  getShikiTheme,
  type ThemeOverrides,
  type ThemeFile,
  type ShikiThemeConfig,
} from '@config/theme'

// 主题模式：light 亮色、dark 暗色、system 跟随系统
export type ThemeMode = 'light' | 'dark' | 'system'
// 字体族：inter 或系统默认字体
export type FontFamily = 'inter' | 'system'

/**
 * ThemeContext 提供的值的类型
 *
 * 这里用 interface 描述 Context 的“数据合同”，和 Go 的 struct 类似，
 * 但 TS 的 interface 主要用于编译期类型检查，不会生成运行时代码。
 */
interface ThemeContextType {
  // 应用级偏好（持久化到本地存储）
  /** 当前主题模式：light 亮色 / dark 暗色 / system 跟随系统 */
  mode: ThemeMode
  /** 应用级默认颜色主题（工作空间没有覆盖时使用） */
  colorTheme: string
  /** 当前字体：inter 或系统默认字体 */
  font: FontFamily
  /** 设置主题模式并持久化到本地存储 */
  setMode: (mode: ThemeMode) => void
  /** 设置应用级默认颜色主题 */
  setColorTheme: (theme: string) => void
  /** 设置字体并持久化到本地存储 */
  setFont: (font: FontFamily) => void

  // 工作空间级主题覆盖
  /** 当前工作空间 ID（null 表示没有工作空间上下文） */
  activeWorkspaceId: string | null
  /** 工作空间特定的颜色主题覆盖（null 表示继承应用默认值） */
  workspaceColorTheme: string | null
  /** 设置工作空间特定的颜色主题覆盖（null 表示继承） */
  setWorkspaceColorTheme: (theme: string | null) => void

  // 派生/计算值
  /** 实际解析后的亮/暗模式（system 模式会转为系统偏好） */
  resolvedMode: 'light' | 'dark'
  /** 系统当前的亮/暗偏好（来自 matchMedia 或 Electron IPC） */
  systemPreference: 'light' | 'dark'
  /** 实际生效的颜色主题：previewColorTheme ?? workspaceColorTheme ?? colorTheme */
  effectiveColorTheme: string
  /** 临时预览主题（悬停时），不会持久化 */
  previewColorTheme: string | null
  /** 设置临时预览主题；传入 null 清除预览 */
  setPreviewColorTheme: (theme: string | null) => void
  /** 当前 effectiveColorTheme 是从哪里来的 */
  effectiveColorThemeSource: 'preview' | 'workspace' | 'app'
  /** 预设主题是如何解析出来的 */
  themeResolvedFrom: 'none' | 'ipc' | 'fallback'
  /** 非致命的主题加载错误；正常加载时为 null */
  themeLoadError: string | null

  // 主题解析（单例，只加载一次）
  /** 已加载的预设主题文件；默认主题或加载中为 null */
  presetTheme: ThemeFile | null
  /** 完全解析后的主题（预设合并所有覆盖项） */
  resolvedTheme: ThemeOverrides
  /** 当前是否处于暗色模式（scenic 主题强制暗色） */
  isDark: boolean
  /** 当前是否是 scenic 模式（背景图 + 玻璃面板） */
  isScenic: boolean
  /** 当前模式对应的 Shiki 代码高亮主题名 */
  shikiTheme: string
  /** Shiki 主题配置（包含亮/暗变体） */
  shikiConfig: ShikiThemeConfig
}

// 本地持久化的主题数据格式
interface StoredTheme {
  mode: ThemeMode
  colorTheme: string
  font?: FontFamily
  /** 当用户通过 UI 显式修改主题时为 true（启动时不会自动保存） */
  isUserOverride?: boolean
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

/**
 * import.meta.glob 是 Vite 提供的批量导入语法：
 * 它会自动把 ../../../resources/themes/*.json 下所有 JSON 文件打包进来。
 * eager: true 表示同步加载；import: 'default' 表示取每个模块的 default 导出。
 * 结果类型用 as 断言为 Record<string, ThemeFile>。
 */
const bundledThemeModules = import.meta.glob('../../../resources/themes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, ThemeFile>

/**
 * 从批量导入结果构建 id -> ThemeFile 的 Map
 * 文件名去掉 .json 扩展名作为主题 id。
 */
const BUNDLED_THEMES = new Map<string, ThemeFile>(
  Object.entries(bundledThemeModules).map(([path, theme]) => {
    const fileName = path.split('/').pop() ?? ''
    const id = fileName.replace('.json', '')
    return [id, theme]
  })
)

// ThemeProvider 的 props
interface ThemeProviderProps {
  /** 被 Provider 包裹的子组件树 */
  children: ReactNode
  /** 默认主题模式；本地没有持久化值时使用 */
  defaultMode?: ThemeMode
  /** 默认颜色主题 id；本地没有持久化值时使用 */
  defaultColorTheme?: string
  /** 默认字体；本地没有持久化值时使用 */
  defaultFont?: FontFamily
  /** 用于工作空间级主题覆盖的当前工作空间 ID */
  activeWorkspaceId?: string | null
}

/**
 * 获取系统当前是亮色还是暗色偏好
 */
function getSystemPreference(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

/**
 * 从 localStorage 读取保存的主题设置
 */
function loadStoredTheme(): StoredTheme | null {
  if (typeof window === 'undefined') return null
  return storage.get<StoredTheme | null>(storage.KEYS.theme, null)
}

/**
 * 把主题设置保存到 localStorage
 */
function saveTheme(theme: StoredTheme): void {
  storage.set(storage.KEYS.theme, theme)
}

/**
 * ThemeProvider：管理整个应用的主题状态
 *
 * 包括：
 * - 应用级主题偏好（模式、颜色主题、字体）的读取和持久化
 * - 工作空间级主题覆盖
 * - 系统主题监听和跨窗口同步
 * - 预设主题加载、CSS 变量注入、DOM 属性更新
 * - Shiki 代码高亮主题选择
 */
export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultColorTheme = 'default',
  defaultFont = 'system',
  activeWorkspaceId = null
}: ThemeProviderProps) {
  const stored = loadStoredTheme()

  // === 偏好状态（应用级持久化） ===
  const [mode, setModeState] = useState<ThemeMode>(stored?.mode ?? defaultMode)
  // 只有用户通过 UI 显式设置过主题时，才使用 localStorage 里的 colorTheme
  const [colorTheme, setColorThemeState] = useState<string>(() => {
    if (stored?.isUserOverride && stored.colorTheme) {
      return stored.colorTheme
    }
    return defaultColorTheme // 后续会被 config.json 的 effect 更新
  })
  const [font, setFontState] = useState<FontFamily>(stored?.font ?? defaultFont)
  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(getSystemPreference)
  const [previewColorTheme, setPreviewColorTheme] = useState<string | null>(null)

  // === 工作空间级主题覆盖 ===
  const [workspaceColorTheme, setWorkspaceColorThemeState] = useState<string | null>(null)

  // 标记是否正在接收外部窗口的同步更新，避免回环广播
  const isExternalUpdate = useRef(false)

  // 挂载时从 config.json 加载应用级 colorTheme（仅当用户没有手动覆盖时）
  useEffect(() => {
    // 如果用户已经通过 UI 显式设置过主题，跳过
    if (stored?.isUserOverride) return

    window.electronAPI?.getColorTheme?.().then((configTheme) => {
      if (configTheme && configTheme !== 'default') {
        setColorThemeState(configTheme)
      }
    }).catch(() => {
      // 出错时保持默认
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 只在挂载时运行一次

  // === 预设主题状态（单例） ===
  const [presetTheme, setPresetTheme] = useState<ThemeFile | null>(null)
  const [themeResolvedFrom, setThemeResolvedFrom] = useState<'none' | 'ipc' | 'fallback'>('none')
  const [themeLoadError, setThemeLoadError] = useState<string | null>(null)

  // === 派生值 ===
  // system 模式时以系统偏好为准
  const resolvedMode = mode === 'system' ? systemPreference : mode
  // 实际生效主题：预览 > 工作空间覆盖 > 应用默认
  const effectiveColorTheme = previewColorTheme ?? workspaceColorTheme ?? colorTheme
  const effectiveColorThemeSource: 'preview' | 'workspace' | 'app' =
    previewColorTheme !== null ? 'preview' : workspaceColorTheme !== null ? 'workspace' : 'app'
  const isDarkFromMode = resolvedMode === 'dark'

  // 工作空间切换时加载其主题覆盖
  useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceColorThemeState(null)
      return
    }

    window.electronAPI?.getWorkspaceColorTheme?.(activeWorkspaceId).then((theme) => {
      setWorkspaceColorThemeState(theme)
    }).catch(() => {
      setWorkspaceColorThemeState(null)
    })
  }, [activeWorkspaceId])

  // 当 effectiveColorTheme 变化时加载预设主题（单例：只在 ThemeContext 里加载，不在 useTheme 里重复加载）
  useEffect(() => {
    let cancelled = false

    const applyFallback = (reason: string) => {
      const fallbackTheme = BUNDLED_THEMES.get(effectiveColorTheme)
      if (fallbackTheme) {
        if (!cancelled) {
          setPresetTheme(fallbackTheme)
          setThemeResolvedFrom('fallback')
          setThemeLoadError(reason)
        }
        console.warn(`[ThemeContext] ${reason} Falling back to bundled theme: ${effectiveColorTheme}`)
        return
      }

      if (!cancelled) {
        setPresetTheme(null)
        setThemeResolvedFrom('none')
        setThemeLoadError(reason)
      }
      console.error(`[ThemeContext] ${reason} No bundled fallback found for: ${effectiveColorTheme}`)
    }

    if (!effectiveColorTheme || effectiveColorTheme === 'default') {
      setPresetTheme(null)
      setThemeResolvedFrom('none')
      setThemeLoadError(null)
      return () => {
        cancelled = true
      }
    }

    // 先通过 IPC（应用级）加载预设主题，失败则回退到内置主题。
    // playground/浏览器模式下 electronAPI 可能存在但 loadPresetTheme 不存在。
    const loadPresetTheme = window.electronAPI?.loadPresetTheme
    if (!loadPresetTheme) {
      applyFallback(`electronAPI.loadPresetTheme is unavailable for "${effectiveColorTheme}".`)
      return () => {
        cancelled = true
      }
    }

    loadPresetTheme(effectiveColorTheme).then((preset) => {
      if (cancelled) return

      if (preset?.theme) {
        setPresetTheme(preset.theme)
        setThemeResolvedFrom('ipc')
        setThemeLoadError(null)
        return
      }

      applyFallback(`Preset theme was not returned by IPC for "${effectiveColorTheme}".`)
    }).catch((error) => {
      applyFallback(`Failed to load preset theme via IPC for "${effectiveColorTheme}": ${error instanceof Error ? error.message : String(error)}.`)
    })

    return () => {
      cancelled = true
    }
  }, [effectiveColorTheme])

  // 解析主题（预设 → 最终覆盖值）
  const resolvedTheme = useMemo(() => {
    return resolveTheme(presetTheme ?? undefined)
  }, [presetTheme])

  // 判断是否是 scenic 模式：需要 mode 为 scenic 且设置了背景图
  const isScenic = useMemo(() => {
    return resolvedTheme.mode === 'scenic' && !!resolvedTheme.backgroundImage
  }, [resolvedTheme])

  // 强制暗色的主题（例如 Dracula）无论系统模式如何都使用暗色
  const isDarkOnlyTheme = presetTheme?.supportedModes?.length === 1 && presetTheme.supportedModes[0] === 'dark'

  // isDark 反映最终视觉：scenic、强制暗色主题，或系统暗色
  const isDark = isScenic || isDarkOnlyTheme ? true : isDarkFromMode

  // Shiki 主题配置
  const shikiConfig = useMemo(() => {
    return presetTheme?.shikiTheme || DEFAULT_SHIKI_THEME
  }, [presetTheme])

  // 根据当前模式获取对应的 Shiki 主题名
  const shikiTheme = useMemo(() => {
    const supportedModes = presetTheme?.supportedModes
    const currentMode = isDark ? 'dark' : 'light'

    // 如果主题支持的模式有限，且不支持当前模式，就用它支持的那个模式
    if (supportedModes && supportedModes.length > 0 && !supportedModes.includes(currentMode)) {
      const effectiveMode = supportedModes[0] === 'dark'
      return getShikiTheme(shikiConfig, effectiveMode)
    }

    return getShikiTheme(shikiConfig, isDark)
  }, [shikiConfig, isDark, presetTheme])

  // === DOM 效果（单例：所有主题相关的 DOM 操作都在这里） ===

  // 应用基础主题 class 和 data 属性
  useEffect(() => {
    const root = document.documentElement

    // 应用字体
    if (font === 'inter') {
      root.dataset.font = 'inter'
    } else {
      delete root.dataset.font
    }

    // 应用颜色主题 data 属性
    if (effectiveColorTheme && effectiveColorTheme !== 'default') {
      root.dataset.theme = effectiveColorTheme
    } else {
      delete root.dataset.theme
    }

    // 始终开启主题覆盖，用于半透明背景（vibrancy 效果）
    root.dataset.themeOverride = 'true'
  }, [effectiveColorTheme, font])

  // 应用暗/亮 class 和主题相关的 DOM 属性
  // 在预设加载或模式变化时执行
  useEffect(() => {
    const root = document.documentElement

    // 强制暗色主题会覆盖系统模式
    const isDarkOnlyTheme = presetTheme?.supportedModes?.length === 1 && presetTheme.supportedModes[0] === 'dark'

    // 应用模式 class
    // scenic 和强制暗色主题都强制使用 dark
    const effectiveMode = (isScenic || isDarkOnlyTheme) ? 'dark' : resolvedMode
    root.classList.remove('light', 'dark')
    root.classList.add(effectiveMode)

    // 处理 themeMismatch：在以下情况设置实心背景
    // 1. 主题不支持当前模式（例如 Dracula 强制暗色但当前是亮色），或
    // 2. 解析后的模式和系统偏好不一致（vibrancy 不匹配）
    const supportedModes = presetTheme?.supportedModes
    const currentMode = isDarkFromMode ? 'dark' : 'light'
    const themeModeUnsupported = supportedModes && supportedModes.length > 0 && !supportedModes.includes(currentMode)
    const vibrancyMismatch = resolvedMode !== systemPreference

    if (themeModeUnsupported || vibrancyMismatch) {
      root.dataset.themeMismatch = 'true'
    } else {
      delete root.dataset.themeMismatch
    }

    // 设置 scenic 模式相关属性，供 CSS 选择器使用
    if (isScenic) {
      root.dataset.scenic = 'true'
      if (resolvedTheme.backgroundImage) {
        root.style.setProperty('--background-image', `url("${resolvedTheme.backgroundImage}")`)
      }
    } else {
      delete root.dataset.scenic
      root.style.removeProperty('--background-image')
    }

  }, [presetTheme, resolvedMode, systemPreference, isScenic, resolvedTheme, isDarkFromMode])

  // 注入 CSS 变量
  useEffect(() => {
    const styleId = 'craft-theme-overrides'
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null

    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = styleId
      document.head.appendChild(styleEl)
    }

    // 默认主题时清空自定义 CSS
    if (!effectiveColorTheme || effectiveColorTheme === 'default') {
      styleEl.textContent = ''
      return
    }

    // 只在预设主题加载完成后再注入 CSS，避免用空/错误值闪烁
    if (!presetTheme) {
      // 加载过程中保留已有 CSS
      return
    }

    // 生成 CSS 变量声明
    const cssVars = themeToCSS(resolvedTheme, isDark)

    if (cssVars) {
      styleEl.textContent = `:root {\n  ${cssVars}\n}`
    } else {
      styleEl.textContent = ''
    }
  }, [effectiveColorTheme, presetTheme, resolvedTheme, isDark])

  // === 系统偏好监听 ===
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = (e: MediaQueryListEvent) => {
      setSystemPreference(e.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleMediaChange)

    // 如果可用，通过 Electron IPC 监听系统主题变化（在 macOS 上更可靠）
    let cleanup: (() => void) | undefined
    if (window.electronAPI?.onSystemThemeChange) {
      cleanup = window.electronAPI.onSystemThemeChange((isDark) => {
        setSystemPreference(isDark ? 'dark' : 'light')
      })
    }

    // 从 Electron 获取初始系统主题
    if (window.electronAPI?.getSystemTheme) {
      window.electronAPI.getSystemTheme().then((isDark) => {
        setSystemPreference(isDark ? 'dark' : 'light')
      })
    }

    return () => {
      mediaQuery.removeEventListener('change', handleMediaChange)
      cleanup?.()
    }
  }, [])

  // === 跨窗口同步监听 ===
  useEffect(() => {
    if (!window.electronAPI?.onThemePreferencesChange) return

    const cleanup = window.electronAPI.onThemePreferencesChange((preferences) => {
      isExternalUpdate.current = true
      setModeState(preferences.mode as ThemeMode)
      setColorThemeState(preferences.colorTheme)
      setFontState(preferences.font as FontFamily)
      // 从其他窗口同步过来时，也视为用户显式修改，因为用户在别处确实改了主题
      saveTheme({
        mode: preferences.mode as ThemeMode,
        colorTheme: preferences.colorTheme,
        font: preferences.font as FontFamily,
        isUserOverride: true
      })
      setTimeout(() => {
        isExternalUpdate.current = false
      }, 0)
    })

    return cleanup
  }, [])

  // === 带持久化和广播的 setter ===
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode)
    // 保留已有的 isUserOverride 标志
    const existing = loadStoredTheme()
    saveTheme({ mode: newMode, colorTheme, font, isUserOverride: existing?.isUserOverride })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode: newMode, colorTheme, font })
    }
  }, [colorTheme, font])

  const setColorTheme = useCallback((newTheme: string) => {
    setColorThemeState(newTheme)
    // 标记为用户显式覆盖，因为用户通过 UI 主动选择了主题
    saveTheme({ mode, colorTheme: newTheme, font, isUserOverride: true })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode, colorTheme: newTheme, font })
    }
  }, [mode, font])

  const setFont = useCallback((newFont: FontFamily) => {
    setFontState(newFont)
    // 保留已有的 isUserOverride 标志
    const existing = loadStoredTheme()
    saveTheme({ mode, colorTheme, font: newFont, isUserOverride: existing?.isUserOverride })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode, colorTheme, font: newFont })
    }
  }, [mode, colorTheme])

  // 设置工作空间特定的颜色主题覆盖
  const setWorkspaceColorTheme = useCallback((newTheme: string | null) => {
    if (!activeWorkspaceId) return
    setWorkspaceColorThemeState(newTheme)
    window.electronAPI?.setWorkspaceColorTheme?.(activeWorkspaceId, newTheme)
    // 广播给其他窗口
    window.electronAPI?.broadcastWorkspaceThemeChange?.(activeWorkspaceId, newTheme)
  }, [activeWorkspaceId])

  // 监听其他窗口的工作空间主题变化
  useEffect(() => {
    if (!window.electronAPI?.onWorkspaceThemeChange) return

    const cleanup = window.electronAPI.onWorkspaceThemeChange(({ workspaceId, themeId }) => {
      // 只更新属于当前工作空间的覆盖
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorThemeState(themeId)
      }
    })

    return cleanup
  }, [activeWorkspaceId])

  return (
    <ThemeContext.Provider
      value={{
        // 应用级偏好
        mode,
        colorTheme,
        font,
        setMode,
        setColorTheme,
        setFont,

        // 工作空间级主题覆盖
        activeWorkspaceId,
        workspaceColorTheme,
        setWorkspaceColorTheme,

        // 派生值
        resolvedMode,
        systemPreference,
        effectiveColorTheme,
        previewColorTheme,
        setPreviewColorTheme,
        effectiveColorThemeSource,
        themeResolvedFrom,
        themeLoadError,

        // 主题解析（单例）
        presetTheme,
        resolvedTheme,
        isDark,
        isScenic,
        shikiTheme,
        shikiConfig,
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

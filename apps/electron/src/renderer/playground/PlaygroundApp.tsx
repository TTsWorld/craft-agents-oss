/**
 * Playground 主应用入口。
 *
 * 这是 Electron renderer 进程里的 Design System Playground 页面：
 * - 左侧：组件分类列表（Sidebar）
 * - 中间：选中组件的实时预览（ComponentPreview）
 * - 右侧：组件变体与属性调试面板（VariantsSidebar）
 *
 * 类比 Go：可以把它看成一个轻量级的 "main"，只负责组装三个子包，自身不处理具体渲染。
 */

import * as React from 'react'
import { PanelRight } from 'lucide-react'
import { CraftAgentsSymbol } from '@/components/icons/CraftAgentsSymbol'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/ThemeContext'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PresetTheme } from '@config/theme'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar } from './Sidebar'
import { ComponentPreview } from './ComponentPreview'
import { VariantsSidebar } from './VariantsSidebar'
import { getCategories, getComponentById, type ComponentVariant } from './registry'

/** localStorage 键：记录上一次选中的组件 id */
const SELECTED_STORAGE_KEY = 'playground-selected-component'
/** localStorage 键：记录右侧变体面板是否展开 */
const VARIANTS_SIDEBAR_KEY = 'playground-variants-sidebar-open'

/** 主题下拉框兜底选项（当 electronAPI 无法加载预设主题时使用） */
const FALLBACK_THEME_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'ghostty', label: 'Ghostty' },
  { value: 'github', label: 'GitHub' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'haze', label: 'Haze' },
  { value: 'night-owl', label: 'Night Owl' },
  { value: 'nord', label: 'Nord' },
  { value: 'one-dark-pro', label: 'One Dark Pro' },
  { value: 'pierre', label: 'Pierre' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'vitesse', label: 'Vitesse' },
] as const

/** Playground 根组件：布局 + 主题 + 选中组件状态管理 */
export function PlaygroundApp() {
  const categories = React.useMemo(() => getCategories(), [])
  const {
    workspaceColorTheme,
    effectiveColorTheme,
    setColorTheme,
    setWorkspaceColorTheme,
    setPreviewColorTheme,
    activeWorkspaceId,
  } = useTheme()
  const [presetThemes, setPresetThemes] = React.useState<PresetTheme[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(() => {
    // 尝试从 localStorage 恢复上次选中的组件
    try {
      const stored = localStorage.getItem(SELECTED_STORAGE_KEY)
      if (stored) {
        // 恢复前先校验该组件是否仍然存在于注册表中
        const component = getComponentById(stored)
        if (component) {
          return stored
        }
      }
    } catch {
      // 忽略 localStorage 读取/解析异常
    }
    return null
  })
  const [props, setProps] = React.useState<Record<string, unknown>>({})
  const [selectedVariant, setSelectedVariant] = React.useState<string | null>(null)
  const [variantsSidebarOpen, setVariantsSidebarOpen] = React.useState(() => {
    try {
      const stored = localStorage.getItem(VARIANTS_SIDEBAR_KEY)
      return stored !== 'false' // 默认展开
    } catch {
      return true
    }
  })

  // 挂载后通过 Electron preload 加载用户自定义预设主题
  React.useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI?.loadPresetThemes) {
        console.warn('[Playground] electronAPI.loadPresetThemes 不可用，使用兜底主题选项')
        setPresetThemes([])
        return
      }

      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
      } catch (error) {
        console.error('[Playground] 加载预设主题失败，使用兜底选项:', error)
        setPresetThemes([])
      }
    }

    void loadThemes()
  }, [])

  // 合并兜底主题与从 Electron 加载的预设主题，生成下拉框选项
  const themeOptions = React.useMemo(() => {
    const loadedOptions = presetThemes.map(theme => ({
      value: theme.id,
      label: theme.theme.name || theme.id,
    }))

    const merged = new Map<string, string>()

    for (const option of FALLBACK_THEME_OPTIONS) {
      merged.set(option.value, option.label)
    }

    for (const option of loadedOptions) {
      merged.set(option.value, option.label)
    }

    return Array.from(merged.entries()).map(([value, label]) => ({ value, label }))
  }, [presetThemes])

  // 卸载时清除预览主题，避免影响主应用
  React.useEffect(() => {
    return () => {
      setPreviewColorTheme(null)
    }
  }, [setPreviewColorTheme])

  // 持久化当前选中的组件 id 到 localStorage
  React.useEffect(() => {
    try {
      if (selectedId) {
        localStorage.setItem(SELECTED_STORAGE_KEY, selectedId)
      } else {
        localStorage.removeItem(SELECTED_STORAGE_KEY)
      }
    } catch {
      // 忽略存储异常
    }
  }, [selectedId])

  // 持久化右侧变体面板展开状态到 localStorage
  React.useEffect(() => {
    try {
      localStorage.setItem(VARIANTS_SIDEBAR_KEY, String(variantsSidebarOpen))
    } catch {
      // 忽略存储异常
    }
  }, [variantsSidebarOpen])

  const selectedComponent = selectedId ? (getComponentById(selectedId) ?? null) : null

  // 切换组件时重置 props 为默认值，并清除当前选中的变体
  React.useEffect(() => {
    if (selectedComponent) {
      const defaults: Record<string, unknown> = {}
      for (const prop of selectedComponent.props) {
        defaults[prop.name] = prop.defaultValue
      }
      setProps(defaults)
      setSelectedVariant(null)
    }
  }, [selectedComponent])

  /** 用户选择某个变体时，先用默认值再用变体 props 覆盖 */
  const handleVariantSelect = (variant: ComponentVariant) => {
    if (selectedComponent) {
      const defaults: Record<string, unknown> = {}
      for (const prop of selectedComponent.props) {
        defaults[prop.name] = prop.defaultValue
      }
      setProps({ ...defaults, ...variant.props })
      setSelectedVariant(variant.name)
    }
  }

  /** 用户在右侧手动修改属性时，清除变体选中状态 */
  const handlePropsChange = (newProps: Record<string, unknown>) => {
    setProps(newProps)
    setSelectedVariant(null)
  }

  /** 切换主题：若当前存在 workspace 级别覆盖，则更新 workspace 主题；否则更新应用默认主题 */
  const handleThemeChange = (nextTheme: string) => {
    const normalized = nextTheme === 'default' ? null : nextTheme

    // 立即生效，无论持久化层是否成功
    setPreviewColorTheme(normalized)

    // 优先级：workspace 主题覆盖 > 应用默认主题
    if (workspaceColorTheme !== null && activeWorkspaceId) {
      setWorkspaceColorTheme(normalized)
      return
    }

    setColorTheme(nextTheme)
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* 顶部标题栏：Logo、主题切换、主题选择、变体面板开关 */}
      <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-border bg-background">
        <div className="flex items-center gap-3">
          <CraftAgentsSymbol className="h-5 w-5" />
          <h1 className="font-semibold text-foreground font-sans">
            Design System Playground
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Select value={effectiveColorTheme ?? 'default'} onValueChange={handleThemeChange}>
            <SelectTrigger className="h-8 w-[170px] bg-foreground/5 border-border/50 text-xs">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              {themeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={() => setVariantsSidebarOpen(!variantsSidebarOpen)}
            className={cn(
              'p-2 rounded-md transition-colors',
              variantsSidebarOpen
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
            )}
            title={variantsSidebarOpen ? 'Hide variants' : 'Show variants'}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 主体：左侧分类列表 + 中间预览 + 右侧属性/变体面板 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧组件分类列表 */}
        <Sidebar
          categories={categories}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* 中间预览区 */}
        {selectedComponent ? (
          <ComponentPreview
            component={selectedComponent}
            props={props}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select a component from the sidebar
          </div>
        )}

        {/* 右侧变体与属性面板 */}
        <VariantsSidebar
          component={selectedComponent}
          selectedVariant={selectedVariant}
          onVariantSelect={handleVariantSelect}
          props={props}
          onPropsChange={handlePropsChange}
          isOpen={variantsSidebarOpen}
        />
      </div>
    </div>
  )
}

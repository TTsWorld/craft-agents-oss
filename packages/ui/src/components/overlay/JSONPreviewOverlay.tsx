/**
 * JSONPreviewOverlay - 交互式 JSON 树查看器浮层
 *
 * 使用 @uiw/react-json-view 进行展开/折叠树导航。
 * 包装 PreviewOverlay 以与其他浮层保持一致的展示。
 */

import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import JsonView from '@uiw/react-json-view'
import { ContentFrame } from './ContentFrame'

/**
 * 递归解析 JSON 值中被字符串化的 JSON。
 * 处理嵌套模式如 {"result": "{\"nested\": \"value\"}"}
 * 使其显示为可展开的树节点而非纯字符串。
 */
function deepParseJson(value: unknown): unknown {
  // 处理 null/undefined
  if (value === null || value === undefined) return value

  // 若为字符串，尝试解析为 JSON
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        // 递归解析结果，以处理多层嵌套
        return deepParseJson(JSON.parse(trimmed))
      } catch {
        // 非有效 JSON，返回原始字符串
        return value
      }
    }
    return value
  }

  // 若为数组，递归处理每个元素
  if (Array.isArray(value)) {
    return value.map(deepParseJson)
  }

  // 若为对象，递归处理每个属性
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = deepParseJson(val)
    }
    return result
  }

  // 原始类型（数字、布尔值）- 原样返回
  return value
}
import { vscodeTheme } from '@uiw/react-json-view/vscode'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { Braces, Copy, Check } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'

export interface JSONPreviewOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 要显示的已解析 JSON 数据 */
  data: unknown
  /** 文件路径 — 显示带"打开"+"在{文件管理器}中显示"的双触发菜单徽标 */
  filePath?: string
  /** 头部显示的标题（无 filePath 时的回退） */
  title?: string
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** 可选错误消息 */
  error?: string
  /** 无对话框内联渲染（用于 playground） */
  embedded?: boolean
}

/**
 * 适配应用 CSS 变量的自定义主题。
 * JSON 特定样式回退到 VS Code 暗色主题颜色。
 */
const craftAgentDarkTheme = {
  ...vscodeTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

const craftAgentLightTheme = {
  ...githubLightTheme,
  '--w-rjv-font-family': 'var(--font-mono, ui-monospace, monospace)',
  '--w-rjv-background-color': 'transparent',
}

export function JSONPreviewOverlay({
  isOpen,
  onClose,
  data,
  filePath,
  title = 'JSON',
  theme = 'dark',
  error,
  embedded,
}: JSONPreviewOverlayProps) {
  const { t } = useTranslation()
  // 根据模式选择主题
  const jsonTheme = useMemo(() => {
    return theme === 'dark' ? craftAgentDarkTheme : craftAgentLightTheme
  }, [theme])

  // 递归解析数据中的字符串化 JSON 以获得更好的展示。
  // 防护：@uiw/react-json-view 在 null/undefined/原始类型值上会崩溃——
  // 将它们包装在对象中使查看器能安全渲染。
  const processedData = useMemo(() => {
    const parsed = deepParseJson(data)
    if (parsed === null || parsed === undefined) return { '(empty)': null }
    if (typeof parsed !== 'object') return { '(root)': parsed }
    return parsed as object
  }, [data])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      typeBadge={{
        icon: Braces,
        label: 'JSON',
        variant: 'blue',
      }}
      filePath={filePath}
      title={title}
      theme={theme}
      error={error ? { label: t('preview.parseError'), message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      <ContentFrame title="JSON">
        <div className="flex-1 overflow-y-auto min-h-0 p-4">
          <div className="p-4">
            <JsonView
              value={processedData}
              style={jsonTheme}
              collapsed={false}
              enableClipboard={true}
              displayDataTypes={false}
              shortenTextAfterLength={100}
            >
              {/* 使用 lucide-react 的自定义复制图标 */}
              <JsonView.Copied
                render={(props) => {
                  // 需要类型断言 - @uiw/react-json-view 类型不包含 data-copied
                  const isCopied = (props as Record<string, unknown>)['data-copied']
                  return isCopied ? (
                    <Check
                      className="ml-1.5 inline-flex cursor-pointer text-green-500"
                      size={10}
                      onClick={props.onClick}
                    />
                  ) : (
                    <Copy
                      className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground"
                      size={10}
                      onClick={props.onClick}
                    />
                  )
                }}
              />
            </JsonView>
          </div>
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}

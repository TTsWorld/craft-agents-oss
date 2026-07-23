/**
 * GenericOverlay - 未知工具内容的兜底浮层
 *
 * 使用 PreviewOverlay 进行展示，CodeBlock 提供语法高亮。
 * 根据内容特征或文件路径自动检测语言。
 * 支持可选的 diff 模式进行并排对比。
 */

import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileCode } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { CodeBlock } from '../markdown/CodeBlock'

export interface GenericOverlayProps {
  /** 要显示的内容（非 diff 模式时使用） */
  content: string
  /** 语法高亮使用的语言（未提供时自动检测） */
  language?: string
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 头部显示的可选标题 */
  title?: string
  /** 暗色/亮色主题模式（默认 'light'） */
  theme?: 'light' | 'dark'
  /** 启用 diff 模式进行并排对比 */
  diffMode?: boolean
  /** diff 模式的原始内容（左侧） */
  originalContent?: string
  /** diff 模式的修改内容（右侧） */
  modifiedContent?: string
  /** 内联渲染，不使用对话框（用于 playground） */
  embedded?: boolean
  /** 工具执行失败时的错误信息 */
  error?: string
}

/**
 * 根据内容特征自动检测语言。
 * 依次检查 JSON、代码块标记，最后回退到 markdown。
 */
export function detectLanguage(content: string): string {
  const trimmed = content.trim()

  // 检查 JSON——以 { 或 [ 开头，看起来像有效的 JSON 结构
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json'
  }

  // 检查开头的代码块标记
  const codeBlockMatch = content.match(/^```(\w+)/)
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1]
  }

  // GenericOverlay 内容默认为 markdown（评论、思考过程等）
  return 'markdown'
}

/**
 * 根据文件路径扩展名检测语言。
 */
export function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    php: 'php',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    toml: 'toml',
    ini: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
  }
  return langMap[ext || ''] || 'text'
}

export function GenericOverlay({
  content,
  language,
  isOpen,
  onClose,
  title,
  theme,
  diffMode = false,
  originalContent = '',
  modifiedContent = '',
  embedded,
  error,
}: GenericOverlayProps) {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t('overlay.preview')

  // 未提供时自动检测语言
  const detectedLanguage = useMemo(() => {
    if (language) return language
    // 尝试从标题（文件路径）检测
    if (resolvedTitle.includes('/') || resolvedTitle.includes('.')) {
      const pathLang = detectLanguageFromPath(resolvedTitle)
      if (pathLang !== 'text') return pathLang
    }
    return detectLanguage(diffMode ? modifiedContent : content)
  }, [language, resolvedTitle, diffMode, modifiedContent, content])

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: FileCode,
        label: detectedLanguage,
        variant: 'gray',
      }}
      title={resolvedTitle}
      embedded={embedded}
      error={error ? { label: 'Tool Failed', message: error } : undefined}
      className="bg-foreground-3"
    >
      <ContentFrame title={t('overlay.preview')}>
        <div className="flex-1 overflow-y-auto min-h-0">
          {diffMode ? (
            // 并排 diff 视图
            <div className="flex gap-4 h-full p-4">
              <div className="flex-1 flex flex-col min-w-0">
                <div className="text-xs text-muted-foreground mb-2 font-medium">Original</div>
                <div className="flex-1 overflow-auto p-4">
                  <CodeBlock code={originalContent} language={detectedLanguage} mode="minimal" forcedTheme={theme} />
                </div>
              </div>
              <div className="flex-1 flex flex-col min-w-0">
                <div className="text-xs text-muted-foreground mb-2 font-medium">Modified</div>
                <div className="flex-1 overflow-auto p-4">
                  <CodeBlock code={modifiedContent} language={detectedLanguage} mode="minimal" forcedTheme={theme} />
                </div>
              </div>
            </div>
          ) : (
            // 单内容视图
            <div className="p-4">
              <CodeBlock code={content} language={detectedLanguage} mode="minimal" forcedTheme={theme} />
            </div>
          )}
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}

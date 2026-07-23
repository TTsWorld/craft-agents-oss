/**
 * CodePreviewOverlay - 代码文件预览浮层（Read/Write 工具）
 *
 * 使用 PreviewOverlay 进行展示，ShikiCodeViewer 提供语法高亮。
 * 文件路径徽标通过 PlatformContext 提供"打开"/"在 {文件管理器} 中显示"功能。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, PenLine } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { ShikiCodeViewer } from '../code-viewer/ShikiCodeViewer'

export interface CodePreviewOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 要显示的代码内容 */
  content: string
  /** 文件路径，用于语言检测和展示 */
  filePath: string
  /** 语法高亮使用的语言（未提供时自动检测） */
  language?: string
  /** 模式：'read' 或 'write' */
  mode?: 'read' | 'write'
  /** 起始行号（默认：1） */
  startLine?: number
  /** 原始文件总行数（用于展示） */
  totalLines?: number
  /** 显示的行数 */
  numLines?: number
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** 工具执行失败时的错误信息 */
  error?: string
  /** 内联渲染，不使用对话框（用于 playground） */
  embedded?: boolean
  /** 原始 shell 命令（用于 Codex 读取）- 显示在代码上方 */
  command?: string
}

export function CodePreviewOverlay({
  isOpen,
  onClose,
  content,
  filePath,
  language,
  mode = 'read',
  startLine = 1,
  totalLines,
  numLines,
  theme = 'light',
  error,
  embedded,
  command,
}: CodePreviewOverlayProps) {
  const { t } = useTranslation()

  // 构建带行号信息的副标题
  const subtitle =
    startLine !== undefined && totalLines !== undefined && numLines !== undefined
      ? `Lines ${startLine}–${startLine + numLines - 1} of ${totalLines}`
      : undefined

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: mode === 'write' ? PenLine : BookOpen,
        label: mode === 'write' ? 'Write' : 'Read',
        variant: mode === 'write' ? 'amber' : 'blue',
      }}
      filePath={filePath}
      subtitle={subtitle}
      error={error ? { label: mode === 'write' ? 'Write Failed' : 'Read Failed', message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {/* 存在命令时显示（Codex 通过 shell 命令读取） */}
      {command && (
        <div className="px-6 mb-4">
          <div className="w-full max-w-[850px] mx-auto">
            <div className="bg-background shadow-minimal rounded-[8px] px-4 py-3 font-mono">
              <div className="text-xs font-semibold text-muted-foreground/70 mb-1">Command</div>
              <div className="text-sm text-foreground overflow-x-auto">
                <span className="text-muted-foreground select-none">$ </span>
                <span>{command}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <ContentFrame title={t('overlay.code')} fitContent minWidth={850}>
        <div>
          <ShikiCodeViewer
            code={content}
            filePath={filePath}
            language={language}
            startLine={startLine}
            theme={theme}
          />
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}

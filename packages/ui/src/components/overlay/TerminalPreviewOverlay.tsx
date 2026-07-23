/**
 * TerminalPreviewOverlay - 终端输出浮层（Bash/Grep/Glob 工具）
 *
 * 使用 PreviewOverlay 进行展示，TerminalOutput 进行显示。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Search, FolderSearch } from 'lucide-react'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { TerminalOutput, type ToolType } from '../terminal/TerminalOutput'

export interface TerminalPreviewOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 执行的命令 */
  command: string
  /** 命令的输出 */
  output: string
  /** 退出码（0 = 成功） */
  exitCode?: number
  /** 用于显示样式的工具类型 */
  toolType?: ToolType
  /** 命令功能的可选描述 */
  description?: string
  /** 主题模式 */
  theme?: 'light' | 'dark'
  /** 命令执行失败时的错误消息 */
  error?: string
  /** 无对话框内联渲染（用于 playground） */
  embedded?: boolean
}

function getToolConfig(toolType: ToolType): {
  icon: typeof Terminal
  label: string
  variant: BadgeVariant
} {
  switch (toolType) {
    case 'grep':
      return { icon: Search, label: 'Grep', variant: 'green' }
    case 'glob':
      return { icon: FolderSearch, label: 'Glob', variant: 'purple' }
    default:
      return { icon: Terminal, label: 'Bash', variant: 'gray' }
  }
}

export function TerminalPreviewOverlay({
  isOpen,
  onClose,
  command,
  output,
  exitCode,
  toolType = 'bash',
  description,
  theme = 'light',
  error,
  embedded,
}: TerminalPreviewOverlayProps) {
  const { t } = useTranslation()
  const config = getToolConfig(toolType)

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: config.icon,
        label: config.label,
        variant: config.variant,
      }}
      title={description || ''}
      error={error ? { label: 'Command Failed', message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      <ContentFrame title={t('overlay.terminal')}>
        <div className="flex-1 overflow-y-auto min-h-0">
          <TerminalOutput
            command={command}
            output={output}
            exitCode={exitCode}
            toolType={toolType}
            description={description}
            theme={theme}
          />
        </div>
      </ContentFrame>
    </PreviewOverlay>
  )
}

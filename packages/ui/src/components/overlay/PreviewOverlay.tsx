/**
 * PreviewOverlay - 所有预览浮层的基础组件
 *
 * 为模态/全屏浮层提供统一的展示逻辑：
 * - Portal 渲染到 document.body（全屏模式经由 FullscreenOverlayBase）
 * - 响应式模态（>=1200px）vs 全屏（<1200px）模式
 * - ESC 键关闭
 * - 点击背景关闭（模态模式）
 * - 一致的头部布局，带徽标、关闭按钮
 * - 可选错误横幅
 *
 * 全屏模式下头部委托给 FullscreenOverlayBase（由其渲染
 * FullscreenOverlayBaseHeader）。模态/内联模式下直接渲染头部。
 *
 * 使用者：CodePreviewOverlay、TerminalPreviewOverlay、GenericOverlay 等。
 */

import { useEffect, type ReactNode } from 'react'
import * as ReactDOM from 'react-dom'
import { type LucideIcon } from 'lucide-react'
import { useOverlayMode, OVERLAY_LAYOUT } from '../../lib/layout'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'
import { FullscreenOverlayBaseHeader } from './FullscreenOverlayBaseHeader'
import { OverlayErrorBanner } from './OverlayErrorBanner'
import type { PreviewBadgeVariant } from '../ui/PreviewHeader'

/** 徽标颜色变体 - 重新导出以向后兼容 */
export type BadgeVariant = PreviewBadgeVariant

/** 所有浮层模式共享的背景类 - 单一来源 */
const OVERLAY_BG = 'bg-background'

export interface PreviewOverlayProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调 */
  onClose: () => void
  /** 主题模式 */
  theme?: 'light' | 'dark'

  /** 类型徽标配置 — 工具/格式指示器 */
  typeBadge: {
    icon: LucideIcon
    label: string
    variant: BadgeVariant
  }

  /** 文件路径 — 显示带"打开"+"在{文件管理器}中显示"的双触发菜单徽标 */
  filePath?: string
  /** 标题 — 显示为徽标。无文件路径时的回退。 */
  title?: string
  /** 标题徽标点击回调（仅在无 filePath 时使用） */
  onTitleClick?: () => void
  /** 可选副标题（如行范围信息） */
  subtitle?: string

  /** 可选错误状态 */
  error?: {
    label: string
    message: string
  }

  /** 头部右侧显示的操作 */
  headerActions?: ReactNode

  /** 主内容 */
  children: ReactNode

  /** 内联渲染（无对话框/portal）— 用于嵌入设计系统 playground */
  embedded?: boolean

  /** 浮层容器的自定义类名（如覆盖 bg-background） */
  className?: string
}

export function PreviewOverlay({
  isOpen,
  onClose,
  theme = 'light',
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  error,
  headerActions,
  children,
  embedded = false,
  className,
}: PreviewOverlayProps) {
  // 若提供自定义 className 则使用，否则回退到默认背景
  const bgClass = className || OVERLAY_BG
  const responsiveMode = useOverlayMode()
  const isModal = responsiveMode === 'modal'

  // 仅模态模式处理 ESC 键（全屏模式由 FullscreenOverlayBase 处理 ESC）
  useEffect(() => {
    if (!isOpen || !isModal) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isModal, onClose])

  if (!isOpen && !embedded) return null

  // 模态/内联模式下渲染的头部（全屏模式委托给 FullscreenOverlayBase）
  const header = (
    <FullscreenOverlayBaseHeader
      onClose={onClose}
      typeBadge={typeBadge}
      filePath={filePath}
      title={title}
      onTitleClick={onTitleClick}
      subtitle={subtitle}
      headerActions={headerActions}
    />
  )

  // 错误横幅 — 使用共享的 OverlayErrorBanner 带着色阴影样式。
  // 渲染在居中包装器内，使错误 + 内容一起居中。
  const errorBanner = error && (
    <div className="px-6 pb-4">
      <OverlayErrorBanner label={error.label} message={error.message} />
    </div>
  )

  // 模态/内联模式的渐变淡出遮罩 — 镜像 FullscreenOverlayBase 的
  // 滚动容器结构，使子组件（ContentFrame 等）在所有模式下
  // 于可滚动、带遮罩的视口内使用流式布局时表现一致。
  const FADE_SIZE = 24
  const FADE_MASK = `linear-gradient(to bottom, transparent 0%, black ${FADE_SIZE}px, black calc(100% - ${FADE_SIZE}px), transparent 100%)`

  const contentArea = (
    <div
      className="flex-1 min-h-0 relative"
      style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
    >
      <div
        className="absolute inset-0 overflow-y-auto"
        style={{ paddingTop: FADE_SIZE, paddingBottom: FADE_SIZE, scrollPaddingTop: FADE_SIZE }}
      >
        {/* 居中包装器 — 内容小时错误 + 内容一起垂直居中 */}
        <div className="min-h-full flex flex-col justify-center">
          {errorBanner}
          {children}
        </div>
      </div>
    </div>
  )

  // 内联模式 — 无对话框/portal 内联渲染，用于设计系统 playground
  if (embedded) {
    return (
      <div className={`flex flex-col ${bgClass} h-full w-full overflow-hidden rounded-lg border border-foreground/5`}>
        {header}
        {contentArea}
      </div>
    )
  }

  // 全屏模式 — FullscreenOverlayBase 通过结构化 props 渲染头部
  // 并拥有带遮罩的滚动容器。子组件直接渲染在其中。
  if (!isModal) {
    return (
      <FullscreenOverlayBase
        isOpen={isOpen}
        onClose={onClose}
        typeBadge={typeBadge}
        filePath={filePath}
        title={title}
        onTitleClick={onTitleClick}
        subtitle={subtitle}
        headerActions={headerActions}
        error={error}
      >
        {children}
      </FullscreenOverlayBase>
    )
  }

  // 模态模式 - 使用自己的 portal，点击背景关闭
  return ReactDOM.createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${OVERLAY_LAYOUT.modalBackdropClass}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`flex flex-col ${bgClass} shadow-3xl overflow-hidden smooth-corners`}
        style={{
          width: '90vw',
          maxWidth: OVERLAY_LAYOUT.modalMaxWidth,
          height: `${OVERLAY_LAYOUT.modalMaxHeightPercent}vh`,
          borderRadius: 16,
        }}
      >
        {header}
        {contentArea}
      </div>
    </div>,
    document.body
  )
}

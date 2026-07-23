/**
 * FullscreenOverlayBase - 所有全屏浮层的基础组件
 *
 * 使用 Radix Dialog 原语实现：
 * - 焦点管理（打开时失焦，关闭时恢复）
 * - ESC 键处理
 * - 与其他 Radix 组件协调（弹出层、下拉菜单）
 * - 无障碍（role="dialog", aria-modal）
 *
 * 额外处理：
 * - macOS 交通灯按钮隐藏（通过 PlatformContext）
 * - 默认景深背景（bg-foreground-3 + fullscreen-overlay-background 模糊）
 *   调用方可通过 className 覆盖（twMerge 解决冲突）
 * - 可选的结构化头部，带徽标（typeBadge, filePath, title, subtitle）
 * - 可选的内置复制按钮（copyContent 属性）
 * - 全视口滚动容器，带边缘到边缘的渐变遮罩（iOS 风格 contentInset）。
 *   滚动区域覆盖整个对话框——内容在浮动头部后方滚动。
 *   CSS 遮罩渐变在两端（顶部和底部，从 y=0 开始）淡出内容。
 *   头部浮在最上层，覆盖其后的内容。
 *   内容内边距在静止状态清空头部的空间，确保初始无裁剪。
 *
 * 布局：
 *   Dialog.Content (fixed inset-0, relative)
 *   ├── Masked area (absolute inset-0, CSS mask gradient)
 *   │   └── Scroll container (h-full, overflow-y-auto, paddingTop = header + fade)
 *   │       └── {error banner}
 *   │       └── {children}
 *   └── Header (absolute top-0, z-10, floating on top of scroll content)
 *
 * 使用方：PreviewOverlay, DocumentFormattedMarkdownOverlay, WorkspaceCreationScreen
 */

import { useEffect, useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'
import { getDismissibleLayerBridge } from '../../lib/dismissible-layer-bridge'
import { FullscreenOverlayBaseHeader, type OverlayTypeBadge } from './FullscreenOverlayBaseHeader'
import { OverlayErrorBanner, type OverlayErrorBannerProps } from './OverlayErrorBanner'

// 全屏浮层的 z-index——必须高于应用外层 UI（z-overlay: 300）
// 优先使用 CSS 变量，回退到硬编码值
const Z_FULLSCREEN = 'var(--z-fullscreen, 350)'

// HEADER_HEIGHT 必须与 PreviewHeader 的 height 属性一致（48px）。
// FADE_SIZE 是内容在边缘淡入/淡出的过渡区域大小。
const HEADER_HEIGHT = 48
const FADE_SIZE = 24

// 边缘到边缘的渐变淡出遮罩——从 y=0 开始，在两端按 FADE_SIZE 淡出。
// 浮动头部覆盖其后的内容；遮罩仅提供平滑的淡出效果。
const FADE_MASK = `linear-gradient(to bottom, transparent 0px, black ${FADE_SIZE}px, black calc(100% - ${FADE_SIZE}px), transparent 100%)`

export interface FullscreenOverlayBaseProps {
  /** 浮层是否可见 */
  isOpen: boolean
  /** 浮层关闭时的回调（ESC 键触发） */
  onClose: () => void
  /** 浮层内部渲染的内容 */
  children: ReactNode
  /** 容器的额外 CSS 类 */
  className?: string
  /** 浮层的无障碍标题（视觉隐藏） */
  accessibleTitle?: string

  // --- 结构化头部属性（可选） ---
  // 提供以下任一属性时，会在子内容上方渲染 FullscreenOverlayBaseHeader。

  /** 类型徽标——工具/格式标识（如"Read"、"Image"、"Bash"） */
  typeBadge?: OverlayTypeBadge
  /** 文件路径——显示带"打开"+"在 {文件管理器} 中显示"的双触发菜单徽标 */
  filePath?: string
  /** 标题——无 filePath 时显示为徽标 */
  title?: string
  /** 标题徽标的点击处理函数 */
  onTitleClick?: () => void
  /** 副标题——附加信息徽标（如"第 1-50 行，共 200 行"） */
  subtitle?: string
  /** 头部右侧操作（如 diff 控件） */
  headerActions?: ReactNode
  /** 提供时，在头部右侧操作区渲染内置复制按钮 */
  copyContent?: string

  /** 可选错误横幅——渲染在头部和子内容之间 */
  error?: OverlayErrorBannerProps
}

export function handleFullscreenEscapeWithStack(): boolean {
  const bridge = getDismissibleLayerBridge()
  if (!bridge) return false
  return bridge.handleEscape()
}

export function FullscreenOverlayBase({
  isOpen,
  onClose,
  children,
  className,
  accessibleTitle = 'Overlay',
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  headerActions,
  copyContent,
  error,
}: FullscreenOverlayBaseProps) {
  const { onSetTrafficLightsVisible } = usePlatform()

  // 判断是否需要渲染结构化头部。
  // 任何头部相关属性都会触发头部渲染。
  const hasHeader = !!(typeBadge || filePath || title || subtitle || headerActions || copyContent)
  const overlayIdRef = useRef(`fullscreen-overlay-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    if (!isOpen) return

    const bridge = getDismissibleLayerBridge()
    if (!bridge) return

    return bridge.registerLayer({
      id: overlayIdRef.current,
      type: 'radix-dialog',
      priority: 100,
      close: onClose,
    })
  }, [isOpen, onClose])

  // 浮层打开时隐藏 macOS 交通灯按钮，关闭时恢复
  // 防止在全屏浮层后方误点窗口控件
  useEffect(() => {
    if (!isOpen) return

    onSetTrafficLightsVisible?.(false)
    return () => onSetTrafficLightsVisible?.(true)
  }, [isOpen, onSetTrafficLightsVisible])

  // 内容内边距在静止状态清除浮动头部的空间（存在时）。
  // 无头部时，仅保留淡出区域的内边距。
  const contentPaddingTop = hasHeader ? HEADER_HEIGHT + FADE_SIZE : FADE_SIZE

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          className={cn(
            'fixed inset-0 overflow-hidden outline-none',
            'bg-foreground-3 fullscreen-overlay-background',
            className
          )}
          style={{ zIndex: Z_FULLSCREEN }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(event) => {
            const handled = handleFullscreenEscapeWithStack()
            if (!handled) return

            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {/* 无障碍用的视觉隐藏标题——Radix Dialog 要求 */}
          <Dialog.Title className="sr-only">{accessibleTitle}</Dialog.Title>

          {/* 全视口带遮罩的滚动区域——覆盖整个对话框（含头部后方）。
              CSS 遮罩渐变在两端淡出内容（从 y=0 开始）。
              内容内边距在静止状态清空头部的空间。 */}
          <div
            className="absolute inset-0"
            style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
          >
            <div
              className="h-full overflow-y-auto"
              style={{ paddingTop: contentPaddingTop, paddingBottom: FADE_SIZE, scrollPaddingTop: contentPaddingTop }}
            >
              {/* 居中包裹层——错误横幅和内容作为一个整体移动。
                  min-h-full 确保内容较小时居中；内容可以超出增长。 */}
              <div className="min-h-full flex flex-col justify-center">
                {/* 错误横幅——在居中流中，位于内容上方 */}
                {error && (
                  <div className="px-6 pb-4">
                    <OverlayErrorBanner label={error.label} message={error.message} />
                  </div>
                )}
                {children}
              </div>
            </div>
          </div>

          {/* 浮动头部——渲染在滚动区域之后，使其视觉上在最上层（DOM 顺序）。
              绝对定位在视口顶部，位于滚动内容之上。 */}
          {hasHeader && (
            <div className="absolute top-0 left-0 right-0 z-10">
              <FullscreenOverlayBaseHeader
                onClose={onClose}
                typeBadge={typeBadge}
                filePath={filePath}
                title={title}
                onTitleClick={onTitleClick}
                subtitle={subtitle}
                headerActions={headerActions}
                copyContent={copyContent}
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

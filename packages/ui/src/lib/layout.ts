/**
 * Chat UI 的共享布局常量
 *
 * 这些值确保 Electron 与 Web 查看器之间的视觉一致性。
 * 在 ChatDisplay（Electron）和 SessionViewer（UI 包）中均导入并使用。
 */

/**
 * 浮层布局配置
 * 控制浮层以弹窗还是全屏形式展示
 */
export const OVERLAY_LAYOUT = {
  /** 弹窗展示的最小视口宽度（低于此值 = 全屏） */
  /** 设为极高值以始终使用全屏模式 */
  modalBreakpoint: 99999,
  /** 弹窗最大宽度 */
  modalMaxWidth: 1100,
  /** 弹窗最大高度（占视口的百分比） */
  modalMaxHeightPercent: 85,
  /** 弹窗模式的遮罩 class（半透明） */
  modalBackdropClass: 'bg-black/50',
  /** 全屏模式的遮罩 class（不透明） */
  fullscreenBackdropClass: 'bg-background',
} as const

/**
 * Chat 布局配置
 */
export const CHAT_LAYOUT = {
  /** 聊天内容区域的最大宽度 */
  maxWidth: 'max-w-[840px]',

  /** 主容器的水平内边距 */
  containerPaddingX: 'px-5',

  /** 主容器的垂直内边距 */
  containerPaddingY: 'py-8',

  /** 组合后的容器内边距 */
  containerPadding: 'px-5 py-8',

  /** 消息/turn 之间的垂直间距 */
  messageSpacing: 'space-y-2.5',

  /** 用户消息的额外内边距（与 AI 回复形成视觉区隔） */
  userMessagePadding: 'pt-4 pb-2',

  /** 底部品牌区的内边距 */
  brandingPadding: 'pt-16 pb-24',
} as const

/**
 * 常见模式的组合 class 字符串
 */
export const CHAT_CLASSES = {
  /** 主消息容器：最大宽度 + 居中 + 内边距 + 间距 */
  messageContainer: `${CHAT_LAYOUT.maxWidth} mx-auto ${CHAT_LAYOUT.containerPadding} ${CHAT_LAYOUT.messageSpacing}`,

  /** 带内边距的用户消息包装器 */
  userMessageWrapper: CHAT_LAYOUT.userMessagePadding,

  /** 底部品牌区容器 */
  brandingContainer: `flex justify-center ${CHAT_LAYOUT.brandingPadding}`,
} as const

// ============================================================================
// 响应式浮层 Hook
// ============================================================================

import { useState, useEffect } from 'react'

export type OverlayMode = 'modal' | 'fullscreen'

/**
 * 根据视口大小判断浮层应以弹窗还是全屏形式展示的 Hook。
 *
 * @returns 视口足够大时返回 'modal'，否则返回 'fullscreen'
 */
export function useOverlayMode(): OverlayMode {
  const [mode, setMode] = useState<OverlayMode>(() => {
    if (typeof window === 'undefined') return 'fullscreen'
    return window.innerWidth >= OVERLAY_LAYOUT.modalBreakpoint ? 'modal' : 'fullscreen'
  })

  useEffect(() => {
    const handleResize = () => {
      const newMode = window.innerWidth >= OVERLAY_LAYOUT.modalBreakpoint ? 'modal' : 'fullscreen'
      setMode(newMode)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return mode
}

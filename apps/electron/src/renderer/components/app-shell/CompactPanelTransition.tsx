/**
 * CompactPanelTransition - 紧凑模式下导航器与详情面板之间的 iOS 风格滑动切换。
 *
 * 为什么不直接内联在 PanelStackContainer 里？
 * - PanelStackContainer 已经在处理侧边栏/导航器/内容区布局，把 spring 动画和 reduced-motion 逻辑抽到这里更清爽。
 * - 导航器和详情两个 slot 需要对称的动画变体，集中管理更容易保持一致。
 *
 * 动画规则：
 * - 只使用 GPU 友好属性：transform + opacity（见 apps/electron/CLAUDE.md）。
 * - 前进（navigator → detail）：导航器视差左移到 -30%，详情从右侧 100% 滑入。
 * - 后退（detail → navigator）：对称反向。
 * - prefers-reduced-motion：回退到 120ms 的 tween。
 */

import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'

const SNAPPY_SPRING = { type: 'spring' as const, stiffness: 400, damping: 36, mass: 0.8 }
const REDUCED_TWEEN = { type: 'tween' as const, duration: 0.12 }

/** CompactPanelRole：类型别名 */
export type CompactPanelRole = 'navigator' | 'detail'

interface CompactPanelTransitionProps {
  role: CompactPanelRole
  /** 为 true 时表示详情面板应处于前景（导航器应滑出） */
  isDetailActive: boolean
  children: React.ReactNode
}

/**
 * CompactPanelTransition - 给 slot 包一层绝对定位 + transform 动画的 motion.div。
 *
 * 导航器和详情两个 slot 始终保持挂载，只是滑入滑出。
 * 离屏 slot 设置 pointer-events: none 和 aria-hidden，避免截获点击或屏幕阅读器焦点。
 */
export function CompactPanelTransition({
  role,
  isDetailActive,
  children,
}: CompactPanelTransitionProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_TWEEN : SNAPPY_SPRING

  const isOffscreen = role === 'navigator' ? isDetailActive : !isDetailActive
  // 导航器使用视差 -30%，营造位于详情面板后方的层次感；详情完全滑出到 100%，避免覆盖导航器。
  const offscreenX = role === 'navigator' ? '-30%' : '100%'

  return (
    <motion.div
      className="absolute left-0 right-0 bottom-0"
      style={{
        top: 'var(--compact-panel-stack-top, 0px)',
        // 详情面板在过渡期间位于导航器之上
        zIndex: role === 'detail' ? 10 : 0,
        // 提示浏览器开启合成层，GPU 成本低，可防止首帧卡顿
        willChange: 'transform',
        // 离屏 slot 不接收点击和焦点
        pointerEvents: isOffscreen ? 'none' : 'auto',
      }}
      aria-hidden={isOffscreen || undefined}
      initial={false}
      animate={{ x: isOffscreen ? offscreenX : '0%' }}
      transition={transition}
    >
      {children}
    </motion.div>
  )
}

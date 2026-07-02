/**
 * collapsible — React 组件
 * 
 * 所属目录：ui
 */
/**
 * Collapsible — 可折叠面板组件
 *
 * 基于 Radix UI Collapsible 封装，并提供 AnimatedCollapsibleContent
 * 用 motion 动画实现高度 0 → auto 的展开效果（纯 CSS 做不到 height: auto 动画）。
 */
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { motion, AnimatePresence } from "motion/react"
import * as React from "react"

// 直接复用 Radix 原组件
const Collapsible = CollapsiblePrimitive.Root
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent

// 弹簧动画配置：干脆、无回弹
const springTransition = {
  type: "spring" as const,
  stiffness: 1400,
  damping: 75,
}

interface AnimatedCollapsibleContentProps {
  /** 是否展开 */
  isOpen: boolean
  /** 子内容 */
  children: React.ReactNode
  /** 容器额外 className */
  className?: string
}

/**
 * AnimatedCollapsibleContent — 带动画的折叠内容
 *
 * 用弹簧物理动画同时过渡高度和透明度。
 * motion 可以直接处理 height: "auto"，这是 CSS 动画办不到的。
 */
function AnimatedCollapsibleContent({
  isOpen,
  children,
  className
}: AnimatedCollapsibleContentProps) {
  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={springTransition}
          className={className}
          style={{ clipPath: "inset(0 -20px)" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  AnimatedCollapsibleContent,
  springTransition,
}

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { cn } from '../../lib/utils'

/**
 * 简单的带动画的可折叠内容包裹组件。
 */
function AnimatedCollapsibleContent({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface CollapsibleSectionProps {
  sectionId: string
  headingLevel: number
  isCollapsed: boolean
  onToggle: (sectionId: string) => void
  children: React.ReactNode
}

/**
 * CollapsibleSection
 *
 * 渲染一个带可折叠标题的 markdown section。
 * - 第一个子元素为标题(作为折叠触发器渲染)
 * - 其余子元素为内容(可折叠)
 * - 箭头在 hover 时出现,展开时旋转
 * - 仅 H1-H4 可折叠;H5-H6 正常渲染
 */
export function CollapsibleSection({
  sectionId,
  headingLevel,
  isCollapsed,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  // 提取标题(第一个子元素)和内容(其余部分)
  const childArray = React.Children.toArray(children)
  const heading = childArray[0]
  const content = childArray.slice(1)

  // 仅 H1-H4 支持折叠
  if (headingLevel > 4) {
    return <>{children}</>
  }

  const isExpanded = !isCollapsed
  const hasContent = content.length > 0

  return (
    <div className="markdown-collapsible-section" data-section-id={sectionId}>
      {/* 标题 + 折叠触发器 */}
      <div
        className={cn(
          'relative group',
          hasContent && 'cursor-pointer'
        )}
        onClick={() => hasContent && onToggle(sectionId)}
      >
        {/* 箭头 - 折叠时始终可见,展开时仅在 hover 时可见 */}
        <motion.div
          initial={false}
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className={cn(
            'absolute -left-4 top-[5px] select-none transition-opacity',
            !hasContent && 'opacity-0',
            hasContent && isCollapsed && 'opacity-100',
            hasContent && isExpanded && 'opacity-0 group-hover:opacity-100'
          )}
        >
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        </motion.div>

        {/* 标题内容 */}
        {heading}
      </div>

      {/* 可折叠内容 */}
      {hasContent && (
        <AnimatedCollapsibleContent isOpen={isExpanded}>
          <div className="collapsible-section-content">
            {content}
          </div>
        </AnimatedCollapsibleContent>
      )}
    </div>
  )
}

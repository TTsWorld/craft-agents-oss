import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, FileDiff, ArrowUpRight } from 'lucide-react'
import { SimpleDropdown, SimpleDropdownItem } from '../ui/SimpleDropdown'
import { cn } from '../../lib/utils'

export interface TurnCardActionsMenuProps {
  /** 在新窗口中打开 turn 详情的回调 */
  onOpenDetails?: () => void
  /** 在多文件 diff 视图中打开所有编辑/写入操作的回调 */
  onOpenMultiFileDiff?: () => void
  /** 本 turn 是否包含 Edit 或 Write 活动 */
  hasEditOrWriteActivities?: boolean
  /** 触发按钮的额外 className */
  className?: string
}

/**
 * TurnCardActionsMenu - TurnCard 头部操作的下拉菜单
 *
 * 展示：
 * - 当 turn 包含 Edit/Write 活动时显示"查看文件改动"
 * - 始终显示"查看 turn 详情"
 */
export function TurnCardActionsMenu({
  onOpenDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  className,
}: TurnCardActionsMenuProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)

  // 没有可用操作时不渲染
  if (!onOpenDetails && !onOpenMultiFileDiff) {
    return null
  }

  return (
    <SimpleDropdown
      align="end"
      onOpenChange={setIsOpen}
      trigger={
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "p-1 rounded-[6px] transition-opacity shrink-0",
            "opacity-0 group-hover:opacity-100",
            "bg-background shadow-minimal",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
            isOpen && "opacity-100 text-foreground",
            className
          )}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
            }
          }}
        >
          <MoreHorizontal className="w-3 h-3" />
        </div>
      }
    >
      {onOpenMultiFileDiff && hasEditOrWriteActivities && (
        <SimpleDropdownItem
          onClick={onOpenMultiFileDiff}
          icon={<FileDiff />}
        >
          {t('chat.viewFileChanges')}
        </SimpleDropdownItem>
      )}
      {onOpenDetails && (
        <SimpleDropdownItem
          onClick={onOpenDetails}
          icon={<ArrowUpRight />}
        >
          {t('chat.viewTurnDetails')}
        </SimpleDropdownItem>
      )}
    </SimpleDropdown>
  )
}

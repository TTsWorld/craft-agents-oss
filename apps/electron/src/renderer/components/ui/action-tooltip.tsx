/**
 * ActionTooltip — 给操作按钮加提示 Tooltip
 *
 * Action 是应用内全局可注册的快捷键/命令动作（类似 Go 里的命令映射表）。
 * 这个组件用 useActionLabel 拿到动作的显示名称和快捷键，并包一个 Tooltip。
 */
import { useActionLabel } from '@/actions'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import type { ActionId } from '@/actions/definitions'

interface ActionTooltipProps {
  /** 动作 ID */
  action: ActionId
  /** 被包裹的触发元素 */
  children: React.ReactNode
}

/** 动作提示组件 */
export function ActionTooltip({ action, children }: ActionTooltipProps) {
  const { label, hotkey } = useActionLabel(action)

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {hotkey && <kbd className="ml-2 text-xs opacity-60">{hotkey}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

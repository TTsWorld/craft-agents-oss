/**
 * ActionMenuItem — 把全局 Action 包装成下拉菜单项
 *
 * 与 ActionTooltip 类似，都是基于 useActionLabel 读取 Action 的显示名和快捷键，
 * 这里渲染成 StyledDropdownMenuItem，用于面板头部等下拉菜单。
 */
import { useActionLabel } from '@/actions'
import { StyledDropdownMenuItem } from './styled-dropdown'
import type { ActionId } from '@/actions/definitions'

interface ActionMenuItemProps {
  /** Action ID */
  action: ActionId
  /** 点击回调 */
  onClick?: () => void
  /** 子元素，不传则使用 Action 的 label */
  children?: React.ReactNode
}

/** Action 菜单项 */
export function ActionMenuItem({ action, onClick, children }: ActionMenuItemProps) {
  const { label, hotkey } = useActionLabel(action)

  return (
    <StyledDropdownMenuItem onClick={onClick}>
      <span>{children || label}</span>
      {hotkey && (
        <span className="ml-auto text-xs text-muted-foreground">{hotkey}</span>
      )}
    </StyledDropdownMenuItem>
  )
}

/**
 * SettingsEditRow
 *
 * 带 "Edit" 按钮的设置行，点击后弹出 EditPopover。
 * 用户提交编辑请求后，会打开一个新的、已聚焦的聊天窗口，
 * 并把当前设置项的上下文预填进去，方便 Agent 快速执行修改。
 */

import { Button } from '@/components/ui/button'
import { EditPopover, type EditContext } from '@/components/ui/EditPopover'
import { SettingsRow } from './SettingsRow'

export interface SettingsEditRowProps {
  /** 行标签 */
  label: string
  /** 标签下方的描述说明 */
  description?: string
  /** 当前值的展示内容（显示在右侧） */
  value?: React.ReactNode
  /** 编辑上下文：告诉 Agent 当前在修改什么 */
  editContext: EditContext
  /** 编辑输入框的示例占位文本（例如 "Change the API endpoint"） */
  editExample?: string
  /** 是否在卡片内部 */
  inCard?: boolean
  /** 额外 className */
  className?: string
}

export function SettingsEditRow({
  label,
  description,
  value,
  editContext,
  editExample,
  inCard = true,
  className,
}: SettingsEditRowProps) {
  return (
    <SettingsRow
      label={label}
      description={description}
      inCard={inCard}
      className={className}
      action={
        <EditPopover
          trigger={
            <Button variant="ghost" size="sm" className="h-7 px-2.5 rounded-[6px] bg-background shadow-minimal">
              Edit
            </Button>
          }
          example={editExample}
          context={editContext}
        />
      }
    >
      {value}
    </SettingsRow>
  )
}

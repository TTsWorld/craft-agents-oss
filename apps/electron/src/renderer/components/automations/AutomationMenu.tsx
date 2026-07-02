/**
 * AutomationMenu - 自动化操作共享菜单内容
 *
 * 使用方：
 * - AutomationsListPanel（通过“...”按钮下拉、右键上下文菜单）
 * - AutomationInfoPage（标题下拉菜单）
 *
 * 使用 MenuComponents 上下文来渲染 DropdownMenu 或 ContextMenu 的原语，
 * 遵循与 SourceMenu 相同的双菜单模式。
 */

import { useTranslation } from 'react-i18next'
import {
  Trash2,
  FileCode,
  Copy,
  Play,
  Power,
  PowerOff,
  Send,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface AutomationMenuProps {
  automationId: string
  automationName: string
  enabled: boolean
  onToggleEnabled?: () => void
  onTest?: () => void
  onDuplicate?: () => void
  onEditJson?: () => void
  onDelete?: () => void
  /** 发送到其他工作区（不传则隐藏该选项） */
  onSendToWorkspace?: () => void
}

export function AutomationMenu({
  automationId,
  automationName,
  enabled,
  onToggleEnabled,
  onTest,
  onDuplicate,
  onEditJson,
  onDelete,
  onSendToWorkspace,
}: AutomationMenuProps) {
  const { MenuItem, Separator } = useMenuComponents()
  const { t } = useTranslation()

  return (
    <>
      {/* 启用 / 禁用切换 */}
      {onToggleEnabled && (
        <MenuItem onClick={onToggleEnabled}>
          {enabled ? (
            <PowerOff className="h-3.5 w-3.5" />
          ) : (
            <Power className="h-3.5 w-3.5" />
          )}
          <span className="flex-1">{enabled ? t('automations.menuDisable') : t('automations.menuEnable')}</span>
        </MenuItem>
      )}

      {/* 测试自动化 */}
      {onTest && (
        <MenuItem onClick={onTest}>
          <Play className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.runTest')}</span>
        </MenuItem>
      )}

      {/* 复制 */}
      {onDuplicate && (
        <MenuItem onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuDuplicate')}</span>
        </MenuItem>
      )}

      {/* 发送到其他工作区 */}
      {onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t('sendToWorkspace.title')}</span>
        </MenuItem>
      )}

      {/* 编辑 automations.json */}
      {onEditJson && (
        <MenuItem onClick={onEditJson}>
          <FileCode className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuEditConfiguration')}</span>
        </MenuItem>
      )}

      <Separator />

      {/* 删除 */}
      {onDelete && (
        <MenuItem onClick={onDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuDelete')}</span>
        </MenuItem>
      )}
    </>
  )
}

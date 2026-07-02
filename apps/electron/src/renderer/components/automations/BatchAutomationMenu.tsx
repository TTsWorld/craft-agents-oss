/**
 * BatchAutomationMenu - 多选自动化后的批量操作右键/下拉菜单内容。
 *
 * 自包含组件：通过 hook 读取多选状态、自动化元数据和 IPC 回调。
 * 使用 useMenuComponents() 渲染多态菜单项，因此既能用于 DropdownMenu，
 * 也能用于 ContextMenu。
 *
 * 与 BatchSessionMenu 模式保持一致，提供自动化专属的批量操作：
 * 全部启用/禁用、批量删除。
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Power, PowerOff, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { automationSelection } from '@/hooks/useEntitySelection'
import { automationsAtom } from '@/atoms/automations'
import { useAppShellContext } from '@/context/AppShellContext'

const {
  useSelection: useAutomationSelection,
  useSelectedIds: useAutomationSelectedIds,
} = automationSelection

export function BatchAutomationMenu() {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  const selectedIds = useAutomationSelectedIds()
  const { clearMultiSelect } = useAutomationSelection()
  const automations = useAtomValue(automationsAtom)

  const {
    activeWorkspaceId,
  } = useAppShellContext()

  // 根据选中 ID 解析出对应的自动化元数据
  const selectedAutomations = useMemo(() => {
    return [...selectedIds]
      .map(id => automations.find(a => a.id === id))
      .filter((a): a is NonNullable<typeof a> => a != null)
  }, [selectedIds, automations])

  // 判断当前选中的自动化是否全部已启用
  const allEnabled = useMemo(() => {
    return selectedAutomations.length > 0 && selectedAutomations.every(a => a.enabled)
  }, [selectedAutomations])

  // 批量启用/禁用：顺序调用 IPC，避免 automations.json 的读写竞争
  const handleBatchToggle = useCallback(async () => {
    if (!activeWorkspaceId) return
    const targetEnabled = !allEnabled
    const count = selectedAutomations.length
    clearMultiSelect()
    for (const a of selectedAutomations) {
      await window.electronAPI.setAutomationEnabled(
        activeWorkspaceId,
        a.event,
        a.matcherIndex,
        targetEnabled,
      ).catch(() => {})
    }
    toast(targetEnabled
      ? t('automations.batchEnabled', { count })
      : t('automations.batchDisabled', { count })
    )
  }, [activeWorkspaceId, selectedAutomations, allEnabled, clearMultiSelect, t])

  // 批量删除：按 matcherIndex 降序顺序删除，这样先删后面的不会导致前面索引失效
  const handleBatchDelete = useCallback(async () => {
    if (!activeWorkspaceId) return
    const count = selectedIds.size
    clearMultiSelect()
    const sorted = [...selectedAutomations].sort((a, b) => b.matcherIndex - a.matcherIndex)
    for (const a of sorted) {
      await window.electronAPI.deleteAutomation(
        activeWorkspaceId,
        a.event,
        a.matcherIndex,
      ).catch(() => {})
    }
    toast(t('automations.batchDeleted', { count }))
  }, [activeWorkspaceId, selectedIds.size, selectedAutomations, clearMultiSelect, t])

  const count = selectedIds.size

  return (
    <>
      {/* 顶部显示已选中数量 */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('automations.batchSelected', { count })}
      </div>
      <Separator />

      {/* 启用/禁用全部 */}
      <MenuItem onClick={handleBatchToggle}>
        {allEnabled ? (
          <PowerOff className="h-3.5 w-3.5" />
        ) : (
          <Power className="h-3.5 w-3.5" />
        )}
        <span className="flex-1">{allEnabled ? t('automations.menuDisableAll') : t('automations.menuEnableAll')}</span>
      </MenuItem>

      <Separator />

      {/* 删除 */}
      {activeWorkspaceId && (
        <MenuItem onClick={handleBatchDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('automations.menuDelete')}</span>
        </MenuItem>
      )}
    </>
  )
}

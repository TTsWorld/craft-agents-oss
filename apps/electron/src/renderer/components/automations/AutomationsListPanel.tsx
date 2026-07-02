/**
 * AutomationsListPanel
 *
 * 在第二列显示的自动化导航面板。
 * 遵循 SourcesListPanel 的模式：头像、标题、副标题、徽章。
 * 标题和加号按钮由 AppShell 里共享的 PanelHeader 处理。
 *
 * 支持 CMD/CTRL+点击多选、Shift+点击区间选择，
 * 使用共享的 EntityRow + createEntitySelection 基础设施。
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Webhook } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { EntityRow } from '@/components/ui/entity-row'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { SessionSearchHeader } from '@/components/app-shell/SessionSearchHeader'
import { AutomationMenu } from './AutomationMenu'
import { BatchAutomationMenu } from './BatchAutomationMenu'
import { AutomationAvatar } from './AutomationAvatar'
import { SendResourceToWorkspaceDialog } from '@/components/app-shell/SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { automationSelection } from '@/hooks/useEntitySelection'
import { APP_EVENTS, AGENT_EVENTS, getEventDisplayName, type AutomationListItem, type AutomationListFilter } from './types'
import { formatShortRelativeTime } from './utils'

const {
  useSelection: useAutomationSelection,
} = automationSelection


/** 自动化行里用于事件名和动作类型的微型徽章 */
function MicroBadge({ children, colorClass }: { children: React.ReactNode; colorClass: string }) {
  return (
    <span className={cn('shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded', colorClass)}>
      {children}
    </span>
  )
}

// ============================================================================
// 单个自动化条目
// ============================================================================

interface AutomationItemProps {
  automation: AutomationListItem
  isSelected: boolean
  isInMultiSelect: boolean
  isMultiSelectActive: boolean
  isFirst: boolean
  onClick: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
  onDelete: () => void
  onToggleEnabled: () => void
  onTest: () => void
  onDuplicate: () => void
  onSendToWorkspace?: () => void
}

function AutomationItem({
  automation,
  isSelected,
  isInMultiSelect,
  isMultiSelectActive,
  isFirst,
  onClick,
  onToggleSelect,
  onRangeSelect,
  onDelete,
  onToggleEnabled,
  onTest,
  onDuplicate,
  onSendToWorkspace,
}: AutomationItemProps) {
  const { t } = useTranslation()
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      // 右键：如果处于多选模式且当前未选中，则自动加入多选
      if (isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    onClick()
  }, [isMultiSelectActive, isInMultiSelect, onToggleSelect, onRangeSelect, onClick])

  return (
    <EntityRow
      className={cn('automation-item', !automation.enabled && 'opacity-50')}
      showSeparator={!isFirst}
      separatorClassName="pl-10 pr-4"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      onMouseDown={handleClick}
      icon={<AutomationAvatar event={automation.event} size="sm" />}
      title={automation.name}
      badges={
        <>
          <MicroBadge colorClass="bg-foreground/8 text-foreground/60">
            {getEventDisplayName(automation.event)}
          </MicroBadge>
          {automation.actions.some(a => a.type === 'prompt') && (
            <MicroBadge colorClass="bg-accent/10 text-accent">
              {t('automations.badgePrompt')}
            </MicroBadge>
          )}
          {automation.actions.some(a => a.type === 'webhook') && (
            <MicroBadge colorClass="bg-orange-500/10 text-orange-600 dark:text-orange-400">
              {t('automations.badgeWebhook')}
            </MicroBadge>
          )}
        </>
      }
      trailing={
        automation.lastExecutedAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 text-[11px] text-foreground/40 whitespace-nowrap cursor-default">
                {formatShortRelativeTime(automation.lastExecutedAt)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('automations.lastRan', { time: formatShortRelativeTime(automation.lastExecutedAt) })}
            </TooltipContent>
          </Tooltip>
        ) : undefined
      }
      menuContent={
        <AutomationMenu
          automationId={automation.id}
          automationName={automation.name}
          enabled={automation.enabled}
          onToggleEnabled={onToggleEnabled}
          onTest={onTest}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onSendToWorkspace={onSendToWorkspace}
        />
      }
      contextMenuContent={isMultiSelectActive && isInMultiSelect ? <BatchAutomationMenu /> : undefined}
    />
  )
}

// ============================================================================
// AutomationsListPanel
// ============================================================================

export interface AutomationsListPanelProps {
  automations: AutomationListItem[]
  automationFilter?: AutomationListFilter | null
  onAutomationClick: (automationId: string) => void
  onDeleteAutomation?: (automationId: string) => void
  onToggleAutomation?: (automationId: string) => void
  onTestAutomation?: (automationId: string) => void
  onDuplicateAutomation?: (automationId: string) => void
  selectedAutomationId?: string | null
  workspaceRootPath?: string
  className?: string
}

export function AutomationsListPanel({
  automations,
  automationFilter,
  onAutomationClick,
  onDeleteAutomation,
  onToggleAutomation,
  onTestAutomation,
  onDuplicateAutomation,
  selectedAutomationId,
  workspaceRootPath,
  className,
}: AutomationsListPanelProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // “发送到工作区”弹窗状态
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendResourceId, setSendResourceId] = useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = useState('')

  const {
    select: selectAutomation,
    toggle: toggleAutomation,
    selectRange,
    isMultiSelectActive,
    isSelected: isInSelection,
  } = useAutomationSelection()

  const isSearchMode = searchActive && searchQuery.length >= 2

  // 按侧边栏筛选（来自路由）过滤自动化
  const categoryFiltered = React.useMemo(() => {
    const kind = automationFilter?.kind ?? 'all'
    if (kind === 'all') return automations
    if (kind === 'scheduled') return automations.filter(a => a.event === 'SchedulerTick')
    if (kind === 'app') return automations.filter(a => (APP_EVENTS as string[]).includes(a.event) && a.event !== 'SchedulerTick')
    if (kind === 'agent') return automations.filter(a => (AGENT_EVENTS as string[]).includes(a.event))
    return automations
  }, [automations, automationFilter?.kind])

  // 再用搜索关键词过滤（匹配名称、摘要、事件显示名）
  const searchFiltered = React.useMemo(() => {
    if (!isSearchMode) return categoryFiltered
    const q = searchQuery.toLowerCase()
    return categoryFiltered.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      getEventDisplayName(a.event).toLowerCase().includes(q)
    )
  }, [categoryFiltered, isSearchMode, searchQuery])

  // 排序：最近执行过的排在最前，从未执行的沉底
  const filteredAutomations = React.useMemo(() => {
    return [...searchFiltered].sort((a, b) => {
      if (!a.lastExecutedAt && !b.lastExecutedAt) return 0
      if (!a.lastExecutedAt) return 1
      if (!b.lastExecutedAt) return -1
      return new Date(b.lastExecutedAt).getTime() - new Date(a.lastExecutedAt).getTime()
    })
  }, [searchFiltered])

  const handleItemClick = useCallback((automationId: string, index: number) => {
    selectAutomation(automationId, index)
    onAutomationClick(automationId)
  }, [selectAutomation, onAutomationClick])

  const handleToggleSelect = useCallback((automationId: string, index: number) => {
    toggleAutomation(automationId, index)
  }, [toggleAutomation])

  const handleRangeSelect = useCallback((toIndex: number) => {
    const allIds = filteredAutomations.map(a => a.id)
    selectRange(toIndex, allIds)
  }, [filteredAutomations, selectRange])

  // 空状态：没有任何自动化配置
  if (automations.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<Webhook />}
          title={t('automations.noAutomationsConfigured')}
          description={t('automations.emptyDescription')}
          docKey="automations"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('automations.addAutomation')}
                </button>
              }
              {...getEditConfig('automation-config', workspaceRootPath)}
            />
          )}
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {/* 搜索头部 */}
      {searchActive && (
        <SessionSearchHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchClose={() => {
            setSearchActive(false)
            setSearchQuery('')
          }}
          placeholder={t('automations.searchPlaceholder')}
          resultCount={isSearchMode ? filteredAutomations.length : undefined}
        />
      )}

      {/* 过滤后为空的状态 */}
      {filteredAutomations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          <p className="text-sm text-muted-foreground">
            {isSearchMode ? t('automations.noAutomationsFound') : t('automations.noAutomationsConfigured')}
          </p>
          {isSearchMode && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-xs text-foreground hover:underline"
            >
              {t('automations.clearSearch')}
            </button>
          )}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="pb-2" data-list-role="automations">
            <div className="pt-1">
              {filteredAutomations.map((automation, index) => (
                <AutomationItem
                  key={automation.id}
                  automation={automation}
                  isSelected={selectedAutomationId === automation.id}
                  isInMultiSelect={isMultiSelectActive && isInSelection(automation.id)}
                  isMultiSelectActive={isMultiSelectActive}
                  isFirst={index === 0}
                  onClick={() => handleItemClick(automation.id, index)}
                  onToggleSelect={() => handleToggleSelect(automation.id, index)}
                  onRangeSelect={() => handleRangeSelect(index)}
                  onDelete={() => onDeleteAutomation?.(automation.id)}
                  onToggleEnabled={() => onToggleAutomation?.(automation.id)}
                  onTest={() => onTestAutomation?.(automation.id)}
                  onDuplicate={() => onDuplicateAutomation?.(automation.id)}
                  onSendToWorkspace={hasOtherWorkspaces ? () => {
                    setSendResourceId(automation.id)
                    setSendResourceLabel(automation.name)
                    setSendDialogOpen(true)
                  } : undefined}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      )}

      {/* 发送到工作区弹窗 */}
      {sendResourceId && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="automation"
          resourceIds={[sendResourceId]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </div>
  )
}

/**
 * MultiSelectPanel - 多选时显示的占位面板。
 *
 * 展示选中数量，并提供批量操作按钮（状态、标签、归档、发送工作区等）。
 * 会话、来源、技能等列表的多选场景都会复用。
 */

import * as React from 'react'
import { Archive, Tag, CheckCircle2, Send } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
  DropdownMenuSub,
} from '@/components/ui/styled-dropdown'
import type { SessionStatusId, SessionStatus } from '@/config/session-status-config'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { LabelMenuItems, StatusMenuItems } from './SessionMenuParts'

type MultiSelectEntityType = 'automation' | 'session' | 'skill' | 'source'

/** MultiSelectPanelProps：组件 props 类型定义 */
export interface MultiSelectPanelProps {
  /** 选中项数量 */
  count: number
  /** 实体类型，用于选择正确的本地化文案（默认 "session"） */
  entityType?: MultiSelectEntityType
  /** 可用工作状态列表 */
  sessionStatuses?: SessionStatus[]
  /** 如果所有选中项状态一致，则显示该状态 */
  activeStatusId?: SessionStatusId | null
  /** 为所有选中项设置状态的回调 */
  onSetStatus?: (status: SessionStatusId) => void
  /** 可用标签配置树 */
  labels?: LabelConfig[]
  /** 所有选中项共有的标签 ID 集合 */
  appliedLabelIds?: Set<string>
  /** 切换某个标签的回调 */
  onToggleLabel?: (labelId: string) => void
  /** 归档所有选中项的回调 */
  onArchive?: () => void
  /** 发送到其他工作区的回调 */
  onSendToWorkspace?: () => void
  /** 清空选择的回调 */
  onClearSelection?: () => void
  /** 容器额外的 CSS 类名 */
  className?: string
}

/** MultiSelectPanel - 多选占位面板 */
export function MultiSelectPanel({
  count,
  entityType = 'session',
  sessionStatuses = [],
  activeStatusId,
  onSetStatus,
  labels = [],
  appliedLabelIds = new Set(),
  onToggleLabel,
  onArchive,
  onSendToWorkspace,
  onClearSelection,
  className,
}: MultiSelectPanelProps) {
  const { t } = useTranslation()
  const clickLabel = t('multiSelect.click')

  const commandClick = (
    <KbdGroup>
      <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
      <Kbd>{clickLabel}</Kbd>
    </KbdGroup>
  )

  const shiftClick = (
    <KbdGroup>
      <Kbd>⇧</Kbd>
      <Kbd>{clickLabel}</Kbd>
    </KbdGroup>
  )

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full gap-6 p-8',
        className
      )}
    >
      {/* 选中数量 */}
      <div className="flex flex-col items-center gap-2">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
          <span className="text-2xl font-semibold text-accent">{count}</span>
        </div>
        <h2 className="text-lg font-medium text-foreground">
          {t(`multiSelect.selected.${entityType}`, { count })}
        </h2>
        <div className="text-sm text-foreground/50 flex flex-col items-center gap-1">
          <span>
            <Trans
              i18nKey="multiSelect.selectionHint"
              components={{
                cmdClick: commandClick,
                shiftClick,
              }}
            />
          </span>
          <span>
            <Trans
              i18nKey="multiSelect.clearSelection"
              components={{ kbd: <Kbd /> }}
            />
          </span>
        </div>
      </div>

      {/* 批量操作按钮 */}
      <div className="flex flex-wrap justify-center gap-2">
        {onSetStatus && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
              >
                <CheckCircle2 className="w-4 h-4" />
                {t('multiSelect.changeStatus')}
              </Button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="center">
              <StatusMenuItems
                sessionStatuses={sessionStatuses}
                activeStateId={activeStatusId ?? undefined}
                onSelect={onSetStatus}
                menu={{ MenuItem: StyledDropdownMenuItem }}
              />
            </StyledDropdownMenuContent>
          </DropdownMenu>
        )}
        {onToggleLabel && labels.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
              >
                <Tag className="w-4 h-4" />
                {t('multiSelect.setLabels')}
              </Button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="center" className="min-w-[220px]">
              <LabelMenuItems
                labels={labels}
                appliedLabelIds={appliedLabelIds}
                onToggle={onToggleLabel}
                menu={{
                  MenuItem: StyledDropdownMenuItem,
                  Separator: StyledDropdownMenuSeparator,
                  Sub: DropdownMenuSub,
                  SubTrigger: StyledDropdownMenuSubTrigger,
                  SubContent: StyledDropdownMenuSubContent,
                }}
              />
            </StyledDropdownMenuContent>
          </DropdownMenu>
        )}
        {onSendToWorkspace && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSendToWorkspace}
            className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
          >
            <Send className="w-4 h-4" />
            {t('sessionMenu.sendToWorkspace')}
          </Button>
        )}
        {onArchive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onArchive}
            className="gap-2 bg-background shadow-minimal hover:bg-foreground/[0.03]"
          >
            <Archive className="w-4 h-4" />
            {t('sessionMenu.archive')}
          </Button>
        )}
      </div>

      {/* 键盘提示已移到点击提示上方 */}
    </div>
  )
}

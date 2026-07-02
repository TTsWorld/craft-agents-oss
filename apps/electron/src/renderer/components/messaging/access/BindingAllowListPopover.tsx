/**
 * 单条 binding（会话绑定）的 allow-list 编辑器。
 *
 * 触发器是 binding 行右侧的一个小药丸按钮；点击后弹出三种模式：
 *  - inherit：继承工作空间 owner 列表（新 binding 的默认值）
 *  - allow-list：显式指定允许发送者的子集（必须包含 owner）
 *  - open：任何在该 chat 内的人都能路由消息（兼容旧版本/公开场景）
 *
 * 第一期做得比较轻量：只能看到已有允许发送者并勾选/取消 owner。
 * 添加任意发送者走“待审批请求”流程；这个 popover 只负责把已知用户裁剪到当前 binding。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Lock, Globe, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BindingAccess, BindingAccessMode, PlatformOwner } from './types'

interface Props {
  access: BindingAccess
  // 工作空间 owner 列表；inherit / allow-list 模式都基于这个集合计算
  workspaceOwners: PlatformOwner[]
  onChange: (next: BindingAccess) => void
}

// 三种模式对应的 i18n key，用于在 UI 中显示模式名称
const MODE_LABEL_KEYS: Record<BindingAccessMode, string> = {
  inherit: 'settings.messaging.telegram.access.bindingPopover.mode.inherit.label',
  'allow-list': 'settings.messaging.telegram.access.bindingPopover.mode.allowList.label',
  open: 'settings.messaging.telegram.access.bindingPopover.mode.open.label',
}

// 三种模式对应的说明文字 i18n key
const MODE_DESCRIPTION_KEYS: Record<BindingAccessMode, string> = {
  inherit: 'settings.messaging.telegram.access.bindingPopover.mode.inherit.description',
  'allow-list': 'settings.messaging.telegram.access.bindingPopover.mode.allowList.description',
  open: 'settings.messaging.telegram.access.bindingPopover.mode.open.description',
}

// 每种模式对应的图标组件。typeof ShieldCheck 表示“某个 lucide 图标组件类型”。
const MODE_ICONS: Record<BindingAccessMode, typeof ShieldCheck> = {
  inherit: ShieldCheck,
  'allow-list': Lock,
  open: Globe,
}

export function BindingAllowListPopover({ access, workspaceOwners, onChange }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const triggerLabel = buildTriggerLabel(access, workspaceOwners.length, t)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs text-foreground/60 hover:text-foreground"
        >
          {triggerLabel}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="px-3 py-2.5">
          <div className="text-xs font-medium">
            {t('settings.messaging.telegram.access.bindingPopover.title')}
          </div>
        </div>
        <div className="border-t border-border/50">
          {(['inherit', 'allow-list', 'open'] as BindingAccessMode[]).map((mode) => (
            <ModeRow
              key={mode}
              mode={mode}
              selected={access.mode === mode}
              onSelect={() =>
                onChange({
                  mode,
                  // 离开 allow-list 模式时清空 allowedSenderIds，避免网关继续沿用旧数据做判断
                  allowedSenderIds:
                    mode === 'allow-list'
                      ? access.allowedSenderIds.length > 0
                        ? access.allowedSenderIds
                        : workspaceOwners.map((o) => o.userId)
                      : [],
                })
              }
            />
          ))}
        </div>

        {access.mode === 'allow-list' && (
          <div className="border-t border-border/50 px-3 py-2.5">
            <div className="text-xs font-medium">
              {t('settings.messaging.telegram.access.allowedUsersTitle')}
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {workspaceOwners.length === 0 ? (
                <div className="text-xs text-foreground/50">
                  {t('settings.messaging.telegram.access.bindingPopover.noKnownUsers')}
                </div>
              ) : (
                workspaceOwners.map((owner) => {
                  const checked = access.allowedSenderIds.includes(owner.userId)
                  const primary = owner.displayName || owner.username || owner.userId
                  return (
                    <button
                      key={owner.userId}
                      type="button"
                      onClick={() => {
                        const next = checked
                          ? access.allowedSenderIds.filter((id) => id !== owner.userId)
                          : [...access.allowedSenderIds, owner.userId]
                        onChange({ mode: 'allow-list', allowedSenderIds: next })
                      }}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.05]"
                    >
                      <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/70">
                        {checked && <Check className="h-3 w-3" />}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-xs">{primary}</div>
                      {owner.username && (
                        <div className="shrink-0 text-xs text-foreground/40">
                          @{owner.username}
                        </div>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ModeRow({
  mode,
  selected,
  onSelect,
}: {
  mode: BindingAccessMode
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const Icon = MODE_ICONS[mode]
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
    >
      <Icon
        className="mt-0.5 h-4 w-4 shrink-0 text-foreground/60"
        strokeWidth={1.5}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs font-medium">
          {t(MODE_LABEL_KEYS[mode])}
          {selected && <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />}
        </div>
        <div className="mt-0.5 text-xs text-foreground/50">
          {t(MODE_DESCRIPTION_KEYS[mode])}
        </div>
      </div>
    </button>
  )
}

// 根据当前 access 模式生成触发按钮上显示的简短标签
function buildTriggerLabel(
  access: BindingAccess,
  workspaceOwnersCount: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (access.mode === 'inherit') {
    return workspaceOwnersCount === 0
      ? t('settings.messaging.telegram.access.bindingPopover.trigger.inheritEmpty')
      : t('settings.messaging.telegram.access.bindingPopover.trigger.inherit', {
          count: workspaceOwnersCount,
        })
  }
  if (access.mode === 'open') {
    return t('settings.messaging.telegram.access.bindingPopover.trigger.open')
  }
  return t('settings.messaging.telegram.access.bindingPopover.trigger.allowList', {
    count: access.allowedSenderIds.length,
  })
}

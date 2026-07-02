/**
 * 工作空间级“允许用户”列表编辑器，按平台维护。
 *
 * 这个列表决定谁能执行预绑定命令（如 `/new`、`/bind`），
 * 也作为 `mode === 'inherit'` 的 binding 默认的 `allowedSenderIds`。
 *
 * 组件被设计为渲染在 Settings → Messaging 里可折叠的“Allowed users”区域内，
 * 因此每行用 `IconSpacer` 做缩进，与父标题的文字列对齐，
 * 样式与“已配对超级群”下的 topic 行保持一致。
 *
 * 没有“手动添加用户”输入框：让用户手动输入 Telegram 数字 user_id 体验很差。
 * 添加用户走 pending-requests 面板：网关记录被拒绝的尝试后，owner 一键提升即可。
 */

import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PlatformOwner } from './types'

// 图标列宽度，必须与相邻行/父标题的图标列宽度一致，才能对齐
const ROW_ICON_SLOT_PX = 22

interface Props {
  owners: PlatformOwner[]
  // enforced 为 true 表示网关真的会按这个列表拦截；为 false 时列表仅作信息展示，
  // “锁定”操作由别处（AccessModeBanner）承载。
  enforced: boolean
  onRemove: (userId: string) => void
  // 当前用户 ID，用于给当前用户显示“(你)”标记
  currentUserId?: string
}

// 22px 宽的透明占位符，让无图标的行与父标题文字列对齐（参考 topic 行模式）
function IconSpacer() {
  return <div className="shrink-0" style={{ width: ROW_ICON_SLOT_PX, height: ROW_ICON_SLOT_PX }} />
}

export function OwnersListEditor({ owners, enforced, onRemove, currentUserId }: Props) {
  if (owners.length === 0) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 text-xs text-foreground/50">
        <IconSpacer />
        <span>
          <Trans
            i18nKey="settings.messaging.telegram.access.owners.empty"
            components={{
              code: <code className="rounded bg-foreground/[0.06] px-1 py-0.5" />,
            }}
          />
        </span>
      </div>
    )
  }

  return (
    <div className="divide-y divide-border/50">
      {owners.map((owner) => (
        <OwnerRow
          key={owner.userId}
          owner={owner}
          enforced={enforced}
          isCurrentUser={owner.userId === currentUserId}
          onRemove={() => onRemove(owner.userId)}
        />
      ))}
    </div>
  )
}

function OwnerRow({
  owner,
  enforced,
  isCurrentUser,
  onRemove,
}: {
  owner: PlatformOwner
  enforced: boolean
  isCurrentUser: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const primary = owner.displayName || owner.username || owner.userId
  const secondary = [
    owner.username ? `@${owner.username}` : null,
    `id ${owner.userId}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <IconSpacer />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm">{primary}</span>
          {isCurrentUser && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              {t('settings.messaging.telegram.access.owners.youBadge')}
            </span>
          )}
          {!enforced && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-foreground/40">
              {t('settings.messaging.telegram.access.owners.notEnforced')}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">{secondary}</div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="text-foreground/60 hover:text-destructive"
        aria-label={t('settings.messaging.telegram.access.owners.removeAria', { name: primary })}
      >
        <X className="h-3.5 w-3.5" />
        {t('settings.messaging.telegram.access.owners.remove')}
      </Button>
    </div>
  )
}

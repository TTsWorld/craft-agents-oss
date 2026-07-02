/**
 * 当 `accessMode === 'open'` 时，显示在平台卡片顶部的警告横幅。
 *
 * 作用是提醒管理员当前任何人都能通过该消息平台与 Agent 交互，
 * 并提供“一键锁定”按钮切换到 owner-only 模式。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  onLockDown: () => void
  // 可覆盖默认说明文字，例如用于非 Telegram 平台时传入不同文案
  description?: string
}

export function AccessModeBanner({ onLockDown, description }: Props) {
  const { t } = useTranslation()
  return (
    <div className="mx-4 my-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {t('settings.messaging.telegram.access.banner.title')}
        </div>
        <div className="mt-0.5 text-xs text-foreground/60">
          {description ?? t('settings.messaging.telegram.access.banner.description')}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onLockDown}>
        {t('settings.messaging.telegram.access.banner.lockDown')}
      </Button>
    </div>
  )
}

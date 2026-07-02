/**
 * TelegramConnectDialog —— 在模态框里输入 bot token 完成配对。
 *
 * 与 WhatsAppConnectDialog 是“兄弟组件”：对话框外形相同，但鉴权流程不同。
 * Telegram Bot API 不支持二维码登录，只能通过 @BotFather 发放的 bot token 连接。
 * 用户粘贴 token → 测试 → 保存 → 对话框关闭。
 *
 * 由 MessagingSettingsPage 用作保存 Telegram token 的唯一入口。
 * `reconfigure` 为 true 时表示“重新配置”：用户在三点菜单中选择 Reconfigure 时传入，
 * UI 文案会体现“替换已有 token”。
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'

interface TelegramConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 为 true 时把流程视为“替换已有 token”（来自 Reconfigure 菜单项）
  reconfigure?: boolean
  onSaved?: () => void
}

// 测试连接的结果状态机，TS 可辨识联合类型
type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; botName?: string; botUsername?: string }
  | { state: 'error'; error: string }

export function TelegramConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: TelegramConnectDialogProps) {
  const { t } = useTranslation()
  const [token, setToken] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  // 每次对话框打开/关闭时重置本地状态，避免重新配置时残留上次的成功/失败标记
  React.useEffect(() => {
    if (!open) {
      setToken('')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  // 点击“测试连接”：调用主进程验证 token 是否有效
  const handleTest = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testTelegramToken(trimmed)
      if (result.success) {
        setTest({ state: 'success', botName: result.botName, botUsername: result.botUsername })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({
        state: 'error',
        error: err instanceof Error ? err.message : t('common.error'),
      })
    }
  }

  // 点击“保存”：把验证通过的 token 持久化到主进程配置
  const handleSave = async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await window.electronAPI.saveTelegramToken(trimmed)
      toast.success(t('settings.messaging.telegram.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.telegram.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.telegram.reconfigureTitle')
              : t('settings.messaging.telegram.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.telegram.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <SettingsSecretInput
            value={token}
            onChange={setToken}
            placeholder={t('settings.messaging.telegram.tokenPlaceholder')}
            disabled={saving}
          />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!token.trim() || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="mr-1 text-[14px]" />}
              {t('settings.messaging.telegram.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t('settings.messaging.telegram.validBot', {
                  username: test.botUsername ?? test.botName ?? 'bot',
                })}
              </span>
            )}
            {test.state === 'error' && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <X className="h-3.5 w-3.5" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={!token.trim() || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="mr-1 text-[14px]" />}
            {t('settings.messaging.telegram.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

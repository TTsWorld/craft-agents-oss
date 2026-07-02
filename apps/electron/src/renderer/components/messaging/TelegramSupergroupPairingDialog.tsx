/**
 * TelegramSupergroupPairingDialog —— Telegram 超级群（forum）工作空间级配对。
 *
 * 与 PairingCodeDialog 是“兄弟组件”：文案不同，并且内置轮询循环，
 * 检测用户在群里发送配对码后是否完成绑定。
 *
 * 为什么用轮询：目前还没有专门的“超级群已配对”广播事件；
 * 而这个流程每个工作空间最多只跑一次，为此增加协议事件性价比不高。
 * 对话框打开期间每 1.5 秒调用 `getMessagingSupergroup()`，
 * 首次返回非空就关闭对话框并弹出成功提示。
 */

import * as React from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Bot 用户名（不带 @），用于生成“打开 bot”的 deep link
  botUsername?: string
  // 超级群配对成功后回调，父组件通常会重新拉取状态
  onPaired?: () => void
}

export function TelegramSupergroupPairingDialog({ open, onOpenChange, botUsername, onPaired }: Props) {
  const { t } = useTranslation()
  const [code, setCode] = React.useState<string | null>(null)
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = React.useState(0)
  const onPairedRef = React.useRef(onPaired)
  onPairedRef.current = onPaired

  // 每次对话框打开时重新生成配对码；关闭再打开会产生新码，
  // 符合用户预期，也避免与上一个码的 TTL 产生竞态。
  React.useEffect(() => {
    if (!open) {
      setCode(null)
      setExpiresAt(null)
      setError(null)
      return
    }
    let cancelled = false
    window.electronAPI
      .generateMessagingSupergroupCode('telegram')
      .then((res) => {
        if (cancelled) return
        setCode(res.code)
        setExpiresAt(res.expiresAt)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('common.error'))
      })
    return () => { cancelled = true }
  }, [open, t])

  // 倒计时：每秒更新剩余秒数
  React.useEffect(() => {
    if (!expiresAt) return
    const update = () => setSecondsLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  // 轮询检测是否已完成配对。关闭、成功或配对码过期时停止。
  React.useEffect(() => {
    if (!open || !code) return
    let cancelled = false
    const tick = async () => {
      try {
        const sg = await window.electronAPI.getMessagingSupergroup()
        if (cancelled) return
        if (sg) {
          toast.success(
            t('settings.messaging.telegram.supergroup.pairedToast', {
              defaultValue: 'Supergroup paired',
            }),
          )
          onPairedRef.current?.()
          onOpenChange(false)
        }
      } catch {
        // 尽力而为，继续轮询
      }
    }
    const interval = setInterval(tick, 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [open, code, t, onOpenChange])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60
  const pairCommand = code ? `/pair ${code}` : ''
  const botLink = botUsername ? `https://t.me/${botUsername}` : null

  const handleCopy = async () => {
    if (!pairCommand) return
    try {
      await navigator.clipboard.writeText(pairCommand)
      toast.success(t('toast.copied'))
    } catch {
      toast.error(t('toast.copyFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('settings.messaging.telegram.supergroup.dialogTitle', {
              defaultValue: 'Pair Telegram supergroup',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings.messaging.telegram.supergroup.dialogDescription', {
              defaultValue:
                'Add the bot to your supergroup, then type the command in any topic. The bot needs privacy mode disabled (BotFather → /setprivacy → Disable) or admin rights to read non-command messages.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          {error ? (
            <p className="text-sm text-destructive text-center">{error}</p>
          ) : code ? (
            <>
              <div className="rounded-lg bg-muted px-6 py-4 font-mono text-3xl font-bold tracking-[0.3em]">
                {code}
              </div>

              <div className="flex items-center gap-2 text-sm">
                <code className="rounded bg-muted px-2 py-1 font-mono">{pairCommand}</code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent"
                  title={t('common.copy')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>

              <p className="text-center text-sm text-muted-foreground">
                {t('settings.messaging.telegram.supergroup.dialogSendHint', {
                  defaultValue:
                    'Send this command from any topic in your supergroup. The dialog closes once paired.',
                })}
              </p>

              {botLink && (
                <a
                  href={botLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  @{botUsername}
                </a>
              )}

              {secondsLeft > 0 && (
                <p className="text-center text-xs text-muted-foreground">
                  {t('dialog.pairingCode.expiresIn', {
                    minutes,
                    seconds: String(seconds).padStart(2, '0'),
                  })}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('common.loading', { defaultValue: 'Loading…' })}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

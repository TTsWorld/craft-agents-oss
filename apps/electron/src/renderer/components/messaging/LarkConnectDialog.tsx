/**
 * LarkConnectDialog —— 输入 App ID + App Secret 完成 Lark / Feishu 配对。
 *
 * 与 `TelegramConnectDialog` 是同一套模态框结构，区别：
 *   - 两个密钥字段（App ID + App Secret），而不是一个 bot token
 *   - 需要选择区域：Lark（海外版）和 Feishu（国内版）是两个独立的开放平台；
 *     bot 属于其中一个，选择后不可更改。
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

interface LarkConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // 为 true 时把流程视为“替换已有凭证”
  reconfigure?: boolean
  onSaved?: () => void
}

// 测试连接结果状态机
type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success' }
  | { state: 'error'; error: string }

// Lark 域名联合类型：'lark' 海外版，'feishu' 国内版
type LarkDomain = 'lark' | 'feishu'

export function LarkConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: LarkConnectDialogProps) {
  const { t } = useTranslation()
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [domain, setDomain] = React.useState<LarkDomain>('lark')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  // 对话框关闭时重置所有本地状态
  React.useEffect(() => {
    if (!open) {
      setAppId('')
      setAppSecret('')
      setDomain('lark')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  // 两个字段都非空时才允许测试和保存
  const ready = appId.trim().length > 0 && appSecret.trim().length > 0

  // 点击“测试连接”
  const handleTest = async () => {
    if (!ready) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testLarkCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain,
      })
      if (result.success) {
        setTest({ state: 'success' })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({ state: 'error', error: err instanceof Error ? err.message : t('common.error') })
    }
  }

  // 点击“保存”：把验证通过的凭证持久化
  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveLarkCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain,
      })
      toast.success(t('settings.messaging.lark.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.lark.saveFailed'))
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
              ? t('settings.messaging.lark.reconfigureTitle')
              : t('settings.messaging.lark.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.lark.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* 区域选择器：Lark 海外版 vs Feishu 国内版 */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('settings.messaging.lark.domainLabel')}
            </div>
            <div className="flex gap-2">
              <Button
                variant={domain === 'lark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDomain('lark')}
                disabled={saving}
              >
                {t('settings.messaging.lark.domainLark')}
              </Button>
              <Button
                variant={domain === 'feishu' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDomain('feishu')}
                disabled={saving}
              >
                {t('settings.messaging.lark.domainFeishu')}
              </Button>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('settings.messaging.lark.appIdLabel')}
            </div>
            <SettingsSecretInput
              value={appId}
              onChange={setAppId}
              placeholder={t('settings.messaging.lark.appIdPlaceholder')}
              disabled={saving}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('settings.messaging.lark.appSecretLabel')}
            </div>
            <SettingsSecretInput
              value={appSecret}
              onChange={setAppSecret}
              placeholder={t('settings.messaging.lark.appSecretPlaceholder')}
              disabled={saving}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!ready || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="mr-1 text-[14px]" />}
              {t('settings.messaging.lark.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t('settings.messaging.lark.testOk')}
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
            disabled={!ready || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="mr-1 text-[14px]" />}
            {t('settings.messaging.lark.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

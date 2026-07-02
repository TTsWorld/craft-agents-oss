/**
 * MessagingSessionMenuItem
 *
 * “Connect Messaging → Telegram / WhatsApp / Lark” 子菜单块，
 * 被 SessionMenu（真实的右键/context/dropdown 菜单）和 playground 预览共用。
 *
 * 行为：
 *  - 如果目标平台尚未连接，引导用户到正确的设置入口：
 *    WhatsApp 打开连接对话框；Telegram/Lark 默认跳转到 messaging 设置并提示。
 *    调用方可通过 `onTelegramNotConfigured` 覆盖默认行为（例如 playground 没有路由，只 toast）。
 *  - 如果平台已连接，通过 `messagingDialogAtom` 打开配对码对话框，
 *    并调用 `generateMessagingPairingCode` 生成配对码。
 *
 * 组件只渲染 `<Sub>` 子菜单块；由调用方决定放在哪里、是否加分隔线。
 * 通过 `useMenuComponents()` 读取菜单原子组件，使其在 DropdownMenu 或 ContextMenu 中表现一致。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import type { TFunction } from 'i18next'
import { navigate, routes } from '@/lib/navigate'
import { useMenuComponents } from '@/components/ui/menu-context'
import { messagingDialogAtom } from '@/atoms/messaging'

export type MessagingPlatform = 'telegram' | 'whatsapp' | 'lark'

export interface UseMessagingConnectOptions {
  // 要绑定配对码的 session ID
  sessionId: string
  /**
   * 当用户点击 Telegram 或 Lark 但该平台尚未配置时调用。
   * 默认行为：跳转到 messaging 设置并弹出提示。
   * Playground 会覆盖为只 toast（因为 playground 没有路由）。
   */
  onTelegramNotConfigured?: () => void
  /**
   * 自定义配对码生成失败时的错误分类器。
   * 默认使用 {@link classifyMessagingError}，把“未连接”“限流”等错误映射为 i18n key。
   */
  classifyError?: (err: unknown, t: TFunction) => string
}

/**
 * 共享的“连接并配对”处理函数。
 *
 * 同时被下拉/context 菜单的 `MessagingSessionMenuItem` 和抽屉式的 `CompactSessionMenu` 使用。
 * React.useCallback 保证多次渲染间引用稳定，避免子菜单触发不必要的重渲染。
 */
export function useMessagingConnect({
  sessionId,
  onTelegramNotConfigured,
  classifyError = classifyMessagingError,
}: UseMessagingConnectOptions) {
  const { t } = useTranslation()
  const setMessagingDialog = useSetAtom(messagingDialogAtom)

  return React.useCallback(async (platform: MessagingPlatform) => {
    // 前置检查：如果平台未连接，直接引导设置，避免无意义地请求服务器。
    // 读取配置失败时视为“未知”，继续尝试生成配对码，让服务端给出真实错误。
    try {
      const cfg = await window.electronAPI.getMessagingConfig()
      const runtime = cfg?.runtime?.[platform]
      const isConnected = Boolean(runtime?.connected)
      if (!isConnected) {
        if (platform === 'whatsapp') {
          setMessagingDialog({ kind: 'wa_connect', continueToPairingSessionId: sessionId })
        } else if (onTelegramNotConfigured) {
          onTelegramNotConfigured()
        } else {
          // Telegram 和 Lark 都走“打开 Settings”路径：两者都用设置对话框，而非内联连接流程
          navigate(routes.view.settings('messaging'))
          toast.info(t('toast.telegramNotConfiguredOpenSettings'))
        }
        return
      }
    } catch {
      // 读取配置失败，继续尝试生成配对码
    }

    setMessagingDialog({
      kind: 'pairing',
      platform,
      sessionId,
      code: null,
      expiresAt: null,
    })
    try {
      const result = await window.electronAPI.generateMessagingPairingCode(sessionId, platform)
      setMessagingDialog({
        kind: 'pairing',
        platform,
        sessionId,
        code: result.code,
        expiresAt: result.expiresAt,
        botUsername: result.botUsername,
      })
    } catch (err) {
      setMessagingDialog({
        kind: 'pairing',
        platform,
        sessionId,
        code: null,
        expiresAt: null,
        error: classifyError(err, t),
      })
    }
  }, [sessionId, onTelegramNotConfigured, classifyError, setMessagingDialog, t])
}

export interface MessagingSessionMenuItemProps extends UseMessagingConnectOptions {}

export function MessagingSessionMenuItem(props: MessagingSessionMenuItemProps) {
  const { t } = useTranslation()
  const { MenuItem, Sub, SubTrigger, SubContent } = useMenuComponents()
  const handleConnectMessaging = useMessagingConnect(props)

  return (
    <Sub>
      <SubTrigger className="pr-2">
        <MessageSquare className="h-3.5 w-3.5" />
        <span className="flex-1">{t('sessionMenu.connectMessaging')}</span>
      </SubTrigger>
      <SubContent>
        <MenuItem onClick={() => handleConnectMessaging('telegram')}>
          <span>Telegram</span>
        </MenuItem>
        <MenuItem onClick={() => handleConnectMessaging('whatsapp')}>
          <span>WhatsApp</span>
        </MenuItem>
        <MenuItem onClick={() => handleConnectMessaging('lark')}>
          <span>Lark / Feishu</span>
        </MenuItem>
      </SubContent>
    </Sub>
  )
}

/**
 * 把配对码 RPC 返回的原始错误转换为用户可见的文案。
 *
 * 故意保持精简——只识别几种已知失败模式；其余错误原样展示，避免掩盖真实问题。
 */
export function classifyMessagingError(err: unknown, t: TFunction): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/platform not connected|no adapter|not configured/i.test(msg)) {
    return t('toast.messagingNotConfigured')
  }
  if (/rate.?limit/i.test(msg)) {
    return t('toast.messagingRateLimited')
  }
  return msg
}

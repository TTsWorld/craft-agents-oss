/**
 * MessagingDialogHost
 *
 * 全局宿主组件，负责管理消息配对/连接对话框的状态。
 *
 * 为什么需要它：
 *  - 菜单（右键/context menu/dropdown）触发配对后，菜单本身会关闭；
 *    如果对话框由菜单组件持有，菜单卸载时对话框也会消失。
 *  - 把对话框状态提升到全局 atom，并由这个宿主组件渲染，可以让对话框
 *    在触发菜单关闭后继续存在。
 *
 * 自动关闭：当用户在其 bot 中发送 `/pair <code>` 完成绑定后，网关会发出
 * `messaging:bindingChanged` 事件；我们监听该信号，拉取最新 binding 列表，
 * 如果当前对话框的 sessionId 在该平台上已有活跃绑定，就关闭对话框并 toast 成功。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { messagingDialogAtom } from '@/atoms/messaging'
import { PairingCodeDialog } from './PairingCodeDialog'
import { WhatsAppConnectDialog } from './WhatsAppConnectDialog'

export function MessagingDialogHost() {
  const [state, setState] = useAtom(messagingDialogAtom)
  const { t } = useTranslation()

  const close = () => setState({ kind: 'closed' })

  // 仅在用户等待配对码时订阅 binding 变化事件。
  // 事件回调需要读取最新 state，但 effect 依赖数组又不能包含 state，
  // 否则每次 state 变化都会重新订阅。用 ref 保存最新 state 以保持稳定订阅。
  const stateRef = React.useRef(state)
  stateRef.current = state

  const isWaitingForPair = state.kind === 'pairing' && state.code !== null
  React.useEffect(() => {
    if (!isWaitingForPair) return
    const off = window.electronAPI.onMessagingBindingChanged(async () => {
      const current = stateRef.current
      if (current.kind !== 'pairing' || current.code === null) return
      try {
        const bindings = await window.electronAPI.getMessagingBindings()
        const bound = bindings.some(
          (b) =>
            b.enabled &&
            b.sessionId === current.sessionId &&
            b.platform === current.platform,
        )
        if (bound) {
          toast.success(t('toast.messagingPaired'))
          setState({ kind: 'closed' })
        }
      } catch {
        // 如果无法验证，保持对话框打开，用户仍可手动关闭
      }
    })
    return off
  }, [isWaitingForPair, setState, t])

  // 打开配对码对话框，并异步向主进程申请生成配对码
  const openPairing = async (sessionId: string, platform: 'telegram' | 'whatsapp') => {
    setState({
      kind: 'pairing',
      platform,
      sessionId,
      code: null,
      expiresAt: null,
    })
    try {
      const result = await window.electronAPI.generateMessagingPairingCode(sessionId, platform)
      setState({
        kind: 'pairing',
        platform,
        sessionId,
        code: result.code,
        expiresAt: result.expiresAt,
        botUsername: result.botUsername,
      })
    } catch (err) {
      setState({
        kind: 'pairing',
        platform,
        sessionId,
        code: null,
        expiresAt: null,
        error: classifyMessagingError(err),
      })
    }
  }

  // WhatsApp 连接成功后：如果之前记录了“连接完成后要跳转到的 sessionId”，
  // 则继续为该 session 生成配对码；否则直接关闭对话框。
  const handleWhatsAppConnected = () => {
    if (state.kind === 'wa_connect' && state.continueToPairingSessionId) {
      void openPairing(state.continueToPairingSessionId, 'whatsapp')
      return
    }
    close()
  }

  return (
    <>
      <PairingCodeDialog
        open={state.kind === 'pairing'}
        onOpenChange={(o) => { if (!o) close() }}
        platform={state.kind === 'pairing' ? state.platform : 'telegram'}
        code={state.kind === 'pairing' ? state.code : null}
        expiresAt={state.kind === 'pairing' ? state.expiresAt : null}
        botUsername={state.kind === 'pairing' ? state.botUsername : undefined}
        error={state.kind === 'pairing' ? state.error : undefined}
      />
      <WhatsAppConnectDialog
        open={state.kind === 'wa_connect'}
        onOpenChange={(o) => { if (!o) close() }}
        onConnected={handleWhatsAppConnected}
      />
    </>
  )
}

function classifyMessagingError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not connected/i.test(msg)) {
    return 'WhatsApp is not connected yet. Reconnect it in Settings → Messaging and try again.'
  }
  if (/rate.?limit/i.test(msg)) {
    return 'Too many pairing code requests. Please wait a moment and try again.'
  }
  return msg
}

/**
 * MessagingSettingsPagePreview
 * MessagingSettingsPagePreview：消息设置页面的 playground 预览包装器。
 *
 * Thin playground wrapper around the real MessagingSettingsPage that drives
 * the mock messaging state via `window.__playgroundMessaging` based on
 * variant props. Lets you toggle Telegram/WhatsApp connection status and
 * seed bindings without the component needing playground-specific props.
 * 它通过 playground 变体 props 驱动 mock 状态，让设计师可以在没有后端的情况下切换连接状态和绑定数据。
 */

import * as React from 'react'
// jotai 是 React 状态管理库；useSetAtom 只返回设置 atom 的函数，不订阅 atom 变化。
import { useSetAtom } from 'jotai'
import MessagingSettingsPage from '../../../pages/settings/MessagingSettingsPage'
import { setMessagingBindingsAtom, type MessagingBinding } from '../../../atoms/messaging'
import { sessionMetaMapAtom, type SessionMeta } from '../../../atoms/sessions'
import { playgroundMessagingHandle } from '../../mock-utils'

// playground 预设：无绑定、一条绑定、多条绑定。
type BindingsPreset = 'none' | 'one' | 'many'

// playground 工作区 ID，用于把 mock 数据限定在 playground 范围内。
const PLAYGROUND_WORKSPACE_ID = 'playground-workspace'

// 根据预设生成不同的 MessagingBinding 数组；...base 展开语法复用公共字段。
function buildBindings(preset: BindingsPreset): MessagingBinding[] {
  const base = {
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    enabled: true,
    createdAt: Date.now(),
  }
  switch (preset) {
    case 'none':
      return []
    case 'one':
      return [
        {
          ...base,
          id: 'binding-1',
          sessionId: 'session-aaa',
          platform: 'telegram',
          channelId: '123456',
          channelName: 'Gyula (DM)',
        },
      ]
    case 'many':
      return [
        {
          ...base,
          id: 'binding-1',
          sessionId: 'session-aaa',
          platform: 'telegram',
          channelId: '123456',
          channelName: 'Gyula (DM)',
        },
        {
          ...base,
          id: 'binding-2',
          sessionId: 'session-bbb',
          platform: 'whatsapp',
          channelId: '36201234567@s.whatsapp.net',
          channelName: 'Standup Bot',
          createdAt: Date.now() - 86_400_000,
        },
        {
          ...base,
          id: 'binding-3',
          sessionId: 'session-ccc',
          platform: 'telegram',
          channelId: '-10098765',
          channelName: 'Team Inbox',
          createdAt: Date.now() - 2 * 86_400_000,
        },
      ]
  }
}

/**
 * Mock SessionMeta entries matching the mock bindings so `getSessionTitle`
 * resolves to a real-looking title in the playground (instead of the
 * sessionId-slice fallback).
 * 模拟 SessionMeta，让 getSessionTitle 在 playground 里显示真实名称而不是 sessionId。
 */
const MOCK_SESSION_META: Record<string, SessionMeta> = {
  'session-aaa': {
    id: 'session-aaa',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Gyula DM — Telegram chat',
  },
  'session-bbb': {
    id: 'session-bbb',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Standup Bot — WhatsApp workflow',
  },
  'session-ccc': {
    id: 'session-ccc',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Team Inbox — Telegram group',
  },
}

/** MessagingSettingsPagePreviewProps：组件 props 类型定义 */
export interface MessagingSettingsPagePreviewProps {
  telegramConnected: boolean
  whatsappConnected: boolean
  bindings: BindingsPreset
}

/** MessagingSettingsPagePreview：函数 */
export function MessagingSettingsPagePreview({
  telegramConnected,
  whatsappConnected,
  bindings,
}: MessagingSettingsPagePreviewProps) {
  // 从 jotai 拿到设置函数，用于直接修改全局状态（这里把 mock 绑定写进 atom）。
  const setBindingsAtom = useSetAtom(setMessagingBindingsAtom)
  const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

  // Seed session metadata once so `getSessionTitle` resolves to a real name
  // for the mock bindings. Runs on mount; cleared on unmount to avoid leaking
  // fake sessions into other playground demos.
  // 组件挂载时把 mock session 元数据写入 atom；卸载时清理，避免污染其他 demo。
  React.useEffect(() => {
    setSessionMetaMap((prev) => {
      const next = new Map(prev)
      for (const meta of Object.values(MOCK_SESSION_META)) next.set(meta.id, meta)
      return next
    })
    return () => {
      setSessionMetaMap((prev) => {
        const next = new Map(prev)
        for (const id of Object.keys(MOCK_SESSION_META)) next.delete(id)
        return next
      })
    }
  }, [setSessionMetaMap])

  // 当 Telegram 连接状态 prop 变化时，同步到 playground mock handle。
  React.useEffect(() => {
    playgroundMessagingHandle.setTelegramConnected(
      telegramConnected,
      telegramConnected ? 'Playground Bot' : undefined,
    )
  }, [telegramConnected])

  // 当 WhatsApp 连接状态 prop 变化时，同步到 playground mock handle。
  React.useEffect(() => {
    playgroundMessagingHandle.setWhatsAppConnected(
      whatsappConnected,
      whatsappConnected ? 'Gyula' : undefined,
    )
  }, [whatsappConnected])

  // 当绑定 preset 变化时，生成绑定数据并同时写入 mock handle 和 jotai atom。
  React.useEffect(() => {
    const seeded = buildBindings(bindings)
    playgroundMessagingHandle.setBindings(seeded)
    // Also seed the atom directly so the first render of BindingsTable shows
    // the seeded rows even before the effect fires.
    setBindingsAtom(seeded)
  }, [bindings, setBindingsAtom])

  // 渲染真实页面组件，所有 playground 状态已通过副作用注入。
  return <MessagingSettingsPage />
}

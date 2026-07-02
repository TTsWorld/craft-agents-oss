/**
 * 消息网关状态原子
 *
 * 消息网关（messaging gateway）的工作区级别状态。
 * 通过订阅 messaging:bindingChanged 推送事件来填充。
 *
 * IPC（Inter-Process Communication）是 Electron 里主进程和渲染进程通信的机制，
 * 这里渲染进程收到推送事件后更新 Jotai atom。
 */

import { atom } from 'jotai'

/** 消息绑定：把一个会话（session）和一个外部消息渠道（如 Telegram/WhatsApp）关联起来。 */
export interface MessagingBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  channelId: string
  /** Telegram 超级群论坛主题 ID；DM 或非 Telegram 场景下为 undefined。 */
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  /**
   * 每个绑定的访问策略。接口字段 optional（可选），因此旧绑定在接入控制之前创建的
   * 也不会破坏 atom 更新。UI 把缺失值当作 'open' 处理。
   */
  accessMode?: 'inherit' | 'allow-list' | 'open'
  allowedSenderIds?: string[]
}

/** 当前工作区所有启用中的消息绑定列表。 */
export const messagingBindingsAtom = atom<MessagingBinding[]>([])

/**
 * 派生 atom：按 sessionId 分组后的消息绑定。
 * Map<string, MessagingBinding[]> 类似 Go 的 map[string][]MessagingBinding。
 */
export const messagingBindingsBySessionAtom = atom((get) => {
  const map = new Map<string, MessagingBinding[]>()
  for (const binding of get(messagingBindingsAtom)) {
    if (!binding.enabled) continue
    const list = map.get(binding.sessionId)
    if (list) {
      list.push(binding)
    } else {
      map.set(binding.sessionId, [binding])
    }
  }
  return map
})

/**
 * Action atom：设置绑定列表，同时过滤掉未启用的绑定。
 * 第一个参数传 null 表示这是一个可写的 action atom。
 */
export const setMessagingBindingsAtom = atom(
  null,
  (_get, set, bindings: MessagingBinding[]) => {
    set(messagingBindingsAtom, bindings.filter((binding) => binding.enabled))
  },
)

/**
 * 全局消息对话框状态。
 *
 * 把它从 SessionMenu 里提升到 atom，是因为右键菜单/下拉框关闭时对话框不能跟着消失。
 * 实际由挂载在 AppShell 级别的 <MessagingDialogHost /> 渲染。
 */
export type MessagingDialogState =
  | { kind: 'closed' }
  | {
      kind: 'pairing'
      platform: 'telegram' | 'whatsapp' | 'lark'
      sessionId: string
      code: string | null
      expiresAt: number | null
      botUsername?: string
      error?: string
    }
  | {
      kind: 'wa_connect'
      continueToPairingSessionId?: string
    }

/** 当前消息对话框的状态，初始为关闭。 */
export const messagingDialogAtom = atom<MessagingDialogState>({ kind: 'closed' })

/**
 * EventSink 扇出工具。
 *
 * 把多个 EventSink 回调组合成单个回调。
 * 用于把 MessagingGateway 和现有的 WsRpcServer push 接在一起。
 *
 * bootstrap 中的用法：
 * ```ts
 * import { createFanOutSink } from '@craft-agent/messaging-gateway'
 *
 * setSessionEventSink: (sm, sink) => {
 *   const fanOut = createFanOutSink(sink, gateway.onSessionEvent.bind(gateway))
 *   sm.setEventSink(fanOut)
 * }
 * ```
 */

import type { PushTarget } from '@craft-agent/shared/protocol'

export type EventSinkFn = (channel: string, target: PushTarget, ...args: any[]) => void

/**
 * 创建一个扇出 EventSink，把事件转发给多个 sink。
 * 其中一个 sink 出错不会阻塞其他 sink。
 */
export function createFanOutSink(...sinks: EventSinkFn[]): EventSinkFn {
  return (channel: string, target: PushTarget, ...args: any[]) => {
    for (const sink of sinks) {
      try {
        sink(channel, target, ...args)
      } catch {
        // 一个 sink 失败不能影响其他 sink
      }
    }
  }
}

/**
 * 类型安全的 push 辅助函数。
 *
 * 把 server.push 包装一层，让 channel 和 args 在编译期与 BroadcastEventMap 对齐，
 * 避免手写 channel 字符串时出错。
 *
 * 泛型 K 被约束为 BroadcastEventMap 的键且为 string，这样 channel 只能是已知事件名，
 * args 也会自动对应到该事件名的参数类型。
 *
 * 类似 Golang 里把 `map[string]any` 的 push 包装成强类型函数。
 */

import type { BroadcastEventMap, PushTarget } from '@craft-agent/shared/protocol'
import type { RpcServer } from './types'

export function pushTyped<K extends keyof BroadcastEventMap & string>(
  server: RpcServer,
  channel: K,
  target: PushTarget,
  ...args: BroadcastEventMap[K]
): void {
  server.push(channel, target, ...args)
}

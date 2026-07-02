import type { Message, StoredMessage } from './message.ts';

/**
 * 运行时 Message ↔ 持久化 StoredMessage 的转换器。
 *
 * 思路类似 Golang 里的 DTO 转换：运行时对象多放一些 UI 状态字段，
 * 落盘对象只保留必要字段，两者分离可以避免序列化出错。
 */

/**
 * 把运行时的 Message 转成落盘用的 StoredMessage。
 *
 * 排除的瞬态字段：
 * - isStreaming：流式输出中标记，落盘时不需要
 * - isPending：待确认/待处理标记，落盘时不需要
 *
 * 同时把 Message 里的 `role` 字段改名为 StoredMessage 里的 `type` 字段。
 */
export function messageToStored(msg: Message): StoredMessage {
  const { role, isStreaming, isPending, ...rest } = msg;
  return { ...rest, type: role } as StoredMessage;
}

/**
 * 把落盘的 StoredMessage 转回运行时的 Message。
 *
 * 老版本存储的消息可能缺少 timestamp，这里用 `??` 提供当前时间作为兜底。
 * 同时把 StoredMessage 里的 `type` 字段恢复为 Message 里的 `role` 字段。
 */
export function storedToMessage(stored: StoredMessage): Message {
  const { type, ...rest } = stored;
  return { ...rest, role: type, timestamp: stored.timestamp ?? Date.now() } as Message;
}

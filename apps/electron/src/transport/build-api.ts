/**
 * 构造 Electron 渲染进程使用的客户端 API 代理。
 *
 * 这个文件替代了原来 329 行的 preload 脚本。
 * ElectronAPI 这个 TypeScript interface 负责在编译期做类型检查，
 * 而这个代理对象负责在运行期把方法调用分发到对应的 IPC channel。
 *
 * 对 Golang 同学来说：可以把 ElectronAPI 理解成服务端定义的一套接口，
 * buildClientApi 就是根据 channelMap 这个“路由表”动态生成接口实现的工厂函数。
 */

import type { RpcClient } from '@craft-agent/server-core/transport'
import type { ElectronAPI } from '../shared/types'

// ---------------------------------------------------------------------------
// 通道映射条目（Channel map entry）
// ---------------------------------------------------------------------------

/**
 * 单个通道映射条目，描述一个 ElectronAPI 方法对应哪种 IPC 通道。
 * - invoke：一次请求-响应式的调用（类似 HTTP/RPC）。
 * - listener：事件监听器，底层是 pub/sub（类似 Go 里的 channel 订阅）。
 */
export type ChannelMapEntry =
  | { type: 'invoke'; channel: string; transform?: (result: any) => any }
  | { type: 'listener'; channel: string }

/**
 * 整个映射表：key 是渲染进程调用的方法名，value 是对应的通道配置。
 * Record<string, ChannelMapEntry> 是 TS 内置类型，相当于 Go 里的 map[string]ChannelMapEntry。
 */
export type ChannelMap = Record<string, ChannelMapEntry>

// ---------------------------------------------------------------------------
// 代理构造器
// ---------------------------------------------------------------------------

/**
 * 根据 channelMap 为渲染进程构造出 ElectronAPI 的 JavaScript 对象。
 *
 * @param client - 实际发 RPC/监听事件的底层客户端。
 * @param channelMap - 方法名到 IPC 通道的映射表。
 * @param isChannelAvailable - 可选的通道可用性判断函数，用于 GUI 根据连接状态禁用某些功能。
 */
export function buildClientApi(
  client: RpcClient,
  channelMap: ChannelMap,
  isChannelAvailable?: (channel: string) => boolean,
): ElectronAPI {
  const api: Record<string, any> = {}
  const nested: Record<string, Record<string, any>> = {}

  for (const [key, entry] of Object.entries(channelMap)) {
    let fn: (...a: any[]) => any

    if (entry.type === 'listener') {
      // listener：把回调注册到底层 client 的 on 方法上。
      fn = (cb: (...args: any[]) => void) => client.on(entry.channel, cb)
    } else if (entry.transform) {
      // invoke + transform：先发起调用，拿到结果后再用 transform 做后处理。
      const t = entry.transform
      fn = async (...args: any[]) => t(await client.invoke(entry.channel, ...args))
    } else {
      // 普通 invoke：直接把参数透传给底层 client。
      fn = (...args: any[]) => client.invoke(entry.channel, ...args)
    }

    // 带点号的方法名（如 "browserPane.create"）会被展开成嵌套对象：api.browserPane.create
    const dotIdx = key.indexOf('.')
    if (dotIdx !== -1) {
      const ns = key.slice(0, dotIdx)
      const method = key.slice(dotIdx + 1)
      if (!nested[ns]) nested[ns] = {}
      nested[ns][method] = fn
    } else {
      api[key] = fn
    }
  }

  // 把收集到的命名空间（如 browserPane）作为普通对象挂到 api 上
  for (const [ns, methods] of Object.entries(nested)) {
    api[ns] = methods
  }

  // 暴露通道可用性检查函数，GUI 可以根据这个判断某些功能当前是否可用
  api.isChannelAvailable = isChannelAvailable ?? (() => true)

  // 用 `as ElectronAPI` 告诉 TS：这个动态构造出来的对象满足 ElectronAPI 类型约束。
  return api as ElectronAPI
}

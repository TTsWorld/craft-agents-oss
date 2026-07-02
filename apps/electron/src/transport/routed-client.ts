/**
 * RoutedClient —— 客户端侧通道路由器。
 *
 * 内部封装了两个 WsRpcClient 实例：
 * - localClient：永远是内置的 Electron 本地服务器；
 * - workspaceClient：当前活动 workspace 所归属的服务器（可能是本地，也可能是远程）。
 *
 * 路由规则：
 * - LOCAL_ONLY 通道永远走 localClient；
 * - 其他通道全部走 workspaceClient；
 * - 当用户切换 workspace 时，workspaceClient 会被替换，REMOTE_ELIGIBLE 的监听器
 *   会透明地重新订阅（make-before-break：先在新客户端订阅，再取消旧客户端）。
 *
 * 对 Golang 同学的类比：这就像一个支持动态 upstream 切换的反向代理 + 订阅管理器。
 */

import type { WsRpcClient, TransportConnectionState } from './client'
import type { RpcClient } from '@craft-agent/server-core/transport'
import type { RemoteServerConfig } from '@craft-agent/core/types'
import { isLocalOnly, RPC_CHANNELS } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 单个监听器条目。
 * - callback：收到事件时执行的回调函数。
 * - unsub：取消订阅函数，调用后停止监听。
 */
interface ListenerEntry {
  callback: (...args: any[]) => void
  unsub: () => void
}

/**
 * 增强版 SWITCH_WORKSPACE 通道返回的结果。
 * - workspaceId：本地 workspace ID。
 * - remoteServer：如果切换到远程 workspace，则包含远程服务器配置；本地则为 null/undefined。
 */
export interface WorkspaceSwitchResult {
  workspaceId: string
  remoteServer?: RemoteServerConfig | null
}

/**
 * 工厂函数类型：根据远程服务器配置创建一个新的 WsRpcClient。
 *
 * 写法 `(remoteServer: RemoteServerConfig) => WsRpcClient` 是 TS 的函数类型，
 * 相当于 Go 里的 `type WorkspaceClientFactory func(remoteServer RemoteServerConfig) WsRpcClient`。
 */
export type WorkspaceClientFactory = (remoteServer: RemoteServerConfig) => WsRpcClient

// ---------------------------------------------------------------------------
// RoutedClient 类
// ---------------------------------------------------------------------------

/**
 * 路由客户端：实现 RpcClient 接口，根据通道的“本地/远程”属性决定把请求发到哪里。
 * 这样上层代码不需要关心当前 workspace 是本地还是远程，统一调用 RoutedClient 即可。
 */
export class RoutedClient implements RpcClient {
  private workspaceClient: WsRpcClient

  /**
   * REMOTE_ELIGIBLE 监听器注册表。
   * 这些监听器在 workspace 切换时需要“迁移”到新 client，因此单独保存。
   * 用 Map<string, Set<...>> 管理，键是 channel，值是该通道下的所有监听器条目。
   */
  private remoteListeners = new Map<string, Set<ListenerEntry>>()

  /**
   * Capability（能力/反向调用）处理器注册表。
   * 服务端可以反向调用客户端注册的 capability，切换 client 后需要重新注册。
   */
  private capabilities = new Map<string, (...args: any[]) => Promise<any> | any>()

  /**
   * 连接状态监听器集合。
   * RoutedClient 自己聚合这些监听器，然后委托给当前的 workspaceClient 去监听状态变化。
   */
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private connectionStateUnsub: (() => void) | null = null

  /** 用于在切换 workspace 时创建远程 WsRpcClient 的工厂函数。 */
  private clientFactory: WorkspaceClientFactory | null = null

  /**
   * workspace ID 映射：把本地 workspace ID 翻译成远程 workspace ID。
   * 当当前 workspace 是远程时，渲染进程传的是本地 ID，但远程服务器只认识自己的 remoteId，
   * 所以 invoke() 需要在参数里把 localId 替换成 remoteId。
   */
  private workspaceIdMapping: { localId: string; remoteId: string } | null = null

  constructor(
    private readonly localClient: WsRpcClient,
    initialWorkspaceClient: WsRpcClient,
  ) {
    this.workspaceClient = initialWorkspaceClient
    this.bindConnectionState()
  }

  /** 设置创建远程 workspace 客户端的工厂函数。 */
  setClientFactory(factory: WorkspaceClientFactory): void {
    this.clientFactory = factory
  }

  /**
   * 设置 workspace ID 映射（用于远程 workspace）。
   * invoke() 会把参数中的 localId 替换为 remoteId，让远程服务器能正确解析 workspace。
   */
  setWorkspaceMapping(localId: string, remoteId: string): void {
    this.workspaceIdMapping = { localId, remoteId }
  }

  /** 清除 workspace ID 映射（切换回本地 workspace 时调用）。 */
  clearWorkspaceMapping(): void {
    this.workspaceIdMapping = null
  }

  // -------------------------------------------------------------------------
  // RpcClient 接口实现
  // -------------------------------------------------------------------------

  /**
   * 发起一次 RPC 调用。
   * 根据 channel 的本地/远程属性选择 target client，必要时翻译 workspaceId 参数。
   */
  async invoke(channel: string, ...args: any[]): Promise<any> {
    const isLocal = isLocalOnly(channel)
    const target = isLocal ? this.localClient : this.workspaceClient

    /**
     * 本地 workspace ID → 远程 workspace ID 的参数翻译。
     * RPC 处理函数通常把 workspaceId 作为普通参数传入（而不是从连接上下文取），
     * 所以路由到远程服务器时，需要把渲染进程的 localId 换成 remoteId。
     * 这里同时处理两种形式：
     * - 顶层字符串参数：例如 getSkills(workspaceId)
     * - 对象参数里的 workspaceId 字段：例如 testAutomation({ workspaceId, ... })
     */
    const translatedArgs = (!isLocal && this.workspaceIdMapping)
      ? args.map(arg => {
          if (arg === this.workspaceIdMapping!.localId) return this.workspaceIdMapping!.remoteId
          if (arg && typeof arg === 'object' && 'workspaceId' in arg && arg.workspaceId === this.workspaceIdMapping!.localId) {
            return { ...arg, workspaceId: this.workspaceIdMapping!.remoteId }
          }
          return arg
        })
      : args

    const result = await target.invoke(channel, ...translatedArgs)

    // 拦截 SWITCH_WORKSPACE 的返回结果，根据是否有远程服务器来切换 workspaceClient
    if (channel === RPC_CHANNELS.window.SWITCH_WORKSPACE) {
      this.handleWorkspaceSwitch(result as WorkspaceSwitchResult)
    }

    return result
  }

  /**
   * 注册一个事件监听器。
   * LOCAL_ONLY 通道直接委托给 localClient；其他通道注册到 workspaceClient，
   * 并记录到 remoteListeners 中，以便 workspace 切换时重新订阅。
   */
  on(channel: string, callback: (...args: any[]) => void): () => void {
    if (isLocalOnly(channel)) {
      return this.localClient.on(channel, callback)
    }

    // REMOTE_ELIGIBLE：先在 workspaceClient 上订阅，再跟踪起来用于后续重新订阅
    const unsub = this.workspaceClient.on(channel, callback)

    let set = this.remoteListeners.get(channel)
    if (!set) {
      set = new Set()
      this.remoteListeners.set(channel, set)
    }
    const entry: ListenerEntry = { callback, unsub }
    set.add(entry)

    // 返回的取消订阅函数：取消底层订阅，并从注册表中移除
    return () => {
      entry.unsub()
      set!.delete(entry)
      if (set!.size === 0) this.remoteListeners.delete(channel)
    }
  }

  /**
   * 注册一个 capability（服务端可调用的客户端能力）。
   * 同时注册到 localClient 和 workspaceClient，因为任意一个服务端都可能反向调用它。
   */
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilities.set(channel, handler)
    this.localClient.handleCapability(channel, handler)
    if (this.workspaceClient !== this.localClient) {
      this.workspaceClient.handleCapability(channel, handler)
    }
  }

  // -------------------------------------------------------------------------
  // 扩展接口（由 bootstrap / build-api 使用）
  // -------------------------------------------------------------------------

  /** 判断某个 channel 当前是否可用。 */
  isChannelAvailable(channel: string): boolean {
    const target = isLocalOnly(channel) ? this.localClient : this.workspaceClient
    return target.isChannelAvailable(channel)
  }

  /** 获取当前 workspaceClient 的连接状态。 */
  getConnectionState(): TransportConnectionState {
    return this.workspaceClient.getConnectionState()
  }

  /** 注册连接状态变化监听器，注册后立即同步当前状态一次。 */
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => { this.connectionStateListeners.delete(callback) }
  }

  /** 立即触发底层 workspaceClient 的重连。 */
  reconnectNow(): void {
    this.workspaceClient.reconnectNow()
  }

  // -------------------------------------------------------------------------
  // workspace 切换逻辑
  // -------------------------------------------------------------------------

  /** 处理 SWITCH_WORKSPACE 的返回结果，决定是否需要切换 workspaceClient。 */
  private handleWorkspaceSwitch(result: WorkspaceSwitchResult): void {
    if (!result) return

    if (result.remoteServer && this.clientFactory) {
      // 切换到远程 workspace：建立 ID 映射，创建并连接新的远程 client
      this.setWorkspaceMapping(result.workspaceId, result.remoteServer.remoteWorkspaceId)
      const newClient = this.clientFactory(result.remoteServer)
      newClient.connect()
      this.swapWorkspaceClient(newClient)
    } else if (!result.remoteServer && this.workspaceClient !== this.localClient) {
      // 切回本地 workspace：清除 ID 映射，恢复使用 localClient
      this.clearWorkspaceMapping()
      this.swapWorkspaceClient(this.localClient)
    }
  }

  /**
   * 把 workspaceClient 替换为新的客户端。
   * 切换时需要：
   * 1. 重新注册所有 capability；
   * 2. 重新订阅 REMOTE_ELIGIBLE 监听器（make-before-break）；
   * 3. 重新绑定连接状态委托；
   * 4. 销毁旧的远程客户端（如果它不是本地客户端，也不是新客户端）。
   */
  private swapWorkspaceClient(newClient: WsRpcClient): void {
    const old = this.workspaceClient
    this.workspaceClient = newClient

    // 1. 重新注册 capability 到新的 workspaceClient
    for (const [channel, handler] of this.capabilities) {
      newClient.handleCapability(channel, handler)
    }

    // 2. 重新订阅 REMOTE_ELIGIBLE 监听器：先在新 client 上订阅，再取消旧 client
    for (const [channel, entries] of this.remoteListeners) {
      for (const entry of entries) {
        const oldUnsub = entry.unsub
        entry.unsub = newClient.on(channel, entry.callback)
        oldUnsub()
      }
    }

    // 3. 重新绑定连接状态委托
    this.bindConnectionState()

    // 4. 销毁旧客户端（但保留本地客户端，避免误杀）
    if (old !== this.localClient && old !== newClient) {
      old.destroy()
    }

    /**
     * 5. 当新的远程客户端连接成功后，触发一次“合成的过期重连”事件。
     * workspace 切换会创建一个全新的 client，不是自然的重连，所以 __transport:reconnected
     * 不会自动触发。这里手动 emitReconnected(true) 让 App 执行过期恢复逻辑，
     * 刷新在切换期间可能错过的会话变更。
     */
    if (newClient !== this.localClient) {
      /**
       * 这里用 let 而不是 const，是因为 onConnectionStateChanged 可能立即同步调用回调
       *（如果新 client 已经处于 connected 状态）。如果用 const，unsub 在被赋值前就被使用，
       * 会进入“暂时性死区”（TDZ）。`?.` 是可选链，表示 unsub 为 undefined 时不调用。
       */
      let unsub: (() => void) | undefined
      unsub = newClient.onConnectionStateChanged((state) => {
        if (state.status === 'connected') {
          unsub?.()
          newClient.emitReconnected(true)
        }
      })
    }
  }

  /**
   * 绑定 workspaceClient 的连接状态到 RoutedClient 的监听器集合。
   * 每次 workspaceClient 被替换后都需要重新绑定。
   */
  private bindConnectionState(): void {
    // `?.()` 是可选链调用：如果 connectionStateUnsub 为 null 就不执行。
    this.connectionStateUnsub?.()
    this.connectionStateUnsub = this.workspaceClient.onConnectionStateChanged((state) => {
      // 用展开运算符复制一份状态快照，避免监听器修改原始对象互相影响
      const snapshot = { ...state }
      for (const cb of this.connectionStateListeners) {
        // try/catch 保证单个监听器抛错不会破坏整个传输层
        try { cb(snapshot) } catch { /* listener errors must not break transport */ }
      }
    })
  }
}

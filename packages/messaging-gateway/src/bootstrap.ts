/**
 * createMessagingBootstrap —— 所有 host 共用的、可组合的 messaging 装配逻辑。
 *
 * 两个 host（Electron 主进程和独立的 Bun server）都必须走这个 helper。
 * 删掉任意一个调用点都会让另一个的 typecheck 挂掉 —— 这是防止两条路径产生分歧的
 * 唯一护栏。不要在 host 里直接 new MessagingGatewayRegistry。
 *
 * 调用形状：
 *   const handle = createMessagingBootstrap({ ... })                  // bootstrapServer 之前
 *   const deps   = { ..., messagingRegistry: handle.registry }        // 传给 createHandlerDeps
 *   sink = handle.wrapSink(baseSink)                                  // 传给 setSessionEventSink
 *   handle.setPublisher(instance.wsServer.push.bind(instance.wsServer))  // bootstrap 之后
 *   await handle.initializeWorkspaces(workspaceIds)                   // bootstrap 之后
 *   await handle.dispose()                                            // 关闭时
 */

import type { PushTarget } from '@craft-agent/shared/protocol'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type { ISessionManager } from '@craft-agent/server-core/handlers'

import { MessagingGatewayRegistry } from './registry'
import { createFanOutSink, type EventSinkFn } from './event-fanout'
import type { MessagingLogger } from './types'

export type PublishEventFn = (channel: string, target: PushTarget, ...args: unknown[]) => void

export interface MessagingBootstrapOptions {
  sessionManager: ISessionManager
  credentialManager: CredentialManager
  /** 给定 workspace 的 messaging 存储目录绝对路径。 */
  getMessagingDir: (workspaceId: string) => string
  /** 可选的 legacy 目录（relocation 之前），用于一次性迁移。Headless 省略此项。 */
  getLegacyMessagingDir?: (workspaceId: string) => string | undefined
  logger?: MessagingLogger
  whatsapp: {
    /** 内置 worker.cjs 的绝对路径。 */
    workerEntry: string
    /**
     * 要拉起的 Node 二进制。对于自身不跑在 Node 上的 host（即 Bun）是必填项。
     * 在 WhatsAppAdapter 内部默认为 `process.execPath` —— 对 Electron 正确
     *（通过 ELECTRON_RUN_AS_NODE 以 Node 方式重入），但对 Bun 是错的，
     * 所以 Bun host 必须传 `'node'` 或一个显式路径。
     */
    nodeBin?: string
    pairingMode?: 'qr' | 'code'
  }
}

export interface MessagingBootstrapHandle {
  /** 具体的 registry；在 HandlerDeps 里作为 `messagingRegistry` 传入。 */
  readonly registry: MessagingGatewayRegistry
  /**
   * 在 `bootstrapServer` 返回、`instance.wsServer` 可用后，绑定 WS push publisher。
   * 在 `initializeWorkspaces` 之前调用也是安全的。
   */
  setPublisher(push: PublishEventFn): void
  /** 在基础 RPC push sink 之上叠加 session-event 扇出。 */
  wrapSink(baseSink: EventSinkFn): EventSinkFn
  /** 初始化给定的 workspace ID 列表。调用方自行过滤（例如跳过 `remoteServer`）。 */
  initializeWorkspaces(workspaceIds: string[]): Promise<void>
  /** 停止所有 gateway 并释放资源。从 host 的关闭路径调用。 */
  dispose(): Promise<void>
}

export function createMessagingBootstrap(opts: MessagingBootstrapOptions): MessagingBootstrapHandle {
  let publisher: PublishEventFn | null = null

  const registry = new MessagingGatewayRegistry({
    sessionManager: opts.sessionManager,
    credentialManager: opts.credentialManager,
    getMessagingDir: opts.getMessagingDir,
    getLegacyMessagingDir: opts.getLegacyMessagingDir,
    logger: opts.logger,
    whatsapp: {
      workerEntry: opts.whatsapp.workerEntry,
      nodeBin: opts.whatsapp.nodeBin,
      pairingMode: opts.whatsapp.pairingMode ?? 'qr',
    },
    publishEvent: (channel, target, ...args) => {
      publisher?.(channel, target, ...args)
    },
  })

  const log = opts.logger?.child({ component: 'bootstrap' })
  log?.info('messaging bootstrap created', {
    event: 'messaging_bootstrap_created',
    workerEntry: opts.whatsapp.workerEntry,
    nodeBin: opts.whatsapp.nodeBin ?? '(host default)',
    pairingMode: opts.whatsapp.pairingMode ?? 'qr',
  })

  return {
    registry,
    setPublisher(push) {
      publisher = push
    },
    wrapSink(baseSink) {
      return createFanOutSink(baseSink, registry.onSessionEvent)
    },
    async initializeWorkspaces(workspaceIds) {
      for (const wsId of workspaceIds) {
        try {
          await registry.initializeWorkspace(wsId)
        } catch (err) {
          log?.error('failed to initialize workspace', {
            event: 'workspace_init_failed',
            workspaceId: wsId,
            error: err,
          })
        }
      }
    },
    async dispose() {
      await registry.stopAll().catch(() => {})
    },
  }
}

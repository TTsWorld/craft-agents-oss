/**
 * RemoteBrowserPaneManager.ts
 *
 * 远程浏览器面板的代理实现。可以把这里的角色理解为：
 * - 服务端（Node.js / TypeScript）= 大脑，负责把 Agent 的浏览器工具调用翻译成 RPC 消息；
 * - 桌面客户端（Electron）= 四肢，真正控制着本地 Chromium 窗口；
 * - 本文件 = 二者之间的“神经束”。
 *
 * 核心能力：`client:browser:invoke`
 * 当 Agent 运行在远程服务器（WebUI / Docker / Headless）而浏览器实例在用户的本地电脑上时，
 * 我们通过 `CLIENT_BROWSER_INVOKE` 这条能力通道，把 `navigate`、`clickElement`、
 * `screenshot` 等调用转发到本地 Electron，由 Electron 的 BrowserPaneManager 执行后再把
 * 结果通过同一条 WebSocket RPC 返回。
 *
 * 与 Go 的类比：
 * - 如果 Go 里有一个 `IBrowserPaneManager` 接口和它的 gRPC 客户端封装，这个文件就相当于
 *   那个 gRPC 客户端——每个方法都只做序列化 + RPC 调用 + 反序列化。
 * - TypeScript 的 `implements IBrowserPaneManager` 类似 Go 的接口实现约束；
 *   必须提供接口声明的所有方法，否则编译期报错。
 *
 * Agent 开发关键点：
 * 1. 浏览器工具最终落地不在本进程，因此同步接口只能返回占位值（`remote-pending:*`），
 *    真正需要结果的流程要使用 `*Async` 方法并 await。
 * 2. `invoke()` 会检查目标 client 是否声明了 `CLIENT_BROWSER_INVOKE` 能力，
 *    没有则抛出 `BROWSER_NO_CAPABLE_CLIENT`。
 * 3. `uploadFile` 明确不支持远程路径，因为服务器无法访问用户本地文件系统。
 */

import { CodedError } from '@craft-agent/shared/protocol'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'
import type {
  IBrowserPaneManager,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
  BrowserConsoleOptions,
  BrowserConsoleEntry,
  BrowserNetworkOptions,
  BrowserNetworkEntry,
  BrowserKeyArgs,
  BrowserWaitArgs,
  BrowserWaitResult,
  BrowserDownloadOptions,
  BrowserDownloadEntry,
  BrowserInstanceSnapshot,
  AccessibilitySnapshot,
} from '../handlers/browser-pane-manager-interface'
import {
  CLIENT_BROWSER_INVOKE,
  requestClientBrowserInvoke,
  type BrowserCapabilityMethod,
  type ScreenshotResultWire,
} from '../transport'
import type { RpcServer } from '../transport/types'

/** 创建 RemoteBrowserPaneManager 所需的依赖。 */
export interface RemoteBrowserPaneManagerDeps {
  readonly sessionId: string
  readonly workspaceId: string
  readonly rpcServer: RpcServer
  /**
   * 解析应托管此会话浏览器的桌面客户端。
   * 如果没有连接的客户端可用，则返回 null。SessionManager 处理固定和回退选择，因此桥接层不关心路由策略。
   */
  readonly getHostClient: () => string | null
}

/**
 * 远程浏览器面板的代理实现。
 * 把 Agent 的浏览器工具调用通过 `client:browser:invoke` RPC 转发到本地 Electron 客户端执行。
 */
export class RemoteBrowserPaneManager implements IBrowserPaneManager {
  private readonly sessionId: string
  private readonly workspaceId: string
  private readonly rpcServer: RpcServer
  private readonly getHostClient: () => string | null

  constructor(deps: RemoteBrowserPaneManagerDeps) {
    this.sessionId = deps.sessionId
    this.workspaceId = deps.workspaceId
    this.rpcServer = deps.rpcServer
    this.getHostClient = deps.getHostClient
  }

  // ---------------------------------------------------------------------------
  // 内部：打包并发送一个 IBrowserPaneManager 调用。
  // ---------------------------------------------------------------------------

  private async invoke<T>(method: BrowserCapabilityMethod, args: unknown[]): Promise<T> {
    const clientId = this.getHostClient()
    if (!clientId) {
      throw new CodedError(
        'BROWSER_NO_CAPABLE_CLIENT',
        'No connected desktop client supports browser tools for this session. ' +
        'Open this workspace from the Craft Agent desktop app and try again.',
      )
    }
    if (!this.rpcServer.hasClientCapability(clientId, CLIENT_BROWSER_INVOKE)) {
      throw new CodedError(
        'CAPABILITY_UNAVAILABLE',
        `Client ${clientId} does not advertise the ${CLIENT_BROWSER_INVOKE} capability.`,
      )
    }
    return await requestClientBrowserInvoke<T>(this.rpcServer, clientId, {
      v: 1,
      method,
      args,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    })
  }

  /** IBPM 上的同步方法通过在调用者中等待来模拟；这里我们为 SessionManager 使用的即发即弃路径保留 `void` 返回。 */
  private invokeSync(method: BrowserCapabilityMethod, args: unknown[]): void {
    this.invoke<unknown>(method, args).catch(() => {
      // 忽略错误——setAgentControl / unbindAllForSession 等调用方不会 await。
      // 如果远程代理真的出了问题，下一次 awaited 调用会把错误抛出来。
    })
  }

  // ---------------------------------------------------------------------------
  // IBrowserPaneManager — 会话生命周期
  // ---------------------------------------------------------------------------

  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {
    // 无操作：路径解析属于远程服务器，而不是客户端 BPM。
    // 从服务器端调用此方法在本地仍然有用，用于
    // 元数据，但 BPM 本身在远程桥接上不需要它们。
  }

  destroyForSession(sessionId: string): void {
    this.invokeSync('destroyForSession', [sessionId])
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    await this.invoke<void>('clearVisualsForSession', [sessionId])
  }

  unbindAllForSession(sessionId: string): void {
    this.invokeSync('unbindAllForSession', [sessionId])
  }

  /**
   * IBPM 声明 `getOrCreateForSession` 为同步方法。异步工作在此处即发即弃；
   * SessionManager 的工具运行时总是随后进行等待调用（导航、截图等），这些调用会暴露真正的错误。
   *
   * 需要实际 instanceId 的调用者应使用通过 browser-tool-runtime 的异步友好型 `createForSession` 路径，该路径会等待。
   */
  getOrCreateForSession(sessionId: string, _options?: { workspaceId?: string | null }): string {
    // 远程桥接无法同步阻塞 WS 往返，这里直接返回一个占位标记。
    // 需要真实 instanceId 的调用方应使用 `getOrCreateForSessionAsync`。
    // workspaceId 通过 `BrowserCapabilityRequest.workspaceId` 在线路上传输
    // （从 `this.workspaceId` 设置），因此调度器已经知道它。
    this.invokeSync('getOrCreateForSession', [sessionId])
    return `remote-pending:${sessionId}`
  }

  async getOrCreateForSessionAsync(sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return await this.invoke('getOrCreateForSession', [sessionId])
  }

  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    _options?: { workspaceId?: string | null },
  ): void {
    this.invokeSync('setAgentControl', [sessionId, meta])
  }

  // ---------------------------------------------------------------------------
  // IBrowserPaneManager — 实例管理
  // ---------------------------------------------------------------------------

  createForSession(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): string {
    this.invokeSync('createForSession', [sessionId, options])
    return `remote-pending:${sessionId}`
  }

  async createForSessionAsync(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string> {
    return await this.invoke('createForSession', [sessionId, options])
  }

  getInstance(_id: string): BrowserInstanceSnapshot | undefined {
    // 同步访问器——桥接无法在此处进行 WS 往返。需要此信息的调用者
    // 应使用异步友好型 `getInstanceAsync`。
    return undefined
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return await this.invoke('getInstance', [id])
  }

  listInstances(): BrowserInstanceInfo[] {
    // 同步表面返回 []；远程感知代码使用 `listInstancesAsync`。
    return []
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    return await this.invoke('listInstances', [])
  }

  focusBoundForSession(sessionId: string, _options?: { workspaceId?: string | null }): string {
    this.invokeSync('focusBoundForSession', [sessionId])
    return `remote-pending:${sessionId}`
  }

  async focusBoundForSessionAsync(sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return await this.invoke('focusBoundForSession', [sessionId])
  }

  bindSession(id: string, sessionId: string, _options?: { workspaceId?: string | null }): void {
    this.invokeSync('bindSession', [id, sessionId])
  }

  focus(id: string): void {
    this.invokeSync('focus', [id])
  }

  destroyInstance(id: string): void {
    this.invokeSync('destroyInstance', [id])
  }

  hide(id: string): void {
    this.invokeSync('hide', [id])
  }

  clearAgentControl(sessionId: string): void {
    this.invokeSync('clearAgentControl', [sessionId])
  }

  clearAgentControlForInstance(
    instanceId: string,
    sessionId?: string,
  ): { released: boolean; reason?: string } {
    // 同步 IBPM 返回——实际调用走 fire-and-forget。
    // 在强制停止流程中，本地清理成功只代表“尽力而为”。
    this.invokeSync('clearAgentControlForInstance', [instanceId, sessionId])
    return { released: true }
  }

  // ---------------------------------------------------------------------------
  // 异步方法——这些才是对代理真正重要的方法。
  // ---------------------------------------------------------------------------

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    return await this.invoke('navigate', [id, url])
  }
  async goBack(id: string): Promise<void> {
    await this.invoke('goBack', [id])
  }
  async goForward(id: string): Promise<void> {
    await this.invoke('goForward', [id])
  }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    return await this.invoke('getAccessibilitySnapshot', [id])
  }
  async clickElement(
    id: string, ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number },
  ): Promise<void> {
    await this.invoke('clickElement', [id, ref, options])
  }
  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    await this.invoke('clickAtCoordinates', [id, x, y])
  }
  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.invoke('drag', [id, x1, y1, x2, y2])
  }
  async fillElement(id: string, ref: string, value: string): Promise<void> {
    await this.invoke('fillElement', [id, ref, value])
  }
  async typeText(id: string, text: string): Promise<void> {
    await this.invoke('typeText', [id, text])
  }
  async selectOption(id: string, ref: string, value: string): Promise<void> {
    await this.invoke('selectOption', [id, ref, value])
  }
  async setClipboard(id: string, text: string): Promise<void> {
    await this.invoke('setClipboard', [id, text])
  }
  async getClipboard(id: string): Promise<string> {
    return await this.invoke('getClipboard', [id])
  }
  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void> {
    await this.invoke('scroll', [id, direction, amount])
  }
  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    await this.invoke('sendKey', [id, args])
  }
  async uploadFile(_id: string, _ref: string, _filePaths: string[]): Promise<unknown> {
    throw new CodedError(
      'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
      'File upload from a remote agent is not supported. ' +
      'Ask the user to attach the file to the session instead.',
    )
  }
  async evaluate(id: string, expression: string): Promise<unknown> {
    return await this.invoke('evaluate', [id, expression])
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const wire = await this.invoke<ScreenshotResultWire>('screenshot', [id, options])
    return this.fromScreenshotWire(wire)
  }
  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const wire = await this.invoke<ScreenshotResultWire>('screenshotRegion', [id, target])
    return this.fromScreenshotWire(wire)
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    // IBPM 声明为同步。异步结果在消费 consoleLogs 的运行时层内部等待；
    // 返回 [] 保持同步表面完整。
    void this.invoke<BrowserConsoleEntry[]>('getConsoleLogs', [id, options]).catch(() => {})
    return []
  }
  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    void this.invoke<{ width: number; height: number }>('windowResize', [id, width, height]).catch(() => {})
    return { width, height }
  }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    void this.invoke<BrowserNetworkEntry[]>('getNetworkLogs', [id, options]).catch(() => {})
    return []
  }
  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    return await this.invoke('waitFor', [id, args])
  }
  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    return await this.invoke('getDownloads', [id, options])
  }
  async detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return await this.invoke('detectSecurityChallenge', [id])
  }

  // ---------------------------------------------------------------------------
  // 线路转换
  // ---------------------------------------------------------------------------

  private fromScreenshotWire(wire: ScreenshotResultWire): BrowserScreenshotResult {
    const bytes = wire.imageBytes
    // WS 层上的结构化克隆可能将其作为 Uint8Array 或带有 `data` 字段的序列化对象传递——
    // 两种形式都接受。
    let buffer: Buffer
    if (bytes instanceof Uint8Array) {
      buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } else if (bytes && typeof bytes === 'object' && 'data' in (bytes as object)) {
      buffer = Buffer.from((bytes as { data: number[] }).data)
    } else {
      buffer = Buffer.from(bytes as unknown as ArrayBufferLike)
    }
    return {
      imageBuffer: buffer,
      imageFormat: wire.imageFormat,
      metadata: wire.metadata,
    }
  }
}

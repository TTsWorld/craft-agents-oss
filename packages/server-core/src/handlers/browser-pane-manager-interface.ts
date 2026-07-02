/**
 * 文件：browser-pane-manager-interface.ts
 * 位置：packages/server-core/src/handlers
 * 职责：定义 SessionManager 所需的浏览器面板管理器接口 IBrowserPaneManager。
 *
 * 架构角色：
 *   - handlers 层负责把 domain 逻辑和具体运行时绑定；这里只声明“我需要什么样的能力”，
 *     不实现浏览器窗口。
 *   - 具体实现位于 apps/electron 的 BrowserPaneManager。
 *   - 类似 Go 中在 handler 包里定义接口，由 app 层提供实现，避免循环依赖。
 *
 * Agent 开发关注点：
 *   - browser_tool 是 Agent 与浏览器交互的入口；本接口覆盖了近 40 个浏览器操作。
 *   - 为了支持远程 server（WebUI 通过 WebSocket 调用），每个同步方法都配了 Async 版本，
 *     因为远程调用无法同步返回结果。
 */

import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// 辅助类型 —— 只取 BPM 内部类型的最小子集
// ---------------------------------------------------------------------------

/** SessionManager 访问 BrowserInstance 时只用到的字段子集。 */
export interface BrowserInstanceSnapshot {
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  title: string
  currentUrl: string
}

export interface BrowserScreenshotOptions {
  /** raw 表示原始截图；agent 表示给 Agent 看的高亮/标注版本。 */
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserConsoleOptions {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: string
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: string
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface AccessibilityNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  focused?: boolean
  checked?: boolean
  disabled?: boolean
}

export interface AccessibilitySnapshot {
  url: string
  title: string
  nodes: AccessibilityNode[]
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/**
 * 浏览器面板管理器接口。
 *
 * TS 特性：
 *   - 接口里所有属性默认都是 public，不需要额外访问修饰符。
 *   - `options?: {...}` 中的 `?` 表示该参数/字段可选，类似 Go 里 struct 指针字段 nil 表示未传。
 *   - 方法重载在 TS 接口中不常用；这里用 `xxx` + `xxxAsync` 成对出现来弥补“远程调用不能同步返回”。
 *   - `Buffer` 是 Node.js 的类型，TS 通过 @types/node 提供声明。
 */
export interface IBrowserPaneManager {
  // -- 会话生命周期 --------------------------------------------------------

  /** 注册一个回调，用于把 sessionId 解析成文件路径。 */
  setSessionPathResolver(fn: (sessionId: string) => string | null): void

  /** 销毁所有绑定到某个 session 的浏览器实例。 */
  destroyForSession(sessionId: string): void

  /** 清除某 session 的 Agent 控制浮层和原生浮层状态。 */
  clearVisualsForSession(sessionId: string): Promise<void>

  /** 解绑某 session 的所有浏览器实例（非破坏性，只解除归属）。 */
  unbindAllForSession(sessionId: string): void

  /**
   * 获取或创建某 session 的浏览器实例，返回实例 ID。
   * workspaceId 可选，用于多 workspace 场景下的实例隔离。
   */
  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): string

  /**
   * getOrCreateForSession 的异步版本。
   *
   * 为什么需要：远程 browser pane manager 通过 WebSocket 通信，无法同步拿到返回值。
   */
  getOrCreateForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /**
   * 激活或更新某 session 的 Agent 控制浮层。
   * meta 可携带 displayName、intent 等给 UI 展示的信息。
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void

  // -- 实例管理 ------------------------------------------------------------

  /** 为 session 创建一个浏览器实例；options.show 控制是否立即显示窗口。 */
  createForSession(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): string

  /** createForSession 的异步版本。 */
  createForSessionAsync(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string>

  /**
   * 根据实例 ID 获取实例快照（同步；仅本地）。
   * 需要支持远程时改用 getInstanceAsync。
   */
  getInstance(id: string): BrowserInstanceSnapshot | undefined

  /** getInstance 的异步版本，用于远程调用。 */
  getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined>

  /**
   * 列出所有浏览器实例（同步；仅本地）。
   * 需要支持远程时改用 listInstancesAsync。
   */
  listInstances(): BrowserInstanceInfo[]

  /** listInstances 的异步版本，用于远程调用。 */
  listInstancesAsync(): Promise<BrowserInstanceInfo[]>

  /** 聚焦某 session 绑定的浏览器实例，没有则创建。 */
  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): string

  /** focusBoundForSession 的异步版本。 */
  focusBoundForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /** 把一个浏览器实例绑定到某个 session。 */
  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void

  /** 聚焦某个浏览器实例窗口。 */
  focus(id: string): void

  /** 销毁某个浏览器实例。 */
  destroyInstance(id: string): void

  /** 隐藏某个浏览器实例窗口。 */
  hide(id: string): void

  /** 清除某 session 所有实例的 Agent 控制浮层。 */
  clearAgentControl(sessionId: string): void

  /** 清除某个具体实例的 Agent 控制浮层；返回是否成功释放及原因。 */
  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string }

  // -- 页面导航 ------------------------------------------------------------

  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  goBack(id: string): Promise<void>
  goForward(id: string): Promise<void>

  // -- 页面交互 ------------------------------------------------------------

  getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number): Promise<void>
  drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void>
  fillElement(id: string, ref: string, value: string): Promise<void>
  typeText(id: string, text: string): Promise<void>
  selectOption(id: string, ref: string, value: string): Promise<void>
  setClipboard(id: string, text: string): Promise<void>
  getClipboard(id: string): Promise<string>
  scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>
  sendKey(id: string, args: BrowserKeyArgs): Promise<void>
  uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown>
  evaluate(id: string, expression: string): Promise<unknown>

  // -- 截图 ----------------------------------------------------------------

  screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>
  screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult>

  // -- 监控 ----------------------------------------------------------------

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[]
  windowResize(id: string, width: number, height: number): { width: number; height: number }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[]
  waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult>
  getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]>
  detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }>
}

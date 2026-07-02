/**
 * Headless 模式下的 BrowserPaneManager 空实现（Null Object）
 *
 * 文件职责：
 *   - 当应用以 headless（无 GUI）模式运行时，没有真实的浏览器窗口/面板，
 *     但业务代码仍需要满足 IBrowserPaneManager 接口。
 *   - 本类作为“空对象”实现：
 *     - 生命周期类方法做空操作；
 *     - 真正需要浏览器能力的方法抛出清晰错误；
 *     - 查询类方法返回空结果或安全默认值。
 *   - 这样上层就不需要写大量 `if (browserPaneManager)` 防御代码，
 *     而是统一按 interface 调用，由运行时注入真实实现或空实现。
 *
 * 与 Golang 的类比：
 *   - 相当于为一个 interface 提供一个 noop / stub 实现；
 *   - Golang 里常用 var _ Interface = (*Stub)(nil) 做编译期断言，
 *     TypeScript 里则用 `implements IBrowserPaneManager` 让 tsc 检查。
 *
 * TS 特性小记：
 *   - `type { ... }` 是类型导入，编译后擦除；interface 也只在类型检查阶段存在。
 *   - 方法参数名以 `_` 开头（如 `_sessionId`），表示“该参数未使用”，
 *     同时抑制 TS 的 noUnusedParameters 报错。
 */

import type {
  IBrowserPaneManager,
  AccessibilitySnapshot,
  BrowserConsoleEntry,
  BrowserConsoleOptions,
  BrowserDownloadEntry,
  BrowserDownloadOptions,
  BrowserInstanceSnapshot,
  BrowserKeyArgs,
  BrowserNetworkEntry,
  BrowserNetworkOptions,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
  BrowserWaitArgs,
  BrowserWaitResult,
} from '../handlers/browser-pane-manager-interface'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

/** headless 模式下所有浏览器自动化调用统一抛出的错误信息 */
const NOT_AVAILABLE = 'Browser automation is not available in headless mode'

/**
 * 生成“当前不可用”错误。
 * 返回类型 `never` 表示该函数不会正常返回，与 Golang 中 panic 语义类似。
 */
function unavailable(method: string): never {
  throw new Error(`${method}: ${NOT_AVAILABLE}`)
}

/** Headless 模式下的 BrowserPaneManager 空实现 */
export class NullBrowserPaneManager implements IBrowserPaneManager {
  // -- 会话生命周期（空操作） --
  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {}
  destroyForSession(_sessionId: string): void {}
  async clearVisualsForSession(_sessionId: string): Promise<void> {}
  unbindAllForSession(_sessionId: string): void {}
  getOrCreateForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string { return unavailable('getOrCreateForSession') }
  async getOrCreateForSessionAsync(_sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> { return unavailable('getOrCreateForSession') }
  setAgentControl(
    _sessionId: string,
    _meta: { displayName?: string; intent?: string },
    _options?: { workspaceId?: string | null },
  ): void {}

  // -- 实例管理 --
  createForSession(_sessionId: string, _options?: { show?: boolean; workspaceId?: string | null }): string { return unavailable('createForSession') }
  async createForSessionAsync(_sessionId: string, _options?: { show?: boolean; workspaceId?: string | null }): Promise<string> { return unavailable('createForSession') }
  getInstance(_id: string): BrowserInstanceSnapshot | undefined { return undefined }
  async getInstanceAsync(_id: string): Promise<BrowserInstanceSnapshot | undefined> { return undefined }
  listInstances(): BrowserInstanceInfo[] { return [] }
  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> { return [] }
  focusBoundForSession(_sessionId: string, _options?: { workspaceId?: string | null }): string { return unavailable('focusBoundForSession') }
  async focusBoundForSessionAsync(_sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> { return unavailable('focusBoundForSession') }
  bindSession(_id: string, _sessionId: string, _options?: { workspaceId?: string | null }): void { unavailable('bindSession') }
  focus(_id: string): void { unavailable('focus') }
  destroyInstance(_id: string): void {}
  hide(_id: string): void {}
  clearAgentControl(_sessionId: string): void {}
  clearAgentControlForInstance(_instanceId: string, _sessionId?: string): { released: boolean; reason?: string } {
    return { released: false, reason: NOT_AVAILABLE }
  }

  // -- 页面导航 --
  async navigate(_id: string, _url: string): Promise<{ url: string; title: string }> { unavailable('navigate') }
  async goBack(_id: string): Promise<void> { unavailable('goBack') }
  async goForward(_id: string): Promise<void> { unavailable('goForward') }

  // -- 页面交互 --
  async getAccessibilitySnapshot(_id: string): Promise<AccessibilitySnapshot> { unavailable('getAccessibilitySnapshot') }
  async clickElement(_id: string, _ref: string, _options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void> { unavailable('clickElement') }
  async clickAtCoordinates(_id: string, _x: number, _y: number): Promise<void> { unavailable('clickAtCoordinates') }
  async drag(_id: string, _x1: number, _y1: number, _x2: number, _y2: number): Promise<void> { unavailable('drag') }
  async fillElement(_id: string, _ref: string, _value: string): Promise<void> { unavailable('fillElement') }
  async typeText(_id: string, _text: string): Promise<void> { unavailable('typeText') }
  async selectOption(_id: string, _ref: string, _value: string): Promise<void> { unavailable('selectOption') }
  async setClipboard(_id: string, _text: string): Promise<void> { unavailable('setClipboard') }
  async getClipboard(_id: string): Promise<string> { return unavailable('getClipboard') }
  async scroll(_id: string, _direction: 'up' | 'down' | 'left' | 'right', _amount?: number): Promise<void> { unavailable('scroll') }
  async sendKey(_id: string, _args: BrowserKeyArgs): Promise<void> { unavailable('sendKey') }
  async uploadFile(_id: string, _ref: string, _filePaths: string[]): Promise<unknown> { return unavailable('uploadFile') }
  async evaluate(_id: string, _expression: string): Promise<unknown> { return unavailable('evaluate') }

  // -- 截图 --
  async screenshot(_id: string, _options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> { return unavailable('screenshot') }
  async screenshotRegion(_id: string, _target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> { return unavailable('screenshotRegion') }

  // -- 监控与日志 --
  getConsoleLogs(_id: string, _options?: BrowserConsoleOptions): BrowserConsoleEntry[] { return [] }
  windowResize(_id: string, _width: number, _height: number): { width: number; height: number } { return unavailable('windowResize') }
  getNetworkLogs(_id: string, _options?: BrowserNetworkOptions): BrowserNetworkEntry[] { return [] }
  async waitFor(_id: string, _args: BrowserWaitArgs): Promise<BrowserWaitResult> { return unavailable('waitFor') }
  async getDownloads(_id: string, _options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> { return [] }
  async detectSecurityChallenge(_id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return { detected: false, provider: 'none', signals: [] }
  }
}

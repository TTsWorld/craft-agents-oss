/**
 * `client:browser:invoke` 能力的线协议定义。
 *
 * 当 Agent 在远程服务器上运行，而浏览器实例在本地 Electron 客户端时，
 * RemoteBrowserPaneManager 把 IBrowserPaneManager 的方法调用打包成 BrowserCapabilityRequest，
 * 通过 WS 发送给本地客户端，再由客户端的 BrowserPaneManager 真正执行。
 *
 * 这种"远程调用本地资源"的模式是 Craft Agent 支持 headless server + 本地浏览器自动化的关键。
 */

/** 浏览器能力协议版本号，当前固定为 1 */
export const BROWSER_CAPABILITY_VERSION = 1

/**
 * BrowserPaneManager 支持的方法名。
 *
 * args 按方法签名顺序传入位置参数。
 */
export type BrowserCapabilityMethod =
  // 生命周期 / 实例管理
  | 'createForSession'
  | 'getOrCreateForSession'
  | 'focusBoundForSession'
  | 'destroyInstance'
  | 'destroyForSession'
  | 'getInstance'
  | 'listInstances'
  | 'bindSession'
  | 'unbindAllForSession'
  | 'setAgentControl'
  | 'clearAgentControl'
  | 'clearAgentControlForInstance'
  | 'clearVisualsForSession'
  | 'focus'
  | 'hide'
  // 导航
  | 'navigate'
  | 'goBack'
  | 'goForward'
  // 交互
  | 'getAccessibilitySnapshot'
  | 'clickElement'
  | 'clickAtCoordinates'
  | 'drag'
  | 'fillElement'
  | 'typeText'
  | 'selectOption'
  | 'sendKey'
  | 'scroll'
  | 'waitFor'
  | 'evaluate'
  // 剪贴板
  | 'setClipboard'
  | 'getClipboard'
  // 截图 / 检查
  | 'screenshot'
  | 'screenshotRegion'
  | 'getConsoleLogs'
  | 'getNetworkLogs'
  | 'windowResize'
  | 'getDownloads'
  | 'uploadFile'
  | 'detectSecurityChallenge'

export interface BrowserCapabilityRequest {
  /** 协议版本，当前固定为 1 */
  v: 1
  method: BrowserCapabilityMethod
  /** 位置参数，匹配 IBrowserPaneManager[method] 的签名 */
  args: unknown[]
  /** 所属 session，客户端用它做 owner-key 命名空间 */
  sessionId: string
  /** 所属 workspace，和 sessionId 组合成 owner-key 前缀 */
  workspaceId: string
}

/**
 * screenshot / screenshotRegion 的线格式。
 *
 * 本地 BrowserScreenshotResult 里 imageBuffer 是 Node Buffer，不能通过 WS 结构化克隆传输，
 * 所以分发器把 Buffer 转成 Uint8Array，RemoteBrowserPaneManager 再转回 Buffer。
 */
export interface ScreenshotResultWire {
  /** 图片格式：png 或 jpeg */
  imageFormat: 'png' | 'jpeg'
  /** 图片原始字节（Uint8Array，已从 Node Buffer 转换） */
  imageBytes: Uint8Array
  /** 可选元数据 */
  metadata?: Record<string, unknown>
}

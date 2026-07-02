/**
 * 浏览器工具栏窗口的 preload 脚本。
 *
 * preload 是 Electron 在加载网页前执行的一段脚本，它比页面拥有更多权限，
 * 可以通过 contextBridge 把“裁剪后的安全 API”暴露给前端 React。
 *
 * 这里只暴露一个最小化的 API：React 组件 BrowserControls 用它向主进程的
 * BrowserPaneManager 发送导航动作（前进/后退/刷新等），并接收页面状态更新。
 */

import { contextBridge, ipcRenderer } from 'electron'

// IPC 通道名常量集合。`as const` 是 TypeScript 惯用法，让对象的每个属性
// 都变成精确的字面量类型（类似 Go 里的 const 字符串枚举），避免拼写错误。
const CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
} as const

// BrowserPaneManager 创建工具栏窗口时，会通过 URL 查询参数把实例 ID 传进来。
// `location.search` 就是当前页面 URL 里 `?` 后面的部分。
const instanceId = new URLSearchParams(location.search).get('instanceId') || ''

// 通过 contextBridge 把 API 安全注入到渲染进程的 `window.browserToolbar`。
// 之后 React 代码里就能调用 window.browserToolbar.navigate(...) 等方法。
contextBridge.exposeInMainWorld('browserToolbar', {
  instanceId,

  // 导航到指定 URL：ipcRenderer.invoke 是“发请求等响应”的异步 IPC。
  navigate: (url: string) => ipcRenderer.invoke(CHANNELS.NAVIGATE, instanceId, url),

  // 浏览器历史：后退/前进/刷新/停止加载
  goBack: () => ipcRenderer.invoke(CHANNELS.GO_BACK, instanceId),
  goForward: () => ipcRenderer.invoke(CHANNELS.GO_FORWARD, instanceId),
  reload: () => ipcRenderer.invoke(CHANNELS.RELOAD, instanceId),
  stop: () => ipcRenderer.invoke(CHANNELS.STOP, instanceId),

  // 通知主进程菜单弹窗的几何状态（展开/收起 + 高度），用于调整窗口大小。
  setMenuGeometry: (open: boolean, height = 0) => ipcRenderer.invoke(CHANNELS.MENU_GEOMETRY, instanceId, open, height),

  // 隐藏工具栏窗口 / 彻底销毁工具栏窗口
  hideWindow: () => ipcRenderer.invoke(CHANNELS.HIDE, instanceId),
  closeWindowEntirely: () => ipcRenderer.invoke(CHANNELS.DESTROY, instanceId),

  // 订阅浏览器状态更新。ipcRenderer.on 注册监听器；返回一个取消订阅函数。
  onStateUpdate: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.STATE_UPDATE, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler) }
  },

  // 订阅页面主题色变化（用于工具栏跟随网页主题色）。
  onThemeColor: (callback: (color: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, color: string | null) => callback(color)
    ipcRenderer.on(CHANNELS.THEME_COLOR, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.THEME_COLOR, handler) }
  },

  // 订阅“强制关闭菜单”事件（例如点击外部区域时）。
  onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { reason?: string }) => callback(payload)
    ipcRenderer.on(CHANNELS.FORCE_CLOSE_MENU, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.FORCE_CLOSE_MENU, handler) }
  },
})

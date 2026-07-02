/**
 * 客户端能力（Capabilities）定义。
 *
 * 服务器可以请求客户端执行一些本地操作（打开浏览器、显示对话框、选择文件等），
 * 这些能力在 WebSocket 握手时由客户端声明，服务端按需调用。
 *
 * 类似 gRPC 里的客户端流式方法，但更简单：服务端通过 invokeClient 直接调用客户端 handler。
 */

import type { BrowserCapabilityRequest } from './browser-capability'
import type { RpcServer } from './types'

/** 在客户端默认浏览器打开 URL */
export const CLIENT_OPEN_EXTERNAL = 'client:openExternal'

/** 用系统默认应用打开文件 */
export const CLIENT_OPEN_PATH = 'client:openPath'

/** 在 Finder / Explorer 中定位文件 */
export const CLIENT_SHOW_IN_FOLDER = 'client:showItemInFolder'

/** 在客户端显示确认对话框 */
export const CLIENT_CONFIRM_DIALOG = 'client:confirmDialog'

/** 在客户端显示原生文件选择器 */
export const CLIENT_OPEN_FILE_DIALOG = 'client:openFileDialog'

/** 调用客户端的 BrowserPaneManager（远程浏览器能力） */
export const CLIENT_BROWSER_INVOKE = 'client:browser:invoke'

/** Electron 客户端在握手时声明的所有能力 */
export const LOCAL_CLIENT_CAPABILITIES: readonly string[] = [
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
]

// ---------------------------------------------------------------------------
// 能力调用辅助函数（对 server.invokeClient 的薄封装 + 错误处理）
// ---------------------------------------------------------------------------

/**
 * 请求客户端用默认浏览器打开 URL。
 */
export async function requestClientOpenExternal(
  server: RpcServer,
  clientId: string,
  url: string,
): Promise<{ opened: boolean; error?: string; authUrl?: string }> {
  try {
    await server.invokeClient(clientId, CLIENT_OPEN_EXTERNAL, url)
    return { opened: true }
  } catch (err) {
    const code = (err as any)?.code
    const message = err instanceof Error ? err.message : String(err)
    return { opened: false, error: `${code ?? 'UNKNOWN'}: ${message}`, authUrl: url }
  }
}

/**
 * 请求客户端用系统默认应用打开文件（等价于 Electron shell.openPath）。
 */
export async function requestClientOpenPath(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<{ error?: string }> {
  try {
    const result = await server.invokeClient(clientId, CLIENT_OPEN_PATH, path)
    return result ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

/**
 * 请求客户端在 Finder / Explorer 中定位文件。
 */
export async function requestClientShowInFolder(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<void> {
  await server.invokeClient(clientId, CLIENT_SHOW_IN_FOLDER, path)
}

/** 确认对话框规格（映射到 Electron MessageBoxOptions） */
export interface ConfirmDialogSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * 请求客户端显示确认对话框，返回点击按钮的索引。
 */
export async function requestClientConfirmDialog(
  server: RpcServer,
  clientId: string,
  spec: ConfirmDialogSpec,
): Promise<{ response: number }> {
  return await server.invokeClient(clientId, CLIENT_CONFIRM_DIALOG, spec)
}

/** 文件选择器对话框规格（映射到 Electron OpenDialogOptions） */
export interface FileDialogSpec {
  title?: string
  defaultPath?: string
  properties?: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * 请求客户端显示原生文件/文件夹选择器。
 */
export async function requestClientOpenFileDialog(
  server: RpcServer,
  clientId: string,
  spec: FileDialogSpec,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return await server.invokeClient(clientId, CLIENT_OPEN_FILE_DIALOG, spec)
}

/**
 * 请求客户端调用 BrowserPaneManager 方法。
 *
 * 泛型 T 表示远端 BrowserPaneManager 方法的返回类型；
 * server.invokeClient 返回 Promise<any>，这里用 `as Promise<T>` 做类型断言。
 */
export async function requestClientBrowserInvoke<T>(
  server: RpcServer,
  clientId: string,
  req: BrowserCapabilityRequest,
): Promise<T> {
  return server.invokeClient(clientId, CLIENT_BROWSER_INVOKE, req) as Promise<T>
}

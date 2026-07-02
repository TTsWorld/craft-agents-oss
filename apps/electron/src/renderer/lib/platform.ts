/**
 * 平台检测工具
 *
 * 渲染进程的平台检测集中入口。
 * 不要直接访问 navigator.platform，而是通过这里的工具函数/常量。
 *
 * @example
 * import { isMac, isWindows, PATH_SEP, getPathBasename } from '@/lib/platform'
 *
 * // 平台判断
 * const modifier = isMac ? '⌘' : 'Ctrl'
 *
 * // 路径处理
 * const folderName = getPathBasename('/Users/alice/projects') // 'projects'
 */

/** 当前运行在 macOS 上时为 true */
export const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('mac')

/** 当前运行在 Windows 上时为 true */
export const isWindows =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('win')

/** 当前运行在 Linux 上时为 true */
export const isLinux =
  typeof navigator !== 'undefined' &&
  navigator.platform.toLowerCase().includes('linux')

/**
 * 当前代码是否运行在浏览器中部署的 Web UI（apps/webui）里，而不是 Electron 渲染进程。
 *
 * webui 的 Vite 配置通过 `define` 注入 `import.meta.env.IS_WEBUI = 'true'`，
 * 这样我们就能区分环境（例如跳过 macOS 红绿灯内边距，因为普通浏览器标签不需要）。
 */
export const isWebUI: boolean = Boolean(
  (import.meta as { env?: { IS_WEBUI?: unknown } }).env?.IS_WEBUI,
)

/**
 * 获取当前平台的文件管理器名称。
 * macOS → "Finder"，Windows → "Explorer"，Linux → "File Manager"
 */
export function getFileManagerName(): string {
  if (isMac) return 'Finder'
  if (isWindows) return 'Explorer'
  return 'File Manager'
}

/** 当前操作系统原生路径分隔符 */
export const PATH_SEP = isWindows ? '\\' : '/'

/**
 * 获取路径的最后一段（文件夹/文件名）。
 * 根据当前 OS 处理 Unix（/）与 Windows（\）分隔符。
 */
export function getPathBasename(path: string): string {
  return path.split(PATH_SEP).pop() || ''
}

/**
 * path-validation.ts
 *
 * 路径安全校验工具。核心职责：
 * 1. 校验路径格式是否符合当前服务器平台（Unix / Windows）；
 * 2. 校验工作目录是否真实存在且是目录；
 * 3. 校验 workspace root 是否可用（允许新建目录场景）。
 *
 * 与 Go 的类比：
 * - 这就像 Go 里写一个 `PathValidationResult` 结构体 + 一组纯函数；
 *   没有 side effect，输入确定则输出确定。
 * - `NodeJS.Platform` 来自 Node 运行时，类似 Go 的 `runtime.GOOS`；
 *   但这里通过参数注入 platform，方便单测。
 *
 * TypeScript 要点：
 * - `type StatLike = (path: string) => Stats` 是函数类型别名，
 *   表示“接收 string 返回 Stats 的函数”，类似 Go 的 `func(string) fs.FileInfo`。
 * - 默认参数 `platform: NodeJS.Platform = process.platform` 让生产代码直接取当前平台，
 *   测试代码可以传入 `'win32'` 或 `'darwin'` 做跨平台测试。
 *
 * Agent 开发关键点：
 * - Agent 经常需要读写用户文件系统，路径校验是第一道安全闸；
 * - 拒绝跨平台路径（如把 Windows 盘符路径传给 macOS 服务器）可以避免大量
 *   “文件找不到”类的运行时错误。
 */

import { statSync, type Stats } from 'fs'
import { dirname, win32 as pathWin32 } from 'path'

/**
 * 路径校验结果结构体。
 * - 类似 Go 里的 `struct { Valid bool; Reason string }`。
 * - `reason?: string` 中 `?` 表示可选字段，相当于 Go 中可能是零值的字符串。
 */
export interface PathValidationResult {
  valid: boolean
  reason?: string
}

/**
 * 获取文件状态信息的函数类型别名。
 * - 类型签名 `(path: string) => Stats` 表示“接收 string，返回 Stats”。
 * - 类似 Go 的 `func(string) fs.FileInfo`。
 * - 这里把 `statSync` 抽象成可注入的参数，方便单元测试传入 mock。
 */
type StatLike = (path: string) => Stats

/**
 * 判断路径是否为当前平台的绝对路径。
 * - Windows：X:\... 或 \\\\server\\share\\...
 * - Unix：以 / 开头
 */
function isAbsolutePathForPlatform(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  }
  return path.startsWith('/')
}

/**
 * 校验路径格式是否符合当前服务器平台（不访问文件系统）。
 * - 拒绝跨平台路径，例如把 Windows 的 `C:\...` 传给 macOS/Linux 服务器。
 * - `platform` 可注入，这样在单测里不用 mock 全局变量就能测试不同平台。
 * - 类似 Go 中写一个纯函数，输入输出确定，无副作用。
 */
export function validatePathFormat(
  path: string,
  platform: NodeJS.Platform = process.platform
): PathValidationResult {
  const trimmed = path.trim()
  const isWindows = platform === 'win32'

  // 空路径直接拒绝，类似 Go 中对空字符串做早期返回。
  if (!trimmed) {
    return { valid: false, reason: 'Path is required.' }
  }

  // 非 Windows 服务器：只接受 Unix 绝对路径，拒绝 Windows 盘符路径和 UNC 路径。
  if (!isWindows) {
    if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
      return { valid: false, reason: 'Windows drive path is not valid on this server. Use a server-side path.' }
    }
    if (trimmed.startsWith('\\\\')) {
      return { valid: false, reason: 'UNC path is not valid on this server. Use a server-side path.' }
    }
    if (!trimmed.startsWith('/')) {
      return { valid: false, reason: 'Path must be absolute (start with /).' }
    }
    return { valid: true }
  }

  // Windows 服务器：拒绝 Unix 风格路径，要求必须是 Windows 绝对路径。
  if (trimmed.startsWith('/')) {
    return { valid: false, reason: 'Unix path is not valid on this server. Use a Windows path (e.g., C:\\\\...).' }
  }

  if (!isAbsolutePathForPlatform(trimmed, platform)) {
    return { valid: false, reason: 'Path must be an absolute Windows path (e.g., C:\\\\... or \\\\server\\\\share\\\\...).' }
  }

  return { valid: true }
}

/**
 * 校验一个路径是否是当前服务器上可用的工作目录。
 * - 先调用 `validatePathFormat` 做格式校验；
 * - 再用 `statFn` 检查路径是否存在且是目录（类似 Go 的 `os.Stat` + `IsDir`）。
 * - `statFn` 默认是 `statSync`，测试时可替换为 mock 函数。
 */
export function isValidWorkingDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  // 格式不通过时直接透传原因，减少嵌套。
  if (!formatCheck.valid) return formatCheck

  // 尝试获取文件状态；失败说明路径不存在，上层调用方可以据此决定行为。
  try {
    const s = statFn(trimmed)
    if (!s.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
  } catch {
    return { valid: false, reason: `Directory not found: ${trimmed}` }
  }

  return { valid: true }
}

/**
 * 校验 workspace root 路径在当前服务器上是否可用。
 * - 如果路径本身已是目录，直接通过；
 * - 如果路径不存在，则向上逐层查找父目录，直到找到一个存在的目录为止。
 *   这样可以支持“新建 workspace”场景：允许用户指定一个还不存在的目录，
 *   但要求它的父目录必须存在。
 * - 类似 Go 里先 `os.Stat` 再 `filepath.Dir` 向上回溯的逻辑。
 */
export function isValidWorkspaceRootPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  if (!formatCheck.valid) return formatCheck

  try {
    const existing = statFn(trimmed)
    // 路径已存在但不是目录，不能作为 workspace root。
    if (!existing.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
    return { valid: true }
  } catch {
    // 路径不存在：向上逐层查找父目录，支持“新建目录”场景。
    let currentPath = trimmed

    while (true) {
      // 根据平台选择对应的路径 dirname 实现，类似 Go 的 `filepath.Dir`。
      const parentPath = platform === 'win32' ? pathWin32.dirname(currentPath) : dirname(currentPath)

      // 已经到达根目录仍找不到存在的父目录，则判定失败。
      if (!parentPath || parentPath === currentPath) {
        return { valid: false, reason: `Parent directory not found: ${currentPath}` }
      }

      try {
        const parent = statFn(parentPath)
        if (!parent.isDirectory()) {
          return { valid: false, reason: `Parent path is not a directory: ${parentPath}` }
        }
        return { valid: true }
      } catch {
        // 父目录也不存在，继续向上回溯。
        currentPath = parentPath
      }
    }
  }
}

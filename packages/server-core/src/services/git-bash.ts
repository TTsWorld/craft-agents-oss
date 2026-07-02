/**
 * Git Bash 路径检测与校验
 *
 * 文件职责：
 *   - 在 Windows 上，部分后端工具/脚本依赖 Git Bash（bash.exe）提供的 POSIX 环境。
 *   - 本模块提供三层函数：文件名匹配、完整校验（文件名 + 文件存在性）、仅返回布尔。
 *
 * 与 Golang 的类比：
 *   - `fs/promises` 中的 `stat` 类似 `os.Stat`；这里用 async/await 做异步 IO，
 *     等价于 Golang 中 `os.Stat` 返回 `(FileInfo, error)`。
 *   - TypeScript 的联合返回类型 `{ valid: true; path: string } | { valid: false; error: string }`
 *     类似 Golang 中返回 `(Result, error)`，但通过 `valid` 标签做类型收窄（type narrowing）。
 *
 * TS 特性小记：
 *   - `filePath.trim()` 后直接传给正则，利用 `.test()` 返回 boolean。
 *   - 正则里的 `[\\/]` 字符类同时匹配 Windows 反斜杠与 POSIX 斜杠。
 */
import { stat } from 'fs/promises'

/**
 * 基础文件名校验：路径是否以 bash.exe 结尾。
 * 同时兼容 Windows（\）与 POSIX（/）分隔符，方便跨平台测试。
 * @param filePath - 待校验路径
 */
export function isGitBashExecutablePath(filePath: string): boolean {
  return /(?:^|[\\/])bash\.exe$/i.test(filePath.trim())
}

/**
 * 校验用户提供的 Git Bash 可执行文件路径。
 * 要求：文件名必须是 bash.exe，且文件真实存在。
 * @param filePath - 用户输入路径
 * @returns 校验结果联合类型；valid 为 true 时返回规范化路径，false 时返回错误信息
 */
export async function validateGitBashPath(filePath: string): Promise<{ valid: true; path: string } | { valid: false; error: string }> {
  const trimmedPath = filePath.trim()

  if (!isGitBashExecutablePath(trimmedPath)) {
    return { valid: false, error: 'Path must point to bash.exe' }
  }

  try {
    const info = await stat(trimmedPath)
    if (!info.isFile()) {
      return { valid: false, error: 'Path must point to a file' }
    }
    return { valid: true, path: trimmedPath }
  } catch {
    return { valid: false, error: 'File does not exist at the specified path' }
  }
}

/**
 * 判断给定 Git Bash 路径是否可用，返回纯布尔。
 * 适合在业务逻辑中做简单分支判断，不暴露具体错误原因。
 * @param filePath - 待检查路径
 */
export async function isUsableGitBashPath(filePath: string): Promise<boolean> {
  const result = await validateGitBashPath(filePath)
  return result.valid
}

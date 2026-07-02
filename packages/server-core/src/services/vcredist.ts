/**
 * VC++ Redistributable 安装检查
 *
 * 文件职责：
 *   - 在 Windows 上检查 Microsoft Visual C++ Redistributable 是否已安装。
 *   - 该运行时是 onnxruntime（markitdown 的 magika 文件分类器使用）加载原生 DLL 的前提；
 *     缺失时转换 PDF、PPTX、DOCX、XLSX 等文档会崩溃。
 *
 * 检查原理：
 *   - 通过检查系统目录中是否存在 vcruntime140.dll 来判断。
 *   - 同时覆盖 System32 与 SysWOW64，兼容 x64 与 ARM64 Windows（ARM64 Windows
 *     通过模拟运行 x86_64 程序，因此 x64 DLL 仍可能被加载）。
 *   - 非 Windows 平台直接返回 installed=true，因为共享库由系统包管理器维护。
 *
 * 与 Golang 的类比：
 *   - `process.platform` 类似 Golang 的 `runtime.GOOS`；
 *   - `process.arch` 类似 `runtime.GOARCH`；
 *   - `existsSync` 等价于 Golang 的 `os.Stat(path)` 判断是否存在。
 *
 * TS 特性小记：
 *   - `downloadUrl?: string` 是可选属性，类型为 `string | undefined`。
 *   - 使用模板字符串拼接消息：`message: '...' + '...'` 在编译后就是普通字符串拼接。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** VC++ Redistributable 检查结果 */
export interface VCRedistCheckResult {
  /** 是否已安装 */
  installed: boolean
  /** 人类可读的信息，可用于日志或弹窗 */
  message: string
  /** 当 installed=false 时，指向对应架构的下载链接 */
  downloadUrl?: string
}

/** 根据 CPU 架构返回官方下载 URL */
function getVCRedistDownloadUrl(): string {
  return process.arch === 'arm64'
    ? 'https://aka.ms/vs/17/release/vc_redist.arm64.exe'
    : 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
}

/**
 * 检查 VC++ Redistributable 是否已安装。
 * @returns 检查结果；非 Windows 平台始终视为已安装
 */
export function checkVCRedistInstalled(): VCRedistCheckResult {
  if (process.platform !== 'win32') {
    return { installed: true, message: 'Not applicable on this platform' }
  }

  // VC++ Redistributable 安装 vcruntime140.dll 的已知路径。
  // 同时覆盖 x64 与 ARM64 主机场景：ARM64 Windows 通过模拟运行 x86_64 程序，
  // 因此 SysWOW64 或 System32 中的 x64 DLL 对 onnxruntime 依然有效。
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const dllPaths = [
    join(sysRoot, 'System32', 'vcruntime140.dll'),
    join(sysRoot, 'SysWOW64', 'vcruntime140.dll'),
  ]

  for (const dllPath of dllPaths) {
    if (existsSync(dllPath)) {
      return { installed: true, message: `Found vcruntime140.dll at ${dllPath}` }
    }
  }

  const downloadUrl = getVCRedistDownloadUrl()
  return {
    installed: false,
    downloadUrl,
    message:
      'Microsoft Visual C++ Redistributable is not installed. ' +
      'Document conversion tools (PDF, PPTX, DOCX, XLSX) will not work correctly. ' +
      `Please install it from: ${downloadUrl}`,
  }
}

/**
 * 文件：utils.ts
 * 位置：packages/server-core/src/handlers
 * 职责：server-core handlers 的通用工具函数。
 *
 * 覆盖能力：
 *   - 获取 workspace（不存在则抛错）。
 *   - 构造后端运行时上下文。
 *   - 文件名消毒。
 *   - 获取 workspace 允许访问的目录。
 *   - 校验文件路径，防止路径穿越和读取敏感文件。
 *
 * 架构角色：
 *   - handlers 层共享的 helper，类似 Go 里 `internal/handlerutil` 包。
 *   - 不依赖具体 IPC 实现，只依赖 config、workspace、platform 等抽象。
 *
 * Agent 开发关注点：
 *   - 文件路径校验是 Agent 沙箱的第一道防线：Agent 只能读取/写入允许的目录。
 *   - 默认允许用户主目录、/tmp 以及 workspace 根目录和配置的工作目录。
 *   - 敏感文件（.ssh、.env、pem、key 等）即使在允许目录内也拒绝访问。
 */

import { normalize, isAbsolute, sep } from 'path'
import { homedir, tmpdir } from 'os'
import { realpath } from 'fs/promises'
import { getWorkspaceByNameOrId, type Workspace } from '@craft-agent/shared/config'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { PlatformServices } from '../runtime/platform'

/**
 * 根据 ID 或名称获取 workspace，找不到则抛出错误。
 *
 * 使用场景：后续操作强依赖 workspace 存在，直接失败比返回 null 更清晰。
 * 类比 Go：`if ws == nil { return fmt.Errorf("workspace not found: %s", id) }`。
 */
export function getWorkspaceOrThrow(workspaceId: string): Workspace {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }
  return workspace
}

/**
 * 根据 platform 服务构造后端宿主运行时上下文。
 *
 * TS 特性：
 *   - 返回类型没有显式声明，TS 会根据返回对象自动推断（类型推断）。
 *   - 在简单且类型明确时，可以省略返回类型让代码更短。
 */
export function buildBackendHostRuntimeContext(platform: PlatformServices) {
  return {
    appRootPath: platform.appRootPath,
    resourcesPath: platform.resourcesPath,
    isPackaged: platform.isPackaged,
  }
}

/**
 * 文件名消毒：防止路径穿越和文件系统特殊字符问题。
 *
 * 处理步骤：
 *   1. 替换 / 和 \ 为 _，防止路径穿越。
 *   2. 替换 Windows 禁用的 < > : " | ? *。
 *   3. 删除 ASCII 控制字符。
 *   4. 折叠连续多个点，防止隐藏文件和扩展名欺骗。
 *   5. 去掉首尾的空格和点。
 *   6. 限制长度 200 字符。
 *   7. 如果结果为空，fallback 为 'unnamed'。
 *
 * TS 特性：链式 `.replace().slice().replace()` 中，`||` 用于提供默认值，
 * 因为空字符串会被视为 falsy。
 */
export function sanitizeFilename(name: string): string {
  return name
    // 移除路径分隔符和穿越片段
    .replace(/[/\\]/g, '_')
    // 移除 Windows 禁止字符：< > : " | ? *
    .replace(/[<>:"|?*]/g, '_')
    // 移除 ASCII 控制字符（0-31）
    .replace(/[\x00-\x1f]/g, '')
    // 折叠连续多个点，防止隐藏文件和扩展名欺骗
    .replace(/\.{2,}/g, '.')
    // 移除首尾点和空格（Windows 兼容）
    .replace(/^[.\s]+|[.\s]+$/g, '')
    // 限制长度：200 字符对所有文件系统都安全
    .slice(0, 200)
    // 消毒后为空则回退为 'unnamed'
    || 'unnamed'
}

/**
 * 获取 workspace 的允许目录：workspace 根路径和配置的 workingDirectory。
 *
 * TS 特性：
 *   - `workspaceId?: string | null` 表示可选参数且可为 null。
 *   - `config?.defaults?.workingDirectory` 是连续可选链，避免多层 if 判空。
 *     等价 Go 的 `if config != nil && config.Defaults != nil && config.Defaults.WorkingDirectory != ""`。
 */
export function getWorkspaceAllowedDirs(workspaceId?: string | null): string[] {
  if (!workspaceId) return []
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) return []

  const dirs: string[] = [workspace.rootPath]
  const config = loadWorkspaceConfig(workspace.rootPath)
  if (config?.defaults?.workingDirectory) {
    dirs.push(config.defaults.workingDirectory)
  }
  return dirs
}

/**
 * 校验文件路径是否在允许的目录内，防止路径穿越攻击。
 *
 * 允许的目录：用户主目录、/tmp、以及调用方传入的额外目录（如 workspace root、working directory）。
 *
 * Agent 安全要点：
 *   - 先 normalize 路径，解析 . 和 ..。
 *   - 把 ~ 展开为 home 目录。
 *   - 要求必须是绝对路径。
 *   - 通过 realpath 解析符号链接后再比较。
 *   - 额外拒绝敏感文件模式，即使在允许目录内也不让读。
 *
 * TS 特性：
 *   - `additionalAllowedDirs?: string[]` 是可选参数。
 *   - `...(additionalAllowedDirs ?? [])` 是空值合并 + 展开运算符，
 *     等价 Go 的 `append([]string{home, tmp}, additionalAllowedDirs...)`，但额外处理了 nil。
 *   - `.filter(Boolean)` 过滤掉空字符串等 falsy 值。
 *   - 正则 `[\\/]` 同时匹配 Unix / 和 Windows \。
 */
export async function validateFilePath(
  filePath: string,
  additionalAllowedDirs?: string[],
): Promise<string> {
  // 规范化路径，解析 . 和 ..
  let normalizedPath = normalize(filePath)

  // 把 ~ 展开为 home 目录
  if (normalizedPath.startsWith('~')) {
    normalizedPath = normalizedPath.replace(/^~/, homedir())
  }

  // 必须是绝对路径
  if (!isAbsolute(normalizedPath)) {
    throw new Error('Only absolute file paths are allowed')
  }

  // 解析符号链接得到真实路径
  let realFilePath: string
  try {
    realFilePath = await realpath(normalizedPath)
  } catch {
    // 文件不存在或无法解析时回退到规范化路径
    realFilePath = normalizedPath
  }

  // 定义允许访问的基础目录
  const allowedDirs = [
    homedir(),
    tmpdir(),
    ...(additionalAllowedDirs ?? []),
  ].filter(Boolean)

  // 校验真实路径是否落在某个允许目录内（跨平台）
  const isAllowed = allowedDirs.some(dir => {
    const normalizedDir = normalize(dir)
    const normalizedReal = normalize(realFilePath)
    return normalizedReal.startsWith(normalizedDir + sep) || normalizedReal === normalizedDir
  })

  if (!isAllowed) {
    throw new Error('Access denied: file path is outside allowed directories')
  }

  // 即使在允许目录内，也额外拦截敏感文件。
  // [\\/] 同时匹配 Unix / 和 Windows \ 分隔符。
  const sensitivePatterns = [
    /\.ssh[\\/]/,
    /\.gnupg[\\/]/,
    /\.aws[\\/]credentials/,
    /\.env$/,
    /\.env\./,
    /credentials\.json$/,
    /secrets?\./i,
    /\.pem$/,
    /\.key$/,
  ]

  if (sensitivePatterns.some(pattern => pattern.test(realFilePath))) {
    throw new Error('Access denied: cannot read sensitive files')
  }

  return realFilePath
}

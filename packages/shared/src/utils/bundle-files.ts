/**
 * Bundle 文件工具
 *
 * 把目录树序列化为可移植的 JSON bundle 的共享辅助函数。
 * 用于会话 bundle 和资源 bundle。
 *
 * BundleFile.relativePath 始终使用正斜杠，保证跨平台可移植。
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, relative, dirname, sep } from 'path'
import { debug } from './debug.ts'

/**
 * bundle 最大大小（约 100MB）。
 */
export const MAX_BUNDLE_SIZE_BYTES = 100 * 1024 * 1024

/**
 * bundle 中的单个文件条目。
 * 包含可移植的相对路径和 base64 编码的内容。
 */
export interface BundleFile {
  /** 目录内的可移植相对路径（始终为正斜杠分隔） */
  relativePath: string
  /** Base64 编码的文件内容 */
  contentBase64: string
  /** 原始文件大小（字节），用于校验 */
  size: number
}

// ============================================================
// 路径可移植性
// ============================================================

/**
 * 将操作系统原生的相对路径转换为可移植的正斜杠形式。
 */
export function toPortableRelPath(relPath: string): string {
  return relPath.split(sep).join('/')
}

/**
 * 将可移植的正斜杠路径转换为操作系统原生形式，用于写入文件系统。
 */
export function fromPortableRelPath(portablePath: string): string {
  return portablePath.split('/').join(sep)
}

// ============================================================
// 校验
// ============================================================

/**
 * 校验单个 BundleFile 条目的安全性与完整性。
 * 返回错误信息字符串，合法则返回 null。
 */
export function validateBundleFile(file: BundleFile): string | null {
  if (!file.relativePath || typeof file.relativePath !== 'string') {
    return 'Missing or invalid relativePath'
  }

  // 路径穿越检查
  if (file.relativePath.includes('..')) {
    return `Path traversal detected: ${file.relativePath}`
  }
  if (file.relativePath.startsWith('/') || file.relativePath.startsWith('\\')) {
    return `Absolute path not allowed: ${file.relativePath}`
  }
  if (file.relativePath.includes('\\')) {
    return `Backslash path separator not allowed: ${file.relativePath}`
  }

  // 检查空路径段（双斜杠）
  if (file.relativePath.includes('//')) {
    return `Invalid path (double slash): ${file.relativePath}`
  }

  // 校验 base64 和大小
  if (typeof file.contentBase64 !== 'string') {
    return `Invalid contentBase64 for ${file.relativePath}`
  }
  if (typeof file.size !== 'number' || file.size < 0) {
    return `Invalid size for ${file.relativePath}`
  }

  // 校验解码后大小是否与声明一致
  try {
    const decoded = Buffer.from(file.contentBase64, 'base64')
    if (decoded.length !== file.size) {
      return `Size mismatch for ${file.relativePath}: declared ${file.size}, actual ${decoded.length}`
    }
  } catch {
    return `Invalid base64 encoding for ${file.relativePath}`
  }

  return null
}

// ============================================================
// 收集
// ============================================================

/**
 * 收集目录文件的选项。
 */
export interface CollectOptions {
  /** 跳过的文件名（精确匹配，如 'config.json'） */
  skipFiles?: Set<string>
  /** 跳过的目录名（精确匹配，如 'tmp'） */
  skipDirs?: Set<string>
}

/**
 * 递归收集目录中所有非隐藏普通文件。
 * 返回按 relativePath 排序的 BundleFile 数组，保证输出确定性。
 *
 * 跳过：
 * - 隐藏文件和目录（以 '.' 开头）
 * - 匹配 skipFiles/skipDirs 的文件/目录
 * - 无法读取的文件（记录日志并跳过）
 */
export function collectDirectoryFiles(dir: string, options?: CollectOptions): BundleFile[] {
  const files: BundleFile[] = []
  const skipFiles = options?.skipFiles ?? new Set()
  const skipDirs = options?.skipDirs ?? new Set()

  function walk(currentDir: string): void {
    if (!existsSync(currentDir)) return

    const entries = readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      // 跳过隐藏文件和目录
      if (entry.name.startsWith('.')) continue

      const fullPath = join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(fullPath)
      } else if (entry.isFile()) {
        if (skipFiles.has(entry.name)) continue

        try {
          const content = readFileSync(fullPath)
          const stat = statSync(fullPath)
          const relPath = relative(dir, fullPath)

          files.push({
            relativePath: toPortableRelPath(relPath),
            contentBase64: content.toString('base64'),
            size: stat.size,
          })
        } catch (err) {
          debug(`[bundle-files] Failed to read file ${fullPath}:`, err)
          // 跳过无法读取的文件，而不是让整个收集失败
        }
      }
    }
  }

  walk(dir)

  // 排序以保证确定性输出
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  return files
}

// ============================================================
// 恢复
// ============================================================

/**
 * 将 BundleFile 条目恢复到目标目录。
 * 按需创建子目录。写入前逐个校验文件。
 *
 * @throws Error 当任意文件路径校验失败（路径穿越、绝对路径等）时抛出
 */
export function restoreFiles(targetDir: string, files: BundleFile[]): void {
  for (const file of files) {
    const error = validateBundleFile(file)
    if (error) {
      throw new Error(`Invalid bundle file: ${error}`)
    }

    const nativePath = fromPortableRelPath(file.relativePath)
    const fullPath = join(targetDir, nativePath)

    // 安全校验：确保解析后的路径仍在目标目录内
    if (!fullPath.startsWith(targetDir + sep) && fullPath !== targetDir) {
      throw new Error(`Path escapes target directory: ${file.relativePath}`)
    }

    // 确保父目录存在
    const parentDir = dirname(fullPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // 解码并写入
    const content = Buffer.from(file.contentBase64, 'base64')
    writeFileSync(fullPath, content)
  }
}

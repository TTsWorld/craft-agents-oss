/**
 * working-directory-history.ts
 *
 * 维护“工作目录”最近使用历史的小工具。
 * Agent 在执行 bash、grep 等 tool use 时需要知道当前工作目录；
 * 这里保存用户最近选择过的目录，方便输入框快速切换。
 */

import * as storage from '@/lib/local-storage'

/** 最近工作目录的最大保存数量 */
export const MAX_RECENT_WORKING_DIRS = 25

/**
 * 把一条路径加入最近历史。
 * - 先去重；
 * - 插到最前面；
 * - 超过 maxEntries 时截断。
 */
export function addPathToRecentWorkingDirs(
  recentDirs: string[],
  path: string,
  maxEntries = MAX_RECENT_WORKING_DIRS,
): string[] {
  const normalized = path.trim()
  if (!normalized) return [...recentDirs]

  const filtered = recentDirs.filter(p => p !== normalized)
  return [normalized, ...filtered].slice(0, maxEntries)
}

/** 从最近历史中移除一条路径 */
export function removePathFromRecentWorkingDirs(recentDirs: string[], path: string): string[] {
  const normalized = path.trim()
  if (!normalized) return [...recentDirs]
  return recentDirs.filter(p => p !== normalized)
}

/**
 * 规范化历史记录列表：
 * - 去除首尾空白；
 * - 丢弃空值；
 * - 按首次出现顺序去重；
 * - 限制长度。
 */
export function normalizeRecentWorkingDirs(
  paths: string[],
  maxEntries = MAX_RECENT_WORKING_DIRS,
): string[] {
  const unique: string[] = []
  const seen = new Set<string>()

  for (const value of paths) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
    if (unique.length >= maxEntries) break
  }

  return unique
}

/** 从 localStorage 读取最近工作目录（可指定 workspaceId 实现按工作区隔离） */
export function getRecentWorkingDirs(workspaceId?: string): string[] {
  return storage.get<string[]>(storage.KEYS.recentWorkingDirs, [], workspaceId)
}

/** 持久化完整的最近工作目录列表 */
export function setRecentWorkingDirs(paths: string[], workspaceId?: string): string[] {
  const normalized = normalizeRecentWorkingDirs(paths)
  storage.set(storage.KEYS.recentWorkingDirs, normalized, workspaceId)
  return normalized
}

/** 添加一条路径并立即持久化 */
export function addRecentWorkingDir(path: string, workspaceId?: string): string[] {
  const updated = addPathToRecentWorkingDirs(getRecentWorkingDirs(workspaceId), path)
  storage.set(storage.KEYS.recentWorkingDirs, updated, workspaceId)
  return updated
}

/** 移除一条路径并立即持久化 */
export function removeRecentWorkingDir(path: string, workspaceId?: string): string[] {
  const updated = removePathFromRecentWorkingDirs(getRecentWorkingDirs(workspaceId), path)
  storage.set(storage.KEYS.recentWorkingDirs, updated, workspaceId)
  return updated
}

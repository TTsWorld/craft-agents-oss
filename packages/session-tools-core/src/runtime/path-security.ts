/**
 * 路径安全检查（path security）
 *
 * 在 Agent 操作文件系统时，必须确认目标路径落在允许的 workspace/session 目录内，
 * 防止“../”或符号链接逃逸到上级目录。本模块提供两类检查：
 * - 针对已存在路径的 containment 检查
 * - 针对待创建路径的 containment 检查（需向上找到最近存在的祖先目录）
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

/**
 * 标准化路径：Windows 不区分大小写，这里统一转小写以便比较；
 * macOS/Linux 保持原样。
 */
function normalizePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * 判断 target 是否落在 base 目录下（仅基于字符串/相对路径计算，不解析符号链接）。
 * relative(base, target) 返回从 base 到 target 的相对路径；
 * 如果以 ".." 开头或是绝对路径，说明 target 不在 base 内。
 */
function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizePath(base);
  const normalizedTarget = normalizePath(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 对路径解析符号链接（realpath）。
 * 如果路径不存在，则退回到 resolve（绝对路径规范化）。
 */
function realpathIfExists(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path);
}

/**
 * 对“已经存在”的路径做包含性检查：先规范化再解析符号链接，确保真实路径也在 baseDir 内。
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);
  const realTarget = realpathIfExists(resolvedTarget);
  return isWithin(realBase, realTarget);
}

/**
 * 对“待创建/待写入”的路径做包含性检查。
 *
 * 例如要写入 /workspace/session/data/../secret，虽然 lexical 上跨出去了，
 * 但该路径可能尚不存在，无法直接 realpath。此时我们向上找到最近存在的祖先目录，
 * 用该祖先的真实路径判断整棵树是否都在 baseDir 内，从而防止符号链接逃逸。
 */
export function isPathWithinDirectoryForCreation(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const resolvedBase = resolve(baseDir);

  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = realpathIfExists(resolvedBase);

  // 如果目标路径已存在，直接复用已有检查
  if (existsSync(resolvedTarget)) {
    return isPathWithinDirectory(resolvedTarget, realBase);
  }

  // 向上遍历，找到最近一个真实存在的祖先目录
  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    // dirname 到根目录后会保持不变，此时说明已经越出文件系统根，停止
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

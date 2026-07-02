import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 从 .claude-plugin/plugin.json 读取 SDK 插件名称。
 *
 * Claude SDK 使用这个 manifest 里的 `name` 字段来识别插件，
 * 而不是用插件目录的 path.basename()。所有 skill 命中与系统提示引用
 * 都必须使用这个名称，才能与 SDK 期望的一致。
 *
 * @param workspaceRootPath - workspace 根目录
 * @returns 插件名；如果 manifest 不存在或无法读取则返回 null
 */
export function readPluginName(workspaceRootPath: string): string | null {
  try {
    const manifestPath = join(workspaceRootPath, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return manifest.name || null;
  } catch {
    return null;
  }
}

// 为方便使用，从浏览器安全版本 re-export slug 提取函数
export { extractWorkspaceSlugFromPath } from './workspace-slug.ts';

/**
 * 提取用于 SDK skill 命中的 workspace slug。
 *
 * 优先读取 .claude-plugin/plugin.json 中的真实插件名（SDK 实际使用的），
 * 失败时回退到根路径的最后一段。
 *
 * 注意：需要 Node.js（fs/path）。浏览器上下文请用 ./workspace-slug.ts 中的 extractWorkspaceSlugFromPath。
 *
 * @param rootPath - workspace 根路径
 * @param fallbackId - 兜底 ID
 * @returns workspace slug
 */
export function extractWorkspaceSlug(rootPath: string, fallbackId: string): string {
  // 读取 SDK 实际使用的插件名——它用于解析 skills
  const pluginName = readPluginName(rootPath);
  if (pluginName) return pluginName;

  // 回退到路径最后一段（旧行为）
  const pathParts = rootPath.split(/[\\/]/).filter(Boolean);
  return pathParts[pathParts.length - 1] || fallbackId;
}

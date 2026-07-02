/**
 * Workspace 标识（slug）提取工具 - 浏览器安全版本
 *
 * 不含 Node.js fs/path 依赖，可在 renderer / 浏览器上下文中使用。
 * Workspace：Agent 的工作空间，对应一个项目目录；slug 通常用于 skill 命中或会话标识。
 * 如需读取 .claude-plugin/plugin.json，请使用 Node.js 版本的 ./workspace.ts。
 */

/**
 * 从路径中提取 workspace slug（浏览器安全，不访问文件系统）。
 *
 * @param rootPath - workspace 根路径
 * @param fallbackId - 当路径没有有效组件时的回退 ID
 * @returns 路径的最后一段；取不到则返回 fallbackId
 */
export function extractWorkspaceSlugFromPath(rootPath: string, fallbackId: string): string {
  const pathParts = rootPath.split(/[\\/]/).filter(Boolean);
  return pathParts[pathParts.length - 1] || fallbackId;
}

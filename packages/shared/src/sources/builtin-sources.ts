/**
 * Built-in Sources
 *
 * 系统级 source，每个 workspace 都默认可用。
 * 这些 source 不会显示在 sources 列表 UI 中，但 agent 可以使用。
 *
 * 注意：craft-agents-docs 现在已直接配置在 craft-agent.ts 里作为一个始终可用的 MCP server，
 * 不再以 source 形式存在。本文件保留是为了向后兼容，但返回空结果。
 */

import type { LoadedSource, FolderSourceConfig } from './types.ts';

/**
 * 获取某个 workspace 的所有内置 source。
 *
 * 目前返回空数组 —— craft-agents-docs 已移到 craft-agent.ts 中作为常驻 MCP server。
 *
 * @param _workspaceId - workspace ID（未使用）
 * @param _workspaceRootPath - workspace 根目录绝对路径（未使用）
 * @returns 空数组（没有内置 source）
 */
export function getBuiltinSources(_workspaceId: string, _workspaceRootPath: string): LoadedSource[] {
  return [];
}

/**
 * 获取内置的 Craft Agents docs source。
 *
 * @deprecated craft-agents-docs 现在直接配置在 craft-agent.ts 中作为常驻 MCP server。
 * 本函数保留是为了向后兼容，但只返回一个占位对象。
 */
export function getDocsSource(workspaceId: string, workspaceRootPath: string): LoadedSource {
  // 返回占位对象 —— 正常情况下不应再调用
  const placeholderConfig: FolderSourceConfig = {
    id: 'builtin-craft-agents-docs',
    name: 'Craft Agents Docs',
    slug: 'craft-agents-docs',
    enabled: false,
    provider: 'mintlify',
    type: 'mcp',
    mcp: {
      transport: 'http',
      url: 'https://agents.craft.do/docs/mcp',
      authType: 'none',
    },
    tagline: 'Search Craft Agents documentation and source setup guides',
    icon: '📚',
    isAuthenticated: true,
    connectionStatus: 'connected',
  };

  return {
    workspaceId,
    workspaceRootPath,
    folderPath: '',
    config: placeholderConfig,
    guide: { raw: '' },
    isBuiltin: true,
  };
}

/**
 * 判断某个 source slug 是否是内置 source。
 *
 * 返回 false —— craft-agents-docs 现在是常驻 MCP server，不再属于 sources 系统。
 *
 * @param _slug - 要检查的 source slug（未使用）
 * @returns false（没有内置 source）
 */
export function isBuiltinSource(_slug: string): boolean {
  return false;
}

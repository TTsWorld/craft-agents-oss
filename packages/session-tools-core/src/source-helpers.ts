/**
 * session-tools-core 的 Source 辅助函数
 *
 * 用于加载、查找 source 配置和 skill 的独立工具函数。
 * 不依赖完整的 packages/shared 基础设施。
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceConfig } from './types.ts';

/** 去除会干扰 JSON.parse 的 UTF-8 BOM */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * 获取某个 source 目录的路径
 */
export function getSourcePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(workspaceRootPath, 'sources', sourceSlug);
}

/**
 * 获取某个 source 的 config.json 路径
 */
export function getSourceConfigPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json');
}

/**
 * 获取某个 source 的 guide.md 路径
 */
export function getSourceGuidePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'guide.md');
}

/**
 * 判断 source 目录是否存在
 */
export function sourceExists(workspaceRootPath: string, sourceSlug: string): boolean {
  return existsSync(getSourcePath(workspaceRootPath, sourceSlug));
}

/**
 * 判断 source 的配置文件是否存在
 */
export function sourceConfigExists(workspaceRootPath: string, sourceSlug: string): boolean {
  return existsSync(getSourceConfigPath(workspaceRootPath, sourceSlug));
}

/**
 * 从磁盘加载 source 配置。
 * 如果配置不存在或解析失败，返回 null。
 */
export function loadSourceConfig(
  workspaceRootPath: string,
  sourceSlug: string
): SourceConfig | null {
  const configPath = getSourceConfigPath(workspaceRootPath, sourceSlug);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(stripBom(content)) as SourceConfig;
    return config;
  } catch {
    return null;
  }
}

/**
 * 列出 workspace 中所有 source 的 slug
 */
export function listSourceSlugs(workspaceRootPath: string): string[] {
  const sourcesDir = join(workspaceRootPath, 'sources');

  if (!existsSync(sourcesDir)) {
    return [];
  }

  try {
    const entries = readdirSync(sourcesDir);
    return entries.filter((entry) => {
      const entryPath = join(sourcesDir, entry);
      return statSync(entryPath).isDirectory();
    });
  } catch {
    return [];
  }
}

/**
 * 获取某个 skill 目录的路径
 */
export function getSkillPath(workspaceRootPath: string, skillSlug: string): string {
  return join(workspaceRootPath, 'skills', skillSlug);
}

/**
 * 获取某个 skill 的 SKILL.md 路径
 */
export function getSkillMdPath(workspaceRootPath: string, skillSlug: string): string {
  return join(getSkillPath(workspaceRootPath, skillSlug), 'SKILL.md');
}

/**
 * 判断 skill 目录是否存在
 */
export function skillExists(workspaceRootPath: string, skillSlug: string): boolean {
  return existsSync(getSkillPath(workspaceRootPath, skillSlug));
}

/**
 * 判断 skill 的 SKILL.md 文件是否存在
 */
export function skillMdExists(workspaceRootPath: string, skillSlug: string): boolean {
  return existsSync(getSkillMdPath(workspaceRootPath, skillSlug));
}

/**
 * 列出 workspace 中所有 skill 的 slug
 */
export function listSkillSlugs(workspaceRootPath: string): string[] {
  const skillsDir = join(workspaceRootPath, 'skills');

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    const entries = readdirSync(skillsDir);
    return entries.filter((entry) => {
      const entryPath = join(skillsDir, entry);
      return statSync(entryPath).isDirectory();
    });
  } catch {
    return [];
  }
}

// ============================================================
// Session 状态辅助函数
// ============================================================

/**
 * 从持久化的 session.jsonl 头部读取 workingDirectory。
 * 如果 session 文件不存在、无法解析或没有设置 workingDirectory，返回 undefined。
 * 永远不会抛异常。
 */
export function resolveSessionWorkingDirectory(
  workspacePath: string,
  sessionId: string
): string | undefined {
  try {
    const sessionFile = join(workspacePath, 'sessions', sessionId, 'session.jsonl');
    if (!existsSync(sessionFile)) return undefined;
    // 只读第一行（头部）—— 8KB 缓冲区足够
    const fd = openSync(sessionFile, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buffer, 0, 8192, 0);
      const firstLine = buffer.toString('utf-8', 0, bytesRead).split('\n')[0] ?? '';
      const header = JSON.parse(firstLine);
      return header.workingDirectory || undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // 永不失败 —— 调用方会优雅处理缺失
  }
}

/**
 * 为认证请求生成一个唯一请求 ID
 */
export function generateRequestId(prefix: string = 'req'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// 凭证模式辅助函数
// ============================================================

import type { CredentialInputMode } from './types.ts';
export type { CredentialInputMode } from './types.ts';

/**
 * 根据 source 配置和请求的模式，判断实际生效的凭证输入模式。
 *
 * 当 source 配置了 headerNames 数组时，无论显式请求什么模式，
 * 都会自动升级为 'multi-header'。这保证像 Datadog 这类 source
 * （headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"]）始终使用多 header UI。
 *
 * @param source - source 配置（source 不存在时可能为 null）
 * @param requestedMode - tool 调用里显式请求的模式
 * @param requestedHeaderNames - tool 调用里显式提供的 header 名
 * @returns 实际应使用的模式
 */
export function detectCredentialMode(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedMode: CredentialInputMode,
  requestedHeaderNames?: string[]
): CredentialInputMode {
  // 优先使用请求提供的 headerNames，否则回退到 source 配置（API 或 MCP）
  const effectiveHeaderNames = requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;

  // 只要有 headerNames，就强制使用 multi-header 模式
  if (effectiveHeaderNames && effectiveHeaderNames.length > 0) {
    return 'multi-header';
  }

  return requestedMode;
}

/**
 * 从请求参数或 source 配置中获取实际生效的 header 名。
 *
 * @param source - source 配置
 * @param requestedHeaderNames - tool 调用里显式提供的 header 名
 * @returns header 名数组，或 undefined
 */
export function getEffectiveHeaderNames(
  source: { api?: { headerNames?: string[] }; mcp?: { headerNames?: string[] } } | null,
  requestedHeaderNames?: string[]
): string[] | undefined {
  return requestedHeaderNames || source?.api?.headerNames || source?.mcp?.headerNames;
}

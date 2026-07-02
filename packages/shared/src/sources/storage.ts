/**
 * Source Storage
 *
 * workspace 级别 source 的增删改查。
 * source 存储在 {workspaceRootPath}/sources/{sourceSlug}/ 目录下。
 *
 * 注意：所有函数都接收 `workspaceRootPath`（workspace 文件夹绝对路径），
 * 而不是 workspace slug。`LoadedSource.workspaceId` 是用 basename() 从路径取出的目录名。
 *
 * TS/Node 小知识：
 * - `fs` 模块类似 Go 的 os 包，用来读写文件、目录。
 * - `path.join` 类似 Go 的 filepath.Join，`basename` 类似 filepath.Base。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import type {
  FolderSourceConfig,
  SourceGuide,
  LoadedSource,
  CreateSourceInput,
} from './types.ts';
import { validateSourceConfig } from '../config/validators.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { getBuiltinSources, isBuiltinSource, getDocsSource } from './builtin-sources.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { getWorkspaceSourcesPath } from '../workspaces/storage.ts';
// 循环引用：credential-manager.ts 会从本文件导入，但 getSourceCredentialManager
// 只在 saveSourceConfig 里惰性使用，模块加载时不会触发，所以安全。
import { getSourceCredentialManager } from './credential-manager.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// 目录工具
// ============================================================

/**
 * 获取某个 source 在 workspace 中的目录路径
 */
export function getSourcePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getWorkspaceSourcesPath(workspaceRootPath), sourceSlug);
}

/**
 * 确保 workspace 的 sources 目录存在（不存在就创建）
 */
export function ensureSourcesDir(workspaceRootPath: string): void {
  const dir = getWorkspaceSourcesPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// 配置读写
// ============================================================

/**
 * 读取 source 的 config.json
 */
export function loadSourceConfig(
  workspaceRootPath: string,
  sourceSlug: string
): FolderSourceConfig | null {
  const configPath = join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<FolderSourceConfig>(configPath);

    // 本地 source 的路径里可能有 ~ 等可移植变量，展开成绝对路径
    if (config.type === 'local' && config.local?.path) {
      config.local.path = expandPath(config.local.path);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * 标记 source 已认证并已连接。
 * 更新 isAuthenticated、connectionStatus，并清空连接错误。
 *
 * @returns 找到并更新返回 true，否则返回 false
 */
export function markSourceAuthenticated(
  workspaceRootPath: string,
  sourceSlug: string
): boolean {
  const config = loadSourceConfig(workspaceRootPath, sourceSlug);
  if (!config) {
    debug(`[markSourceAuthenticated] Source ${sourceSlug} not found`);
    return false;
  }

  config.isAuthenticated = true;
  config.connectionStatus = 'connected';
  config.connectionError = undefined;

  saveSourceConfig(workspaceRootPath, config);
  debug(`[markSourceAuthenticated] Marked ${sourceSlug} as authenticated`);
  return true;
}

/**
 * 保存 source 的 config.json
 * @throws 配置校验不通过时抛 Error
 */
export function saveSourceConfig(
  workspaceRootPath: string,
  config: FolderSourceConfig
): void {
  // 写盘前先校验
  const validation = validateSourceConfig(config);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[saveSourceConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid source config: ${errorMessages}`);
  }

  const dir = getSourcePath(workspaceRootPath, config.slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 本地 source 路径保存为可移植形式，避免不同机器路径不一致
  const storageConfig: FolderSourceConfig = { ...config, updatedAt: Date.now() };
  if (storageConfig.type === 'local' && storageConfig.local?.path) {
    storageConfig.local = {
      ...storageConfig.local,
      path: toPortablePath(storageConfig.local.path),
    };
  }

  writeFileSync(join(dir, 'config.json'), JSON.stringify(storageConfig, null, 2));

  // 孤儿凭证清理：当 API source 被设为 authType:'none' 时，
  // 该 slug 之前存下的凭证（比如 authType:'header' 时存的）会变成可访问的垃圾。
  // getCredentialId() 把 'none'、'header'、'query' 都映射到同一个 source_apikey 槽位，
  // 因此旧凭证可能在后续配置变更时悄悄覆盖 defaultHeaders。这里主动删除它。
  if (storageConfig.type === 'api' && storageConfig.api?.authType === 'none') {
    deleteApiKeyCredentialBestEffort(workspaceRootPath, storageConfig);
  }
}

/**
 * 尽力删除 API source 在 source_apikey 槽位上的凭证。
 * 绝不抛错 —— 凭证清理不能阻塞配置保存。
 */
function deleteApiKeyCredentialBestEffort(
  workspaceRootPath: string,
  config: FolderSourceConfig
): void {
  try {
    const cm = getSourceCredentialManager();
    // 构造一个最简的 LoadedSource：getCredentialId() 只读 config + workspaceId
    const source: LoadedSource = {
      config,
      guide: null,
      folderPath: getSourcePath(workspaceRootPath, config.slug),
      workspaceRootPath,
      workspaceId: basename(workspaceRootPath),
    };
    cm.deleteSync(source);
  } catch (err) {
    debug('[saveSourceConfig] orphan credential cleanup threw:', err);
  }
}

// ============================================================
// Guide 读写
// ============================================================

/**
 * 解析 guide.md。
 * 提取 Scope、Guidelines、Context、API Notes 等章节，以及 Cache（JSON 代码块）。
 */
function parseGuideMarkdown(raw: string): SourceGuide {
  const guide: SourceGuide = { raw };

  // 按二级标题提取章节（包含 Cache）
  const sectionRegex = /^## (Scope|Guidelines|Context|API Notes|Cache)\n([\s\S]*?)(?=\n## |\Z)/gim;
  let match;
  while ((match = sectionRegex.exec(raw)) !== null) {
    const sectionName = (match[1] ?? '').toLowerCase().replace(/\s+/g, '');
    const content = (match[2] ?? '').trim();

    switch (sectionName) {
      case 'scope':
        guide.scope = content;
        break;
      case 'guidelines':
        guide.guidelines = content;
        break;
      case 'context':
        guide.context = content;
        break;
      case 'apinotes':
        guide.apiNotes = content;
        break;
      case 'cache':
        // 从 ```json ... ``` 代码块里解析 JSON
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
          try {
            guide.cache = JSON.parse(jsonMatch[1]);
          } catch {
            // JSON 无效就忽略
          }
        }
        break;
    }
  }

  return guide;
}

/**
 * 加载并解析 guide.md（包含 frontmatter 缓存）
 */
export function loadSourceGuide(workspaceRootPath: string, sourceSlug: string): SourceGuide | null {
  const guidePath = join(getSourcePath(workspaceRootPath, sourceSlug), 'guide.md');
  if (!existsSync(guidePath)) return null;

  try {
    const raw = readFileSync(guidePath, 'utf-8');
    return parseGuideMarkdown(raw);
  } catch {
    return null;
  }
}

/**
 * 从 guide.md 内容中提取简短 tagline。
 * 优先找标题后面的第一段非空段落，否则退回到 scope 章节。
 *
 * @returns tagline 字符串（最长 100 字符），找不到返回 null
 */
export function extractTagline(guide: SourceGuide | null): string | null {
  if (!guide?.raw) return null;

  const content = guide.raw;

  // 尝试匹配标题 # Title 后面的第一段
  // 匹配：# Title\n\n<first paragraph>
  const titleMatch = content.match(/^#[^\n]+\n+([^\n#][^\n]*)/);
  if (titleMatch?.[1]?.trim()) {
    const tagline = titleMatch[1].trim();
    // 跳过看起来像章节标题或占位符的行
    if (!tagline.startsWith('##') && !tagline.startsWith('(')) {
      return tagline.slice(0, 100);
    }
  }

  // 退回到 scope 章节第一行
  if (guide.scope) {
    const firstLine = guide.scope.split('\n')[0]?.trim();
    if (firstLine && !firstLine.startsWith('(')) {
      return firstLine.slice(0, 100);
    }
  }

  return null;
}

/**
 * 保存 guide.md
 */
export function saveSourceGuide(
  workspaceRootPath: string,
  sourceSlug: string,
  guide: SourceGuide
): void {
  const dir = getSourcePath(workspaceRootPath, sourceSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(dir, 'guide.md'), guide.raw);
}

// ============================================================
// 图标操作（复用 utils/icon.ts 里的工具函数）
// ============================================================

/**
 * 查找 source 的图标文件
 * @returns 图标文件绝对路径，找不到返回 undefined
 */
export function findSourceIcon(workspaceRootPath: string, sourceSlug: string): string | undefined {
  return findIconFile(getSourcePath(workspaceRootPath, sourceSlug));
}

/**
 * 从 URL 下载图标并保存到 source 目录。
 * @returns 下载后的图标路径，失败返回 null
 */
export async function downloadSourceIcon(
  workspaceRootPath: string,
  sourceSlug: string,
  iconUrl: string
): Promise<string | null> {
  const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
  return downloadIcon(sourceDir, iconUrl, 'Sources');
}

/**
 * 判断 source 是否需要下载图标。
 * 当配置里的 icon 是 URL 且本地还没有图标文件时返回 true。
 */
export function sourceNeedsIconDownload(
  workspaceRootPath: string,
  sourceSlug: string,
  config: FolderSourceConfig
): boolean {
  const iconPath = findSourceIcon(workspaceRootPath, sourceSlug);
  return needsIconDownload(config.icon, iconPath);
}

// 为了使用方便，重新导出图标工具
export { isIconUrl } from '../utils/icon.ts';

// ============================================================
// 加载操作
// ============================================================

/**
 * 加载完整的 source（包含 config、guide、图标路径等）
 * @param workspaceRootPath - workspace 文件夹绝对路径，例如 ~/.craft-agent/workspaces/xxx
 * @param sourceSlug - source 文件夹名
 */
export function loadSource(workspaceRootPath: string, sourceSlug: string): LoadedSource | null {
  const folderPath = getSourcePath(workspaceRootPath, sourceSlug);
  const config = loadSourceConfig(workspaceRootPath, sourceSlug);
  if (!config) return null;

  // 用文件夹名作为 workspaceId，凭证查找时用它做 key
  // 注意：凭证 key 是目录名（例如 "046a02d0-..."），不是完整路径
  const workspaceId = basename(workspaceRootPath);

  // 预计算图标路径，渲染层就不用再访问文件系统
  const iconPath = findIconFile(folderPath);

  return {
    config,
    guide: loadSourceGuide(workspaceRootPath, sourceSlug),
    folderPath,
    workspaceRootPath,
    workspaceId,
    iconPath,
  };
}

/**
 * 加载某个 workspace 下的所有 source
 */
export function loadWorkspaceSources(workspaceRootPath: string): LoadedSource[] {
  ensureSourcesDir(workspaceRootPath);

  const sources: LoadedSource[] = [];
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);

  if (!existsSync(sourcesDir)) return sources;

  const entries = readdirSync(sourcesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const source = loadSource(workspaceRootPath, entry.name);
      if (source) {
        sources.push(source);
      }
    }
  }

  return sources;
}

/**
 * 获取某个 workspace 下已启用的 source
 */
export function getEnabledSources(workspaceRootPath: string): LoadedSource[] {
  return loadWorkspaceSources(workspaceRootPath).filter((s) => s.config.enabled);
}

/**
 * 判断 source 是否可以被使用（已启用且认证状态 OK）。
 * authType 为 'none' 或未定义时视为已认证。
 *
 * 不要用内联 `s.config.enabled && s.config.isAuthenticated`，
 * 用这个函数可以保证对“无需认证”source 的处理一致。
 */
export function isSourceUsable(source: LoadedSource): boolean {
  if (!source.config.enabled) return false;

  // 从 MCP 或 API 配置里取 authType
  const authType = source.config.mcp?.authType || source.config.api?.authType;

  // 无需认证的 source 只要启用就是可用的
  if (authType === 'none' || authType === undefined) return true;

  // 需要认证的 source 必须 isAuthenticated === true
  return source.config.isAuthenticated === true;
}

/**
 * 根据 slug 列表获取 source。
 * 同时包含磁盘上的用户配置 source 和没有文件夹的内置 source（例如 craft-agents-docs）。
 */
export function getSourcesBySlugs(workspaceRootPath: string, slugs: string[]): LoadedSource[] {
  const workspaceId = basename(workspaceRootPath);
  const sources: LoadedSource[] = [];
  for (const slug of slugs) {
    // 先检查内置 source（它们没有磁盘文件夹）
    if (isBuiltinSource(slug)) {
      // 目前只有 craft-agents-docs 是内置 source
      if (slug === 'craft-agents-docs') {
        sources.push(getDocsSource(workspaceId, workspaceRootPath));
      }
      continue;
    }
    // 从磁盘加载用户配置的 source
    const source = loadSource(workspaceRootPath, slug);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * 加载某个 workspace 的所有 source，**包含内置 source**。
 * 内置 source（例如 craft-agents-docs）始终可用，会和用户配置的 source 合并。
 *
 * 当 agent 需要看到所有可用 source（包括系统提供、不存盘的 source）时使用这个函数。
 */
export function loadAllSources(workspaceRootPath: string): LoadedSource[] {
  const workspaceId = basename(workspaceRootPath);
  const userSources = loadWorkspaceSources(workspaceRootPath);
  const builtinSources = getBuiltinSources(workspaceId, workspaceRootPath);
  return [...userSources, ...builtinSources];
}

// ============================================================
// 创建/删除操作
// ============================================================

/**
 * 根据 name 生成 URL 安全的 slug
 */
export function generateSourceSlug(workspaceRootPath: string, name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // 保证 slug 不为空
  if (!slug) {
    slug = 'source';
  }

  // 如果 slug 已存在，就在末尾加数字
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath);
  const existingSlugs = new Set<string>();
  if (existsSync(sourcesDir)) {
    const entries = readdirSync(sourcesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingSlugs.add(entry.name);
      }
    }
  }

  if (!existingSlugs.has(slug)) {
    return slug;
  }

  // 找到下一个可用数字
  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) {
    counter++;
  }

  return `${slug}-${counter}`;
}

/**
 * 在 workspace 中创建一个新 source
 */
export async function createSource(
  workspaceRootPath: string,
  input: CreateSourceInput
): Promise<FolderSourceConfig> {
  const slug = generateSourceSlug(workspaceRootPath, input.name);
  const now = Date.now();

  const config: FolderSourceConfig = {
    // ID 格式：{slug}_{随机串}，方便识别，例如 "linear_a1b2c3d4"
    id: `${slug}_${randomUUID().slice(0, 8)}`,
    name: input.name,
    slug,
    enabled: input.enabled ?? true,
    provider: input.provider,
    type: input.type,
    createdAt: now,
    updatedAt: now,
  };

  // 按类型写入对应配置块
  switch (input.type) {
    case 'mcp':
      if (input.mcp) {
        config.mcp = input.mcp;
      }
      break;
    case 'api':
      if (input.api) {
        config.api = input.api;
      }
      break;
    case 'local':
      if (input.local) {
        config.local = input.local;
      }
      break;
  }

  // 校验并存储图标（emoji 或 URL）
  // URL 图标会在第一次配置变更时由 watcher 下载
  if (input.icon) {
    const validatedIcon = validateIconValue(input.icon, 'Sources');
    if (validatedIcon) {
      config.icon = validatedIcon;
    }
  }

  // 先保存配置，创建目录
  saveSourceConfig(workspaceRootPath, config);

  // 如果 icon 是 URL，立即下载
  // （watcher 也会处理，但这里立即下载能给用户更快反馈）
  const sourcePath = getSourcePath(workspaceRootPath, slug);
  if (config.icon && isIconUrl(config.icon)) {
    const iconPath = await downloadIcon(sourcePath, config.icon, 'Sources');
    if (iconPath) {
      debug(`[createSource] Icon downloaded for ${slug}: ${iconPath}`);
    }
  } else if (!config.icon) {
    // 没有提供图标 —— 尝试从服务 URL 自动获取
    const { deriveServiceUrl, getHighQualityLogoUrl } = await import('../utils/logo.ts');
    const { downloadIcon } = await import('../utils/icon.ts');
    const serviceUrl = deriveServiceUrl(input);
    if (serviceUrl) {
      const logoUrl = await getHighQualityLogoUrl(serviceUrl, input.provider);
      if (logoUrl) {
        const iconPath = await downloadIcon(sourcePath, logoUrl, `createSource:${slug}`);
        if (iconPath) {
          // 保存 source URL 作为参考（不是缓存路径）
          config.icon = logoUrl;
          saveSourceConfig(workspaceRootPath, config);
        }
      }
    }
  }

  // 创建 guide.md 骨架
  // （已移除打包的 guide —— agent 应该通过 craft-agents-docs MCP 查询服务专属指南）
  const guideContent = `# ${input.name}

## Guidelines

(Add usage guidelines here)

## Context

(Add context about this source)
`;
  saveSourceGuide(workspaceRootPath, slug, { raw: guideContent });

  return config;
}

/**
 * 从 workspace 删除一个 source
 */
export function deleteSource(workspaceRootPath: string, sourceSlug: string): void {
  const dir = getSourcePath(workspaceRootPath, sourceSlug);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/**
 * 判断 source 是否存在于 workspace 中
 */
export function sourceExists(workspaceRootPath: string, sourceSlug: string): boolean {
  return existsSync(join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json'));
}

// ============================================================
// Source 加载/保存辅助说明
// ============================================================

// 注：SourceWithContext 和相关包装函数已在本 PR 中移除。
// 需要时请直接使用 loadSourceConfig 和 saveSourceConfig。

// ============================================================
// 重新导出 parseGuideMarkdown，供其他模块使用
// ============================================================

export { parseGuideMarkdown };

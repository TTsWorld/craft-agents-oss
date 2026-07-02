/**
 * Workspace 存储层
 *
 * 提供 workspace 的增删改查操作。
 * workspace 可以通过 rootPath 存放在任意路径；
 * 默认位置为 ~/.craft-agent/workspaces/。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { getDefaultStatusConfig, saveStatusConfig, ensureDefaultIconFiles } from '../statuses/storage.ts';
import { getDefaultLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import { loadConfigDefaults } from '../config/storage.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

/** 应用配置目录：~/.craft-agent */
const CONFIG_DIR = join(homedir(), '.craft-agent');
/** workspace 默认存放目录 */
const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

// ============================================================
// 路径工具（Path Utilities）
// ============================================================

/**
 * 获取默认 workspace 目录路径（~/.craft-agent/workspaces/）
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * 确保默认 workspace 目录存在（不存在则递归创建）
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * 根据 workspace ID 获取默认位置下的根目录路径
 * @param workspaceId - Workspace ID
 * @returns 默认位置下 workspace 根目录的绝对路径
 */
export function getWorkspacePath(workspaceId: string): string {
  return join(DEFAULT_WORKSPACES_DIR, workspaceId);
}

/**
 * 获取 workspace 下 sources 目录的路径
 * @param rootPath - workspace 根目录的绝对路径
 */
export function getWorkspaceSourcesPath(rootPath: string): string {
  return join(rootPath, 'sources');
}

/**
 * 获取 workspace 下 sessions 目录的路径
 * @param rootPath - workspace 根目录的绝对路径
 */
export function getWorkspaceSessionsPath(rootPath: string): string {
  return join(rootPath, 'sessions');
}

/**
 * 获取 workspace 下 skills 目录的路径
 * @param rootPath - workspace 根目录的绝对路径
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(rootPath, 'skills');
}

// ============================================================
// 配置操作（Config Operations）
// ============================================================

/**
 * 从 workspace 目录加载 config.json
 * @param rootPath - workspace 根目录的绝对路径
 * @returns 配置对象；读取失败时返回 null
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    // `as` 是 TS 的类型断言，类似 Golang 中的类型转换，但只在编译期生效
    const config = readJsonFileSync<WorkspaceConfig>(configPath);

    // 展开 defaults.workingDirectory 中的路径变量（如 ~），保证换机后仍可移植
    if (config.defaults?.workingDirectory) {
      config.defaults.workingDirectory = expandPath(config.defaults.workingDirectory);
    }

    // 兼容性处理：读取时同时接受标准名和旧版 permission mode 名称
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed ?? undefined;
    }

    // 把 cyclablePermissionModes 规范化：过滤非法值、去重，若不足两种则回退到全部三种
    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        // 类型谓词：过滤后 TS 能确定 mode 一定不是 null
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      config.defaults.cyclablePermissionModes = normalized.length >= 2
        ? normalized
        : [...PERMISSION_MODE_ORDER];
    }

    if (config.defaults && 'thinkingLevel' in config.defaults) {
      // TODO: 等旧版持久化配置普遍升级后，移除对 legacy 'think' 的兼容处理
      config.defaults.thinkingLevel = normalizeThinkingLevel(config.defaults.thinkingLevel);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * 将 workspace 配置保存到 config.json
 * @param rootPath - workspace 根目录的绝对路径
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  // 复制一份配置用于落盘，避免直接修改传入对象；同时将路径转为可移植形式
  const storageConfig: WorkspaceConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  if (storageConfig.defaults?.workingDirectory) {
    storageConfig.defaults = {
      ...storageConfig.defaults,
      workingDirectory: toPortablePath(storageConfig.defaults.workingDirectory),
    };
  }

  // 使用原子写入，防止程序崩溃或中断时 config.json 损坏
  atomicWriteFileSync(join(rootPath, 'config.json'), JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// 加载操作（Load Operations）
// ============================================================

/**
 * 统计目录下的子目录数量
 */
function countSubdirs(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * 列出目录下的子目录名称
 */
function listSubdirNames(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 从根目录加载 workspace，并附带 source/session 数量等摘要信息
 * @param rootPath - workspace 根目录的绝对路径
 */
export function loadWorkspace(rootPath: string): LoadedWorkspace | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  // 对已有 workspace 进行迁移：确保存在插件清单文件
  ensurePluginManifest(rootPath, config.name);

  // 对已有 workspace 进行迁移：确保存在 skills 目录
  const skillsPath = getWorkspaceSkillsPath(rootPath);
  if (!existsSync(skillsPath)) {
    mkdirSync(skillsPath, { recursive: true });
  }

  return {
    config,
    sourceSlugs: listSubdirNames(getWorkspaceSourcesPath(rootPath)),
    sessionCount: countSubdirs(getWorkspaceSessionsPath(rootPath)),
  };
}

/**
 * 获取 workspace 摘要信息（用于列表展示，比较轻量）
 * @param rootPath - workspace 根目录的绝对路径
 */
export function getWorkspaceSummary(rootPath: string): WorkspaceSummary | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  return {
    slug: config.slug,
    name: config.name,
    sourceCount: countSubdirs(getWorkspaceSourcesPath(rootPath)),
    sessionCount: countSubdirs(getWorkspaceSessionsPath(rootPath)),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

// ============================================================
// 创建/删除操作（Create/Delete Operations）
// ============================================================

/**
 * 根据名称生成 URL 安全的 slug
 *
 * 处理规则：转小写、非字母数字字符替换为短横线、去掉首尾短横线、最多 50 字符。
 */
export function generateSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) {
    slug = 'workspace';
  }

  return slug;
}

/**
 * 为 workspace 生成一个不重复的目录路径。
 * 如果基于 slug 的目录已存在，则追加数字后缀，如 my-workspace、my-workspace-2、my-workspace-3。
 *
 * @param name - 展示名称，用于生成 slug
 * @param baseDir - workspace 目录所在的父目录（如 ~/.craft-agent/workspaces/）
 * @returns 一个不存在的新目录完整路径
 */
export function generateUniqueWorkspacePath(name: string, baseDir: string): string {
  const slug = generateSlug(name);
  let candidate = join(baseDir, slug);

  if (!existsSync(candidate)) {
    return candidate;
  }

  // 循环递增数字后缀，直到找到不存在的目录名
  let counter = 2;
  while (existsSync(join(baseDir, `${slug}-${counter}`))) {
    counter++;
  }

  return join(baseDir, `${slug}-${counter}`);
}

/**
 * 在指定路径创建 workspace 目录结构并写入配置
 * @param rootPath - 将要创建的 workspace 根目录绝对路径
 * @param name - workspace 展示名称
 * @param defaults - 新建 session 的默认设置（可选）
 * @returns 创建好的 WorkspaceConfig
 */
export function createWorkspaceAtPath(
  rootPath: string,
  name: string,
  defaults?: WorkspaceConfig['defaults']
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // 从 config-defaults.json 加载全局默认值
  const globalDefaults = loadConfigDefaults();

  // 合并全局默认值与用户传入的默认值
  // model、thinkingLevel、defaultLlmConnection 保持 undefined，让应用级默认值生效
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    model: undefined,
    thinkingLevel: undefined,
    // defaultLlmConnection 不设置，回退到应用默认
    permissionMode: globalDefaults.workspaceDefaults.permissionMode,
    cyclablePermissionModes: globalDefaults.workspaceDefaults.cyclablePermissionModes,
    enabledSourceSlugs: [],
    workingDirectory: undefined,
    ...defaults, // 用户传入的默认值覆盖上面的全局默认值
  };

  const config: WorkspaceConfig = {
    id: `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug,
    defaults: workspaceDefaults,
    localMcpServers: globalDefaults.workspaceDefaults.localMcpServers,
    createdAt: now,
    updatedAt: now,
  };

  // 创建 workspace 目录结构
  mkdirSync(rootPath, { recursive: true });
  mkdirSync(getWorkspaceSourcesPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSessionsPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSkillsPath(rootPath), { recursive: true });

  // 保存配置
  saveWorkspaceConfig(rootPath, config);

  // 初始化状态（status）配置与默认图标文件
  saveStatusConfig(rootPath, getDefaultStatusConfig());
  ensureDefaultIconFiles(rootPath);

  // 初始化标签（label）配置
  saveLabelConfig(rootPath, getDefaultLabelConfig());

  // 初始化插件清单，使 workspace 能被 SDK 加载为插件（支持 skills、commands、agents）
  ensurePluginManifest(rootPath, name);

  return config;
}

/**
 * 删除 workspace 目录及其所有内容
 * @param rootPath - workspace 根目录的绝对路径
 * @returns 删除成功返回 true，目录不存在或失败返回 false
 */
export function deleteWorkspaceFolder(rootPath: string): boolean {
  if (!existsSync(rootPath)) return false;

  try {
    rmSync(rootPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查指定路径是否是一个有效的 workspace（判断是否存在 config.json）
 * @param rootPath - 要检查的绝对路径
 */
export function isValidWorkspace(rootPath: string): boolean {
  return existsSync(join(rootPath, 'config.json'));
}

/**
 * 重命名 workspace（仅修改目录内 config.json 的 name 字段）
 * @param rootPath - workspace 根目录的绝对路径
 * @param newName - 新的展示名称
 */
export function renameWorkspaceFolder(rootPath: string, newName: string): boolean {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return false;

  config.name = newName.trim();
  saveWorkspaceConfig(rootPath, config);
  return true;
}

// ============================================================
// 自动发现（Auto-Discovery，针对默认 workspace 目录）
// ============================================================

/**
 * 在默认 workspace 目录下自动发现包含有效 config.json 的 workspace
 * @returns 发现的 workspace 根目录路径列表
 */
export function discoverWorkspacesInDefaultLocation(): string[] {
  const discovered: string[] = [];

  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    return discovered;
  }

  try {
    const entries = readdirSync(DEFAULT_WORKSPACES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const rootPath = join(DEFAULT_WORKSPACES_DIR, entry.name);
      if (isValidWorkspace(rootPath)) {
        discovered.push(rootPath);
      }
    }
  } catch {
    // 忽略扫描目录时的错误，直接返回已发现的结果
  }

  return discovered;
}

// ============================================================
// Workspace 主题色（Color Theme）
// ============================================================

/**
 * 读取 workspace 的主题色设置。
 * 返回 undefined 表示使用应用默认主题。
 *
 * @param rootPath - workspace 根目录的绝对路径
 * @returns 主题 ID 或 undefined
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  // `?.` 是可选链：如果 config 或 defaults 为 undefined/null，会安全返回 undefined
  return config?.defaults?.colorTheme;
}

/**
 * 设置 workspace 的主题色。
 * 传入 undefined 可清除自定义主题，恢复为应用默认。
 *
 * @param rootPath - workspace 根目录的绝对路径
 * @param themeId - 主题 ID 或 undefined（表示继承默认）
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // 如果传入了主题 ID，先做校验；undefined 表示继承默认，跳过校验
  // 只允许字母、数字、下划线、短横线，长度 1-64
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // 若 defaults 不存在，先初始化一个空对象
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// 本地 MCP 配置（Local MCP Configuration）
// ============================================================

/**
 * 判断当前 workspace 是否启用本地（stdio）MCP 服务。
 * 优先级：环境变量 CRAFT_LOCAL_MCP_ENABLED > workspace 配置 > 默认 true
 *
 * @param rootPath - workspace 根目录的绝对路径
 * @returns 启用返回 true
 */
export function isLocalMcpEnabled(rootPath: string): boolean {
  // 1. 环境变量优先级最高
  const envValue = process.env.CRAFT_LOCAL_MCP_ENABLED;
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true';
  }

  // 2. workspace 配置
  const config = loadWorkspaceConfig(rootPath);
  if (config?.localMcpServers?.enabled !== undefined) {
    return config.localMcpServers.enabled;
  }

  // 3. 默认启用
  return true;
}

// ============================================================
// 导出常量
// ============================================================

// ============================================================
// 插件清单（Plugin Manifest，用于 SDK 插件集成）
// ============================================================

/**
 * 确保 workspace 包含 .claude-plugin/plugin.json 插件清单。
 * 这样 workspace 可以被 SDK 作为插件加载，从而启用其中的 skills、commands、agents。
 *
 * @param rootPath - workspace 根目录的绝对路径
 * @param workspaceName - workspace 展示名称，用于生成插件名
 */
export function ensurePluginManifest(rootPath: string, workspaceName: string): void {
  const pluginDir = join(rootPath, '.claude-plugin');
  const manifestPath = join(pluginDir, 'plugin.json');

  if (existsSync(manifestPath)) return;

  // 创建 .claude-plugin 目录
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  // 写入最小化插件清单
  const manifest = {
    name: `craft-workspace-${workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    version: '1.0.0',
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };

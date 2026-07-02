/**
 * Safe Mode（安全模式 / Explore 模式）权限配置
 *
 * 允许按 workspace 和按 source 自定义 Safe Mode 规则。用户可以创建
 * permissions.json 来扩展默认规则（在默认基础上更宽松）。
 *
 * 配置文件位置：
 *   - workspace 级：~/.craft-agent/workspaces/{slug}/permissions.json
 *   - source  级：~/.craft-agent/workspaces/{slug}/sources/{sourceSlug}/permissions.json
 *
 * 规则是"叠加式"（additive）的 —— 用户自定义只会在默认之上做加法（更宽松），
 * 不会收紧默认。
 *
 * 概念速记（给刚接触 TS/Agent 的同学）：
 *   - Permission mode：safe / ask / allow-all 三种权限模式（见 CLAUDE.md），
 *     本文件主要服务于 safe 模式下的细粒度规则。
 *   - Source：数据源（mcp / api / local 三类），可挂在自己的权限子配置上。
 *   - Workspace：工作区，包含若干 session 与若干 source。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync, safeJsonParse } from '../utils/files.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { getSourcePath } from '../sources/storage.ts';
import { isValidPermissionsFile } from '../config/validators.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import {
  SAFE_MODE_CONFIG,
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type BlockedCommandHintRule,
  type PermissionPaths,
} from './mode-types.ts';

// ============================================================
// 应用级权限目录（App-level Permissions Directory）
// ============================================================

// 标记本次进程是否已经初始化过权限（避免热重载时重复初始化）
let permissionsInitialized = false;

/**
 * 获取应用级权限目录路径。
 * 默认权限存放在 ~/.craft-agent/permissions/
 * 动态读取环境变量，便于测试通过 CRAFT_CONFIG_DIR 覆盖。
 */
export function getAppPermissionsDir(): string {
  const configDir = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
  return join(configDir, 'permissions');
}

/**
 * 启动时把打包内置的默认权限同步到磁盘。
 * 当内置版本更新时进行迁移，规则如下：
 *   - 目标文件不存在  → 从内置拷贝
 *   - 目标文件存在但非法/损坏 → 从内置拷贝（自愈）
 *   - 目标文件存在且内置版本更新 → 合并新增 pattern、更新版本号
 *   - 目标文件存在且版本相同或更老 → 不做任何事（保留用户改动）
 *
 * 注意：用户的 workspace / source 级 permissions.json 永远不会被本函数改动。
 */
export function ensureDefaultPermissions(): void {
  // 本进程已初始化过则直接返回（避免热重载时重复初始化）
  if (permissionsInitialized) {
    return;
  }
  permissionsInitialized = true;

  const permissionsDir = getAppPermissionsDir();

  // 权限目录不存在则创建（recursive 类似 mkdir -p）
  if (!existsSync(permissionsDir)) {
    mkdirSync(permissionsDir, { recursive: true });
  }

  // 通过共享的 asset 解析器找到内置权限目录
  const bundledPermissionsDir = getBundledAssetsDir('permissions');
  if (!bundledPermissionsDir) {
    return;
  }

  const destPath = join(permissionsDir, 'default.json');
  const srcPath = join(bundledPermissionsDir, 'default.json');

  if (!existsSync(srcPath)) {
    return;
  }

  // 全新安装或文件损坏：从内置拷贝一份新的
  if (!existsSync(destPath) || !isValidPermissionsFile(destPath)) {
    try {
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
      debug('[Permissions] Installed default.json');
    } catch (error) {
      debug('[Permissions] Error installing default.json:', error);
    }
    return;
  }

  // 检查是否需要迁移（内置版本 > 已安装版本）
  try {
    const installedContent = readFileSync(destPath, 'utf-8');
    const bundledContent = readFileSync(srcPath, 'utf-8');

    const installed = safeJsonParse(installedContent) as PermissionsConfigFile;
    const bundled = safeJsonParse(bundledContent) as PermissionsConfigFile;

    // 缺 version 字段时用一个很早的日期兜底，确保能被升级
    const installedVersion = installed.version || '2000-01-01';
    const bundledVersion = bundled.version || '2000-01-01';

    if (bundledVersion > installedVersion) {
      const merged = migratePermissions(installed, bundled);
      writeFileSync(destPath, JSON.stringify(merged, null, 2), 'utf-8');
      debug('[Permissions] Migrated from', installedVersion, 'to', bundledVersion);
    } else {
      debug('[Permissions] Already up to date:', installedVersion);
    }
  } catch (error) {
    debug('[Permissions] Migration error:', error);
  }
}

/**
 * 把内置配置中的新 pattern 合并进已安装配置。
 * 保留用户自定义、追加新 pattern、更新版本号（不做删除）。
 */
function migratePermissions(
  installed: PermissionsConfigFile,
  bundled: PermissionsConfigFile
): PermissionsConfigFile {
  // pattern 既可能是字符串，也可能是 { pattern, comment? } 对象；统一抽出 pattern 串用于去重
  const getPatternString = (p: string | { pattern: string }): string =>
    typeof p === 'string' ? p : p.pattern;

  // 已安装的 bash / MCP pattern 集合（用于判断新配置里哪些是新增）
  const existingBashPatterns = new Set(
    (installed.allowedBashPatterns || []).map(getPatternString)
  );
  const existingMcpPatterns = new Set(
    (installed.allowedMcpPatterns || []).map(getPatternString)
  );

  // 挑出已安装里没有的新 pattern
  const newBashPatterns = (bundled.allowedBashPatterns || []).filter(
    p => !existingBashPatterns.has(getPatternString(p))
  );
  const newMcpPatterns = (bundled.allowedMcpPatterns || []).filter(
    p => !existingMcpPatterns.has(getPatternString(p))
  );

  // 合并 blocked command hints（按 command + whenNotMatching + reason 元组去重）
  const installedHints = installed.blockedCommandHints || [];
  const installedHintKeys = new Set(
    installedHints.map(h => `${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );
  const newBlockedCommandHints = (bundled.blockedCommandHints || []).filter(
    h => !installedHintKeys.has(`${h.command}::${h.whenNotMatching || ''}::${h.reason}`)
  );

  debug('[Permissions] Adding', newBashPatterns.length, 'new bash patterns');
  debug('[Permissions] Adding', newMcpPatterns.length, 'new MCP patterns');
  debug('[Permissions] Adding', newBlockedCommandHints.length, 'new blocked command hints');

  return {
    ...installed,
    version: bundled.version,
    allowedBashPatterns: [
      ...(installed.allowedBashPatterns || []),
      ...newBashPatterns,
    ],
    allowedMcpPatterns: [
      ...(installed.allowedMcpPatterns || []),
      ...newMcpPatterns,
    ],
    blockedCommandHints: [
      ...installedHints,
      ...newBlockedCommandHints,
    ],
  };
}

/**
 * 从 ~/.craft-agent/permissions/default.json 加载默认权限。
 * 文件不存在或非法时返回 null。
 */
export function loadDefaultPermissions(): PermissionsCustomConfig | null {
  const defaultPath = join(getAppPermissionsDir(), 'default.json');
  if (!existsSync(defaultPath)) {
    debug('[Permissions] No default.json found at', defaultPath);
    return null;
  }

  try {
    const content = readFileSync(defaultPath, 'utf-8');
    const config = parsePermissionsJson(content);
    debug('[Permissions] Loaded default permissions from', defaultPath);
    return config;
  } catch (error) {
    debug('[Permissions] Error loading default permissions:', error);
    return null;
  }
}

// 把 mode-types 里的类型再导出给外部消费者
export {
  PermissionsConfigSchema,
  type ApiEndpointRule,
  type PermissionsConfigFile,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type PermissionPaths,
};

// ============================================================
// 类型定义
// ============================================================

/**
 * 带可选 comment 的 pattern 条目；comment 用于错误提示。
 * 保留 permissions.json 里的 comment，便于在拒绝时给用户更友好的提示。
 */
export interface PatternWithComment {
  pattern: string;
  comment?: string;
}

/**
 * 解析并归一化后的权限配置（用户配置侧）。
 *
 * 注意：blockedTools（Write / Edit / MultiEdit / NotebookEdit）是硬编码在
 * SAFE_MODE_CONFIG 里的，不可在此配置 —— 这些是 Explore 模式下必须永远禁止的
 * 基础写入操作。
 */
export interface PermissionsCustomConfig {
  /** 额外允许的 bash pattern（可带 comment 用于错误提示） */
  allowedBashPatterns: PatternWithComment[];
  /** 额外允许的 MCP pattern（以正则字符串形式） */
  allowedMcpPatterns: string[];
  /** 细粒度 API endpoint 规则 */
  allowedApiEndpoints: ApiEndpointRule[];
  /** Explore 模式下允许写入的文件路径（glob pattern 字符串） */
  allowedWritePaths: string[];
  /** 针对特定被禁 Bash 命令的提示信息 */
  blockedCommandHints: BlockedCommandHintRule[];
}

/**
 * 合并后的运行时权限配置（给运行时检查用，含编译后的正则）。
 */
export interface MergedPermissionsConfig {
  /** 被禁工具集合（Write/Edit/...） —— 硬编码，不可配置 */
  blockedTools: Set<string>;
  /** 只读 bash pattern（带元数据，便于给出有用的错误信息） */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** 针对被禁 Bash 命令的解释性提示 */
  blockedCommandHints: CompiledBlockedCommandHint[];
  /** 只读 MCP pattern（已编译的正则） */
  readOnlyMcpPatterns: RegExp[];
  /** 细粒度 API endpoint 规则（已编译） */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** Explore 模式下允许写入的文件路径（glob pattern） */
  allowedWritePaths: string[];
  /** 用于错误信息的展示名 */
  displayName: string;
  /** 快捷键提示 */
  shortcutHint: string;
  /** 权限文件路径，用于"可执行的错误提示"（引导用户去改配置） */
  permissionPaths?: PermissionPaths;
}

/**
 * 权限检查的上下文：携带 workspace / source / agent 相关信息。
 */
export interface PermissionsContext {
  workspaceRootPath: string;
  /** 当前激活的 source slug 列表，用于 source 级规则匹配 */
  activeSourceSlugs?: string[];
}

// ============================================================
// JSON 解析器
// ============================================================

/**
 * 解析并校验一份 permissions.json 内容字符串。
 * 解析失败或校验不通过时返回全空的配置（不会抛错）。
 */
export function parsePermissionsJson(content: string): PermissionsCustomConfig {
  const emptyConfig: PermissionsCustomConfig = {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    blockedCommandHints: [],
  };

  try {
    // safeJsonParse：安全解析 JSON，失败会返回 undefined/抛出
    const json = safeJsonParse(content);
    // PermissionsConfigSchema 是 Zod schema；safeParse 不会抛错，返回结果对象
    const result = PermissionsConfigSchema.safeParse(json);

    if (!result.success) {
      debug('[SafeMode] Validation errors:', result.error.issues);
      // 把每条校验错误都打出来便于调试
      for (const issue of result.error.issues) {
        debug(`[SafeMode]   - ${issue.path.join('.')}: ${issue.message}`);
      }
      return emptyConfig;
    }

    const data = result.data;

    // 通用归一化：从 { pattern, comment? } 对象里抽出 pattern 串；bash 之外的字段用它
    const normalizePatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): string[] => {
      if (!patterns) return [];
      return patterns.map(p => typeof p === 'string' ? p : p.pattern);
    };

    // bash 单独处理：保留 comment，便于错误提示
    const normalizeBashPatterns = (patterns: Array<string | { pattern: string; comment?: string }> | undefined): PatternWithComment[] => {
      if (!patterns) return [];
      return patterns.map(p => {
        if (typeof p === 'string') {
          return { pattern: p };
        }
        return { pattern: p.pattern, comment: p.comment };
      });
    };

    return {
      allowedBashPatterns: normalizeBashPatterns(data.allowedBashPatterns),
      allowedMcpPatterns: normalizePatterns(data.allowedMcpPatterns),
      allowedApiEndpoints: data.allowedApiEndpoints ?? [],
      allowedWritePaths: normalizePatterns(data.allowedWritePaths),
      blockedCommandHints: data.blockedCommandHints ?? [],
    };
  } catch (error) {
    debug('[SafeMode] JSON parse error:', error);
    return emptyConfig;
  }
}

/**
 * 校验一个正则字符串是否合法；合法返回编译后的 RegExp，否则返回 null。
 */
function validateRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * 把一条 BlockedCommandHintRule 编译为运行时形态。
 * 失败（command 为空或 whenNotMatching 非法）时返回 null。
 */
function compileBlockedCommandHint(hint: BlockedCommandHintRule): CompiledBlockedCommandHint | null {
  const command = hint.command.trim().toLowerCase();
  if (!command) return null;

  let whenNotMatchingRegex: RegExp | undefined;
  if (hint.whenNotMatching) {
    const compiled = validateRegex(hint.whenNotMatching);
    if (!compiled) {
      debug(`[Permissions] Invalid blockedCommandHints.whenNotMatching regex, skipping: ${hint.whenNotMatching}`);
      return null;
    }
    whenNotMatchingRegex = compiled;
  }

  return {
    command,
    reason: hint.reason,
    context: hint.context,
    tryInstead: hint.tryInstead,
    example: hint.example,
    whenNotMatching: hint.whenNotMatching,
    whenNotMatchingRegex,
  };
}

/**
 * 判断某个 bash pattern 是否应当被编译/启用。
 * 在非 craftAgentsCli 模式下，跳过以 `^craft-agent\s` 开头的 pattern
 * （因为该 CLI 入口在当前形态下不可用）。
 */
function shouldCompileBashPattern(pattern: string): boolean {
  if (!FEATURE_FLAGS.craftAgentsCli && pattern.startsWith('^craft-agent\\s')) {
    return false;
  }
  return true;
}

/**
 * 校验整份权限配置，返回错误信息字符串数组（空数组表示通过）。
 */
export function validatePermissionsConfig(config: PermissionsConfigFile): string[] {
  const errors: string[] = [];

  // 校验正则 pattern：内部小工具，遍历每条 pattern，非法则记一条错误
  const checkPatterns = (patterns: Array<string | { pattern: string }> | undefined, name: string) => {
    if (!patterns) return;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      if (!p) continue;
      const patternStr = typeof p === 'string' ? p : p.pattern;
      if (!validateRegex(patternStr)) {
        errors.push(`${name}[${i}]: Invalid regex pattern: ${patternStr}`);
      }
    }
  };

  checkPatterns(config.allowedBashPatterns, 'allowedBashPatterns');
  checkPatterns(config.allowedMcpPatterns, 'allowedMcpPatterns');

  // 校验 API endpoint 的 path 正则
  if (config.allowedApiEndpoints) {
    for (let i = 0; i < config.allowedApiEndpoints.length; i++) {
      const rule = config.allowedApiEndpoints[i];
      if (rule && !validateRegex(rule.path)) {
        errors.push(`allowedApiEndpoints[${i}].path: Invalid regex pattern: ${rule.path}`);
      }
    }
  }

  // 校验 blocked command hint 的条件正则
  if (config.blockedCommandHints) {
    for (let i = 0; i < config.blockedCommandHints.length; i++) {
      const hint = config.blockedCommandHints[i];
      if (hint?.whenNotMatching && !validateRegex(hint.whenNotMatching)) {
        errors.push(`blockedCommandHints[${i}].whenNotMatching: Invalid regex pattern: ${hint.whenNotMatching}`);
      }
    }
  }

  return errors;
}

// ============================================================
// 存储相关函数（路径、读、写）
// ============================================================

/** 获取 workspace 级 permissions.json 的路径。 */
export function getWorkspacePermissionsPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'permissions.json');
}

/** 获取某个 source 的 permissions.json 路径。 */
export function getSourcePermissionsPath(workspaceRootPath: string, sourceSlug: string): string {
  return join(getSourcePath(workspaceRootPath, sourceSlug), 'permissions.json');
}

/**
 * 加载 workspace 级权限配置；文件不存在或解析失败返回 null。
 */
export function loadWorkspacePermissionsConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
  const path = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded workspace config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading workspace config:`, error);
    return null;
  }
}

/**
 * 加载 source 级权限配置；文件不存在或解析失败返回 null。
 */
export function loadSourcePermissionsConfig(
  workspaceRootPath: string,
  sourceSlug: string
): PermissionsCustomConfig | null {
  const path = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    const config = parsePermissionsJson(content);
    debug(`[Permissions] Loaded source config from ${path}:`, config);
    return config;
  } catch (error) {
    debug(`[Permissions] Error loading source config:`, error);
    return null;
  }
}

// ============================================================
// 原始读写（供 CLI 的 CRUD 用 —— 保留 schema 层的结构，不做归一化）
// ============================================================

/**
 * 从 workspace permissions.json 读出"原始" PermissionsConfigFile。
 * 返回 Zod 解析后的 schema 对象（不是归一化后的运行时配置）。
 * 文件不存在返回 null。
 */
export function loadRawWorkspacePermissions(workspaceRootPath: string): PermissionsConfigFile | null {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * 从某个 source 的 permissions.json 读出"原始" PermissionsConfigFile。
 * 文件不存在返回 null。
 */
export function loadRawSourcePermissions(workspaceRootPath: string, sourceSlug: string): PermissionsConfigFile | null {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const json = safeJsonParse(content);
  const result = PermissionsConfigSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * 把 PermissionsConfigFile 写入 workspace 的 permissions.json。
 * 写入后使该 workspace 的缓存失效。
 */
export function saveWorkspacePermissions(workspaceRootPath: string, config: PermissionsConfigFile): void {
  const filePath = getWorkspacePermissionsPath(workspaceRootPath);
  mkdirSync(workspaceRootPath, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
}

/**
 * 把 PermissionsConfigFile 写入某个 source 的 permissions.json。
 * 写入后使该 source 的缓存失效。
 */
export function saveSourcePermissions(workspaceRootPath: string, sourceSlug: string, config: PermissionsConfigFile): void {
  const filePath = getSourcePermissionsPath(workspaceRootPath, sourceSlug);
  const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  permissionsConfigCache.invalidateSource(workspaceRootPath, sourceSlug);
}

// ============================================================
// API Endpoint 权限检查
// ============================================================

/**
 * 判断一次 API 调用是否被 endpoint 规则允许。
 * 规则：GET 永远允许；其它方法必须命中一条 method + path 正则匹配的规则。
 */
export function isApiEndpointAllowed(
  method: string,
  path: string,
  config: MergedPermissionsConfig
): boolean {
  const upperMethod = method.toUpperCase();

  // GET 一律放行（只读）
  if (upperMethod === 'GET') return true;

  // 命中任意一条细粒度规则即放行
  for (const rule of config.allowedApiEndpoints) {
    if (rule.method === upperMethod && rule.pathPattern.test(path)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// 配置缓存（In-memory cache）
// ============================================================

/**
 * 已解析的权限配置的内存缓存。
 * 当文件变化时由 ConfigWatcher 主动失效（invalidate）。
 *
 * 类比 Golang：相当于带失效机制的 map cache；用模块级单例维护。
 */
class PermissionsConfigCache {
  // workspaceRootPath → 该 workspace 的用户配置（null 表示明确没有配置文件）
  private workspaceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  // "workspaceRootPath::sourceSlug" → 该 source 的用户配置
  private sourceConfigs: Map<string, PermissionsCustomConfig | null> = new Map();
  // "workspaceRootPath::src1,src2" → 合并后的运行时配置
  private mergedConfigs: Map<string, MergedPermissionsConfig> = new Map();

  // 应用级默认权限（来自 ~/.craft-agent/permissions/default.json）
  // undefined 表示尚未加载过；null 表示加载过但没有
  private defaultConfig: PermissionsCustomConfig | null | undefined = undefined;

  /**
   * 获取（必要时加载）应用级默认权限。
   * 数据来自 ~/.craft-agent/permissions/default.json
   */
  private getDefaultConfig(): PermissionsCustomConfig | null {
    if (this.defaultConfig === undefined) {
      this.defaultConfig = loadDefaultPermissions();
    }
    return this.defaultConfig;
  }

  /**
   * 获取（必要时加载）workspace 级配置。
   */
  getWorkspaceConfig(workspaceRootPath: string): PermissionsCustomConfig | null {
    if (!this.workspaceConfigs.has(workspaceRootPath)) {
      this.workspaceConfigs.set(workspaceRootPath, loadWorkspacePermissionsConfig(workspaceRootPath));
    }
    return this.workspaceConfigs.get(workspaceRootPath) ?? null;
  }

  /**
   * 获取（必要时加载）source 级配置。
   */
  getSourceConfig(workspaceRootPath: string, sourceSlug: string): PermissionsCustomConfig | null {
    const key = `${workspaceRootPath}::${sourceSlug}`;
    if (!this.sourceConfigs.has(key)) {
      this.sourceConfigs.set(key, loadSourcePermissionsConfig(workspaceRootPath, sourceSlug));
    }
    return this.sourceConfigs.get(key) ?? null;
  }

  /**
   * 失效应用级默认权限（ConfigWatcher 调用）。
   * 由于默认配置会影响所有合并结果，因此同时清空所有 merged 缓存。
   */
  invalidateDefaults(): void {
    debug('[Permissions] Invalidating app-level default permissions');
    this.defaultConfig = undefined;
    // 默认会影响所有 merged 结果，全部清掉
    this.mergedConfigs.clear();
  }

  /**
   * 失效某个 workspace 的配置（ConfigWatcher 调用）。
   */
  invalidateWorkspace(workspaceRootPath: string): void {
    debug(`[Permissions] Invalidating workspace config: ${workspaceRootPath}`);
    this.workspaceConfigs.delete(workspaceRootPath);
    // 同时清掉该 workspace 下所有 merged 缓存
    for (const key of this.mergedConfigs.keys()) {
      if (key.startsWith(`${workspaceRootPath}::`)) {
        this.mergedConfigs.delete(key);
      }
    }
  }

  /**
   * 失效某个 source 的配置（ConfigWatcher 调用）。
   */
  invalidateSource(workspaceRootPath: string, sourceSlug: string): void {
    debug(`[Permissions] Invalidating source config: ${workspaceRootPath}/${sourceSlug}`);
    this.sourceConfigs.delete(`${workspaceRootPath}::${sourceSlug}`);
    // 清掉包含该 source 的 merged 缓存。
    // merged 缓存键格式："{workspaceRootPath}::{source1},{source2},..."
    // 必须用精确匹配，避免误伤：例如 "linear" 不要匹配到 "linear-triage"。
    for (const key of this.mergedConfigs.keys()) {
      if (!key.startsWith(`${workspaceRootPath}::`)) continue;

      // 取出 :: 之后的 sources 部分
      const sourcesStr = key.slice(workspaceRootPath.length + 2);
      if (!sourcesStr) continue;

      // 用逗号切分后精确匹配（开始、结束、或被逗号包围都算）
      const sources = sourcesStr.split(',');
      if (sources.includes(sourceSlug)) {
        this.mergedConfigs.delete(key);
      }
    }
  }


  /**
   * 获取某个上下文对应的合并配置（workspace + 当前激活 sources）。
   * 合并是叠加式：用户自定义在默认之上做加法。
   */
  getMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const cacheKey = this.buildCacheKey(context);

    if (!this.mergedConfigs.has(cacheKey)) {
      const merged = this.buildMergedConfig(context);
      this.mergedConfigs.set(cacheKey, merged);
    }

    // 此处用 ! 断言：刚 set 过，一定存在
    return this.mergedConfigs.get(cacheKey)!;
  }

  /**
   * 实际构建合并配置：默认 → workspace 自定义 → 各 source 自定义。
   */
  private buildMergedConfig(context: PermissionsContext): MergedPermissionsConfig {
    const defaults = SAFE_MODE_CONFIG;

    // 起点为硬编码的兜底默认（blockedTools 固定、display 相关设置）
    // blockedTools（Write/Edit/MultiEdit/NotebookEdit）来自 SAFE_MODE_CONFIG，
    // 不能通过 permissions.json 修改
    const merged: MergedPermissionsConfig = {
      blockedTools: new Set(defaults.blockedTools),
      readOnlyBashPatterns: [...defaults.readOnlyBashPatterns],
      blockedCommandHints: [...(defaults.blockedCommandHints ?? [])],
      readOnlyMcpPatterns: [...defaults.readOnlyMcpPatterns],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      displayName: defaults.displayName,
      shortcutHint: defaults.shortcutHint,
      // 写入权限文件的路径，便于错误信息中给用户可执行的指引
      permissionPaths: {
        workspacePath: getWorkspacePermissionsPath(context.workspaceRootPath),
        appDefaultPath: join(getAppPermissionsDir(), 'default.json'),
        docsPath: join(CONFIG_DIR, 'docs', 'permissions.md'),
      },
    };

    // 加载并叠加应用级默认权限（来自 default.json）
    // 真正的 bash / MCP pattern 主要来自这里
    const defaultConfig = this.getDefaultConfig();
    if (defaultConfig) {
      this.applyDefaultConfig(merged, defaultConfig);
    }

    // 叠加 workspace 级自定义
    const wsConfig = this.getWorkspaceConfig(context.workspaceRootPath);
    if (wsConfig) {
      this.applyCustomConfig(merged, wsConfig);
    }

    // 叠加 source 级自定义（叠加式；MCP pattern 会被自动限定到对应 source）
    if (context.activeSourceSlugs) {
      for (const sourceSlug of context.activeSourceSlugs) {
        const srcConfig = this.getSourceConfig(context.workspaceRootPath, sourceSlug);
        if (srcConfig) {
          // applySourceConfig 会把 MCP pattern 自动 scope 到本 source
          this.applySourceConfig(merged, srcConfig, sourceSlug);
        }
      }
    }

    return merged;
  }

  /**
   * 叠加应用级默认配置（来自 default.json）。
   * 这里把 JSON 里的 bash / MCP pattern 加进来。
   * blockedTools 是硬编码在 SAFE_MODE_CONFIG 的，不从 JSON 读取。
   */
  private applyDefaultConfig(merged: MergedPermissionsConfig, config: PermissionsCustomConfig): void {
    // 叠加允许的 bash pattern（编译为带元数据的 CompiledBashPattern，便于错误提示）
    for (const patternEntry of config.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid default bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // 叠加允许的 MCP pattern
    for (const pattern of config.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid default MCP pattern, skipping: ${pattern}`);
      }
    }

    // 叠加允许的 API endpoint
    for (const rule of config.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      }
    }

    // 叠加允许的写入路径
    for (const pattern of config.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // 叠加 blocked command hint（被禁 Bash 命令的上下文化引导）
    for (const hint of config.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * 叠加 workspace / 用户级自定义配置（与 applyDefaultConfig 行为一致，都只是做加法）。
   */
  private applyCustomConfig(merged: MergedPermissionsConfig, custom: PermissionsCustomConfig): void {
    // 叠加允许的 bash pattern（更宽松）
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // 叠加允许的 MCP pattern
    for (const pattern of custom.allowedMcpPatterns) {
      const regex = validateRegex(pattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
      } else {
        debug(`[Permissions] Invalid MCP pattern, skipping: ${pattern}`);
      }
    }

    // 叠加细粒度 API endpoint
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // 叠加允许的写入路径（glob pattern，以字符串形式保存）
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // 叠加 blocked command hint
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * 叠加某个 source 的自定义配置；其中 MCP pattern 会被自动 scope 到本 source。
   *
   * 自动 scope 含义：source 的 permissions.json 里写 "list"，
   * 实际生效的 pattern 会被改写为 "mcp__<sourceSlug>__.*list"，
   * 保证只匹配【本 source】暴露的工具，避免写成简单 pattern 时跨 source 误命中。
   */
  private applySourceConfig(
    merged: MergedPermissionsConfig,
    custom: PermissionsCustomConfig,
    sourceSlug: string
  ): void {
    // 写入路径：正常叠加（属于全局效果，不区分 source）
    for (const pattern of custom.allowedWritePaths) {
      merged.allowedWritePaths.push(pattern);
    }

    // MCP pattern：自动 scope 到本 source
    // 用户写 "list" → 实际变成 "mcp__<sourceSlug>__.*list"
    // 这样确保 pattern 只命中本 source 的工具
    for (const pattern of custom.allowedMcpPatterns) {
      const scopedPattern = `mcp__${sourceSlug}__.*${pattern}`;
      const regex = validateRegex(scopedPattern);
      if (regex) {
        merged.readOnlyMcpPatterns.push(regex);
        debug(`[Permissions] Scoped MCP pattern for ${sourceSlug}: ${pattern} → ${scopedPattern}`);
      } else {
        debug(`[Permissions] Invalid MCP pattern after scoping, skipping: ${scopedPattern}`);
      }
    }

    // bash pattern：正常叠加（不属于 source 特定，bash 是 session 级的）
    for (const patternEntry of custom.allowedBashPatterns) {
      if (!shouldCompileBashPattern(patternEntry.pattern)) {
        debug(`[Permissions] Skipping craft-agent bash pattern (feature disabled): ${patternEntry.pattern}`);
        continue;
      }

      const regex = validateRegex(patternEntry.pattern);
      if (regex) {
        merged.readOnlyBashPatterns.push({
          regex,
          source: patternEntry.pattern,
          comment: patternEntry.comment,
        });
      } else {
        debug(`[Permissions] Invalid bash pattern, skipping: ${patternEntry.pattern}`);
      }
    }

    // API endpoint：正常叠加（API 工具本身已是 source 级，形如 api_<slug>）
    for (const rule of custom.allowedApiEndpoints) {
      const pathRegex = validateRegex(rule.path);
      if (pathRegex) {
        merged.allowedApiEndpoints.push({
          method: rule.method,
          pathPattern: pathRegex,
        });
      } else {
        debug(`[Permissions] Invalid API endpoint path pattern, skipping: ${rule.path}`);
      }
    }

    // blocked command hint：正常叠加（bash 是 session 级概念）
    for (const hint of custom.blockedCommandHints) {
      const compiled = compileBlockedCommandHint(hint);
      if (compiled) {
        merged.blockedCommandHints.push(compiled);
      }
    }
  }

  /**
   * 构建 merged 配置的缓存键：workspace 路径 + 排序后逗号拼接的 source 列表。
   * 排序是为了让不同顺序的同一组 source 命中同一缓存项。
   */
  private buildCacheKey(context: PermissionsContext): string {
    const sources = context.activeSourceSlugs?.sort().join(',') ?? '';
    return `${context.workspaceRootPath}::${sources}`;
  }

  /**
   * 清空全部缓存。
   */
  clear(): void {
    this.defaultConfig = undefined;
    this.workspaceConfigs.clear();
    this.sourceConfigs.clear();
    this.mergedConfigs.clear();
  }
}

// 单例实例（模块级导出，全应用共享）
export const permissionsConfigCache = new PermissionsConfigCache();

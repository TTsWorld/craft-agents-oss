/**
 * Config File Watcher
 *
 * 监听配置文件变更并触发回调。
 * 使用递归目录监听，简单可靠。
 *
 * 监听路径：
 * - ~/.craft-agent/config.json - 主应用配置
 * - ~/.craft-agent/preferences.json - 用户偏好
 * - ~/.craft-agent/theme.json - 应用级主题覆盖
 * - ~/.craft-agent/themes/*.json - 应用级预设主题文件
 * - ~/.craft-agent/workspaces/{slug}/ - workspace 目录（递归）
 *   - sources/{slug}/config.json, guide.md, permissions.json
 *   - skills/{slug}/SKILL.md, icon.*
 *   - sessions/{id}/session.jsonl（仅 header 元数据）
 *   - permissions.json
 */

import { watch, existsSync, readdirSync, statSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { platform } from 'os';
import type { FSWatcher } from 'fs';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { expandPath } from '../utils/paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { perf } from '../utils/perf.ts';
import { loadStoredConfig, type StoredConfig } from './storage.ts';
import {
  validateConfig,
  validatePreferences,
  validateSource,
  type ValidationResult,
} from './validators.ts';
import type { LoadedSource, SourceGuide } from '../sources/types.ts';
import {
  loadSource,
  loadWorkspaceSources,
  loadSourceGuide,
  sourceNeedsIconDownload,
  downloadSourceIcon,
} from '../sources/storage.ts';
import { permissionsConfigCache, getAppPermissionsDir } from '../agent/permissions-config.ts';
import { getWorkspacePath, getWorkspaceSourcesPath, getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import type { LoadedSkill } from '../skills/types.ts';
import { loadSkill, loadAllSkills, invalidateSkillsCache, skillNeedsIconDownload, downloadSkillIcon } from '../skills/storage.ts';
import {
  loadStatusConfig,
  statusNeedsIconDownload,
  downloadStatusIcon,
} from '../statuses/storage.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import type { SessionHeader } from '../sessions/types.ts';
import { AUTOMATIONS_CONFIG_FILE } from '../automations/constants.ts';
import { loadAppTheme, loadPresetThemes, loadPresetTheme, getAppThemesDir } from './storage.ts';
import type { ThemeOverrides, PresetTheme } from './theme.ts';

// ============================================================
// Active Watcher Registry（重复检测）
// ============================================================

/**
 * 按 workspace 目录跟踪活跃的 ConfigWatcher 实例。
 * 用于检测同一目录树上的重复递归监听，
 * 这在 Linux 上可能会卡住 Bun 的事件循环。
 */
const activeWatchers = new Map<string, string>(); // workspaceDir → creator workspaceId

/** 仅用于测试 */
export function _getActiveWatchers(): ReadonlyMap<string, string> {
  return activeWatchers;
}

// ============================================================
// Constants
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// 防抖延迟（毫秒）
const DEBOUNCE_MS = 100;

// Windows 上 fs.watch() 对原子写入触发频繁（unlink + rename = 2+ 事件），
// session 元数据用更长的防抖。
const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

// ============================================================
// Types
// ============================================================

/**
 * 用户偏好结构（与 UserPreferencesSchema 对应）
 */
export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
  };
  notes?: string;
  /** 内部：与 Appearance → Language 同步。由主进程 i18n IPC handler 维护。 */
  uiLanguage?: string;
  updatedAt?: number;
}

/**
 * 配置变更回调集合（类似 Go 的接口/回调表）。
 */
export interface ConfigWatcherCallbacks {
  /** config.json 变更时调用 */
  onConfigChange?: (config: StoredConfig) => void;
  /** preferences.json 变更时调用 */
  onPreferencesChange?: (prefs: UserPreferences) => void;
  /** LLM connections 数组变更时调用（增删改连接） */
  onLlmConnectionsChange?: (connections: import('./storage.ts').LlmConnection[]) => void;

  // Source 回调
  /** 某个 source config 变更时调用（删除则为 null） */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;
  /** source 的 guide.md 变更时调用 */
  onSourceGuideChange?: (slug: string, guide: SourceGuide) => void;
  /** sources 列表变更时调用（增删文件夹） */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  // Skill 回调
  /** 某个 skill 变更时调用（删除则为 null） */
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
  /** skills 列表变更时调用（增删文件夹） */
  onSkillsListChange?: (skills: LoadedSkill[]) => void;

  // Permissions 回调
  /** 应用级默认权限变更时调用（~/.craft-agent/permissions/default.json） */
  onDefaultPermissionsChange?: () => void;
  /** workspace permissions.json 变更时调用 */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;
  /** source permissions.json 变更时调用 */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  // Status 回调
  /** statuses config.json 变更时调用 */
  onStatusConfigChange?: (workspaceId: string) => void;
  /** status 图标文件变更时调用 */
  onStatusIconChange?: (workspaceId: string, iconFilename: string) => void;

  // Label 回调
  /** labels config.json 变更时调用 */
  onLabelConfigChange?: (workspaceId: string) => void;

  // Automations 回调
  /** automations.json 变更时调用 */
  onAutomationsConfigChange?: (workspaceId: string) => void;

  // Session 回调
  /** session JSONL header 被外部修改时调用（标签、名称、flags 等） */
  onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;

  // Theme 回调（仅应用级）
  /** 应用级 theme.json 变更时调用 */
  onAppThemeChange?: (theme: ThemeOverrides | null) => void;
  /** 某个预设主题文件变更时调用（删除则为 null） */
  onPresetThemeChange?: (themeId: string, theme: PresetTheme | null) => void;
  /** 预设主题列表变更时调用（增删文件） */
  onPresetThemesListChange?: (themes: PresetTheme[]) => void;

  // Error 回调
  /** 验证错误时调用 */
  onValidationError?: (file: string, result: ValidationResult) => void;
  /** 读/解析文件出错时调用 */
  onError?: (file: string, error: Error) => void;
}

// ============================================================
// Preferences Loading
// ============================================================

/**
 * 从文件加载偏好设置。
 */
export function loadPreferences(): UserPreferences | null {
  if (!existsSync(PREFERENCES_FILE)) {
    return null;
  }

  try {
    return readJsonFileSync<UserPreferences>(PREFERENCES_FILE);
  } catch (error) {
    debug('[ConfigWatcher] Error loading preferences', error);
    return null;
  }
}

// ============================================================
// ConfigWatcher Class
// ============================================================

/**
 * 监听配置文件变更并触发回调。
 * 对 workspace 文件使用递归目录监听。
 */
export class ConfigWatcher {
  private workspaceId: string;
  private callbacks: ConfigWatcherCallbacks;
  private watchers: FSWatcher[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  // 用于检测新增/删除的已知项
  private knownSources: Set<string> = new Set();
  private knownSkills: Set<string> = new Set();
  private knownThemes: Set<string> = new Set();

  // 用 JSON 字符串跟踪 LLM connections 变化（深比较）
  private lastLlmConnectionsHash: string = '';

  // 计算出的路径
  private workspaceDir: string;
  private sourcesDir: string;
  private skillsDir: string;

  constructor(workspaceIdOrPath: string, callbacks: ConfigWatcherCallbacks) {
    this.callbacks = callbacks;
    // 同时支持 workspace ID 和 workspace 根路径。
    // 路径包含 '/' 或 '\\'（Windows），ID 不包含。
    const isPath = workspaceIdOrPath.includes('/') || workspaceIdOrPath.includes('\\');
    if (isPath) {
      this.workspaceDir = expandPath(workspaceIdOrPath);
      // 从路径中提取 workspace ID（最后一段）
      this.workspaceId = workspaceIdOrPath.split(/[/\\]/).pop() || workspaceIdOrPath;
    } else {
      this.workspaceId = workspaceIdOrPath;
      this.workspaceDir = getWorkspacePath(workspaceIdOrPath);
    }
    this.sourcesDir = getWorkspaceSourcesPath(this.workspaceDir);
    this.skillsDir = getWorkspaceSkillsPath(this.workspaceDir);
  }

  /**
   * 获取该 watcher 绑定的 workspace slug。
   */
  getWorkspaceSlug(): string {
    return this.workspaceId;
  }

  /**
   * 开始监听配置文件。
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    const span = perf.span('configWatcher.start', { workspaceId: this.workspaceId });

    this.isRunning = true;

    // 检测同一目录树上的重复递归监听
    const existingOwner = activeWatchers.get(this.workspaceDir);
    if (existingOwner) {
      debug(`[ConfigWatcher] WARNING: duplicate watcher for ${this.workspaceDir} (already owned by: ${existingOwner}, new: ${this.workspaceId})`);
    }
    activeWatchers.set(this.workspaceDir, this.workspaceId);

    debug('[ConfigWatcher] Starting for workspace:', this.workspaceId);

    // 确保 workspace 目录存在
    if (!existsSync(this.workspaceDir)) {
      mkdirSync(this.workspaceDir, { recursive: true });
    }
    span.mark('ensureDir');

    // 监听全局配置文件
    this.watchGlobalConfigs();
    span.mark('watchGlobalConfigs');

    // 递归监听 workspace 目录
    this.watchWorkspaceDir();
    span.mark('watchWorkspaceDir');

    // 监听应用级主题目录
    this.watchAppThemesDir();
    span.mark('watchAppThemesDir');

    // 监听应用级权限目录
    this.watchAppPermissionsDir();
    span.mark('watchAppPermissionsDir');

    // 初始扫描，填充 known sources、skills、themes
    this.scanSources();
    span.mark('scanSources');

    this.scanSkills();
    span.mark('scanSkills');

    this.scanAppThemes();
    span.mark('scanAppThemes');

    // 初始化 LLM connections hash，用于后续变化检测
    this.initLlmConnectionsHash();
    span.mark('initLlmConnectionsHash');

    debug('[ConfigWatcher] Started watching files');
    span.end();
  }

  /**
   * 初始化 LLM connections hash，用于变化检测。
   */
  private initLlmConnectionsHash(): void {
    const config = loadStoredConfig();
    if (config) {
      const connections = config.llmConnections || [];
      this.lastLlmConnectionsHash = JSON.stringify(connections);
    }
  }

  /**
   * 手动通知 watcher 文件发生变化。
   *  workaround：Bun 的 fs.watch({ recursive: true }) 在 Linux 上不会追踪
   * watcher 启动后创建的目录中的文件。
   * 参见：https://github.com/oven-sh/bun/issues/15939
   * 参见：https://github.com/oven-sh/bun/issues/15085
   * 这些问题修复后，可以移除此方法及其调用点。
   */
  notifyFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    this.handleWorkspaceFileChange(relativePath, 'change');
  }

  /**
   * 停止监听所有文件。
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    activeWatchers.delete(this.workspaceDir);

    // 清除所有防抖定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 关闭所有 watcher
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    this.knownSources.clear();
    this.knownSkills.clear();
    this.knownThemes.clear();

    debug('[ConfigWatcher] Stopped');
  }

  /**
   * 监听全局配置文件（config.json、preferences.json）。
   */
  private watchGlobalConfigs(): void {
    // 确保 config 目录存在
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    try {
      // 监听 config 目录，捕获 config.json、preferences.json、theme.json 的变化
      const watcher = watch(CONFIG_DIR, (eventType, filename) => {
        if (!filename) return;

        if (filename === 'config.json') {
          this.debounce('config.json', () => this.handleConfigChange());
        } else if (filename === 'preferences.json') {
          this.debounce('preferences.json', () => this.handlePreferencesChange());
        } else if (filename === 'theme.json') {
          this.debounce('app-theme', () => this.handleAppThemeChange());
        }
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching global configs:', CONFIG_DIR);
    } catch (error) {
      debug('[ConfigWatcher] Error watching global configs:', error);
    }
  }

  /**
   * 递归监听 workspace 目录。
   */
  private watchWorkspaceDir(): void {
    debug('[ConfigWatcher] Setting up workspace watcher for:', this.workspaceDir);
    try {
      const watcher = watch(this.workspaceDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // 统一路径分隔符
        const normalizedPath = filename.replace(/\\/g, '/');
        this.handleWorkspaceFileChange(normalizedPath, eventType);
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching workspace recursively:', this.workspaceDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching workspace directory:', error);
    }
  }

  /**
   * 处理 workspace 目录内的文件变化。
   */
  private handleWorkspaceFileChange(relativePath: string, eventType: string): void {
    const parts = relativePath.split('/');

    // workspace 级 permissions.json
    if (relativePath === 'permissions.json') {
      this.debounce('workspace-permissions', () => this.handleWorkspacePermissionsChange());
      return;
    }

    // workspace 级 automations 配置文件
    if (relativePath === AUTOMATIONS_CONFIG_FILE) {
      debug('[ConfigWatcher] automations config change detected:', relativePath);
      this.debounce('automations-config', () => this.handleAutomationsConfigChange());
      return;
    }

    // Sources 变更：sources/{slug}/...
    if (parts[0] === 'sources' && parts.length >= 2) {
      const slug = parts[1]!;  // 已确认 parts.length >= 2
      const file = parts[2];

      // 目录级变更（新增/删除 source 文件夹）
      if (parts.length === 2) {
        this.debounce('sources-dir', () => this.handleSourcesDirChange());
        return;
      }

      // 文件级变更
      if (file === 'config.json') {
        this.debounce(`source-config:${slug}`, () => this.handleSourceConfigChange(slug));
      } else if (file === 'guide.md') {
        this.debounce(`source-guide:${slug}`, () => this.handleSourceGuideChange(slug));
      } else if (file === 'permissions.json') {
        this.debounce(`source-permissions:${slug}`, () => this.handleSourcePermissionsChange(slug));
      }
      return;
    }

    // Skills 变更：skills/{slug}/...
    if (parts[0] === 'skills' && parts.length >= 2) {
      const slug = parts[1]!;  // 已确认 parts.length >= 2
      const file = parts[2];

      // 目录级变更（新增/删除 skill 文件夹）
      if (parts.length === 2) {
        this.debounce('skills-dir', () => this.handleSkillsDirChange());
        return;
      }

      // 文件级变更
      if (file === 'SKILL.md') {
        this.debounce(`skill:${slug}`, () => this.handleSkillChange(slug));
      } else if (file && /^icon\.(svg|png|jpg|jpeg)$/i.test(file)) {
        // 图标文件变化也触发 skill 变更（更新 iconPath）
        this.debounce(`skill-icon:${slug}`, () => this.handleSkillChange(slug));
      }
      return;
    }

    // Session 元数据变更：sessions/{id}/session.jsonl
    // 检测外部修改（其他实例、脚本、手动编辑）。
    // 只读第 1 行（header）—— 即使正在流式输出也很轻量。
    if (parts[0] === 'sessions' && parts.length >= 3) {
      const sessionId = parts[1]!;
      const file = parts[2];

      // 只监听真正的 session 文件，忽略 .tmp（原子写入中间文件）
      if (file === 'session.jsonl') {
        this.debounce(`session-meta:${sessionId}`, () => this.handleSessionMetadataChange(sessionId), SESSION_META_DEBOUNCE_MS);
      }
      return;
    }

    // Statuses 变更：statuses/...
    if (parts[0] === 'statuses' && parts.length >= 2) {
      const file = parts[1];

      // config.json 变更
      if (file === 'config.json') {
        this.debounce('statuses-config', () => this.handleStatusConfigChange());
        return;
      }

      // 图标文件变更：statuses/icons/*.svg, *.png 等
      if (file === 'icons' && parts.length >= 3) {
        const iconFilename = parts[2];
        if (iconFilename) {
          this.debounce(`statuses-icon:${iconFilename}`, () => {
            this.handleStatusIconChange(iconFilename);
          });
        }
        return;
      }
    }

    // Labels 变更：labels/...
    if (parts[0] === 'labels' && parts.length >= 2) {
      const file = parts[1];

      // config.json 变更
      if (file === 'config.json') {
        this.debounce('labels-config', () => this.handleLabelConfigChange());
        return;
      }

    }
  }

  /**
   * 按 key 防抖执行 handler。
   */
  private debounce(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      handler();
    }, delayMs);

    this.debounceTimers.set(key, timer);
  }

  // ============================================================
  // Sources Handlers
  // ============================================================

  /**
   * 扫描 sources 目录，填充 known sources。
   */
  private scanSources(): void {
    if (!existsSync(this.sourcesDir)) {
      mkdirSync(this.sourcesDir, { recursive: true });
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          this.knownSources.add(entry);
        }
      }

      debug('[ConfigWatcher] Known sources:', Array.from(this.knownSources));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning sources:', error);
    }
  }

  /**
   * 处理 sources 目录变更（增删文件夹）。
   */
  private handleSourcesDirChange(): void {
    debug('[ConfigWatcher] Sources directory changed');

    if (!existsSync(this.sourcesDir)) {
      // 目录被删除
      const removed = Array.from(this.knownSources);
      this.knownSources.clear();

      for (const slug of removed) {
        this.callbacks.onSourceChange?.(slug, null);
      }

      this.callbacks.onSourcesListChange?.([]);
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);
      const currentFolders = new Set<string>();

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          currentFolders.add(entry);
        }
      }

      // 新增文件夹
      for (const folder of currentFolders) {
        if (!this.knownSources.has(folder)) {
          debug('[ConfigWatcher] New source folder:', folder);
          this.knownSources.add(folder);

          const source = loadSource(this.workspaceDir, folder);
          if (source) {
            this.callbacks.onSourceChange?.(folder, source);
          }
        }
      }

      // 删除文件夹
      for (const folder of this.knownSources) {
        if (!currentFolders.has(folder)) {
          debug('[ConfigWatcher] Removed source folder:', folder);
          this.knownSources.delete(folder);
          this.callbacks.onSourceChange?.(folder, null);
        }
      }

      // 通知列表变化
      const allSources = loadWorkspaceSources(this.workspaceDir);
      this.callbacks.onSourcesListChange?.(allSources);
    } catch (error) {
      debug('[ConfigWatcher] Error handling sources dir change:', error);
      this.callbacks.onError?.('sources/', error as Error);
    }
  }

  /**
   * 处理 source config.json 变更。
   * 如果配置指定了 URL 图标且本地没有，则下载图标。
   */
  private handleSourceConfigChange(slug: string): void {
    debug('[ConfigWatcher] Source config changed:', slug);

    const validation = validateSource(this.workspaceDir, slug);
    if (!validation.valid) {
      debug('[ConfigWatcher] Source validation failed:', slug, validation.errors);
      this.callbacks.onValidationError?.(`sources/${slug}/config.json`, validation);
      return;
    }

    const source = loadSource(this.workspaceDir, slug);

    // 如果需要下载图标（配置里有 URL 但本地没有）
    if (source && sourceNeedsIconDownload(this.workspaceDir, slug, source.config)) {
      debug('[ConfigWatcher] Downloading source icon:', slug);
      downloadSourceIcon(this.workspaceDir, slug, source.config.icon!)
        .then((iconPath) => {
          if (iconPath) {
            debug('[ConfigWatcher] Source icon downloaded:', slug, iconPath);
            // 下载完成后重新触发 source 变更，带上更新后的 icon path
            const updatedSource = loadSource(this.workspaceDir, slug);
            this.callbacks.onSourceChange?.(slug, updatedSource);
          }
        })
        .catch((err) => {
          debug('[ConfigWatcher] Source icon download failed:', slug, err);
        });
    }

    this.callbacks.onSourceChange?.(slug, source);
  }

  /**
   * 处理 source guide.md 变更。
   */
  private handleSourceGuideChange(slug: string): void {
    debug('[ConfigWatcher] Source guide changed:', slug);

    const guide = loadSourceGuide(this.workspaceDir, slug);
    if (guide) {
      this.callbacks.onSourceGuideChange?.(slug, guide);
    }

    // 同时触发完整 source 变更
    const source = loadSource(this.workspaceDir, slug);
    if (source) {
      this.callbacks.onSourceChange?.(slug, source);
    }
  }

  /**
   * 处理 source permissions.json 变更。
   */
  private handleSourcePermissionsChange(slug: string): void {
    debug('[ConfigWatcher] Source permissions.json changed:', slug);

    // 使缓存失效
    permissionsConfigCache.invalidateSource(this.workspaceDir, slug);

    // 通知回调
    this.callbacks.onSourcePermissionsChange?.(slug);
  }

  // ============================================================
  // Skills Handlers
  // ============================================================

  /**
   * 扫描 skills 目录，填充 known skills。
   */
  private scanSkills(): void {
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
      return;
    }

    try {
      const entries = readdirSync(this.skillsDir);

      for (const entry of entries) {
        const entryPath = join(this.skillsDir, entry);
        if (statSync(entryPath).isDirectory()) {
          this.knownSkills.add(entry);
        }
      }

      debug('[ConfigWatcher] Known skills:', Array.from(this.knownSkills));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning skills:', error);
    }
  }

  /**
   * 处理 skills 目录变更（增删文件夹）。
   */
  private handleSkillsDirChange(): void {
    debug('[ConfigWatcher] Skills directory changed');

    if (!existsSync(this.skillsDir)) {
      // 目录被删除
      const removed = Array.from(this.knownSkills);
      this.knownSkills.clear();

      for (const slug of removed) {
        this.callbacks.onSkillChange?.(slug, null);
      }

      this.callbacks.onSkillsListChange?.([]);
      return;
    }

    try {
      const entries = readdirSync(this.skillsDir);
      const currentFolders = new Set<string>();

      for (const entry of entries) {
        const entryPath = join(this.skillsDir, entry);
        if (statSync(entryPath).isDirectory()) {
          currentFolders.add(entry);
        }
      }

      // 新增文件夹
      for (const folder of currentFolders) {
        if (!this.knownSkills.has(folder)) {
          debug('[ConfigWatcher] New skill folder:', folder);
          this.knownSkills.add(folder);

          const skill = loadSkill(this.workspaceDir, folder);
          if (skill) {
            this.callbacks.onSkillChange?.(folder, skill);
          }
        }
      }

      // 删除文件夹
      for (const folder of this.knownSkills) {
        if (!currentFolders.has(folder)) {
          debug('[ConfigWatcher] Removed skill folder:', folder);
          this.knownSkills.delete(folder);
          this.callbacks.onSkillChange?.(folder, null);
        }
      }

      // 重新加载前使缓存失效，确保拿到最新结果
      invalidateSkillsCache();
      const allSkills = loadAllSkills(this.workspaceDir);
      this.callbacks.onSkillsListChange?.(allSkills);
    } catch (error) {
      debug('[ConfigWatcher] Error handling skills dir change:', error);
      this.callbacks.onError?.('skills/', error as Error);
    }
  }

  /**
   * 处理 skill SKILL.md 或图标变更。
   * 如果 skill 元数据有图标 URL 但本地没有图标文件，
   * 则下载图标并在完成后再次触发变更事件。
   */
  private handleSkillChange(slug: string): void {
    debug('[ConfigWatcher] Skill changed:', slug);

    const skill = loadSkill(this.workspaceDir, slug);
    this.callbacks.onSkillChange?.(slug, skill);

    // 检查是否需要从 URL 下载图标
    // 这种情况发生在 SKILL.md 里有 icon: "https://..." 但本地没有 icon.* 文件时
    if (skill && skillNeedsIconDownload(skill)) {
      debug('[ConfigWatcher] Skill needs icon download:', slug, skill.metadata.icon);

      // 异步下载，不阻塞 watcher
      downloadSkillIcon(skill.path, skill.metadata.icon!)
        .then((iconPath) => {
          if (iconPath) {
            // 下载完成后重新加载 skill 并再次触发变更
            const updatedSkill = loadSkill(this.workspaceDir, slug);
            debug('[ConfigWatcher] Icon downloaded, emitting updated skill:', slug);
            this.callbacks.onSkillChange?.(slug, updatedSkill);
          }
        })
        .catch((error) => {
          debug('[ConfigWatcher] Icon download failed for skill:', slug, error);
        });
    }
  }

  // ============================================================
  // Safe Mode & Config Handlers
  // ============================================================

  /**
   * 处理 workspace permissions.json 变更。
   */
  private handleWorkspacePermissionsChange(): void {
    debug('[ConfigWatcher] Workspace permissions.json changed:', this.workspaceId);

    // 使缓存失效
    permissionsConfigCache.invalidateWorkspace(this.workspaceDir);

    // 通知回调
    this.callbacks.onWorkspacePermissionsChange?.(this.workspaceId);
  }

  /**
   * 处理 config.json 变更。
   */
  private handleConfigChange(): void {
    debug('[ConfigWatcher] config.json changed');

    const validation = validateConfig();
    if (!validation.valid) {
      debug('[ConfigWatcher] Config validation failed:', validation.errors);
      this.callbacks.onValidationError?.('config.json', validation);
      return;
    }

    const config = loadStoredConfig();
    if (config) {
      this.callbacks.onConfigChange?.(config);

      // 检测 LLM connections 变化
      // 用 JSON hash 做深比较
      const connections = config.llmConnections || [];
      const currentHash = JSON.stringify(connections);
      if (currentHash !== this.lastLlmConnectionsHash) {
        debug('[ConfigWatcher] LLM connections changed');
        this.lastLlmConnectionsHash = currentHash;
        this.callbacks.onLlmConnectionsChange?.(connections);
      }
    } else {
      this.callbacks.onError?.('config.json', new Error('Failed to load config'));
    }
  }

  /**
   * 处理 preferences.json 变更。
   */
  private handlePreferencesChange(): void {
    debug('[ConfigWatcher] preferences.json changed');

    const validation = validatePreferences();
    if (!validation.valid) {
      debug('[ConfigWatcher] Preferences validation failed:', validation.errors);
      this.callbacks.onValidationError?.('preferences.json', validation);
      return;
    }

    const prefs = loadPreferences();
    if (prefs) {
      this.callbacks.onPreferencesChange?.(prefs);
    }
  }

  // ============================================================
  // Statuses Handlers
  // ============================================================

  /**
   * 处理 statuses config.json 变更。
   * 为任何 URL 图标且无本地文件的 status 下载图标。
   */
  private handleStatusConfigChange(): void {
    debug('[ConfigWatcher] Statuses config.json changed:', this.workspaceId);

    // 加载配置并检查需要下载图标的 status
    const config = loadStatusConfig(this.workspaceDir);
    for (const status of config.statuses) {
      if (statusNeedsIconDownload(this.workspaceDir, status)) {
        debug('[ConfigWatcher] Downloading status icon:', status.id);
        downloadStatusIcon(this.workspaceDir, status.id, status.icon!)
          .then((iconPath) => {
            if (iconPath) {
              debug('[ConfigWatcher] Status icon downloaded:', status.id, iconPath);
              // 下载完成后重新触发 config 变更，更新 UI 图标
              this.callbacks.onStatusConfigChange?.(this.workspaceId);
            }
          })
          .catch((err) => {
            debug('[ConfigWatcher] Status icon download failed:', status.id, err);
          });
      }
    }

    this.callbacks.onStatusConfigChange?.(this.workspaceId);
  }

  /**
   * 处理 status 图标文件变更。
   */
  private handleStatusIconChange(iconFilename: string): void {
    debug('[ConfigWatcher] Status icon changed:', this.workspaceId, iconFilename);
    this.callbacks.onStatusIconChange?.(this.workspaceId, iconFilename);
  }

  // ============================================================
  // Labels Handlers
  // ============================================================

  /**
   * 处理 labels config.json 变更。
   */
  private handleLabelConfigChange(): void {
    debug('[ConfigWatcher] Labels config.json changed:', this.workspaceId);
    this.callbacks.onLabelConfigChange?.(this.workspaceId);
  }

  /**
   * 处理 automations config 变更。
   */
  private handleAutomationsConfigChange(): void {
    debug('[ConfigWatcher] automations config changed:', this.workspaceId);
    this.callbacks.onAutomationsConfigChange?.(this.workspaceId);
  }

  // ============================================================
  // Session Metadata Handlers
  // ============================================================

  /**
   * 处理 session.jsonl 变更 —— 只读第 1 行（header），有效时触发。
   * 这样可以检测外部元数据变更（标签、名称、flags），
   * 无论变更是来自其他实例、脚本还是手动编辑。
   */
  private handleSessionMetadataChange(sessionId: string): void {
    const sessionFile = join(this.workspaceDir, 'sessions', sessionId, 'session.jsonl');

    if (!existsSync(sessionFile)) {
      return;
    }

    const header = readSessionHeader(sessionFile);
    if (header) {
      this.callbacks.onSessionMetadataChange?.(sessionId, header);
    }
  }

  // ============================================================
  // Theme Handlers（App-Level）
  // ============================================================

  /**
   * 处理应用级 theme.json 变更。
   */
  private handleAppThemeChange(): void {
    debug('[ConfigWatcher] App theme.json changed');
    const theme = loadAppTheme();
    this.callbacks.onAppThemeChange?.(theme);
  }

  /**
   * 监听应用级主题目录（~/.craft-agent/themes/）。
   */
  private watchAppThemesDir(): void {
    const themesDir = getAppThemesDir();

    // 创建主题目录（如果不存在）
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }

    try {
      const watcher = watch(themesDir, (eventType, filename) => {
        if (!filename) return;

        // 只处理 .json 文件
        if (filename.endsWith('.json')) {
          const themeId = filename.replace('.json', '');
          this.debounce(`preset-theme:${themeId}`, () => this.handlePresetThemeChange(themeId));
        }
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching app themes directory:', themesDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app themes directory:', error);
    }
  }

  /**
   * 监听应用级权限目录（~/.craft-agent/permissions/）。
   * 监听 default.json 的变化，它包含默认只读模式。
   */
  private watchAppPermissionsDir(): void {
    const permissionsDir = getAppPermissionsDir();

    // 创建权限目录（如果不存在）
    if (!existsSync(permissionsDir)) {
      mkdirSync(permissionsDir, { recursive: true });
    }

    try {
      const watcher = watch(permissionsDir, (eventType, filename) => {
        if (!filename) return;

        // 只监听 default.json —— 默认模式所在文件
        if (filename === 'default.json') {
          this.debounce('default-permissions', () => this.handleDefaultPermissionsChange());
        }
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching app permissions directory:', permissionsDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app permissions directory:', error);
    }
  }

  /**
   * 处理应用级 default.json 权限变更。
   */
  private handleDefaultPermissionsChange(): void {
    debug('[ConfigWatcher] Default permissions changed');

    // 使缓存失效，下次 getMergedConfig() 会从文件重新加载
    permissionsConfigCache.invalidateDefaults();

    // 通知回调
    this.callbacks.onDefaultPermissionsChange?.();
  }

  /**
   * 扫描应用级主题目录，填充 known themes。
   */
  private scanAppThemes(): void {
    const themesDir = getAppThemesDir();

    if (!existsSync(themesDir)) {
      return;
    }

    try {
      const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const themeId = file.replace('.json', '');
        this.knownThemes.add(themeId);
      }

      debug('[ConfigWatcher] Known themes:', Array.from(this.knownThemes));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning themes:', error);
    }
  }

  /**
   * 处理应用级预设主题文件变更。
   */
  private handlePresetThemeChange(themeId: string): void {
    debug('[ConfigWatcher] Preset theme changed:', themeId);

    const themesDir = getAppThemesDir();
    const themePath = join(themesDir, `${themeId}.json`);

    if (!existsSync(themePath)) {
      // 主题被删除
      if (this.knownThemes.has(themeId)) {
        this.knownThemes.delete(themeId);
        this.callbacks.onPresetThemeChange?.(themeId, null);

        // 同时通知列表变化
        const allThemes = loadPresetThemes();
        this.callbacks.onPresetThemesListChange?.(allThemes);
      }
      return;
    }

    // 主题被新增或修改
    if (!this.knownThemes.has(themeId)) {
      this.knownThemes.add(themeId);
    }

    const theme = loadPresetTheme(themeId);
    this.callbacks.onPresetThemeChange?.(themeId, theme);

    // 名称变化会影响排序，因此也通知列表变化
    const allThemes = loadPresetThemes();
    this.callbacks.onPresetThemesListChange?.(allThemes);
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * 为指定 workspace 创建并启动配置监听器。
 * 返回 watcher 实例供后续清理。
 */
export function createConfigWatcher(
  workspaceId: string,
  callbacks: ConfigWatcherCallbacks
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceId, callbacks);
  watcher.start();
  return watcher;
}

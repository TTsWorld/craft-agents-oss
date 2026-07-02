import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { getCredentialManager } from '../credentials/index.ts';
import { getOrCreateLatestSession, type SessionConfig } from '../sessions/index.ts';
import {
  discoverWorkspacesInDefaultLocation,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  createWorkspaceAtPath,
  isValidWorkspace,
} from '../workspaces/storage.ts';
import { findIconFile } from '../utils/icon.ts';
import { extractWorkspaceSlugFromPath } from '../utils/workspace-slug.ts';
import { initializeDocs } from '../docs/index.ts';
import { expandPath, toPortablePath, getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { CONFIG_DIR } from './paths.ts';
import type { StoredAttachment, StoredMessage } from '@craft-agent/core/types';
import type { Plan } from '../agent/plan-types.ts';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import { isValidThinkingLevel, normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { type ConfigDefaults } from './config-defaults-schema.ts';
import { isValidThemeFile } from './validators.ts';

// 为方便从 paths.ts 重新导出 CONFIG_DIR
export { CONFIG_DIR } from './paths.ts';

// 从 core 重新导出基础类型，保持单一事实来源
export type {
  WorkspaceInfo,
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

// 本地使用的导入
import type { Workspace, AuthType } from '@craft-agent/core/types';

// LLM 连接类型与常量
import type { LlmConnection } from './llm-connections.ts';
import { isValidProviderAuthCombination, getDefaultModelsForConnection, getDefaultModelForConnection, isPiProvider, toBedrockNativeId, type LlmProviderType } from './llm-connections.ts';
import {
  getModelProvider,
  getModelById,
  getModelDisplayName,
  normalizeDeprecatedModelId,
  type ModelDefinition,
} from './models.ts';

/**
 * 存储在 JSON 文件里的应用配置。
 * 凭据单独存在加密文件里，不在这里。
 */
export interface StoredConfig {
  // LLM 连接（认证与模型配置的权威来源）
  llmConnections?: LlmConnection[];
  defaultLlmConnection?: string;  // 新 session 默认连接的 slug
  defaultThinkingLevel?: ThinkingLevel;  // 新 session 的应用级默认思考级别

  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // 当前激活的 session（主作用域）
  // 通知
  notificationsEnabled?: boolean;  // 任务完成桌面通知（默认 true）
  // 外观
  colorTheme?: string;  // 选中的预设主题 ID（如 'dracula'、'nord'），默认 'default'
  // 自动更新
  dismissedUpdateVersion?: string;  // 用户忽略的版本（该版本跳过更新通知）
  // 输入设置
  autoCapitalisation?: boolean;  // 输入时自动大写首字母（默认 true）
  sendMessageKey?: 'enter' | 'cmd-enter';  // 发送消息快捷键（默认 'enter'）
  spellCheck?: boolean;  // 输入框拼写检查（默认 false）
  // 电源设置
  keepAwakeWhileRunning?: boolean;  // session 运行时阻止屏幕休眠（默认 false）
  // Tool 元数据
  richToolDescriptions?: boolean;  // 为所有 tool 调用附带意图/动作元数据（默认 true）
  // Tools
  browserToolEnabled?: boolean;  // 内置 browser tool（默认 true）。若用 Playwright/Puppeteer 可关闭。
  allowRemoteEvaluate?: boolean;  // 允许远程 Agent 在本地浏览器执行 browser_tool evaluate（默认 true）。
  // Prompt cache 与上下文
  extendedPromptCache?: boolean;  // 使用 1 小时 prompt cache TTL 而非 5 分钟（默认 false）
  enable1MContext?: boolean;  // 为支持的模型启用 1M 上下文（默认 false，需 Anthropic Tier 4+）
  // Token 优化
  rtkEnabled?: boolean;  // Bash 命令经 rtk 压缩输出（默认 false）。https://github.com/rtk-ai/rtk
  // 网络代理
  networkProxy?: import('./types.ts').NetworkProxySettings;
  // Windows：SDK 子进程使用的 Git Bash（bash.exe）路径
  gitBashPath?: string;
  // 用户 onboarding 时选择“稍后设置”——下次启动跳过 onboarding
  setupDeferred?: boolean;
  // 服务端模式：内嵌远程服务器设置
  serverConfig?: import('./server-config.ts').ServerConfig;
  // 一次性迁移标记。用于每个用户最多运行一次的迁移
  //（例如把之前移除的模型恢复到连接列表，但如果用户后来主动删除就不再添加）。
  migrationsApplied?: string[];
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');

// 跟踪本进程是否已同步过 config-defaults（防止热重载时重复同步）
let configDefaultsSynced = false;

/**
 * 从 bundled 资源同步 config-defaults.json。
 * 每次启动都会写入，确保默认值与当前运行版本一致。
 * 与 docs、themes 等其他 bundled 资源采用相同模式。
 *
 * 事实来源：apps/electron/resources/config-defaults.json
 */
/** bundled 资源不可用时（CI、独立 server）使用的最小默认配置。 */
const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Craft Agents',
  defaults: {
    notificationsEnabled: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
    allowRemoteEvaluate: true,
  },
  workspaceDefaults: {
    thinkingLevel: 'medium',
    permissionMode: 'ask',
    cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
    localMcpServers: { enabled: true },
  },
};

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // 从 resources 目录获取 bundled config-defaults.json
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  // 与 docs 采用相同的同步方式
  const content = readFileSync(bundledFile, 'utf-8');
  writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8');
  debug('[config] Synced config-defaults.json from bundled assets');
}

/**
 * 从 ~/.craft-agent/config-defaults.json 加载默认配置。
 * 该文件每次启动时都会从 bundled 资源同步。
 */
export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    throw new Error('config-defaults.json not found at ' + CONFIG_DEFAULTS_FILE + '. Ensure ensureConfigDir() was called at startup.');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'ask';

  const rawCyclable = Array.isArray(defaults.workspaceDefaults?.cyclablePermissionModes)
    ? defaults.workspaceDefaults.cyclablePermissionModes
    : [];

  const normalizedCyclable: PermissionMode[] = [];
  for (const mode of rawCyclable) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed) continue;
    if (!normalizedCyclable.includes(parsed)) {
      normalizedCyclable.push(parsed);
    }
  }

  defaults.workspaceDefaults.cyclablePermissionModes =
    normalizedCyclable.length >= 2 ? normalizedCyclable : [...PERMISSION_MODE_ORDER];

  return defaults;
}

/**
 * 确保 config-defaults.json 存在且为最新。
 * 每次启动从 bundled 资源同步（与 docs、themes、permissions 一致）。
 */
export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

let configDirInitialized = false;

const MAX_CONFIG_BACKUPS = 3;
const CONFIG_BACKUP_DATE_RE = /^config\.json\.bak-\d{4}-\d{2}-\d{2}$/;

/**
 * 把现有 config.json 快照为按日期命名的文件（config.json.bak-YYYY-MM-DD），
 * 只保留最新的 MAX_CONFIG_BACKUPS 份。在启动时、任何路径可能被修改之前运行，
 * 防止失败路径覆盖 workspace registry。
 * 尽力而为：失败仅记录日志并被吞掉，备份不会阻塞启动。
 */
export function backupConfigFile(): void {
  try {
    if (!existsSync(CONFIG_FILE)) return;

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dated = join(CONFIG_DIR, `config.json.bak-${stamp}`);
    // 每天只保留一份，且从不覆盖：当天的第一份快照在任何修改之前，保存了重置前的好状态。
    // 当天再次启动（例如重置已经清空 registry 后）不应覆盖它。
    if (existsSync(dated)) return;
    writeFileSync(dated, readFileSync(CONFIG_FILE, 'utf-8'), 'utf-8');

    // 文件名使用 ISO 日期，字典序即时间序；删除最旧的几份，只保留最新 MAX_CONFIG_BACKUPS 份。
    const backups = readdirSync(CONFIG_DIR).filter(f => CONFIG_BACKUP_DATE_RE.test(f)).sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - MAX_CONFIG_BACKUPS))) {
      try { rmSync(join(CONFIG_DIR, stale)); } catch { /* 忽略单个清理错误 */ }
    }
  } catch (error) {
    debug('[config] backupConfigFile failed:', error instanceof Error ? error.message : error);
  }
}

/** 确保配置目录已初始化：创建目录、备份、初始化 bundled 资源等 */
export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // 在任何路径可能被修改或失败路径覆盖 workspace registry 之前，先快照现有 config.json
  backupConfigFile();
  // 初始化 bundled docs（创建 ~/.craft-agent/docs/，包含 sources.md、agents.md、permissions.md）
  initializeDocs();

  // 初始化默认配置
  ensureConfigDefaults();

  // 初始化 tool icons（turn card 里显示的 CLI tool 图标）
  ensureToolIcons();

  configDirInitialized = true;
}

/** 从磁盘加载已保存的配置；失败或文件不存在时返回 null */
export function loadStoredConfig(): StoredConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const config = readJsonFileSync<StoredConfig>(CONFIG_FILE);

    // 必须有 workspaces 数组
    if (!Array.isArray(config.workspaces)) {
      return null;
    }

    // 展开路径变量（~ 和 ${HOME}），保证跨机器可移植
    for (const workspace of config.workspaces) {
      workspace.rootPath = expandPath(workspace.rootPath);
    }

    // 校验 active workspace 是否存在
    const activeWorkspace = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    if (!activeWorkspace) {
      // 默认回退到第一个 workspace
      config.activeWorkspaceId = config.workspaces[0]?.id || null;
    }

    // 确保所有 workspace 的文件夹结构存在。
    // 这里的失败是非致命的 —— 下次访问时会重新创建。
    for (const workspace of config.workspaces) {
      if (!isValidWorkspace(workspace.rootPath)) {
        try {
          createWorkspaceAtPath(workspace.rootPath, workspace.name);
        } catch (wsError) {
          debug('[config] Failed to create workspace at', workspace.rootPath, ':', wsError instanceof Error ? wsError.message : wsError);
        }
      }
    }

    return config;
  } catch (error) {
    debug('[config] loadStoredConfig failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// 旧版凭据辅助函数已移除，改用基于连接的凭据查找：
// - getAnthropicApiKey() → credentialManager.getLlmApiKey(connectionSlug)
// - getClaudeOAuthToken() → credentialManager.getLlmOAuth(connectionSlug)

/** 保存配置到磁盘，并把路径转换为可移植形式（~ 前缀） */
export function saveConfig(config: StoredConfig): void {
  ensureConfigDir();

  // 把路径转回可移植形式（~ 前缀），方便跨机器使用
  const storageConfig: StoredConfig = {
    ...config,
    workspaces: config.workspaces.map(ws => ({
      ...ws,
      rootPath: toPortablePath(ws.rootPath),
    })),
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(storageConfig, null, 2), 'utf-8');
}

// 旧版 updateApiKey() 已移除，改用 setupLlmConnection IPC handler。

// 旧版 getter/setter 已移除，改用 LLM connections：
// - getAuthType/setAuthType → 从 getDefaultLlmConnection()/getLlmConnection() 推导
// - getAnthropicBaseUrl/setAnthropicBaseUrl → 使用 connection.baseUrl
// - getCustomModel/setCustomModel → 使用 connection.defaultModel


/**
 * 获取是否启用桌面通知。
 * 未设置时默认 true。
 */
export function getNotificationsEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.notificationsEnabled !== undefined) {
    return config.notificationsEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.notificationsEnabled;
}

/**
 * 设置是否启用桌面通知。
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.notificationsEnabled = enabled;
  saveConfig(config);
}

/**
 * 获取是否启用输入自动大写首字母。
 * 未设置时默认 true。
 */
export function getAutoCapitalisation(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCapitalisation !== undefined) {
    return config.autoCapitalisation;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.autoCapitalisation;
}

/**
 * 设置是否启用输入自动大写首字母。
 */
export function setAutoCapitalisation(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.autoCapitalisation = enabled;
  saveConfig(config);
}

/**
 * 获取发送消息的快捷键。
 * 未设置时默认 'enter'。
 */
export function getSendMessageKey(): 'enter' | 'cmd-enter' {
  const config = loadStoredConfig();
  if (config?.sendMessageKey !== undefined) {
    return config.sendMessageKey;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.sendMessageKey;
}

/**
 * 设置发送消息的快捷键。
 */
export function setSendMessageKey(key: 'enter' | 'cmd-enter'): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.sendMessageKey = key;
  saveConfig(config);
}

/**
 * 获取是否启用输入框拼写检查。
 */
export function getSpellCheck(): boolean {
  const config = loadStoredConfig();
  if (config?.spellCheck !== undefined) {
    return config.spellCheck;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.spellCheck;
}

/**
 * 设置是否启用输入框拼写检查。
 */
export function setSpellCheck(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.spellCheck = enabled;
  saveConfig(config);
}

/**
 * 获取 session 运行时是否阻止屏幕休眠。
 * 未设置时默认 false。
 */
export function getKeepAwakeWhileRunning(): boolean {
  const config = loadStoredConfig();
  if (config?.keepAwakeWhileRunning !== undefined) {
    return config.keepAwakeWhileRunning;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.keepAwakeWhileRunning;
}

/**
 * 设置 session 运行时是否阻止屏幕休眠。
 */
export function setKeepAwakeWhileRunning(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.keepAwakeWhileRunning = enabled;
  saveConfig(config);
}

/**
 * 获取是否启用 rich tool descriptions。
 * 启用后所有 tool 调用会附带意图与显示名元数据。
 * 未设置时默认 true。
 */
export function getRichToolDescriptions(): boolean {
  const config = loadStoredConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions;
  }
  return true;
}

/**
 * 设置是否启用 rich tool descriptions。
 */
export function setRichToolDescriptions(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.richToolDescriptions = enabled;
  saveConfig(config);
}

/**
 * 获取是否启用 extended prompt cache（1 小时 TTL）。
 * 启用后 interceptor 会把 cache_control TTL 从 5 分钟提升到 1 小时。
 * 未设置时默认 false。
 */
export function getExtendedPromptCache(): boolean {
  const config = loadStoredConfig();
  return config?.extendedPromptCache ?? false;
}

/**
 * 设置是否启用 extended prompt cache（1 小时 TTL）。
 */
export function setExtendedPromptCache(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.extendedPromptCache = enabled;
  saveConfig(config);
}

/**
 * 获取是否启用内置 browser tool。
 * 禁用时 session tools 里不会包含 browser_tool。
 * 未设置时默认 true。
 */
export function getBrowserToolEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.browserToolEnabled !== undefined) {
    return config.browserToolEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.browserToolEnabled;
}

/**
 * 设置是否启用内置 browser tool。
 */
export function setBrowserToolEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.browserToolEnabled = enabled;
  saveConfig(config);

  // 清空 session tool 缓存，让所有 session 立即感知变化。
  // 延迟导入避免循环依赖（storage ← session-scoped-tools ← storage）。
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
}

/**
 * 远程 Agent 是否可以在该桌面客户端的本地浏览器执行 `browser_tool evaluate <expression>`。
 * 校验在本地 capability dispatcher 内部执行，远程服务器无法覆盖。
 *
 * 默认 true。如果用户不信任所连接的远程 workspace，可以在 Settings → AI → Advanced 关闭。
 */
export function getAllowRemoteEvaluate(): boolean {
  const config = loadStoredConfig();
  if (config?.allowRemoteEvaluate !== undefined) {
    return config.allowRemoteEvaluate;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.allowRemoteEvaluate;
}

export function setAllowRemoteEvaluate(allowed: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.allowRemoteEvaluate = allowed;
  saveConfig(config);
}

/**
 * 获取是否启用 1M 上下文窗口。
 * 禁用时模型使用 200K 上下文，interceptor 会去掉 context-1m beta header。
 * 默认 false —— 1M beta 需要 Anthropic Tier 4+，默认开启会在低 tier API key 的大上下文场景下触发 400 "Invalid Request"（#567）。
 * 用户在 AI Settings → Performance → Extended Context (1M) 手动开启。
 */
export function getEnable1MContext(): boolean {
  const config = loadStoredConfig();
  return config?.enable1MContext === true;
}

/**
 * 设置是否启用 1M 上下文窗口。
 */
export function setEnable1MContext(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.enable1MContext = enabled;
  saveConfig(config);
}

/**
 * 获取是否启用 rtk Bash 输出压缩。
 * 启用后 PreToolUse pipeline 会把常见 Bash 命令（git、ls、grep、test runner 等）
 * 改写为等价的 `rtk` 命令以减少 token 消耗。
 * 默认 false，需手动开启；需要 PATH 上有 rtk 二进制或应用内置 rtk。
 * https://github.com/rtk-ai/rtk
 */
export function getRtkEnabled(): boolean {
  const config = loadStoredConfig();
  return config?.rtkEnabled === true;
}

/**
 * 设置是否启用 rtk Bash 输出压缩。
 */
export function setRtkEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.rtkEnabled = enabled;
  saveConfig(config);
}

/**
 * 获取持久化的 Git Bash 路径（仅 Windows）。
 * 用于设置 SDK 子进程环境变量 CLAUDE_CODE_GIT_BASH_PATH。
 */
export function getGitBashPath(): string | undefined {
  const config = loadStoredConfig();
  return config?.gitBashPath;
}

/**
 * 设置 Git Bash 路径（仅 Windows）。
 * 持久化到配置，重启后仍生效。
 * 配置无法加载时返回 false（路径不会被持久化）。
 */
export function setGitBashPath(path: string): boolean {
  const config = loadStoredConfig();
  if (!config) {
    console.warn('[storage] Failed to persist Git Bash path: config could not be loaded');
    return false;
  }
  config.gitBashPath = path;
  saveConfig(config);
  return true;
}

/**
 * 清空持久化的 Git Bash 路径（仅 Windows）。
 * 用于存储路径已过期或无效时。
 */
export function clearGitBashPath(): void {
  const config = loadStoredConfig();
  if (!config || !config.gitBashPath) return;
  delete config.gitBashPath;
  saveConfig(config);
}

// 注意：getDefaultWorkingDirectory/setDefaultWorkingDirectory 已移除
// 工作目录现在按 workspace 存在 workspace config.json 的 defaults.workingDirectory 中
// 注意：getDefaultPermissionMode/getEnabledPermissionModes 已移除
// 权限设置现在按 workspace 存在 workspace config.json 的 defaults.permissionMode、defaults.cyclablePermissionModes 中

/** 获取 config.json 文件路径 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * 清空所有配置与凭据（登出）。
 * 删除 config 文件和 credentials 文件。
 */
export async function clearAllConfig(): Promise<void> {
  // 删除 config 文件
  if (existsSync(CONFIG_FILE)) {
    rmSync(CONFIG_FILE);
  }

  // 删除 credentials 文件
  const credentialsFile = join(CONFIG_DIR, 'credentials.enc');
  if (existsSync(credentialsFile)) {
    rmSync(credentialsFile);
  }

  // 可选：删除 workspace 数据（会话）
  const workspacesDir = join(CONFIG_DIR, 'workspaces');
  if (existsSync(workspacesDir)) {
    rmSync(workspacesDir, { recursive: true });
  }
}

// ============================================
// Workspace 管理函数
// ============================================

/**
 * 生成唯一 workspace ID。
 * 使用随机 UUID 风格格式。
 */
export function generateWorkspaceId(): string {
  // 生成随机字节并格式化为 8-4-4-4-12 的 UUID 风格字符串
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 在 workspace_root/icon.* 查找 workspace 图标。
 * 找到返回绝对路径，否则返回 null。
 */
export function findWorkspaceIcon(rootPath: string): string | null {
  return findIconFile(rootPath) ?? null;
}

/** 获取所有 workspace，并解析名称与本地图标 */
export function getWorkspaces(): Workspace[] {
  const config = loadStoredConfig();
  const workspaces = config?.workspaces || [];

  // 从文件夹配置读取名称，并解析本地图标
  return workspaces.map(w => {
    // 名称以 workspace 文件夹配置为单一事实来源
    const wsConfig = loadWorkspaceConfig(w.rootPath);
    const name = wsConfig?.name || basename(w.rootPath) || 'Untitled';

    // 如果存储的 iconUrl 是远程 URL 则直接使用；否则检查本地图标文件
    let iconUrl = w.iconUrl;
    if (!iconUrl || (!iconUrl.startsWith('http://') && !iconUrl.startsWith('https://'))) {
      const localIcon = findWorkspaceIcon(w.rootPath);
      if (localIcon) {
        // 转成 file:// URL 供 Electron renderer 使用
        // 追加 mtime 作为缓存破坏参数，图标变更时 UI 会刷新
        try {
          const mtime = statSync(localIcon).mtimeMs;
          iconUrl = `file://${localIcon}?t=${mtime}`;
        } catch {
          iconUrl = `file://${localIcon}`;
        }
      }
    }

    const slug = extractWorkspaceSlugFromPath(w.rootPath, w.id);
    return { ...w, name, slug, iconUrl };
  });
}

/** 获取当前激活的 workspace；没有则返回第一个 */
export function getActiveWorkspace(): Workspace | null {
  const config = loadStoredConfig();
  if (!config || !config.activeWorkspaceId) {
    return config?.workspaces[0] || null;
  }
  return config.workspaces.find(w => w.id === config.activeWorkspaceId) || config.workspaces[0] || null;
}

/**
 * 按名称（不区分大小写）或 ID 查找 workspace。
 * CLI 的 -w 标志用它指定 workspace。
 */
export function getWorkspaceByNameOrId(nameOrId: string): Workspace | null {
  const workspaces = getWorkspaces();
  return workspaces.find(w =>
    w.id === nameOrId ||
    w.name.toLowerCase() === nameOrId.toLowerCase()
  ) || null;
}

/** 更新 workspace 的远程服务器信息 */
export function updateWorkspaceRemoteServer(
  workspaceId: string,
  remoteServer: { url: string; token: string; remoteWorkspaceId: string },
): void {
  const config = loadStoredConfig();
  if (!config) return;
  const ws = config.workspaces.find(w => w.id === workspaceId);
  if (!ws) throw new Error('Workspace not found');
  ws.remoteServer = remoteServer;
  saveConfig(config);
}

/** 设置当前激活的 workspace */
export function setActiveWorkspace(workspaceId: string): void {
  const config = loadStoredConfig();
  if (!config) return;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return;

  config.activeWorkspaceId = workspaceId;
  saveConfig(config);
}

/**
 * 原子切换到某个 workspace 并加载/创建 session。
 * 把两个操作放在一起，避免竞态条件。
 *
 * @param workspaceId 要切换的 workspace ID
 * @returns workspace 和 session；找不到 workspace 时返回 null
 */
export async function switchWorkspaceAtomic(workspaceId: string): Promise<{ workspace: Workspace; session: SessionConfig } | null> {
  const config = loadStoredConfig();
  if (!config) return null;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return null;

  // 获取或创建该 workspace 的最新 session
  const session = await getOrCreateLatestSession(workspace.rootPath);

  // 更新 config 中的 active workspace
  config.activeWorkspaceId = workspaceId;
  workspace.lastAccessedAt = Date.now();
  saveConfig(config);

  return { workspace, session };
}

/**
 * 把一个 workspace 加入全局配置。
 * @param workspace - workspace 数据（必须包含 rootPath）
 */
export function addWorkspace(workspace: Omit<Workspace, 'id' | 'createdAt' | 'slug'>): Workspace {
  const config = loadStoredConfig();
  if (!config) {
    throw new Error('No config found');
  }

  const slug = extractWorkspaceSlugFromPath(workspace.rootPath, '');

  // 检查是否已有相同 rootPath 的 workspace
  const existing = config.workspaces.find(w => w.rootPath === workspace.rootPath);
  if (existing) {
    // 用新设置更新已有 workspace
    const updated: Workspace = {
      ...existing,
      ...workspace,
      slug,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    const existingIndex = config.workspaces.indexOf(existing);
    config.workspaces[existingIndex] = updated;
    saveConfig(config);
    return updated;
  }

  const newWorkspace: Workspace = {
    ...workspace,
    slug,
    id: generateWorkspaceId(),
    createdAt: Date.now(),
  };

  // 如果文件夹结构不存在则创建
  if (!isValidWorkspace(newWorkspace.rootPath)) {
    createWorkspaceAtPath(newWorkspace.rootPath, newWorkspace.name);
  }

  config.workspaces.push(newWorkspace);

  // 如果是唯一 workspace，设为 active
  if (config.workspaces.length === 1) {
    config.activeWorkspaceId = newWorkspace.id;
  }

  saveConfig(config);
  return newWorkspace;
}

/**
 * 同步 workspace：发现默认位置里尚未被全局配置追踪的 workspace，加入配置。
 * 在应用启动时调用。
 */
export function syncWorkspaces(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const discoveredPaths = discoverWorkspacesInDefaultLocation();
  const trackedPaths = new Set(config.workspaces.map(w => w.rootPath));

  let added = false;
  for (const rootPath of discoveredPaths) {
    if (trackedPaths.has(rootPath)) continue;

    // 加载 workspace 配置以获取名称
    const wsConfig = loadWorkspaceConfig(rootPath);
    if (!wsConfig) continue;

    const newWorkspace: Workspace = {
      id: wsConfig.id || generateWorkspaceId(),
      name: wsConfig.name,
      slug: extractWorkspaceSlugFromPath(rootPath, ''),
      rootPath,
      createdAt: wsConfig.createdAt || Date.now(),
    };

    config.workspaces.push(newWorkspace);
    added = true;
  }

  if (added) {
    // 如果没有 active workspace，设为第一个
    if (!config.activeWorkspaceId && config.workspaces.length > 0) {
      config.activeWorkspaceId = config.workspaces[0]!.id;
    }
    saveConfig(config);
  }
}

/** 移除指定 workspace，并清理相关凭据与数据 */
export async function removeWorkspace(workspaceId: string): Promise<boolean> {
  const config = loadStoredConfig();
  if (!config) return false;

  const index = config.workspaces.findIndex(w => w.id === workspaceId);
  if (index === -1) return false;

  config.workspaces.splice(index, 1);

  // 如果删除的是 active workspace，切换到第一个可用
  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = config.workspaces[0]?.id || null;
  }

  saveConfig(config);

  // 清理该 workspace 在凭据存储里的凭据
  const manager = getCredentialManager();
  await manager.deleteWorkspaceCredentials(workspaceId);

  // 删除 workspace 数据目录（session、plan 等）
  const workspaceDataDir = join(WORKSPACES_DIR, workspaceId);
  if (existsSync(workspaceDataDir)) {
    try {
      rmSync(workspaceDataDir, { recursive: true });
    } catch (error) {
      console.error(`[storage] Failed to delete workspace data directory: ${workspaceDataDir}`, error);
    }
  }

  return true;
}

// 注意：renameWorkspace() 已移除 —— workspace 名称现在只存在文件夹配置中
// 重命名请通过 updateWorkspaceSetting('name', ...) 修改文件夹配置

// ============================================
// Workspace 会话持久化
// ============================================

const WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

/** 确保 workspace 数据目录存在，返回目录路径 */
function ensureWorkspaceDir(workspaceId: string): string {
  const dir = join(WORKSPACES_DIR, workspaceId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}


// 为方便从 core 重新导出类型
export type { StoredAttachment, StoredMessage } from '@craft-agent/core/types';

/** workspace 会话结构 */
export interface WorkspaceConversation {
  messages: StoredMessage[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  savedAt: number;
}

/** 保存 workspace 会话（消息 + token 使用情况） */
export function saveWorkspaceConversation(
  workspaceId: string,
  messages: StoredMessage[],
  tokenUsage: WorkspaceConversation['tokenUsage']
): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'conversation.json');

  const conversation: WorkspaceConversation = {
    messages,
    tokenUsage,
    savedAt: Date.now(),
  };

  try {
    writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
  } catch (e) {
    // 处理循环引用或其他序列化错误
    console.error(`[storage] [CYCLIC STRUCTURE] Failed to save workspace conversation:`, e);
    console.error(`[storage] Message count: ${messages.length}, message types: ${messages.map(m => m.type).join(', ')}`);
    // 尝试用净化后的消息保存
    try {
      const sanitizedMessages = messages.map((m, i) => {
        let safeToolInput = m.toolInput;
        if (m.toolInput) {
          try {
            JSON.stringify(m.toolInput);
          } catch (inputErr) {
            console.error(`[storage] [CYCLIC STRUCTURE] in message ${i} toolInput (tool: ${m.toolName}), keys: ${Object.keys(m.toolInput).join(', ')}, error: ${inputErr}`);
            safeToolInput = { error: '[non-serializable input]' };
          }
        }
        return { ...m, toolInput: safeToolInput };
      });
      const sanitizedConversation: WorkspaceConversation = {
        messages: sanitizedMessages,
        tokenUsage,
        savedAt: Date.now(),
      };
      writeFileSync(filePath, JSON.stringify(sanitizedConversation, null, 2), 'utf-8');
      console.error(`[storage] Saved sanitized workspace conversation successfully`);
    } catch (e2) {
      console.error(`[storage] Failed to save even sanitized workspace conversation:`, e2);
    }
  }
}

/** 加载 workspace 会话 */
export function loadWorkspaceConversation(workspaceId: string): WorkspaceConversation | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<WorkspaceConversation>(filePath);
  } catch {
    return null;
  }
}

/** 获取 workspace 数据目录路径 */
export function getWorkspaceDataPath(workspaceId: string): string {
  return join(WORKSPACES_DIR, workspaceId);
}

/** 清空 workspace 会话 */
export function clearWorkspaceConversation(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');
  if (existsSync(filePath)) {
    writeFileSync(filePath, '{}', 'utf-8');
  }

  // 同时清空任何 active plan（plan 是 session 作用域）
  clearWorkspacePlan(workspaceId);
}

// ============================================
// Plan 持久化（Session 作用域）
// Plan 按 workspace 存储，随 /clear 清空
// ============================================

/**
 * 保存 workspace 的 plan。
 * Plan 是 session 作用域：session 期间持久化，但用户运行 /clear 或新建 session 时清空。
 */
export function saveWorkspacePlan(workspaceId: string, plan: Plan): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'plan.json');
  writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
}

/**
 * 加载 workspace 当前 plan。
 * 没有时返回 null。
 */
export function loadWorkspacePlan(workspaceId: string): Plan | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<Plan>(filePath);
  } catch {
    return null;
  }
}

/**
 * 清空 workspace 的 plan。
 * 用户运行 /clear 或取消 plan 时调用。
 */
export function clearWorkspacePlan(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

// ============================================
// Session Input Drafts
// 按 session 持久化 composer 状态（文本 + 附件），跨应用重启保留。
// 附件有两种形态：
//  - Track P: { path, name } —— 通过 webUtils.getPathForFile 捕获的绝对路径
//   （文件选择器 / 系统拖拽）。hydrate 时通过 file:readUserAttachment RPC 重新读取。
//  - Track C: { path, name, content } —— 粘贴 / 网页拖拽的内联内容，
//    从未在磁盘存在。hydrate 直接从存储的字节重建。
// ============================================

const DRAFTS_FILE = join(CONFIG_DIR, 'drafts.json');

/** 内联附件内容 */
export interface DraftAttachmentContent {
  type: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'unknown';
  mimeType: string;
  size: number;
  base64?: string;
  text?: string;
  thumbnailBase64?: string;
}

/** 草稿附件引用 */
export interface DraftAttachmentRef {
  path: string;
  name: string;
  /** 无真实文件系统路径的附件内联内容（粘贴、网页拖拽）。
   *  存在时 hydrate 从这些字节重建，跳过磁盘读取。 */
  content?: DraftAttachmentContent;
}

/** 单个 session 的草稿 */
export interface SessionDraft {
  text: string;
  attachments?: DraftAttachmentRef[];
}

interface DraftsData {
  drafts: Record<string, SessionDraft>;
  updatedAt: number;
}

const ATTACHMENT_CONTENT_TYPES = new Set(['image', 'pdf', 'text', 'office', 'audio', 'unknown']);

/** 判断草稿路径是否为绝对路径 */
function isAbsoluteDraftPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

/** 类型守卫：value 是否为 DraftAttachmentContent */
function isDraftAttachmentContent(value: unknown): value is DraftAttachmentContent {
  if (!value || typeof value !== 'object') return false;
  const c = value as DraftAttachmentContent;
  if (!ATTACHMENT_CONTENT_TYPES.has(c.type as string)) return false;
  if (typeof c.mimeType !== 'string') return false;
  if (typeof c.size !== 'number') return false;
  if (c.base64 !== undefined && typeof c.base64 !== 'string') return false;
  if (c.text !== undefined && typeof c.text !== 'string') return false;
  if (c.thumbnailBase64 !== undefined && typeof c.thumbnailBase64 !== 'string') return false;
  return true;
}

/** 类型守卫：value 是否为 DraftAttachmentRef */
function isDraftAttachmentRef(value: unknown): value is DraftAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as DraftAttachmentRef;
  if (typeof ref.path !== 'string' || typeof ref.name !== 'string') return false;
  if (ref.content !== undefined && !isDraftAttachmentContent(ref.content)) return false;
  // 迁移后保护：没有 content 的引用必须有绝对路径。这会在首次加载时拒绝
  // 0.8.11 的损坏形态（synthetic path === filename，无 content），
  // 用户只会看到一次空草稿，而不是附件永远静默消失。
  if (ref.content === undefined && !isAbsoluteDraftPath(ref.path)) return false;
  return true;
}

/** 类型守卫：value 是否为 SessionDraft */
function isSessionDraft(value: unknown): value is SessionDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SessionDraft;
  if (typeof candidate.text !== 'string') return false;
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return false;
    if (!candidate.attachments.every(isDraftAttachmentRef)) return false;
  }
  return true;
}

/** 判断草稿是否为空 */
function isEmptyDraft(draft: SessionDraft): boolean {
  return !draft.text && (!draft.attachments || draft.attachments.length === 0);
}

/**
 * 从磁盘加载所有草稿。无法解析为 SessionDraft 的条目（如升级前的字符串草稿）会被静默丢弃。
 */
function loadDraftsData(): DraftsData {
  try {
    if (!existsSync(DRAFTS_FILE)) {
      return { drafts: {}, updatedAt: 0 };
    }
    const raw = readJsonFileSync<{ drafts?: Record<string, unknown>; updatedAt?: number }>(DRAFTS_FILE);
    const drafts: Record<string, SessionDraft> = {};
    for (const [sessionId, value] of Object.entries(raw.drafts ?? {})) {
      if (isSessionDraft(value)) {
        drafts[sessionId] = value;
      }
    }
    return { drafts, updatedAt: raw.updatedAt ?? 0 };
  } catch {
    return { drafts: {}, updatedAt: 0 };
  }
}

/** 保存草稿数据 */
function saveDraftsData(data: DraftsData): void {
  ensureConfigDir();
  data.updatedAt = Date.now();
  writeFileSync(DRAFTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 获取指定 session 的持久化草稿（文本 + 附件引用）。
 */
export function getSessionDraft(sessionId: string): SessionDraft | null {
  const data = loadDraftsData();
  return data.drafts[sessionId] ?? null;
}

/**
 * 设置 session 草稿。空草稿（无文本且无附件）会从磁盘移除。
 */
export function setSessionDraft(sessionId: string, draft: SessionDraft): void {
  const data = loadDraftsData();
  if (isEmptyDraft(draft)) {
    delete data.drafts[sessionId];
  } else {
    data.drafts[sessionId] = {
      text: draft.text,
      ...(draft.attachments && draft.attachments.length > 0
        ? { attachments: draft.attachments.map(normalizeDraftAttachment) }
        : {}),
    };
  }
  saveDraftsData(data);
}

/** 规范化草稿附件，只保留有效字段 */
function normalizeDraftAttachment(ref: DraftAttachmentRef): DraftAttachmentRef {
  const base: DraftAttachmentRef = { path: ref.path, name: ref.name };
  if (ref.content && isDraftAttachmentContent(ref.content)) {
    const c = ref.content;
    base.content = {
      type: c.type,
      mimeType: c.mimeType,
      size: c.size,
      ...(c.base64 !== undefined ? { base64: c.base64 } : {}),
      ...(c.text !== undefined ? { text: c.text } : {}),
      ...(c.thumbnailBase64 !== undefined ? { thumbnailBase64: c.thumbnailBase64 } : {}),
    };
  }
  return base;
}

/** 删除指定 session 的草稿 */
export function deleteSessionDraft(sessionId: string): void {
  const data = loadDraftsData();
  delete data.drafts[sessionId];
  saveDraftsData(data);
}

/**
 * 获取所有草稿，以 sessionId 为 key 的对象。
 */
export function getAllSessionDrafts(): Record<string, SessionDraft> {
  const data = loadDraftsData();
  return data.drafts;
}

// ============================================
// Theme Storage（仅应用级）
// ============================================

import type { ThemeOverrides, ThemeFile, PresetTheme } from './theme.ts';

const APP_THEME_FILE = join(CONFIG_DIR, 'theme.json');
const APP_THEMES_DIR = join(CONFIG_DIR, 'themes');

/**
 * 获取应用级主题覆盖文件路径（~/.craft-agent/theme.json）。
 */
export function getAppThemePath(): string {
  return APP_THEME_FILE;
}

// 跟踪本进程是否已同步过预设主题（防止热重载时重复初始化）
let presetsInitialized = false;

/**
 * 获取应用级主题目录。
 * 预设主题存放在 ~/.craft-agent/themes/
 */
export function getAppThemesDir(): string {
  return APP_THEMES_DIR;
}

/**
 * 加载应用级主题覆盖。
 */
export function loadAppTheme(): ThemeOverrides | null {
  try {
    if (!existsSync(APP_THEME_FILE)) {
      return null;
    }
    return readJsonFileSync<ThemeOverrides>(APP_THEME_FILE);
  } catch {
    return null;
  }
}

/**
 * 保存应用级主题覆盖。
 */
export function saveAppTheme(theme: ThemeOverrides): void {
  ensureConfigDir();
  writeFileSync(APP_THEME_FILE, JSON.stringify(theme, null, 2), 'utf-8');
}


// ============================================
// 预设主题（应用级）
// ============================================

/**
 * 启动时把 bundled 预设主题同步到磁盘。
 * 保留用户自定义：
 * - 文件不存在 → 从 bundle 复制
 * - 文件存在但损坏 → 从 bundle 复制（自动修复）
 * - 文件存在且有效 → 跳过（保留用户修改）
 *
 * 用户自创的主题文件（非 bundled 文件名）不会被触碰。
 * 用户颜色覆盖存在 theme.json（独立文件），也不会被触碰。
 */
export function ensurePresetThemes(): void {
  // 本进程已初始化则跳过（防止热重载时重复初始化）
  if (presetsInitialized) {
    return;
  }
  presetsInitialized = true;

  const themesDir = getAppThemesDir();

  // 创建主题目录
  if (!existsSync(themesDir)) {
    mkdirSync(themesDir, { recursive: true });
  }

  // 通过 shared asset resolver 定位 bundled themes 目录
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return;
  }

  // 复制 bundled 预设主题到磁盘，保留用户自定义
  try {
    const bundledFiles = readdirSync(bundledThemesDir).filter(f => f.endsWith('.json'));
    for (const file of bundledFiles) {
      const srcPath = join(bundledThemesDir, file);
      const destPath = join(themesDir, file);

      // 文件存在且有效时跳过（保留用户自定义）
      if (existsSync(destPath) && isValidThemeFile(destPath)) {
        continue;
      }

      // 复制新文件或修复损坏文件
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
    }
  } catch {
    // 主题可选，忽略错误
  }
}

/**
 * 从应用主题目录加载所有预设主题。
 * 返回按名称排序的 PresetTheme 数组。
 */
export function loadPresetThemes(): PresetTheme[] {
  ensurePresetThemes();

  const themesDir = getAppThemesDir();
  if (!existsSync(themesDir)) {
    return [];
  }

  const themes: PresetTheme[] = [];

  try {
    const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      const path = join(themesDir, file);
      try {
        const theme = readJsonFileSync<ThemeFile>(path);
        // 把相对 backgroundImage 路径解析为 file:// URL
        const resolvedTheme = resolveThemeBackgroundImage(theme, path);
        themes.push({ id, path, theme: resolvedTheme });
      } catch {
        // 跳过无效主题文件
      }
    }
  } catch {
    return [];
  }

  // 排序：default 在最前，其余按名称字母序
  return themes.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return (a.theme.name || a.id).localeCompare(b.theme.name || b.id);
  });
}

/**
 * 根据文件扩展名获取 MIME 类型，用于 data URL 编码。
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/**
 * 把主题里的相对 backgroundImage 路径解析为 data URL。
 * 如果 backgroundImage 是相对路径（无协议），则相对于主题 JSON 所在目录解析、
 * 读取文件并转换为 data URL。因为渲染进程在 dev 模式的 localhost 下无法直接访问 file:// URL。
 * @param theme - 要处理的主题对象
 * @param themePath - 主题 JSON 文件的绝对路径
 */
function resolveThemeBackgroundImage(theme: ThemeFile, themePath: string): ThemeFile {
  if (!theme.backgroundImage) {
    return theme;
  }

  // 已是绝对 URL（http://、https://、data: 等协议）则直接返回
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(theme.backgroundImage);
  if (hasProtocol) {
    return theme;
  }

  // 相对路径：按主题 JSON 所在目录解析
  const themeDir = dirname(themePath);
  const absoluteImagePath = join(themeDir, theme.backgroundImage);

  // 读取文件并转为 data URL，这样 renderer 能使用
  //（renderer 在 localhost 下访问 file:// URL 会被拦截）
  try {
    if (!existsSync(absoluteImagePath)) {
      console.warn(`Theme background image not found: ${absoluteImagePath}`);
      return theme;
    }

    const imageBuffer = readFileSync(absoluteImagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = getMimeType(absoluteImagePath);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      ...theme,
      backgroundImage: dataUrl,
    };
  } catch (error) {
    console.warn(`Failed to read theme background image: ${absoluteImagePath}`, error);
    return theme;
  }
}

/**
 * 按 ID 加载指定预设主题。
 * @param id - 主题 ID（不含 .json 的文件名）
 */
export function loadPresetTheme(id: string): PresetTheme | null {
  const themesDir = getAppThemesDir();
  const path = join(themesDir, `${id}.json`);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const theme = readJsonFileSync<ThemeFile>(path);
    // 把相对 backgroundImage 路径解析为 file:// URL
    const resolvedTheme = resolveThemeBackgroundImage(theme, path);
    return { id, path, theme: resolvedTheme };
  } catch {
    return null;
  }
}

/**
 * 获取应用级预设主题目录路径。
 */
export function getPresetThemesDir(): string {
  return getAppThemesDir();
}

/**
 * 把预设主题重置为 bundled 默认版本。
 * 自动通过 getBundledAssetsDir('themes') 定位 bundled 路径。
 * @param id - 要重置的主题 ID
 */
export function resetPresetTheme(id: string): boolean {
  // 通过 shared asset resolver 定位 bundled themes 目录
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return false;
  }

  const bundledPath = join(bundledThemesDir, `${id}.json`);
  const themesDir = getAppThemesDir();
  const destPath = join(themesDir, `${id}.json`);

  if (!existsSync(bundledPath)) {
    return false;
  }

  try {
    const content = readFileSync(bundledPath, 'utf-8');
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }
    writeFileSync(destPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Color Theme Selection（存储在 config 中）
// ============================================

/**
 * 获取当前选中的颜色主题 ID。
 * 未设置时返回 'default'。
 */
export function getColorTheme(): string {
  const config = loadStoredConfig();
  if (config?.colorTheme !== undefined) {
    return config.colorTheme;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.colorTheme;
}

/**
 * 设置颜色主题 ID。
 */
export function setColorTheme(themeId: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.colorTheme = themeId;
  saveConfig(config);
}

// ============================================
// Auto-Update Dismissed Version
// ============================================

/**
 * 获取用户忽略的版本号。
 * 没有时返回 null。
 */
export function getDismissedUpdateVersion(): string | null {
  const config = loadStoredConfig();
  return config?.dismissedUpdateVersion ?? null;
}

/**
 * 设置用户忽略的版本号。
 * 传入版本字符串以跳过该版本的更新通知。
 */
export function setDismissedUpdateVersion(version: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.dismissedUpdateVersion = version;
  saveConfig(config);
}

/**
 * 清空用户忽略的版本号。
 * 新版本发布或成功更新后调用。
 */
export function clearDismissedUpdateVersion(): void {
  const config = loadStoredConfig();
  if (!config) return;
  delete config.dismissedUpdateVersion;
  saveConfig(config);
}

// ============================================
// LLM Connections
// ============================================

// 为方便重新导出类型（实际 import 在文件顶部）
export type {
  LlmConnection,
  LlmProviderType,
  LlmAuthType,
  LlmConnectionWithStatus,
} from './llm-connections.ts';

/**
 * 把 Codex（OpenAI）和 Copilot 连接迁移到 Pi 后端。
 * 启动时运行，对现有用户透明路由到 PiAgent。
 *
 * 无需重新认证：凭据按连接 slug 存储，PiAgent 通过 piAuthProvider 读取相同的 OAuth token。
 *
 * 迁移规则：
 * - openai + oauth       → pi + openai-codex
 * - openai + api_key     → pi + openai
 * - openai_compat        → pi + openai（保留 baseUrl）
 * - copilot              → pi + github-copilot
 * - defaultModel 重置为 Pi 默认值（丢弃过时的 Codex/Copilot 模型 ID）
 * - codexPath 移除（不再需要）
 */
function migrateCodexCopilotToPi(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;

  for (const connection of config.llmConnections) {
    // 把可能存在的旧 providerType 值当字符串处理
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connAny = connection as any;
    const providerStr = connection.providerType as string;
    if (providerStr === 'openai' && connection.authType === 'oauth') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai-codex';
      connection.name = 'ChatGPT Plus (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined; // 重置，后续回填会选 Pi 默认
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai' && (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint')) {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      connection.name = 'OpenAI API (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai_compat') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      // 保留自定义端点 baseUrl
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'copilot') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'github-copilot';
      connection.name = 'GitHub Copilot (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    }
  }

  // 清理 openaiVariant 配置字段（Codex 专用 A/B 测试，已不再相关）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (configAny.openaiVariant) {
    delete configAny.openaiVariant;
    changed = true;
  }

  return changed;
}

/**
 * 回填所有连接的 models 和 defaultModel。
 * 确保内置连接（anthropic、openai）始终有模型列表，
 * 而不仅仅是 compat 连接。
 */
export function shouldMigratePiOpenAiProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType' | 'baseUrl'>): boolean {
  // 清理 legacy：旧版 ChatGPT Plus OAuth 连接可能仍被标记为 openai。
  // 仅把那些迁移到 openai-codex。
  //
  // 重要：不要迁移 API key 或自定义端点连接：
  // - `api_key` / `api_key_with_endpoint` 配 `openai` 是普通 OpenAI API auth，
  // - 强制改成 openai-codex 会把请求路由到 ChatGPT 后端认证，重启后失败。
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai') return false;
  if (connection.authType !== 'oauth') return false;
  if (typeof connection.baseUrl === 'string' && connection.baseUrl.trim().length > 0) return false;
  return true;
}

export function shouldRepairPiApiKeyCodexProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType'>): boolean {
  // 修复之前启动迁移产生的损坏状态：
  // API key 连接被标记为 openai-codex 会尝试 ChatGPT 后端 JWT 认证并失败。
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai-codex') return false;
  return connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint';
}

/** 把 models 数组规范化为 ID 字符串列表 */
function normalizeModelIds(models?: Array<{ id: string } | string>): string[] {
  if (!models) return [];
  return models
    .map(m => typeof m === 'string' ? m : m.id)
    .filter((id): id is string => !!id && id.trim().length > 0);
}

/** 判断两个模型 ID 集合是否相等（忽略顺序） */
function modelSetEquals(a: string[], b: string[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size !== bs.size) return false;
  for (const id of as) {
    if (!bs.has(id)) return false;
  }
  return true;
}

/** 根据当前模型列表与提供商默认列表推断 modelSelectionMode */
export function inferModelSelectionMode(
  connection: Pick<LlmConnection, 'models'>,
  providerDefaultModelIds: string[],
): 'automaticallySyncedFromProvider' | 'userDefined3Tier' {
  const currentIds = normalizeModelIds(connection.models);
  if (currentIds.length === 0) return 'automaticallySyncedFromProvider';
  return modelSetEquals(currentIds, providerDefaultModelIds)
    ? 'automaticallySyncedFromProvider'
    : 'userDefined3Tier';
}

/** 回填所有连接的模型列表与默认模型 */
function backfillAllConnectionModels(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;
  for (const connection of config.llmConnections) {
    // 先修复之前损坏的 API-key codex 迁移
    if (shouldRepairPiApiKeyCodexProvider(connection)) {
      connection.piAuthProvider = 'openai';
      changed = true;
    }

    // 只把旧版 OAuth 支持的 Pi OpenAI 连接迁移到 ChatGPT 后端 provider key
    if (shouldMigratePiOpenAiProvider(connection)) {
      connection.piAuthProvider = 'openai-codex';
      changed = true;
    }

    const defaultModels = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
    const defaultModel = getDefaultModelForConnection(connection.providerType, connection.piAuthProvider);
    const providerDefaultModelIds = normalizeModelIds(defaultModels as Array<{ id: string } | string>);

    // 注意：bedrock 连接在 migrateLegacyProviderTypes() 中先变成 pi + amazon-bedrock，
    // 然后才运行本函数，所以这里不需要 bedrock 专属处理。

    if (isPiProvider(connection.providerType) && connection.piAuthProvider) {
      // Copilot 模型始终由服务端管理（GitHub 策略决定可用模型），
      // 因此无论 inferModelSelectionMode 从陈旧静态 SDK 数据算出什么，都强制 automatic。
      const isCopilot = connection.piAuthProvider === 'github-copilot';
      const mode = isCopilot
        ? 'automaticallySyncedFromProvider' as const
        : (connection.modelSelectionMode ?? inferModelSelectionMode(connection, providerDefaultModelIds));
      if (connection.modelSelectionMode !== mode) {
        debug('[storage] backfill mode inferred', {
          slug: connection.slug,
          piAuthProvider: connection.piAuthProvider,
          from: connection.modelSelectionMode,
          to: mode,
          currentModelCount: normalizeModelIds(connection.models).length,
        });
        connection.modelSelectionMode = mode;
        changed = true;
      }

      if (mode === 'automaticallySyncedFromProvider') {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0 && !modelSetEquals(currentIds, providerDefaultModelIds)) {
          connection.models = defaultModels;
          changed = true;
        }
      } else {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0) {
          const allowedIds = new Set(providerDefaultModelIds);
          const canonicalCurrentIds = currentIds.map((id) => {
            if (allowedIds.has(id)) return id;
            if (!id.startsWith('pi/')) {
              const prefixed = `pi/${id}`;
              if (allowedIds.has(prefixed)) return prefixed;
            }
            return id;
          });
          const filtered = canonicalCurrentIds.filter(id => allowedIds.has(id));

          if (!modelSetEquals(canonicalCurrentIds, currentIds) || filtered.length !== currentIds.length) {
            debug('[storage] backfill userDefined filtered', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              beforeCount: currentIds.length,
              canonicalCount: canonicalCurrentIds.length,
              afterCount: filtered.length,
              beforeFirst5: currentIds.slice(0, 5),
              afterFirst5: filtered.slice(0, 5),
            });
            connection.models = filtered;
            changed = true;
          }

          if (filtered.length === 0) {
            debug('[storage] backfill userDefined fallback-to-defaults', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              defaultCount: providerDefaultModelIds.length,
            });
            connection.models = defaultModels;
            changed = true;
          }
        }
      }
    }

    if (defaultModels.length > 0 && (!connection.models || (Array.isArray(connection.models) && connection.models.length === 0))) {
      connection.models = defaultModels;
      changed = true;
    }

    if (!connection.defaultModel && defaultModel) {
      connection.defaultModel = defaultModel;
      changed = true;
    }

    // 校验现有 defaultModel 是否在 models 列表中
    if (connection.defaultModel && connection.models && Array.isArray(connection.models) && connection.models.length > 0) {
      const modelIds = connection.models.map(m => typeof m === 'string' ? m : m.id);
      if (!modelIds.includes(connection.defaultModel)) {
        // 重置为列表中的第一个可用模型
        const firstModelId = modelIds[0];
        if (firstModelId) {
          connection.defaultModel = firstModelId;
        }
        changed = true;
      }
    }
  }
  return changed;
}

const OPUS_DEFAULT_ID = 'claude-opus-4-8';
const OPUS_FALLBACK_ID = 'claude-opus-4-7';

/** 获取某连接的默认模型 ID 集合 */
function defaultModelIdsForConnection(connection: LlmConnection): Set<string> {
  return new Set(
    getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
      .map(model => typeof model === 'string' ? model : model.id),
  );
}

/**
 * 规范化连接中的模型 ID。
 * 处理 Bedrock 需要的原生 inference profile ID，以及 Pi 前缀、弃用模型替换等。
 */
function normalizeConnectionModelId(connection: LlmConnection, modelId: string): string {
  const normalized = normalizeDeprecatedModelId(modelId);

  // Bedrock 连接走 Pi，需要原生 inference profile IDs。
  if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const native = toBedrockNativeId(bare);
    const defaults = defaultModelIdsForConnection(connection);
    const prefixedCandidate = `pi/${native}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : native;

    // Pi 0.73.1 尚未暴露 Opus 4.8，保留 4.7 作为可选回退
    // 直到上游 catalog 加入 4.8；优先默认列表已经做了未来兼容。
    if (bare === OPUS_DEFAULT_ID || native.endsWith(`.${OPUS_DEFAULT_ID}`)) {
      const fallbackNative = toBedrockNativeId(OPUS_FALLBACK_ID);
      const prefixedFallback = `pi/${fallbackNative}`;
      const fallback = defaults.has(prefixedFallback) ? prefixedFallback : fallbackNative;
      if (!defaults.has(candidate) && defaults.has(fallback)) return fallback;
    }
    return candidate;
  }

  if (connection.providerType === 'pi') {
    const defaults = defaultModelIdsForConnection(connection);
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const prefixedCandidate = `pi/${bare}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : normalized;
    const prefixedFallback = `pi/${OPUS_FALLBACK_ID}`;
    const fallback = defaults.has(prefixedFallback) ? prefixedFallback : OPUS_FALLBACK_ID;
    if ((bare === OPUS_DEFAULT_ID)
      && !defaults.has(candidate)
      && defaults.has(fallback)) {
      return fallback;
    }
    if (bare === OPUS_DEFAULT_ID && candidate !== normalized) {
      return candidate;
    }
  }

  return normalized;
}

/** 为迁移后的模型 ID 生成展示名 */
function displayNameForMigratedModel(modelId: string): string {
  const bareModelId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  return getModelDisplayName(bareModelId);
}

/** 用新 ID 更新一条模型条目，保留其他元数据 */
function withUpdatedModelEntry(
  connection: LlmConnection,
  entry: ModelDefinition | string,
  nextId: string,
): ModelDefinition | string {
  if (typeof entry === 'string') {
    if (connection.providerType === 'anthropic' && nextId === OPUS_DEFAULT_ID) {
      return { ...getModelById(OPUS_DEFAULT_ID)! };
    }
    return nextId;
  }

  const nextEntry: ModelDefinition = { ...entry, id: nextId };
  if (connection.providerType === 'anthropic' && nextId === OPUS_DEFAULT_ID) {
    return { ...getModelById(OPUS_DEFAULT_ID)! };
  }
  if (nextEntry.name && /Opus 4\.[56]/.test(nextEntry.name)) {
    nextEntry.name = displayNameForMigratedModel(nextId);
  }
  return nextEntry;
}

/** 为默认模型创建一条模型条目 */
function modelEntryForDefault(connection: LlmConnection, modelId: string): ModelDefinition | string {
  if (connection.providerType === 'anthropic' && modelId === OPUS_DEFAULT_ID) {
    return { ...getModelById(OPUS_DEFAULT_ID)! };
  }
  return modelId;
}

/**
 * 把弃用的 Opus 4.5/4.6 ID 以及之前直连 Anthropic 的 Opus 4.7 默认模型
 * 迁移为当前默认 Opus 模型。
 * 自定义/compat 端点被跳过，因为各提供商的别名可能不同。
 */
function migrateLegacyOpusToDefaultOpus(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    if (connection.providerType !== 'anthropic' && connection.providerType !== 'pi') continue;

    if (connection.defaultModel) {
      let normalizedDefault = normalizeConnectionModelId(connection, connection.defaultModel);
      // 之前直连 Anthropic 的默认是 Opus 4.7。把现有直连 Anthropic 默认移到 Opus 4.8，
      // 同时保留 4.7 在模型列表中。Pi 在 catalog 暴露 4.8 前保持 4.7。
      if (connection.providerType === 'anthropic' && normalizedDefault === OPUS_FALLBACK_ID) {
        normalizedDefault = OPUS_DEFAULT_ID;
      }
      if (normalizedDefault !== connection.defaultModel) {
        connection.defaultModel = normalizedDefault;
        changed = true;
      }
    }

    if (connection.models && Array.isArray(connection.models)) {
      const nextModels: Array<ModelDefinition | string> = [];
      const seen = new Set<string>();
      let connectionModelsChanged = false;

      for (const entry of connection.models) {
        const currentId = typeof entry === 'string' ? entry : entry.id;
        const nextId = normalizeConnectionModelId(connection, currentId);

        if (seen.has(nextId)) {
          connectionModelsChanged = true;
          continue;
        }
        seen.add(nextId);

        if (nextId !== currentId) {
          nextModels.push(withUpdatedModelEntry(connection, entry, nextId));
          connectionModelsChanged = true;
        } else {
          nextModels.push(entry);
        }
      }

      if (connection.defaultModel && !seen.has(connection.defaultModel)) {
        nextModels.unshift(modelEntryForDefault(connection, connection.defaultModel));
        connectionModelsChanged = true;
      }

      if (connectionModelsChanged) {
        connection.models = nextModels;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * 把直连 Anthropic 连接中的 Sonnet 4.5 迁移到 Sonnet 4.6。
 * 更新存储的模型 ID 与名称。
 */
function migrateSonnet45ToSonnet46(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  const SONNET_45_ID = 'claude-sonnet-4-5-20250929';
  const SONNET_46_ID = 'claude-sonnet-4-6';

  let changed = false;

  for (const connection of config.llmConnections) {
    // 只迁移直连 Anthropic 连接（不迁移 compat/第三方）
    if (connection.providerType !== 'anthropic') continue;

    // 迁移 defaultModel
    if (connection.defaultModel === SONNET_45_ID) {
      connection.defaultModel = SONNET_46_ID;
      changed = true;
    }

    // 迁移 models 数组
    if (connection.models && Array.isArray(connection.models)) {
      const hasNew = connection.models.some(m =>
        (typeof m === 'string' ? m : m.id) === SONNET_46_ID
      );

      if (hasNew) {
        // 新模型已存在 —— 只删除旧条目避免重复
        const before = connection.models.length;
        connection.models = connection.models.filter(m =>
          (typeof m === 'string' ? m : m.id) !== SONNET_45_ID
        );
        if (connection.models.length !== before) changed = true;
      } else {
        // 新模型不存在 —— 原地重命名旧条目
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string' && model === SONNET_45_ID) {
            connection.models[i] = SONNET_46_ID;
            changed = true;
          } else if (typeof model === 'object' && model.id === SONNET_45_ID) {
            model.id = SONNET_46_ID;
            if (model.name?.includes('4.5')) {
              model.name = model.name.replace('4.5', '4.6');
            }
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

/**
 * 把 workspace 默认模型中的 Sonnet 4.5 迁移到 Sonnet 4.6。
 */
function migrateWorkspaceSonnet45ToSonnet46(config: StoredConfig): void {
  if (!config.workspaces) return;

  const SONNET_45_ID = 'claude-sonnet-4-5-20250929';
  const SONNET_46_ID = 'claude-sonnet-4-6';

  for (const workspace of config.workspaces) {
    const wsConfig = loadWorkspaceConfig(workspace.rootPath);
    if (!wsConfig?.defaults?.model) continue;

    if (wsConfig.defaults.model === SONNET_45_ID) {
      wsConfig.defaults.model = SONNET_46_ID;
      saveWorkspaceConfig(workspace.rootPath, wsConfig);
    }
  }
}

/**
 * 把 workspace 默认模型中弃用/旧的 Opus 默认迁移为当前默认 Opus 模型。
 */
function migrateWorkspaceLegacyOpusToDefaultOpus(config: StoredConfig): void {
  if (!config.workspaces) return;

  for (const workspace of config.workspaces) {
    const wsConfig = loadWorkspaceConfig(workspace.rootPath);
    if (!wsConfig?.defaults?.model) continue;

    const normalized = normalizeDeprecatedModelId(wsConfig.defaults.model);
    const nextModel = normalized === OPUS_FALLBACK_ID ? OPUS_DEFAULT_ID : normalized;
    if (nextModel !== wsConfig.defaults.model) {
      wsConfig.defaults.model = nextModel;
      saveWorkspaceConfig(workspace.rootPath, wsConfig);
    }
  }
}

/**
 * 把旧版 provider type 迁移到当前活跃集合（anthropic, pi, pi_compat）。
 *
 * 1. providerType==='bedrock' → 'pi' + piAuthProvider='amazon-bedrock'。
 *    模型 ID 规范化为 Bedrock 原生（带 pi/ 前缀），供 Pi SDK 解析。
 *
 * 2. providerType==='vertex' → 'pi' + piAuthProvider='google-vertex'。
 *
 * 3. providerType==='anthropic_compat' → 'pi_compat' + customEndpoint.api='anthropic-messages'。
 *    保留 baseUrl 和 models；authType 'api_key_with_endpoint' 保持不变。
 *
 * 同时规范化已经是 pi+Bedrock 的连接。
 */
function migrateLegacyProviderTypes(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    // 把旧值当字符串处理（已从 LlmProviderType 中移除）
    const providerStr = connection.providerType as string;

    // --- bedrock → pi + amazon-bedrock ---
    if (providerStr === 'bedrock') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = connection.piAuthProvider || 'amazon-bedrock';
      // 把模型 ID 规范化为 Bedrock 原生（带 pi/ 前缀），供 Pi SDK 使用
      if (connection.defaultModel) {
        connection.defaultModel = normalizePiBedrockId(connection.defaultModel);
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            connection.models[i] = normalizePiBedrockId(model);
          } else if (model && typeof model === 'object') {
            model.id = normalizePiBedrockId(model.id);
          }
        }
      }
      changed = true;
      continue;
    }

    // --- vertex → pi + google-vertex ---
    if (providerStr === 'vertex') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = 'google-vertex';
      changed = true;
      continue;
    }

    // --- anthropic_compat → pi_compat + customEndpoint ---
    if (providerStr === 'anthropic_compat') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi_compat';
      connection.customEndpoint = { api: 'anthropic-messages' };
      // authType 'api_key_with_endpoint' 保持不变；保留 baseUrl 和 models
      changed = true;
      continue;
    }

    // 正向迁移：已经是 pi+Bedrock 的连接也需要 Bedrock 原生 ID（带 pi/ 前缀）
    if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
      if (connection.defaultModel) {
        const normalized = normalizePiBedrockId(connection.defaultModel);
        if (normalized !== connection.defaultModel) {
          connection.defaultModel = normalized;
          changed = true;
        }
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            const normalized = normalizePiBedrockId(model);
            if (normalized !== model) { connection.models[i] = normalized; changed = true; }
          } else if (model && typeof model === 'object') {
            const normalized = normalizePiBedrockId(model.id);
            if (normalized !== model.id) { model.id = normalized; changed = true; }
          }
        }
      }
    }
  }

  return changed;
}

/** 把带 pi/ 前缀的 Bedrock 模型 ID 规范化：pi/claude-opus-4-8 → pi/us.anthropic.claude-opus-4-8 */
function normalizePiBedrockId(id: string): string {
  const bare = id.startsWith('pi/') ? id.slice(3) : id;
  const native = toBedrockNativeId(normalizeDeprecatedModelId(bare));
  return `pi/${native}`;
}

/**
 * 把 modelDefaults 迁移到 connection.defaultModel，然后删除 modelDefaults。
 * 如果用户设置过 modelDefaults.anthropic，把它应用到默认 anthropic 连接；
 * openai 同理。然后移除 config 里的 modelDefaults。
 */
function migrateModelDefaultsToConnections(config: StoredConfig): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (!configAny.modelDefaults || !config.llmConnections) return false;
  let changed = false;

  // anthropic 模型默认 → 默认 anthropic 连接
  if (configAny.modelDefaults.anthropic) {
    const defaultSlug = config.defaultLlmConnection;
    const anthropicConn = config.llmConnections.find(c =>
      c.slug === defaultSlug && c.providerType === 'anthropic'
    ) || config.llmConnections.find(c =>
      c.providerType === 'anthropic'
    );
    if (anthropicConn) {
      anthropicConn.defaultModel = configAny.modelDefaults.anthropic;
      changed = true;
    }
  }

  // openai 模型默认 → 默认 openai 连接
  if (configAny.modelDefaults.openai) {
    const openaiConn = config.llmConnections.find(c =>
      (c.providerType as string) === 'openai' || (c.providerType as string) === 'openai_compat'
    );
    if (openaiConn) {
      openaiConn.defaultModel = configAny.modelDefaults.openai;
      changed = true;
    }
  }

  // 删除 modelDefaults
  delete configAny.modelDefaults;
  changed = true;

  return changed;
}

/**
 * 把旧版认证配置迁移为 LLM connections。
 * 在应用启动、任何 getLlmConnections() 调用之前调用。
 *
 * 这是一次性迁移，转换：
 * - 旧 authType 字段 → llmConnections 数组中的 LlmConnection
 * - 旧 anthropicBaseUrl → LlmConnection.baseUrl
 * - 旧 customModel → LlmConnection.defaultModel
 * - 旧 model 字段 → modelDefaults（按 provider）
 *
 * 迁移后删除旧字段，因为不再使用。
 */
export function migrateLegacyLlmConnectionsConfig(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalizeModelList = (models?: Array<{ id: string } | string>): string[] => {
    if (!models) return [];
    return models
      .map(model => (typeof model === 'string' ? model : model.id))
      .filter(Boolean);
  };

  const applyCompatDefaults = (target: StoredConfig): boolean => {
    if (!target.llmConnections) return false;
    let changed = false;
    for (const connection of target.llmConnections) {
      // 旧 'openai_compat' 值可能仍存在于磁盘，按字符串处理
      const providerStr = connection.providerType as string;
      if (providerStr !== 'openai_compat') {
        continue;
      }
      const compatDefaults = getDefaultModelsForConnection(connection.providerType).map(
        m => typeof m === 'string' ? m : m.id
      );
      const normalizedModels = normalizeModelList(connection.models);
      if (normalizedModels.length === 0) {
        connection.models = [...compatDefaults];
        changed = true;
      } else if (normalizedModels.length !== (connection.models?.length ?? 0)) {
        connection.models = [...normalizedModels];
        changed = true;
      }
      // 回填缺失的新默认模型
      let currentModels = normalizeModelList(connection.models);
      for (const defaultModel of compatDefaults) {
        if (!currentModels.includes(defaultModel)) {
          currentModels = [...currentModels, defaultModel];
          changed = true;
        }
      }
      if (changed) {
        connection.models = currentModels;
      }
      const currentDefault = connection.defaultModel?.trim();
      if (!currentDefault) {
        connection.defaultModel = (normalizeModelList(connection.models)[0] ?? compatDefaults[0]);
        changed = true;
      } else if (!normalizeModelList(connection.models).includes(currentDefault)) {
        connection.models = [currentDefault, ...normalizeModelList(connection.models).filter(m => m !== currentDefault)];
        changed = true;
      }
    }
    return changed;
  };

  // 已经迁移过 —— llmConnections 数组已存在
  if (config.llmConnections !== undefined) {
    // 清理之前迁移残留的旧字段
    let needsSave = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configAny = config as any;
    if ('authType' in config) {
      delete configAny.authType;
      needsSave = true;
    }
    if ('anthropicBaseUrl' in config) {
      delete configAny.anthropicBaseUrl;
      needsSave = true;
    }
    if ('customModel' in config) {
      delete configAny.customModel;
      needsSave = true;
    }
    if ('model' in config) {
      const legacyModel = configAny.model as string | undefined;
      if (legacyModel) {
        const provider = getModelProvider(legacyModel) ?? 'anthropic';
        configAny.modelDefaults = { ...(configAny.modelDefaults ?? {}), [provider]: legacyModel };
      }
      delete configAny.model;
      needsSave = true;
    }
    // 注意：已迁移的配置不会在这里调用 applyCompatDefaults()。
    // Compat 连接创建后归用户所有，应用不应在每次启动时静默扩展或覆盖用户模型列表。
    // Compat 默认值只在新建连接或首次旧版迁移时应用（即 config.llmConnections === undefined 路径）。

    // Phase 1a-bis：迁移 Codex/Copilot 到 Pi 后端
    if (migrateCodexCopilotToPi(config)) {
      needsSave = true;
    }

    // Phase 1b：在 Pi 模型列表过滤前规范化旧 Opus ID/默认模型
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1c：回填所有连接的 models/defaultModel（不只是 compat）
    if (backfillAllConnectionModels(config)) {
      needsSave = true;
    }
    // Phase 1d：把 modelDefaults 迁移到 connection.defaultModel，然后删除
    if (migrateModelDefaultsToConnections(config)) {
      needsSave = true;
    }
    // Phase 1e：规范化 modelDefaults 引入的旧 Opus ID
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1f：迁移 workspace 中旧 Opus 默认 → 当前默认 Opus
    migrateWorkspaceLegacyOpusToDefaultOpus(config);
    // Phase 1g：直连 Anthropic 的 Sonnet 4.5 → Sonnet 4.6
    if (migrateSonnet45ToSonnet46(config)) {
      needsSave = true;
    }
    // Phase 1h：workspace 默认模型 Sonnet 4.5 → Sonnet 4.6
    migrateWorkspaceSonnet45ToSonnet46(config);
    // Phase 1j：迁移旧 provider type（bedrock/vertex/anthropic_compat → pi/pi_compat）
    if (migrateLegacyProviderTypes(config)) {
      needsSave = true;
    }
    // Phase 1k：规范化 provider-type 迁移引入的旧 Opus ID。
    // 对旧 Bedrock 连接很重要：它们先变成 Pi+Bedrock，然后可以在 Pi catalog 缺 4.8 时回退到 4.7。
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }

    if (needsSave) {
      saveConfig(config);
    }
    return;
  }

  // 初始化为空数组
  config.llmConnections = [];

  // 旧版迁移：如果用户设置过 authType，为其创建连接
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  const legacyAuthType = configAny.authType as AuthType | undefined;
  const legacyBaseUrl = configAny.anthropicBaseUrl as string | undefined;
  const legacyCustomModel = configAny.customModel as string | undefined;
  const legacyModel = configAny.model as string | undefined;

  if (legacyAuthType) {
    let migrated: LlmConnection | null = null;

    if (legacyAuthType === 'oauth_token') {
      // Claude Max OAuth
      migrated = {
        slug: 'claude-max',
        name: 'Claude Max',
        providerType: 'anthropic',
        authType: 'oauth',
        models: getDefaultModelsForConnection('anthropic'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_oauth') {
      // ChatGPT Plus OAuth → Pi 后端
      migrated = {
        slug: 'codex',
        name: 'ChatGPT Plus (via Pi)',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'openai-codex',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai-codex'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_api_key') {
      // OpenAI API Key → Pi 后端
      migrated = {
        slug: 'codex-api',
        name: 'OpenAI API (via Pi)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'api_key') {
      // Anthropic API Key - 有自定义端点时变为 pi_compat
      const hasCustomEndpoint = !!legacyBaseUrl;
      if (hasCustomEndpoint) {
        migrated = {
          slug: 'anthropic-api',
          name: 'Custom Anthropic-Compatible',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          customEndpoint: { api: 'anthropic-messages' },
          models: getDefaultModelsForConnection('pi_compat'),
          createdAt: Date.now(),
        };
      } else {
        migrated = {
          slug: 'anthropic-api',
          name: 'Anthropic (API Key)',
          providerType: 'anthropic',
          authType: 'api_key',
          models: getDefaultModelsForConnection('anthropic'),
          createdAt: Date.now(),
        };
      }
    }

    if (migrated) {
      // 校验迁移出的连接是否有合法的 provider/auth 组合
      if (!isValidProviderAuthCombination(migrated.providerType, migrated.authType)) {
        console.warn(
          `[config] Legacy migration created invalid provider/auth combination: ` +
          `providerType=${migrated.providerType}, authType=${migrated.authType} ` +
          `(slug: ${migrated.slug}). Skipping migration for this connection.`
        );
      } else {
        // 应用旧 baseUrl
        if (legacyBaseUrl) {
          migrated.baseUrl = legacyBaseUrl;
        }

        // 应用旧 customModel
        if (legacyCustomModel) {
          migrated.defaultModel = legacyCustomModel;
        }

        config.llmConnections.push(migrated);
        config.defaultLlmConnection = migrated.slug;
      }
    }
  }

  // 迁移后删除旧字段
  delete configAny.authType;
  delete configAny.anthropicBaseUrl;
  delete configAny.customModel;
  delete configAny.model;

  if (legacyModel) {
    const provider = getModelProvider(legacyModel) ?? 'anthropic';
    configAny.modelDefaults = { ...(configAny.modelDefaults ?? {}), [provider]: legacyModel };
  }

  // 对新创建的连接执行同样的回填与迁移
  migrateCodexCopilotToPi(config);
  backfillAllConnectionModels(config);
  migrateModelDefaultsToConnections(config);
  migrateLegacyOpusToDefaultOpus(config);
  migrateWorkspaceLegacyOpusToDefaultOpus(config);

  saveConfig(config);
}

/**
 * 修复指向不存在连接的 defaultLlmConnection 引用。
 * 这种情况可能发生在连接被删除或从未创建时
 *（例如默认是 "anthropic-api"，但只有 "claude-max" 存在）。
 *
 * 同时修复全局 defaultLlmConnection 和 workspace 级默认。
 * 启动时与其他迁移一起调用。
 */
export function migrateOrphanedDefaultConnections(): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (!config.llmConnections || config.llmConnections.length === 0) return;

  let changed = false;

  // 修复指向不存在连接的全局默认
  if (ensureDefaultLlmConnection(config)) {
    changed = true;
  }

  // 修复指向不存在连接的 workspace 默认
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection) {
        const exists = config.llmConnections.some(
          c => c.slug === wsConfig.defaults!.defaultLlmConnection
        );
        if (!exists) {
          delete wsConfig.defaults.defaultLlmConnection;
          saveWorkspaceConfig(ws.rootPath, wsConfig);
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace default connection references:', error);
  }

  if (changed) {
    saveConfig(config);
  }
}

/**
 * 确保默认 LLM 连接设置正确。
 * 写操作内部调用以修复不一致状态。
 * 读操作不会调用这里 —— 读不会修改配置。
 */
function ensureDefaultLlmConnection(config: StoredConfig): boolean {
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const defaultExists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
  if (!config.defaultLlmConnection || !defaultExists) {
    config.defaultLlmConnection = config.llmConnections[0]!.slug;
    return true;
  }

  return false;
}

/**
 * 把旧版全局凭据迁移为 LLM connection-scoped 凭据。
 * 确保 LLM connections 系统启用前保存的凭据仍可通过新基于连接的认证使用。
 *
 * 在应用启动时调用（异步操作，凭据使用加密存储）。
 *
 * 迁移映射：
 * - claude_oauth::global → llm_oauth::claude-max
 * - anthropic_api_key::global → llm_api_key::anthropic-api
 *
 * 迁移成功后删除旧凭据，避免陈旧数据和凭据存储膨胀。
 */
export async function migrateLegacyCredentials(): Promise<void> {
  const manager = getCredentialManager();
  const debug = (await import('../utils/debug.ts')).debug;

  // 迁移 Claude OAuth：claude_oauth::global → llm_oauth::claude-max
  const legacyClaudeOAuth = await manager.getClaudeOAuthCredentials();
  if (legacyClaudeOAuth?.accessToken) {
    // 只有 llm_oauth::claude-max 不存在时才迁移
    const existingLlmOAuth = await manager.getLlmOAuth('claude-max');
    if (!existingLlmOAuth) {
      await manager.setLlmOAuth('claude-max', {
        accessToken: legacyClaudeOAuth.accessToken,
        refreshToken: legacyClaudeOAuth.refreshToken,
        expiresAt: legacyClaudeOAuth.expiresAt,
      });
      debug('[storage] Migrated legacy Claude OAuth to llm_oauth::claude-max');

      // 迁移成功后删除旧凭据
      // 全局凭据的 key 格式为 {type}::global
      try {
        await manager.delete({ type: 'claude_oauth' });
        debug('[storage] Deleted legacy claude_oauth::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy claude_oauth::global:', error);
      }
    }
  }

  // 迁移 Anthropic API key：anthropic_api_key::global → llm_api_key::anthropic-api
  const legacyApiKey = await manager.getApiKey();
  if (legacyApiKey) {
    // 只有 llm_api_key::anthropic-api 不存在时才迁移
    const existingLlmApiKey = await manager.getLlmApiKey('anthropic-api');
    if (!existingLlmApiKey) {
      await manager.setLlmApiKey('anthropic-api', legacyApiKey);
      debug('[storage] Migrated legacy Anthropic API key to llm_api_key::anthropic-api');

      // 迁移成功后删除旧凭据
      try {
        await manager.delete({ type: 'anthropic_api_key' });
        debug('[storage] Deleted legacy anthropic_api_key::global credential');
      } catch (error) {
        debug('[storage] Failed to delete legacy anthropic_api_key::global:', error);
      }
    }
  }
}

/**
 * 获取所有 LLM 连接。
 * 只返回用户添加的连接（不包含自动填充的内置连接）。
 *
 * 注意：本函数只读，不会修改配置。
 * 迁移请在启动时调用 migrateLegacyLlmConnectionsConfig()。
 */
export function getLlmConnections(): LlmConnection[] {
  const config = loadStoredConfig();
  if (!config) return [];

  // 尚未迁移时返回空数组 —— 调用方应在启动时调用迁移
  return config.llmConnections || [];
}

/**
 * 按 slug 获取指定 LLM 连接。
 * @param slug - 连接 slug
 * @returns 连接对象；找不到返回 null
 */
export function getLlmConnection(slug: string): LlmConnection | null {
  const connections = getLlmConnections();
  return connections.find(c => c.slug === slug) || null;
}

/**
 * 新增 LLM 连接。
 * @param connection - 要添加的连接（slug 必须唯一）
 * @returns 添加成功返回 true；slug 已存在返回 false
 */
export function addLlmConnection(connection: LlmConnection): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // 如果尚未迁移则安全地初始化为空数组（写操作的兜底）
  if (!config.llmConnections) {
    config.llmConnections = [];
  }

  // 检查重复 slug
  if (config.llmConnections.some(c => c.slug === connection.slug)) {
    return false;
  }

  // 添加连接并记录时间戳
  config.llmConnections.push({
    ...connection,
    createdAt: connection.createdAt || Date.now(),
  });

  // 添加第一个连接后确保设置默认
  ensureDefaultLlmConnection(config);

  saveConfig(config);
  return true;
}

/**
 * 更新现有 LLM 连接。
 * @param slug - 要更新的连接 slug
 * @param updates - 要应用的部分更新（slug 会被忽略）
 * @returns 更新成功返回 true；找不到返回 false
 */
export function updateLlmConnection(slug: string, updates: Partial<Omit<LlmConnection, 'slug'>>): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // 没有连接则无需更新
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  const existing = connections[index]!;
  const toModelIds = (models?: Array<{ id: string } | string>): string[] =>
    (models ?? []).map(m => typeof m === 'string' ? m : m.id);

  connections[index] = {
    // 保留现有必填字段
    slug: existing.slug,
    name: updates.name ?? existing.name,
    providerType: updates.providerType ?? existing.providerType,
    type: updates.type ?? existing.type, // 旧字段
    authType: updates.authType ?? existing.authType,
    createdAt: updates.createdAt ?? existing.createdAt,
    // 可选字段：updates 显式传了则用 updates，否则保留 existing
    baseUrl: updates.baseUrl !== undefined ? updates.baseUrl : existing.baseUrl,
    models: updates.models !== undefined ? updates.models : existing.models,
    defaultModel: updates.defaultModel !== undefined ? updates.defaultModel : existing.defaultModel,
    modelSelectionMode: updates.modelSelectionMode !== undefined ? updates.modelSelectionMode : existing.modelSelectionMode,
    // Pi auth provider
    piAuthProvider: updates.piAuthProvider !== undefined ? updates.piAuthProvider : existing.piAuthProvider,
    // 自定义端点协议（Anthropic/OpenAI 兼容）
    customEndpoint: updates.customEndpoint !== undefined ? updates.customEndpoint : existing.customEndpoint,
    // 中途发送行为（steer vs queue）—— 读取时通过 resolveMidStreamBehavior()
    midStreamBehavior: updates.midStreamBehavior !== undefined ? updates.midStreamBehavior : existing.midStreamBehavior,
    // 解析后的 Anthropic OAuth 身份（issue #838）—— 无关保存时保留
    oauthAccountUuid: updates.oauthAccountUuid !== undefined ? updates.oauthAccountUuid : existing.oauthAccountUuid,
    oauthAccountEmail: updates.oauthAccountEmail !== undefined ? updates.oauthAccountEmail : existing.oauthAccountEmail,
    oauthOrganizationUuid: updates.oauthOrganizationUuid !== undefined ? updates.oauthOrganizationUuid : existing.oauthOrganizationUuid,
    oauthOrganizationName: updates.oauthOrganizationName !== undefined ? updates.oauthOrganizationName : existing.oauthOrganizationName,
    oauthProfileVerifiedAt: updates.oauthProfileVerifiedAt !== undefined ? updates.oauthProfileVerifiedAt : existing.oauthProfileVerifiedAt,
    // 时间戳
    lastUsedAt: updates.lastUsedAt !== undefined ? updates.lastUsedAt : existing.lastUsedAt,
  };

  const updated = connections[index]!;
  if (updated.providerType === 'pi') {
    const beforeModelIds = toModelIds(existing.models);
    const afterModelIds = toModelIds(updated.models);
    const changed =
      existing.defaultModel !== updated.defaultModel ||
      existing.modelSelectionMode !== updated.modelSelectionMode ||
      !modelSetEquals(beforeModelIds, afterModelIds);

    if (changed) {
      const stack = (new Error().stack ?? '').split('\n').slice(2, 7).map(s => s.trim());
      debug('[storage] updateLlmConnection(pi) changed', {
        slug,
        before: {
          mode: existing.modelSelectionMode,
          defaultModel: existing.defaultModel,
          modelCount: beforeModelIds.length,
          modelsFirst5: beforeModelIds.slice(0, 5),
        },
        after: {
          mode: updated.modelSelectionMode,
          defaultModel: updated.defaultModel,
          modelCount: afterModelIds.length,
          modelsFirst5: afterModelIds.slice(0, 5),
        },
        updates: {
          keys: Object.keys(updates),
          defaultModel: updates.defaultModel,
          modelSelectionMode: updates.modelSelectionMode,
          modelsCount: Array.isArray(updates.models) ? updates.models.length : undefined,
        },
        stack,
      });
    }
  }

  saveConfig(config);
  return true;
}

/**
 * 删除 LLM 连接。
 * @param slug - 要删除的连接 slug
 * @returns 删除成功返回 true；找不到返回 false
 */
export function deleteLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // 没有连接则无需删除
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  connections.splice(index, 1);

  // 如果删除的是默认连接，重置为第一个剩余或清空
  if (config.defaultLlmConnection === slug) {
    config.defaultLlmConnection = connections.length > 0 ? connections[0]!.slug : undefined;
  }

  saveConfig(config);

  // 清理 workspace 对该删除连接的引用（非阻塞）
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection === slug) {
        wsConfig.defaults.defaultLlmConnection = undefined;
        saveWorkspaceConfig(ws.rootPath, wsConfig);
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace references:', error);
  }

  // 清理该连接存储的凭据（API key、OAuth token）
  // fire-and-forget，但会记录错误供调试
  const credentialManager = getCredentialManager();
  credentialManager.delete({ type: 'llm_api_key', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete API key credential for connection '${slug}':`, error);
  });
  credentialManager.delete({ type: 'llm_oauth', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete OAuth credential for connection '${slug}':`, error);
  });

  return true;
}

/**
 * 获取默认 LLM 连接 slug。
 * @returns 默认连接 slug；没有连接时返回 null
 */
export function getDefaultLlmConnection(): string | null {
  const config = loadStoredConfig();
  if (!config) return null;

  // 没有连接返回 null
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return null;
  }

  return config.defaultLlmConnection || config.llmConnections[0]?.slug || null;
}

/**
 * 设置默认 LLM 连接。
 * @param slug - 要设为默认的连接 slug
 * @returns 设置成功返回 true；连接不存在返回 false
 */
export function setDefaultLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // 没有连接则无法设置默认
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  // 验证连接存在
  if (!config.llmConnections.some(c => c.slug === slug)) {
    return false;
  }

  config.defaultLlmConnection = slug;
  saveConfig(config);
  return true;
}

/**
 * 获取新 session 的应用级默认 thinking level。
 * 未设置时回退到 bundled config-defaults。
 */
export function getDefaultThinkingLevel(): ThinkingLevel {
  const config = loadStoredConfig();
  if (config?.defaultThinkingLevel) {
    const normalized = normalizeThinkingLevel(config.defaultThinkingLevel);
    if (normalized) return normalized;
  }
  const defaults = loadConfigDefaults();
  return normalizeThinkingLevel(defaults.workspaceDefaults.thinkingLevel) ?? 'medium';
}

/**
 * 设置新 session 的应用级默认 thinking level。
 * @returns 持久化成功返回 true；配置无法加载返回 false
 */
export function setDefaultThinkingLevel(level: ThinkingLevel): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  config.defaultThinkingLevel = level;
  saveConfig(config);
  return true;
}

/**
 * 更新连接的最后使用时间戳。
 * @param slug - 连接 slug
 */
export function touchLlmConnection(slug: string): void {
  const config = loadStoredConfig();
  if (!config) return;

  // 没有连接则无需更新
  if (!config.llmConnections) return;

  const connection = config.llmConnections.find(c => c.slug === slug);
  if (connection) {
    connection.lastUsedAt = Date.now();
    saveConfig(config);
  }
}

// ============================================
// 网络代理设置
// ============================================

import type { NetworkProxySettings } from './types.ts';

/** 把代理字符串去空；空字符串视为 undefined */
function normalizeProxyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** 规范化代理设置对象 */
function normalizeNetworkProxySettings(
  settings: NetworkProxySettings,
): NetworkProxySettings {
  return {
    enabled: Boolean(settings.enabled),
    httpProxy: normalizeProxyString(settings.httpProxy),
    httpsProxy: normalizeProxyString(settings.httpsProxy),
    noProxy: normalizeProxyString(settings.noProxy),
  };
}

/**
 * 获取当前网络代理设置。
 * 未配置时返回 undefined。
 */
export function getNetworkProxySettings(): NetworkProxySettings | undefined {
  const config = loadStoredConfig();
  return config?.networkProxy;
}

/**
 * 持久化网络代理设置。
 * 代理禁用且所有字段为空时删除该 key。
 */
export function setNetworkProxySettings(settings: NetworkProxySettings): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalized = normalizeNetworkProxySettings(settings);

  // 代理禁用且所有字段为空时彻底移除该 key
  if (!normalized.enabled && !normalized.httpProxy && !normalized.httpsProxy && !normalized.noProxy) {
    delete config.networkProxy;
  } else {
    config.networkProxy = normalized;
  }

  saveConfig(config);
}

// ============================================
// Setup Deferred（用户跳过 onboarding）
// ============================================

/** 用户是否选择了“稍后设置”跳过 onboarding */
export function isSetupDeferred(): boolean {
  return loadStoredConfig()?.setupDeferred === true;
}

export function setSetupDeferred(deferred: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (deferred) {
    config.setupDeferred = true;
  } else {
    delete config.setupDeferred;
  }
  saveConfig(config);
}

// ============================================
// Tool Icons（turn card 中显示的 CLI tool 图标）
// ============================================

import { copyFileSync } from 'fs';

const TOOL_ICONS_DIR_NAME = 'tool-icons';

/**
 * 返回 tool-icons 目录路径：~/.craft-agent/tool-icons/
 */
export function getToolIconsDir(): string {
  return join(CONFIG_DIR, TOOL_ICONS_DIR_NAME);
}

/**
 * 确保 tool-icons 目录存在并包含 bundled 默认图标。
 * 自动通过 getBundledAssetsDir('tool-icons') 定位 bundled 路径。
 * 首次运行时复制 bundled tool-icons.json 和图标文件。
 * 只复制不存在的文件（保留用户自定义）。
 */
export function ensureToolIcons(): void {
  const toolIconsDir = getToolIconsDir();

  // 创建 tool-icons 目录
  if (!existsSync(toolIconsDir)) {
    mkdirSync(toolIconsDir, { recursive: true });
  }

  // 通过 shared asset resolver 定位 bundled tool-icons 目录
  const bundledToolIconsDir = getBundledAssetsDir('tool-icons');
  if (!bundledToolIconsDir) {
    return;
  }

  // 逐个复制 bundled 文件，若目标已存在则跳过
  // 包含 tool-icons.json 及所有图标文件（png、ico、svg、jpg）
  try {
    const bundledFiles = readdirSync(bundledToolIconsDir);
    for (const file of bundledFiles) {
      const destPath = join(toolIconsDir, file);
      if (!existsSync(destPath)) {
        const srcPath = join(bundledToolIconsDir, file);
        copyFileSync(srcPath, destPath);
      }
    }
  } catch {
    // 忽略错误 —— tool icons 是可选增强
  }
}

// ============================================
// Server Mode Configuration
// ============================================

import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.ts';
import { randomUUID } from 'crypto';

/**
 * 获取当前服务端配置。
 * 未配置时返回默认值副本。
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * 持久化服务端配置。
 * 首次启用且没有 token 时自动生成稳定的鉴权 token。
 */
export function setServerConfig(serverConfig: ServerConfig): void {
  const config = loadStoredConfig();
  if (!config) return;

  // 首次启用（或 token 缺失）时生成稳定 token
  if (serverConfig.enabled && !serverConfig.token) {
    serverConfig.token = randomUUID();
  }

  config.serverConfig = serverConfig;
  saveConfig(config);
}

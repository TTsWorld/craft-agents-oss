/**
 * Agent 模块统一导出入口。
 *
 * 这个文件是 @craft-agent/shared/agent 的 barrel file，
 * 把 ClaudeAgent、PiAgent、BaseAgent、core 工具、权限模式、计划、思考级别等集中导出。
 *
 * 对后端工程师来说，可以把这里理解为一个包的 `package.go`：
 * 它本身没有实现，只是重新组织子模块的导出，方便外部按一个路径 import。
 */

// ClaudeAgent（原名 CraftAgent）及兼容别名
export * from './claude-agent.ts';
export * from './conversation-summary.ts';

// PiAgent 直接导出
export { PiAgent, PiBackend } from './pi-agent.ts';
export * from './errors.ts';
export * from './options.ts';

// Session-scoped tools — 限定在某个 session 内使用的工具
export {
  // Session-scoped tools 提供者
  getSessionScopedTools,
  cleanupSessionScopedTools,
  // Plan 文件管理
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  isPathInPlansDir,
  // Session-scoped tool 通知的回调注册表
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  // 类型
  type SessionScopedToolCallbacks,
  type BrowserPaneFns,
  // 认证请求类型（统一认证流）
  type AuthRequest,
  type AuthRequestType,
  type AuthResult,
  type CredentialAuthRequest,
  type McpOAuthAuthRequest,
  type GoogleOAuthAuthRequest,
  type SlackOAuthAuthRequest,
  type MicrosoftOAuthAuthRequest,
  type CredentialInputMode,
} from './session-scoped-tools.ts';

// mode-manager — 集中式权限模式管理
export {
  // Permission Mode API（主要）
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  type PermissionMode,
  getModeState,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  initializeModeState,
  cleanupModeState,
  // Tool 阻断（集中式）
  shouldAllowToolInMode,
  blockWithReason,
  // Session state（轻量级每消息注入）
  getSessionState,
  formatSessionState,
  // Mode manager 单例（高级用例）
  modeManager,
  // Explore 模式默认规则（供 UI 展示）
  SAFE_MODE_CONFIG,
  // 类型
  type ModeState,
  type ModeCallbacks,
  type ModeConfig,
  type PermissionModeChangedBy,
} from './mode-manager.ts';

// Plan 类型与权限模式消息
export type { Plan, PlanStep, PlanState, PlanReviewRequest, PlanReviewResult } from './plan-types.ts';
export { PERMISSION_MODE_MESSAGES, PERMISSION_MODE_PROMPTS } from './plan-types.ts';

// thinking-levels — 扩展推理配置
export {
  type ThinkingLevel,
  type ThinkingLevelDefinition,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  getThinkingTokens,
  getThinkingLevelNameKey,
  isValidThinkingLevel,
} from './thinking-levels.ts';

// permissions-config — workspace/source 级别可定制权限（permissions.json）
export {
  // 解析与校验
  parsePermissionsJson,
  validatePermissionsConfig,
  PermissionsConfigSchema,
  // API endpoint 检查
  isApiEndpointAllowed,
  // 存储函数
  loadWorkspacePermissionsConfig,
  loadSourcePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  // 原始 load/save（CLI CRUD 用）
  loadRawWorkspacePermissions,
  loadRawSourcePermissions,
  saveWorkspacePermissions,
  saveSourcePermissions,
  // 应用级默认权限（~/.craft-agent/permissions/）
  getAppPermissionsDir,
  ensureDefaultPermissions,
  loadDefaultPermissions,
  // 缓存单例
  permissionsConfigCache,
  // 类型
  type ApiEndpointRule,
  type CompiledApiEndpointRule,
  type PermissionsCustomConfig,
  type PermissionsConfigFile,
  type MergedPermissionsConfig,
  type PermissionsContext,
} from './permissions-config.ts';

// BaseAgent — 所有 agent 后端的共享抽象类
export {
  BaseAgent,
  // Mini agent 配置（所有后端集中管理）
  type MiniAgentConfig,
  MINI_AGENT_TOOLS,
  MINI_AGENT_MCP_KEYS,
} from './base-agent.ts';

// backend abstraction — AI agent 统一接口，支持 Claude 和 Pi 切换
export {
  // Factory（createAgent 是推荐名，createBackend 保留兼容）
  createBackend,
  createAgent,
  detectProvider,
  getAvailableProviders,
  // 类型
  type AgentBackend,
  type AgentProvider,
  type BackendConfig,
  type PermissionCallback,
  type PlanCallback,
  type AuthCallback,
  type SourceChangeCallback,
  type SourceActivationCallback,
  type ChatOptions,
  type RecoveryMessage,
  type SdkMcpServerConfig as BackendMcpServerConfig,
  // 枚举
  AbortReason as BackendAbortReason,
} from './backend/index.ts';

// core utilities — 所有 agent 后端共享的工具
export * from './core/index.ts';

// 浏览器工具名规范化辅助函数
export {
  LEGACY_BROWSER_TOOL_ALIASES,
  normalizeCanonicalBrowserToolName,
  normalizeBrowserToolName,
  isCanonicalBrowserToolName,
  isBrowserToolNameOrAlias,
} from './browser-tool-names.ts';

// PowerShell validator root setter（Windows Electron 启动时用）
export { setPowerShellValidatorRoot } from './powershell-validator.ts';

// WS2 keep-alive: shared flag resolver + pushable streaming-input utility.
export {
  resolveKeepBackgroundTasksAlive,
  createPushableInputStream,
  type PushableInputStream,
} from './backend/claude/persistent-input.ts';

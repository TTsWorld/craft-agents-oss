/**
 * Core Agent 模块（桶文件 / barrel）。
 *
 * 【中文学习注释 - 文件级】
 * 本文件是 agent 运行时核心的统一出口：把分散在各个子模块的类/类型/常量统一 re-export，
 * 这样上层（ClaudeAgent、PiAgent）只需要 `from './core'` 一行就能拿到所有核心能力，
 * 而不必关心每个符号具体落在哪个子文件。类比 Golang：相当于一个 package 的统一 facade。
 *
 * 为所有 agent 后端（ClaudeAgent、PiAgent）提供与 provider 无关的共享功能。
 * 这些模块可以组合到任何 agent 实现中。
 *
 * Agent 概念速览（面向初学者）：
 * - permission mode：safe/ask/allow-all 三档权限模式，决定工具调用是否需要用户确认。
 * - source：外部数据源（MCP/API/local），agent 从中获取上下文或调用工具。
 * - skill：可挂载技能（SKILL.md + 配置），扩展 agent 的工具/提示词能力。
 * - session：一次对话会话，承载消息历史与运行时状态。
 * - workspace：工作区，下辖多个 session 与配置（permissions/theme/labels 等）。
 * - PreToolUse：工具调用前的预检钩子（路径展开、权限校验、元数据剥离等）。
 * - MCP：Model Context Protocol，标准化 LLM 与外部工具/数据的接入协议。
 *
 * 子模块职责：
 * - PermissionManager:        工具权限评估与权限模式管理
 * - SourceManager:            外部数据源状态追踪
 * - PromptBuilder:            System prompt 与上下文构建
 * - PathProcessor:            路径展开与规范化
 * - ConfigValidator:          写配置前的格式校验
 * - ConfigWatcherManager:     配置文件热重载监听
 * - SessionLifecycleManager:  会话状态与中止处理
 * - UsageTracker:             Token 用量与上下文窗口追踪
 * - PrerequisiteManager:      前置阅读强制（如使用 source 工具前先读 guide.md）
 *
 * TS 语法提示：`export type { ... }` 只导出类型（编译后消失），
 * `export { ... }` 导出运行时值（类/函数/常量），
 * `export { type X, Y }` 在同一条语句里混合导出类型与值。
 */

// ---- 类型：core 自身定义 ----
export type {
  RecoveryMessage,
  PermissionManagerConfig,
  ToolPermissionResult,
  SourceManagerConfig,
  PromptBuilderConfig,
  ContextBlockOptions,
  PathProcessorConfig,
  ConfigValidatorConfig,
  ConfigValidationResult,
  ConfigFileType,
  // 从 mode-types 重导出（权限模式相关类型）
  PermissionMode,
  ModeConfig,
  CompiledApiEndpointRule,
  CompiledBashPattern,
  MismatchAnalysis,
  PermissionPaths,
  // 从 mode-manager 重导出（工具检查结果类型）
  ToolCheckResult,
} from './types.ts';

// ---- 类型：Config Watcher Manager ----
export type {
  ConfigWatcherManagerCallbacks,
  ConfigWatcherManagerConfig,
} from './config-watcher-manager.ts';

// ---- 类型与枚举：Session Lifecycle ----
export type {
  SessionState,
  SessionLifecycleConfig,
} from './session-lifecycle.ts';
export { AbortReason } from './session-lifecycle.ts';

// ---- 类型：Usage Tracker ----
export type {
  MessageUsage,
  SessionUsage,
  UsageUpdate,
  UsageTrackerConfig,
} from './usage-tracker.ts';

// ---- 常量：权限模式相关 ----
export {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from './types.ts';

// ---- 类：Permission Manager（权限门卫）----
export { PermissionManager } from './permission-manager.ts';

// ---- 类：Source Manager（数据源状态追踪）----
export { SourceManager } from './source-manager.ts';

// ---- 类：Prompt Builder（system prompt 与上下文构建）----
export { PromptBuilder } from './prompt-builder.ts';

// ---- 类与工具函数：Path Processor（路径处理）----
export {
  PathProcessor,
  expandPath,
  normalizePath,
  pathStartsWith,
  toPortablePath,
} from './path-processor.ts';

// ---- 类：Config Validator（写前校验）----
export { ConfigValidator } from './config-validator.ts';

// ---- 类与工厂：Config Watcher Manager（热重载监听）----
export {
  ConfigWatcherManager,
  createConfigWatcherManager,
} from './config-watcher-manager.ts';

// ---- 类与工厂：Session Lifecycle（会话生命周期）----
export {
  SessionLifecycleManager,
  createSessionLifecycleManager,
} from './session-lifecycle.ts';

// ---- 类与工厂：Usage Tracker（Token 用量追踪）----
export {
  UsageTracker,
  createUsageTracker,
} from './usage-tracker.ts';

// ---- PreToolUse 工具集（工具调用前的预检：路径展开/skill 名解析/元数据剥离/写前校验）----
export {
  type PreToolUseContext,
  type PathExpansionResult,
  type SkillQualificationResult,
  type MetadataStrippingResult,
  type ConfigValidationResult as PreToolUseConfigValidationResult,
  type PreToolUseCheckResult,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
  BUILT_IN_TOOLS,
  FILE_PATH_TOOLS,
  CONFIG_WRITE_TOOLS,
  expandToolPaths,
  qualifySkillName,
  stripToolMetadata,
  stripMcpMetadata,
  validateConfigWrite,
  runPreToolUseChecks,
  shouldPromptInAskMode,
} from './pre-tool-use.ts';

// ---- 类与类型：Prerequisite Manager（前置条件强制）----
export { PrerequisiteManager } from './prerequisite-manager.ts';
export type {
  PrerequisiteRule,
  PrerequisiteCheckResult,
  PrerequisiteManagerConfig,
} from './prerequisite-manager.ts';

// ---- 常量：renderer 里用于 mention 识别的 skill plugin 名 ----
export { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';

// ---- RTK detector：RTK 增益路径探测与状态查询 ----
export { getRtkPath, getRtkStatus, getRtkGain, resetRtkPathCache } from './rtk-detector.ts';
export type { RtkStatus, RtkGainStats } from './rtk-detector.ts';

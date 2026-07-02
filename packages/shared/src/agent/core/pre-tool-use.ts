/**
 * 共享的 PreToolUse（工具调用前）工具函数与集中式 PreToolUse 流水线。
 *
 * 概念背景（给 Go 背景的同学）：
 * - 在 Agent / tool use 体系里，"PreToolUse 钩子"是 SDK 在真正执行某个工具前
 *   调用的一次回调，用来做权限校验、参数改写或拦截。类似 Go HTTP 中间件。
 * - 各 agent 后端（Claude、Pi）把自己 SDK 特有的输入归一化后，统一调用
 *   `runPreToolUseChecks()`，再把这个函数返回的判别联合（discriminated union）
 *   结果翻译回各自 SDK 期望的格式。Pi 后端承载 OpenAI / Copilot / Bedrock 等
 *   非 Anthropic 模型，因此它们自动复用同一套校验逻辑。
 *
 * 流水线步骤：
 * 1. 权限模式检查：根据当前模式（safe/ask/allow-all）拦截不被允许的工具
 * 2. Source 拦截：拦截来自未激活 MCP source 的工具
 * 3. 前置条件检查：在阅读 guide.md 之前拦截 source 工具
 * 4. call_llm 检测：拦截 mcp__session__call_llm
 * 5. 输入改写：路径展开、配置文件校验、skill 全限定、元数据剥离
 * 6. Ask 模式提示决策：判断是否需要用户确认
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { expandPath } from '../../utils/paths.ts';
import {
  detectConfigFileType,
  detectAppConfigFileType,
  validateConfigFileContent,
  formatValidationResult,
  type ConfigFileDetection,
} from '../../config/validators.ts';
import {
  CLI_DOMAIN_POLICIES,
  CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES,
  CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES,
  type CliDomainNamespace,
} from '../../config/cli-domains.ts';
import { FEATURE_FLAGS } from '../../feature-flags.ts';
import { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';
import { GLOBAL_AGENT_SKILLS_DIR, PROJECT_AGENT_SKILLS_DIR } from '../../skills/storage.ts';
import {
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  isReadOnlyBashCommandWithConfig,
  getPermissionModeDiagnostics,
  PERMISSION_MODE_CONFIG,
  type PermissionMode,
} from '../mode-manager.ts';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';
import type { PrerequisiteCheckResult } from './prerequisite-manager.ts';
import { rewriteBashWithRtk } from './rtk-rewrite.ts';

// ============================================================
// 类型定义
// ============================================================

/** 单次 PreToolUse 调用上下文（工作区根、workspace id、调试回调） */
export interface PreToolUseContext {
  /** 当前工作目录或 workspace 根路径 */
  workspaceRootPath: string;
  /** 用于 skill 全限定的 workspace ID */
  workspaceId: string;
  /** 可选调试回调 */
  onDebug?: (message: string) => void;
}

/** 路径展开结果：标记是否修改以及最终输入 */
export interface PathExpansionResult {
  /** 是否修改过路径 */
  modified: boolean;
  /** 更新后的 input（未修改则为原 input） */
  input: Record<string, unknown>;
}

/** skill 名称全限定结果 */
export interface SkillQualificationResult {
  /** skill 名称是否被改写 */
  modified: boolean;
  /** 更新后的 input */
  input: Record<string, unknown>;
}

/** 元数据剥离结果（去掉 _intent / _displayName 等 UI 专用字段） */
export interface MetadataStrippingResult {
  /** 是否剥离过字段 */
  modified: boolean;
  /** 清理后的 input */
  input: Record<string, unknown>;
}

/** 配置文件写入校验结果 */
export interface ConfigValidationResult {
  /** 是否通过校验 */
  valid: boolean;
  /** 校验失败时的错误信息 */
  error?: string;
}

// ============================================================
// 内建工具
// ============================================================

/** SDK 内建工具名集合；这些工具不应被剥离元数据 */
export const BUILT_IN_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'SubmitPlan',
  'Skill',
  'SlashCommand',
  'TaskStop',
]);

/** 操作文件路径的工具 */
export const FILE_PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
]);

/** 可以写入配置文件的工具 */
export const CONFIG_WRITE_TOOLS = new Set(['Write', 'Edit']);

/** labels 域禁止使用的文件工具 */
export const LABELS_BLOCKED_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);


// ============================================================
// 路径展开
// ============================================================

/**
 * 展开文件工具入参中的 ~ 路径。
 *
 * 处理多种路径参数：
 * - file_path：Read、Write、Edit、MultiEdit 使用
 * - notebook_path：NotebookEdit 使用
 * - path：Glob、Grep 使用
 *
 * @param toolName - SDK 工具名
 * @param input - 工具入参对象
 * @param onDebug - 可选调试回调
 * @returns 含 modified 标记与更新后 input 的 PathExpansionResult
 */
export function expandToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): PathExpansionResult {
  if (!FILE_PATH_TOOLS.has(toolName)) {
    return { modified: false, input };
  }

  let updatedInput: Record<string, unknown> | null = null;

  // 如果存在 file_path 且以 ~ 开头则展开
  if (typeof input.file_path === 'string' && input.file_path.startsWith('~')) {
    const expandedPath = expandPath(input.file_path);
    onDebug?.(`Expanding path: ${input.file_path} → ${expandedPath}`);
    updatedInput = { ...input, file_path: expandedPath };
  }

  // 如果存在 notebook_path 且以 ~ 开头则展开
  if (typeof input.notebook_path === 'string' && input.notebook_path.startsWith('~')) {
    const expandedPath = expandPath(input.notebook_path);
    onDebug?.(`Expanding notebook path: ${input.notebook_path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), notebook_path: expandedPath };
  }

  // 如果存在 path 且以 ~ 开头则展开（针对 Glob、Grep）
  if (typeof input.path === 'string' && input.path.startsWith('~')) {
    const expandedPath = expandPath(input.path);
    onDebug?.(`Expanding search path: ${input.path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), path: expandedPath };
  }

  return {
    modified: updatedInput !== null,
    input: updatedInput || input,
  };
}

// ============================================================
// Skill 名称全限定
// ============================================================

/**
 * 确保 skill 名称带上正确的插件前缀，成为全限定名。
 *
 * SDK 以 `pluginName:skillSlug` 形式解析 skill，其中 pluginName 来自
 * `.claude-plugin/plugin.json` 的 `name` 字段。skill 可存在于 3 个层级：
 *   1. Workspace：{workspaceRoot}/skills/{slug}/ → plugin name 来自 plugin.json
 *   2. Project：  {workingDir}/.agents/skills/{slug}/ → plugin name = ".agents"
 *   3. Global：   ~/.agents/skills/{slug}/ → plugin name = ".agents"
 *
 * 本函数通过检查 skill 实际落在哪个目录，把裸 slug 解析为正确的插件前缀；
 * 同时会修正被 UI 错误全限定的 skill（UI 总是用 workspace slug，即使对 global/project skill 也是如此）。
 *
 * @param input - Skill 工具入参（{ skill: string, args?: string }）
 * @param workspaceSlug - workspace slug（来自 .claude-plugin/plugin.json 的 name）
 * @param workspaceRootPath - workspace 根目录绝对路径
 * @param workingDirectory - 当前工作目录绝对路径（可选）
 * @param onDebug - 可选调试回调
 * @returns 含 modified 标记与更新后 input 的 SkillQualificationResult
 */
export function qualifySkillName(
  input: Record<string, unknown>,
  workspaceSlug: string,
  workspaceRootPath?: string,
  workingDirectory?: string,
  onDebug?: (message: string) => void
): SkillQualificationResult {
  const skill = input.skill as string | undefined;
  if (!skill) return { modified: false, input };

  // 提取裸 slug：去掉已有的插件前缀（例如 "CraftAgentWS:commit" → "commit"）
  const bareSlug = skill.includes(':') ? skill.split(':').pop()! : skill;
  if (!bareSlug) return { modified: false, input };

  // 如果没有 workspace 根路径，则回退到仅按 workspace 简单全限定
  if (!workspaceRootPath) {
    if (skill.includes(':')) return { modified: false, input };
    const qualifiedSkill = `${workspaceSlug}:${skill}`;
    onDebug?.(`Skill tool: qualified "${skill}" → "${qualifiedSkill}" (legacy fallback)`);
    return { modified: true, input: { ...input, skill: qualifiedSkill } };
  }

  // 通过检查 SKILL.md 存在性判断该 skill 属于哪个插件层级
  const resolvedSkill = resolveSkillPlugin(bareSlug, workspaceSlug, workspaceRootPath, workingDirectory);

  if (resolvedSkill === skill) {
    // 已经正确全限定
    return { modified: false, input };
  }

  onDebug?.(`Skill tool: qualified "${skill}" → "${resolvedSkill}"`);
  return {
    modified: true,
    input: { ...input, skill: resolvedSkill },
  };
}

/**
 * 通过检查 skill 实际位于哪个插件目录，把裸 slug 解析为 plugin:slug 全限定名。
 */
function resolveSkillPlugin(
  bareSlug: string,
  workspaceSlug: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string {
  // 优先级与 loadAllSkills 一致：project（最高）> workspace > global（最低）

  // 1. Project: {workingDir}/.agents/skills/{slug}/SKILL.md
  if (workingDirectory && existsSync(join(workingDirectory, PROJECT_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // 2. Workspace: {workspaceRoot}/skills/{slug}/SKILL.md
  if (existsSync(join(workspaceRootPath, 'skills', bareSlug, 'SKILL.md'))) {
    return `${workspaceSlug}:${bareSlug}`;
  }

  // 3. Global: ~/.agents/skills/{slug}/SKILL.md
  if (existsSync(join(GLOBAL_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // 兜底：假设为 workspace 插件（保持原有行为）
  return `${workspaceSlug}:${bareSlug}`;
}

// ============================================================
// MCP 元数据剥离
// ============================================================

/**
 * 从工具入参中剥除 _intent 与 _displayName 元数据。
 *
 * 这些字段由网络拦截器注入到所有工具 schema，供 Claude 提供语义意图并在 UI 展示。
 * 执行前必须剥除，否则会导致 SDK 校验失败或 MCP server 拒绝。
 *
 * UI 提取这些字段的逻辑在 tool-matching.ts 中，发生在本剥离之前。
 *
 * @param toolName - 工具名
 * @param input - 工具入参对象
 * @param onDebug - 可选调试回调
 * @returns 含 modified 标记与清理后 input 的 MetadataStrippingResult
 */
export function stripToolMetadata(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): MetadataStrippingResult {
  const hasMetadata = '_intent' in input || '_displayName' in input;

  if (!hasMetadata) {
    return { modified: false, input };
  }

  // 剥除元数据字段
  const { _intent, _displayName, ...cleanInput } = input;
  onDebug?.(`Stripped tool metadata from ${toolName}: _intent=${!!_intent}, _displayName=${!!_displayName}`);

  return {
    modified: true,
    input: cleanInput,
  };
}

/**
 * @deprecated 请改用 stripToolMetadata。保留此别名仅为向后兼容。
 */
export const stripMcpMetadata = stripToolMetadata;

// ============================================================
// 配置文件校验
// ============================================================

/**
 * 在配置文件真正落盘前校验写入内容。
 *
 * 针对 workspace 配置文件的 Write/Edit 操作，先校验最终内容再允许写入，
 * 防止非法配置到达磁盘。
 *
 * 校验范围：
 * - sources/{slug}/config.json
 * - skills/{slug}/SKILL.md
 * - statuses/config.json
 * - permissions.json
 * - theme.json
 * - tool-icons/tool-icons.json
 *
 * @param toolName - 'Write' 或 'Edit'
 * @param input - 工具入参（已展开路径）
 * @param workspaceRootPath - 用于识别配置类型的 workspace 根路径
 * @param onDebug - 可选调试回调
 * @returns 含 valid 标记与可选 error 的 ConfigValidationResult
 */
export function validateConfigWrite(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  onDebug?: (message: string) => void
): ConfigValidationResult {
  if (!CONFIG_WRITE_TOOLS.has(toolName)) {
    return { valid: true };
  }

  const filePath = input.file_path as string | undefined;
  if (!filePath) {
    return { valid: true };
  }

  // 先检查 workspace 级配置，再检查 app 级配置
  const detection: ConfigFileDetection | null =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);

  if (!detection) {
    // 不是配置文件，直接放行
    return { valid: true };
  }

  let contentToValidate: string | null = null;

  if (toolName === 'Write') {
    // Write 工具的完整文件内容在 input.content 中
    contentToValidate = input.content as string;
  } else if (toolName === 'Edit') {
    // Edit 工具：在现有文件内容上模拟替换
    try {
      const currentContent = readFileSync(filePath, 'utf-8');
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = input.replace_all as boolean | undefined;
      contentToValidate = replaceAll
        ? currentContent.replaceAll(oldString, newString)
        : currentContent.replace(oldString, newString);
    } catch {
      // 文件尚不存在或无法读取，跳过校验
      // (Write tool will create it; Edit will fail on its own)
      return { valid: true };
    }
  }

  if (!contentToValidate) {
    return { valid: true };
  }

  const validationResult = validateConfigFileContent(detection, contentToValidate);

  if (validationResult && !validationResult.valid) {
    onDebug?.(
      `Config validation blocked ${toolName} to ${detection.displayFile}: ${validationResult.errors.length} errors`
    );
    return {
      valid: false,
      error: `Cannot write invalid config to ${detection.displayFile}.\n\n${formatValidationResult(validationResult)}\n\nFix the errors above and try again.`,
    };
  }

  return { valid: true };
}

/**
 * 为某个 CLI 域构造“请改用 craft-agent 命令”的拦截提示。
 */
function buildCliDomainBlockMessage(namespace: CliDomainNamespace, context: string): string {
  const policy = CLI_DOMAIN_POLICIES[namespace]
  const noun = namespace === 'automation' ? 'automation' : namespace
  const quickExamplesHeading = namespace === 'label' ? 'Quick examples:' : 'Examples:'

  return [
    `${context}`,
    `Use \`craft-agent ${namespace} ...\` instead.`,
    `Run \`${policy.helpCommand}\` for the full ${noun} command reference.`,
    '',
    quickExamplesHeading,
    ...policy.quickExamples.map(example => `  ${example}`),
  ].join('\n')
}

/**
 * 获取文件相对于 workspace 根目录的路径；不在 workspace 内返回 null。
 */
function getWorkspaceRelativePath(
  filePath: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string | null {
  const normalizedWorkspaceRoot = resolve(workspaceRootPath).replace(/\\/g, '/').replace(/\/?$/, '/');
  const resolvedPath = filePath.startsWith('/')
    ? resolve(filePath)
    : resolve(workingDirectory ?? workspaceRootPath, filePath);
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedWorkspaceRoot)) return null;

  return normalizedPath.slice(normalizedWorkspaceRoot.length);
}

/**
 * 判断相对路径是否匹配某个 scope 规则（支持 /**、*、精确匹配）。
 */
function matchesPathScope(relativePath: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3)
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  if (scope.includes('*')) {
    const escaped = scope
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]+')
    return new RegExp(`^${escaped}$`).test(relativePath)
  }

  return relativePath === scope
}

/**
 * 根据配置文件探测结果识别对应的 CLI domain namespace。
 */
function detectCliNamespaceFromConfigDetection(detection: ConfigFileDetection): CliDomainNamespace | null {
  if (detection.type === 'labels') return 'label'
  if (detection.type === 'automations') return 'automation'
  if (detection.type === 'source') return 'source'
  if (detection.type === 'skill') return 'skill'
  return null
}

/**
 * 对特定配置域强制使用 CLI 命令，而非直接文件操作。
 * - labels/**：严格拦截 Read/Write/Edit
 * - sources/{slug}/config.json：Write/Edit 时重定向到 CLI
 * - skills/{slug}/SKILL.md：Write/Edit 时重定向到 CLI
 * - automations.json：Write/Edit 时重定向到 CLI
 */
export function getConfigCliRedirect(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const filePath = input.file_path as string | undefined;

  if (filePath && LABELS_BLOCKED_FILE_TOOLS.has(toolName)) {
    const relativePath = getWorkspaceRelativePath(filePath, workspaceRootPath, workingDirectory)
    if (relativePath) {
      const labelsScopeMatch = CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES.find(
        entry => entry.namespace === 'label' && matchesPathScope(relativePath, entry.scope)
      )
      if (labelsScopeMatch) {
        return {
          message: buildCliDomainBlockMessage(
            'label',
            `Direct ${toolName} operations in labels/ are blocked.`
          ),
        }
      }
    }
  }

  if (!CONFIG_WRITE_TOOLS.has(toolName)) return null;
  if (!filePath) return null;

  const detection =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);
  if (!detection) return null;

  const namespace = detectCliNamespaceFromConfigDetection(detection)
  if (!namespace) return null

  return {
    message: buildCliDomainBlockMessage(
      namespace,
      `Direct ${toolName} operations in ${detection.displayFile} are blocked.`
    ),
  }
}

/**
 * 拦截直接操作受保护配置路径的 Bash 命令，除非使用 craft-agent 命令。
 * Bash 中当前受保护的域在共享 CLI domain policy 中声明。
 */
export function getConfigDomainBashRedirect(
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;

  if (/^craft-agent\s+(label|automation|source|skill)\b/.test(command)) {
    return null;
  }

  const baseDir = resolve(workingDirectory ?? workspaceRootPath);
  const tokenRegex = /'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidate) continue;
    if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.endsWith('.json') && !candidate.endsWith('.jsonl')) {
      continue;
    }
    candidates.push(candidate);
  }

  const bashGuardEntries: Array<{ namespace: CliDomainNamespace; scope: string }> = CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES

  for (const candidate of candidates) {
    const relativePath = getWorkspaceRelativePath(candidate, workspaceRootPath, baseDir);
    if (!relativePath) continue;

    for (const entry of bashGuardEntries) {
      if (!matchesPathScope(relativePath, entry.scope)) continue

      const context = entry.namespace === 'label'
        ? 'Direct Bash operations targeting the workspace labels/ folder are blocked.'
        : `Direct Bash operations targeting \`${relativePath}\` are blocked.`

      return {
        message: buildCliDomainBlockMessage(entry.namespace, context),
      }
    }
  }

  return null;
}

// ============================================================
// 集中式 PreToolUse 流水线
// ============================================================

/**
 * `runPreToolUseChecks()` 返回的可辨识联合类型结果。
 * 各 agent 后端通过简单的 switch 把它翻译成各自 SDK 所需的格式。
 */
export type PreToolUseCheckResult =
  | { type: 'allow' }
  | { type: 'modify'; input: Record<string, unknown> }
  | { type: 'block'; reason: string; source?: 'prerequisite' }
  | {
      type: 'prompt';
      promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
      description: string;
      command?: string;
      modifiedInput?: Record<string, unknown>;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
    }
  | { type: 'source_activation_needed'; sourceSlug: string; sourceExists: boolean }
  | { type: 'call_llm_intercept'; input: Record<string, unknown> }
  | { type: 'spawn_session_intercept'; input: Record<string, unknown> };

/**
 * `runPreToolUseChecks()` 的输入。各 agent 从各自 SDK 的 hook 入参构造此对象，
 * 流水线所需的所有字段都在这里做了归一化。
 */
export interface PreToolUseInput {
  /** SDK-normalized tool name (PascalCase for built-in, mcp__server__tool for MCP) */
  toolName: string;
  /** Tool input object */
  input: Record<string, unknown>;
  /** Current session ID */
  sessionId: string;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Absolute path to workspace root */
  workspaceRootPath: string;
  /** Workspace ID or slug for skill qualification */
  workspaceId: string;
  /** Plans folder path for the session (writes allowed in explore mode) */
  plansFolderPath?: string;
  /** Data folder path (writes allowed in explore mode for transform_data output) */
  dataFolderPath?: string;
  /** Working directory override (for skill resolution) */
  workingDirectory?: string;
  /** Currently active source slugs */
  activeSourceSlugs: string[];
  /** All available sources (for source-exists check) */
  allSourceSlugs: string[];
  /** Whether the agent supports source activation (has onSourceActivationRequest callback) */
  hasSourceActivation: boolean;
  /** PermissionManager for session-scoped whitelists */
  permissionManager: PermissionManagerLike;
  /** PrerequisiteManager for guide.md checking */
  prerequisiteManager?: PrerequisiteManagerLike;
  /** Backend metadata (e.g. Pi forwards intent / displayName via input.metadata) */
  backendMetadata?: { intent?: string; displayName?: string };
  /** RTK Bash-rewrite context (undefined when toggle is off or rtk binary missing) */
  rtkContext?: import('./rtk-rewrite.ts').RtkContext;
  /** Debug callback */
  onDebug?: (message: string) => void;
}

/**
 * runPreToolUseChecks() 依赖的 PermissionManager 最小接口。
 * 这样流水线测试时无需引入完整的 PermissionManager。
 */
export interface PermissionManagerLike {
  isCommandWhitelisted(command: string): boolean;
  isDangerousCommand(command: string): boolean;
  getBaseCommand(command: string): string;
  extractDomainFromNetworkCommand(command: string): string | null;
  isDomainWhitelisted(domain: string): boolean;
}

/**
 * PrerequisiteManager 的最小接口。
 */
export interface PrerequisiteManagerLike {
  checkPrerequisites(toolName: string): PrerequisiteCheckResult;
  trackBashSkillRead(input: Record<string, unknown>): boolean;
}

/** Built-in MCP servers that are always available (not user sources) */
const BUILT_IN_MCP_SERVERS = new Set(['session', 'craft-agents-docs']);

/** File write tools that require permission in ask mode */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * 把权限模式上下文（有效模式、模式变更来源与时间）追加到拦截原因中。
 */
function withPermissionModeContext(reason: string, sessionId: string, effectiveMode: PermissionMode): string {
  if (reason.includes('Effective mode:')) return reason;

  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const modeDisplayName = PERMISSION_MODE_CONFIG[effectiveMode]?.displayName ?? effectiveMode;
  return [
    reason,
    '',
    `Effective mode: ${modeDisplayName}`,
    `Last mode change: ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (modeVersion=${diagnostics.modeVersion})`,
  ].join('\n');
}

/**
 * 集中式 PreToolUse 流水线。
 *
 * 除最终结果外均为同步执行：所有异步工作（source 激活、用户弹窗）都由调用方
 * 根据返回结果类型自行处理。
 *
 * 流水线步骤：
 * 1. 权限模式检查（shouldAllowToolInMode）
 * 2. Source 拦截（未激活的 MCP source）
 * 3. 前置条件检查（source 工具使用前必须先读 guide.md）
 * 4. call_llm 拦截
 * 5. 输入改写（路径、配置校验、skill、元数据）
 * 6. ask 模式弹窗决策
 *
 * @returns agent 翻译成其 SDK 格式的可辨识联合类型
 */
export function runPreToolUseChecks(ctx: PreToolUseInput): PreToolUseCheckResult {
  const {
    toolName,
    input,
    sessionId,
    permissionMode,
    workspaceRootPath,
    workspaceId,
    plansFolderPath,
    dataFolderPath,
    workingDirectory,
    activeSourceSlugs,
    allSourceSlugs,
    hasSourceActivation,
    permissionManager,
    prerequisiteManager,
    backendMetadata,
    onDebug,
  } = ctx;

  // 为自定义 permissions.json 规则构造权限上下文
  const permissionsContext: PermissionsContext = {
    workspaceRootPath,
    activeSourceSlugs,
  };

  // 本会话权限模式的权威来源。
  // 仅把传入的 permissionMode 用于不一致诊断。
  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const effectivePermissionMode = diagnostics.permissionMode;

  if (permissionMode !== effectivePermissionMode) {
    onDebug?.(
      `[ModeSync] sessionId=${sessionId} incomingMode=${permissionMode} effectiveMode=${effectivePermissionMode} ` +
      `modeVersion=${diagnostics.modeVersion} changedBy=${diagnostics.lastChangedBy} changedAt=${diagnostics.lastChangedAt}`
    );
  }

  // ============================================================
  // 1. PERMISSION MODE CHECK
  // ============================================================
  const modeResult = shouldAllowToolInMode(
    toolName,
    input,
    effectivePermissionMode,
    { plansFolderPath, dataFolderPath, permissionsContext }
  );

  if (!modeResult.allowed) {
    const reasonWithContext = withPermissionModeContext(modeResult.reason, sessionId, effectivePermissionMode);
    onDebug?.(`Permission mode ${effectivePermissionMode}: blocking ${toolName} — ${reasonWithContext}`);
    return { type: 'block', reason: reasonWithContext };
  }

  // ============================================================
  // 2. SOURCE BLOCKING (inactive MCP sources)
  // ============================================================
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1];
    if (parts.length >= 3 && serverName && !BUILT_IN_MCP_SERVERS.has(serverName)) {
      const isActive = activeSourceSlugs.includes(serverName);
      if (!isActive) {
        const sourceExists = allSourceSlugs.includes(serverName);
        onDebug?.(`Source "${serverName}" not active (exists=${sourceExists}, hasActivation=${hasSourceActivation})`);
        return {
          type: 'source_activation_needed',
          sourceSlug: serverName,
          sourceExists,
        };
      }
    }
  }

  // ============================================================
  // 3. PREREQUISITE CHECK (guide.md before source tools)
  // ============================================================
  if (prerequisiteManager) {
    // 如果 Bash 正在读某个待读 skill 文件，则放行（这会清除前置条件）
    if (toolName === 'Bash' && prerequisiteManager.trackBashSkillRead(input)) {
      // 前置条件已清除，继续执行后续流水线步骤
    } else {
      const prereqResult = prerequisiteManager.checkPrerequisites(toolName);
      if (!prereqResult.allowed) {
        return { type: 'block', reason: prereqResult.blockReason!, source: 'prerequisite' };
      }
    }
  }

  // ============================================================
  // 4. CALL_LLM / SPAWN_SESSION INTERCEPTION
  // ============================================================
  if (toolName === 'mcp__session__call_llm') {
    return { type: 'call_llm_intercept', input };
  }
  if (toolName === 'mcp__session__spawn_session') {
    return { type: 'spawn_session_intercept', input };
  }

  // ============================================================
  // 5. INPUT TRANSFORMS
  // ============================================================
  let currentInput = input;
  let wasModified = false;

  // 5a. Path expansion
  const pathResult = expandToolPaths(toolName, currentInput, onDebug);
  if (pathResult.modified) {
    currentInput = pathResult.input;
    wasModified = true;
  }

  // 5b. Config-domain Bash guard (block direct labels/automations path operations unless using craft-agent)
  if (FEATURE_FLAGS.craftAgentsCli && toolName === 'Bash') {
    const configDomainBashRedirect = getConfigDomainBashRedirect(currentInput, workspaceRootPath, workingDirectory);
    if (configDomainBashRedirect) {
      return { type: 'block', reason: configDomainBashRedirect.message };
    }
  }

  // 5c. Config file validation
  const configResult = validateConfigWrite(toolName, currentInput, workspaceRootPath, onDebug);
  if (!configResult.valid) {
    return { type: 'block', reason: configResult.error! };
  }

  // 5d. Config file CLI redirect (labels + automations)
  if (FEATURE_FLAGS.craftAgentsCli) {
    const cliRedirect = getConfigCliRedirect(toolName, currentInput, workspaceRootPath, workingDirectory);
    if (cliRedirect) {
      return { type: 'block', reason: cliRedirect.message };
    }
  }

  // 5e. Skill qualification
  if (toolName === 'Skill') {
    const skillResult = qualifySkillName(
      currentInput,
      workspaceId,
      workspaceRootPath,
      workingDirectory,
      onDebug
    );
    if (skillResult.modified) {
      currentInput = skillResult.input;
      wasModified = true;
    }
  }

  // 5f. Metadata stripping
  const metadataResult = stripToolMetadata(toolName, currentInput, onDebug);
  if (metadataResult.modified) {
    currentInput = metadataResult.input;
    wasModified = true;
  }

  // 5g. RTK Bash rewrite (last input transform — flows into both 'modify' and 'prompt' results).
  // 上面的权限判定和下面的 ask 模式弹窗都基于
  // 原始的 input 参数进行，因此 LLM 仍认为它执行的是原始命令
  // ；权限系统只拦截原始命令——只有
  // SDK 实际执行时才会看到重写后的命令。
  if (ctx.rtkContext?.enabled && ctx.rtkContext.path) {
    const rtkResult = rewriteBashWithRtk(
      toolName,
      currentInput,
      ctx.rtkContext.path,
      ctx.rtkContext.exclude,
      onDebug,
    );
    if (rtkResult.modified) {
      currentInput = rtkResult.input;
      wasModified = true;
    }
  }

  // ============================================================
  // 6. ASK MODE PROMPT DECISION
  // ============================================================
  if (effectivePermissionMode === 'ask') {
    const promptInfo = shouldPromptInAskMode(
      toolName,
      input, // Use original input for permission decisions (before stripping)
      permissionManager,
      permissionsContext,
      plansFolderPath,
      onDebug,
    );
    if (promptInfo) {
      const adminWrappedInput =
        promptInfo.promptType === 'admin_approval' &&
        promptInfo.command &&
        typeof currentInput.command === 'string' &&
        process.platform === 'darwin'
          ? { ...currentInput, command: wrapCommandForMacAdminPrompt(promptInfo.command) }
          : undefined;

      return {
        type: 'prompt',
        promptType: promptInfo.promptType,
        description: promptInfo.description,
        command: promptInfo.command,
        modifiedInput: adminWrappedInput ?? (wasModified ? currentInput : undefined),
        appName: promptInfo.appName,
        reason: promptInfo.reason,
        impact: promptInfo.impact,
        requiresSystemPrompt: promptInfo.requiresSystemPrompt,
        rememberForMinutes: promptInfo.rememberForMinutes,
        commandHash: promptInfo.commandHash,
        approvalTtlSeconds: promptInfo.approvalTtlSeconds,
      };
    }
  }

  // ============================================================
  // 返回结果
  // ============================================================
  if (wasModified) {
    return { type: 'modify', input: currentInput };
  }
  return { type: 'allow' };
}

// ============================================================
// ask 模式弹窗决策（跨后端统一）
// ============================================================

/**
 * ask 模式下需要向用户展示的提示信息。
 */
interface PromptInfo {
  promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
  description: string;
  command?: string;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}

/**
 * 用 SHA-256 对命令做哈希，用于“记住本次批准”。
 */
function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

/**
 * 把命令 token 转成更友好的展示名称（如 brew-cask → Brew Cask）。
 */
function toDisplayName(token: string): string {
  return token.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * 判断某命令是否需要 macOS 管理员授权弹窗；命中则返回提示信息。
 */
function classifyAdminApproval(command: string): PromptInfo | null {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();

  const brewInstallCask = normalized.match(/^brew\s+install\s+--cask\s+([^\s]+).*$/);
  if (brewInstallCask) {
    const appToken = brewInstallCask[1] ?? 'application';
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask install: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to complete post-install steps.',
      impact: 'May install files in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  const brewUpgradeCask = normalized.match(/^brew\s+upgrade\s+--cask\s+([^\s]+).*$/);
  if (brewUpgradeCask) {
    const appToken = brewUpgradeCask[1] ?? 'application';
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask upgrade: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to replace app files in protected locations.',
      impact: 'May replace app binaries in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  if (/^installer\s+-pkg\s+.+\s+-target\s+\//.test(normalized)) {
    return {
      promptType: 'admin_approval',
      description: 'Admin approval required for macOS installer package',
      command: trimmed,
      appName: 'Installer Package',
      reason: 'The installer writes files to protected system locations.',
      impact: 'May install system services, app files, or startup items.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 5,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  return null;
}

/**
 * 把命令包装成 `osascript` 管理员权限执行形式（仅 macOS）。
 */
function wrapCommandForMacAdminPrompt(command: string): string {
  // 为 AppleScript shell 字符串转义：\ → \\, " → \", $ → \$
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');

  return `osascript -e 'do shell script "${escaped}" with administrator privileges'`;
}

/**
 * 判断 ask 模式下是否需要用户批准。
 *
 * 如果需要询问则返回 prompt 信息，可自动放行则返回 null。
 * 这是所有 agent 后端 ask 模式决策的唯一真相来源。
 * `shouldAllowToolInMode()` 在 ask 模式下总是返回 `{allowed: true}`，
 * 因此弹窗决策放在这里，而不是从权限检查中推断。
 */
export function shouldPromptInAskMode(
  toolName: string,
  input: Record<string, unknown>,
  permissionManager: PermissionManagerLike,
  permissionsContext: PermissionsContext,
  plansFolderPath?: string,
  onDebug?: (message: string) => void,
): PromptInfo | null {

  // --- 文件写入 ---
  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (permissionManager.isCommandWhitelisted(toolName)) {
      onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
      return null;
    }
    const filePath = (input.file_path as string) || (input.notebook_path as string) || 'unknown';
    return {
      promptType: 'file_write',
      description: `${toolName}: ${filePath}`,
      command: filePath,
    };
  }

  // --- Bash 命令 ---
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const baseCommand = permissionManager.getBaseCommand(command);

    const adminPrompt = classifyAdminApproval(command);
    if (adminPrompt) {
      return adminPrompt;
    }

    // 用基于完整 AST 的校验自动放行只读命令
    // （与 safe 模式共用同一套校验，可识别重定向、替换、写入命令管道等）
    const mergedConfig = permissionsConfigCache.getMergedConfig(permissionsContext);
    if (isReadOnlyBashCommandWithConfig(command, mergedConfig)) {
      onDebug?.(`Auto-allowing read-only command: ${baseCommand}`);
      return null;
    }

    // 检查会话白名单（非危险命令）
    if (permissionManager.isCommandWhitelisted(baseCommand) &&
        !permissionManager.isDangerousCommand(baseCommand)) {
      onDebug?.(`Auto-allowing "${baseCommand}" (previously approved)`);
      return null;
    }

    // 检查 curl/wget 的域名白名单
    if (['curl', 'wget'].includes(baseCommand)) {
      const domain = permissionManager.extractDomainFromNetworkCommand(command);
      if (domain && permissionManager.isDomainWhitelisted(domain)) {
        onDebug?.(`Auto-allowing ${baseCommand} to "${domain}" (domain whitelisted)`);
        return null;
      }
    }

    return {
      promptType: 'bash',
      description: `Execute: ${command}`,
      command,
    };
  }

  // --- MCP 变更操作 ---
  if (toolName.startsWith('mcp__')) {
    // 判断该工具在 safe 模式下是否会被拦截（即是否属于变更操作）
    const safeModeResult = shouldAllowToolInMode(
      toolName, input, 'safe', { plansFolderPath }
    );
    if (!safeModeResult.allowed) {
      // 是变更操作，检查白名单
      if (permissionManager.isCommandWhitelisted(toolName)) {
        onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
        return null;
      }
      const serverAndTool = toolName.replace('mcp__', '').replace(/__/g, '/');
      return {
        promptType: 'mcp_mutation',
        description: `MCP: ${serverAndTool}`,
        command: toolName,
      };
    }
    // 只读 MCP 工具，无需弹窗
    return null;
  }

  // --- API 变更操作 ---
  if (toolName.startsWith('api_')) {
    const method = ((input?.method as string) || 'GET').toUpperCase();
    const path = input?.path as string | undefined;

    if (method !== 'GET') {
      const apiDescription = `${method} ${path || ''}`;

      // 检查 permissions.json 白名单
      if (isApiEndpointAllowed(method, path, permissionsContext)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (whitelisted in permissions.json)`);
        return null;
      }

      // 检查会话白名单
      if (permissionManager.isCommandWhitelisted(apiDescription)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (previously approved)`);
        return null;
      }

      return {
        promptType: 'api_mutation',
        description: `API: ${apiDescription}`,
        command: apiDescription,
      };
    }
  }

  return null;
}

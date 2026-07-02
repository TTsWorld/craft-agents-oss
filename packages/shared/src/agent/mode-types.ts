/**
 * 权限模式（Permission Mode）的类型与常量定义
 *
 * 本文件只包含纯类型与 UI 配置常量，没有任何运行时依赖，
 * 因此可以安全地被打包进浏览器端 bundle（不会拖入 Node 专有模块）。
 *
 * 运行时的模式管理函数（getState/setMode 等）请改用 './mode-manager.ts'。
 */

import { z } from 'zod';

// ============================================================
// 权限模式类型
// ============================================================

/**
 * 权限模式的内部存储键名。
 *
 * 对外展示给用户/写入 session 状态时使用的是 canonical（规范）名称：
 * - explore  -> safe
 * - ask      -> ask
 * - execute  -> allow-all
 */
export type PermissionMode = 'safe' | 'ask' | 'allow-all';

/**
 * 对外规范名（用户、session 状态、UI 上看到的就是这些）
 */
export type PermissionModeCanonical = 'explore' | 'ask' | 'execute';

/**
 * 用 SHIFT+TAB 循环切换模式时的顺序
 */
export const PERMISSION_MODE_ORDER: PermissionMode[] = ['safe', 'ask', 'allow-all'];

/**
 * 内部键名 → 对外规范名的映射
 */
export const PERMISSION_MODE_TO_CANONICAL: Record<PermissionMode, PermissionModeCanonical> = {
  safe: 'explore',
  ask: 'ask',
  'allow-all': 'execute',
};

/**
 * 对外规范名 → 内部键名的映射
 */
export const CANONICAL_TO_PERMISSION_MODE: Record<PermissionModeCanonical, PermissionMode> = {
  explore: 'safe',
  ask: 'ask',
  execute: 'allow-all',
};

/**
 * 把内部键名转成对外规范名
 */
export function toCanonicalPermissionMode(mode: PermissionMode): PermissionModeCanonical {
  return PERMISSION_MODE_TO_CANONICAL[mode];
}

/**
 * 把用户传入的字符串解析为内部键名。
 *
 * 同时接受规范值（explore/ask/execute）和旧版别名
 * （safe/allow-all、ask-to-edit），以便向后兼容历史配置/老 session。
 */
export function parsePermissionMode(mode: string): PermissionMode | null {
  const normalized = mode.trim().toLowerCase();

  if (normalized === 'safe') return 'safe';
  if (normalized === 'ask') return 'ask';
  if (normalized === 'allow-all') return 'allow-all';

  if (normalized === 'explore') return 'safe';
  if (normalized === 'execute') return 'allow-all';
  if (normalized === 'ask-to-edit' || normalized === 'ask_to_edit' || normalized === 'ask to edit') return 'ask';

  return null;
}

// ============================================================
// Permissions 配置类型（浏览器友好的 Zod schema）
// ============================================================

/**
 * API 端点规则：HTTP 方法 + 路径正则
 */
const ApiEndpointRuleSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().describe('Regex pattern for API path'),
  comment: z.string().optional(),
});

export type ApiEndpointRule = z.infer<typeof ApiEndpointRuleSchema>;

/**
 * 模式字符串，可附带可选 comment（用于给用户/Agent 看的注释）
 */
const PatternSchema = z.union([
  z.string(),
  z.object({
    pattern: z.string(),
    comment: z.string().optional(),
  }),
]);

/**
 * 针对特定 Bash 命令的"拦截提示"，用来在 Explore 模式拒绝该命令时
 * 给出更清晰的提示信息。
 */
const BlockedCommandHintSchema = z.object({
  /** 规范化后的小写基础命令名，如 "printf" */
  command: z.string(),
  /** 命令被拒绝时的主要原因 */
  reason: z.string(),
  /** 额外的策略/风险说明 */
  context: z.string().optional(),
  /** 建议的替代操作或下一步动作 */
  tryInstead: z.array(z.string()).optional(),
  /** 一个具体的示例命令 */
  example: z.string().optional(),
  /** 仅当命令"不匹配"该正则时才应用本提示 */
  whenNotMatching: z.string().optional(),
});

export type BlockedCommandHintRule = z.infer<typeof BlockedCommandHintSchema>;

/**
 * permissions.json 的 Zod 校验 schema
 *
 * 注意：核心写入工具（Write/Edit/MultiEdit/NotebookEdit）在 SAFE_MODE_CONFIG 中
 * 被硬编码，在 Explore 模式下永远禁用；blockedTools 字段只能"额外"屏蔽更多工具，
 * 不能解除这些硬编码禁令。
 */
export const PermissionsConfigSchema = z.object({
  /** 用于迁移的版本日期（ISO 格式："2026-02-07"） */
  version: z.string().optional(),
  /** 允许执行的 Bash 命令正则列表 */
  allowedBashPatterns: z.array(PatternSchema).optional(),
  /** 允许调用的 MCP 工具正则列表 */
  allowedMcpPatterns: z.array(PatternSchema).optional(),
  /** API 端点规则：方法 + 路径正则 */
  allowedApiEndpoints: z.array(ApiEndpointRuleSchema).optional(),
  /** Explore 模式下允许写入的文件路径（glob 模式） */
  allowedWritePaths: z.array(PatternSchema).optional(),
  /** 额外要屏蔽的工具（在硬编码默认项之上扩展） */
  blockedTools: z.array(PatternSchema).optional(),
  /** 针对 Bash 命令的提示文案列表 */
  blockedCommandHints: z.array(BlockedCommandHintSchema).optional(),
});

export type PermissionsConfigFile = z.infer<typeof PermissionsConfigSchema>;

// ============================================================
// 模式配置类型
// ============================================================

/**
 * 编译后的 API 端点规则（运行时使用）
 */
export interface CompiledApiEndpointRule {
  method: string;
  pathPattern: RegExp;
}

/**
 * 编译后的 Bash 正则模式，附带用于错误提示的元信息。
 * 把原始 pattern 字符串和 comment 与编译后的 RegExp 一起保存，
 * 是为了在命令没匹配上时给出有用的错误信息。
 */
export interface CompiledBashPattern {
  /** 编译后的正则 */
  regex: RegExp;
  /** 原始 pattern 字符串（错误提示时展示） */
  source: string;
  /** 给人看的、说明这条 pattern 允许什么的注释 */
  comment?: string;
}

/**
 * 运行时使用的、针对特定 Bash 命令的拦截提示
 */
export interface CompiledBlockedCommandHint {
  /** 基础命令 token（小写），如 "printf" */
  command: string;
  reason: string;
  context?: string;
  tryInstead?: string[];
  example?: string;
  /** 可选条件：仅当命令"不匹配"该正则时才应用本提示 */
  whenNotMatching?: string;
  whenNotMatchingRegex?: RegExp;
};

/**
 * "为什么命令没匹配上"的诊断结果。
 *
 * 配合 incr-regex-package 使用：它能逐字符地匹配，告诉我们
 * 究竟匹配到哪儿失败了、期望的是什么，从而给出非常具体的提示。
 */
export interface MismatchAnalysis {
  /** 失败前已经匹配上的前缀 */
  matchedPrefix: string;
  /** 匹配在哪个字符位置停下来 */
  failedAtPosition: number;
  /** 导致失败的 token/单词 */
  failedToken: string;
  /** "最接近匹配成功"的那条 pattern */
  bestMatchPattern?: {
    source: string;
    comment?: string;
  };
  /** 给用户/Agent 的可执行建议 */
  suggestion?: string;
}

/**
 * permissions 配置文件的路径集合，会出现在错误提示里，
 * 告诉 Agent 应该去哪里自定义权限。
 */
export interface PermissionPaths {
  /** workspace 级 permissions.json 的路径 */
  workspacePath: string;
  /** 应用级 default.json 的路径 */
  appDefaultPath: string;
  /** 权限文档路径 */
  docsPath: string;
}

/**
 * Safe 模式（只读）的配置结构
 */
export interface ModeConfig {
  /** Safe 模式下永远禁用的工具（Write/Edit 等）—— 硬编码，不可配置 */
  blockedTools: Set<string>;
  /** 只读 Bash 命令 pattern（带元信息，便于友好的错误提示） */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** 针对特定 Bash 命令的拦截提示 */
  blockedCommandHints?: CompiledBlockedCommandHint[];
  /** 只读 MCP pattern（匹配上的工具允许调用） */
  readOnlyMcpPatterns: RegExp[];
  /** 细粒度的 API 端点规则（方法 + 路径正则） */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** Explore 模式下允许写入的文件路径（glob 模式） */
  allowedWritePaths?: string[];
  /** 给用户看的显示名 */
  displayName: string;
  /** 快捷键提示 */
  shortcutHint: string;
  /** permissions 相关文件路径（用于错误提示） */
  permissionPaths?: PermissionPaths;
}

// ============================================================
// Safe 模式默认配置（浏览器友好 —— 全是纯数据）
// ============================================================

/**
 * Safe 模式的最小兜底配置。
 *
 * 真正的 pattern 集合在运行时由 PermissionsConfigCache 从
 * ~/.craft-agent/permissions/default.json 加载；这份兜底配置的作用是：
 * 即便 JSON 文件缺失或损坏，应用也能正常工作。
 *
 * 想自定义允许的命令，请编辑 ~/.craft-agent/permissions/default.json
 */
export const SAFE_MODE_CONFIG: ModeConfig = {
  // 永远禁用的工具（没有只读变体）—— 这些是基础写入操作，
  // 在 Explore 模式下无论用户如何配置都不允许。
  blockedTools: new Set([
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
  ]),
  // 空的兜底 —— 真实 pattern 从 default.json 加载。
  // 如果 default.json 缺失，Explore 模式下不会有任何 Bash 命令被自动放行。
  readOnlyBashPatterns: [],
  blockedCommandHints: [],
  readOnlyMcpPatterns: [],
  allowedApiEndpoints: [],
  displayName: 'Explore',
  shortcutHint: 'SHIFT+TAB',
};

/**
 * 每种权限模式的展示配置（图标、颜色、文案等）
 */
export const PERMISSION_MODE_CONFIG: Record<PermissionMode, {
  displayName: string;
  shortName: string;
  description: string;
  /** 图标的 SVG path 数据（viewBox 0 0 24 24，stroke 风格） */
  svgPath: string;
  /** Tailwind 颜色类名，统一主题 */
  colorClass: {
    /** 文本颜色，如 'text-info' */
    text: string;
    /** 背景颜色，如 'bg-info' */
    bg: string;
    /** 边框颜色，如 'border-info' */
    border: string;
  };
}> = {
  'safe': {
    displayName: 'Explore',
    shortName: 'Explore',
    description: 'Read-only exploration. Blocks writes, never prompts.',
    // 指南针图标（Lucide）
    svgPath: 'M16.24 7.76l-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
    colorClass: {
      text: 'text-foreground/60',
      bg: 'bg-foreground/60',
      border: 'border-foreground/60',
    },
  },
  'ask': {
    displayName: 'Ask to Edit',
    shortName: 'Ask',
    description: 'Prompts before making edits.',
    // 信息图标（Lucide）
    svgPath: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01',
    colorClass: {
      text: 'text-info',
      bg: 'bg-info',
      border: 'border-info',
    },
  },
  'allow-all': {
    displayName: 'Execute',
    shortName: 'Execute',
    description: 'Automatic execution, no prompts.',
    // 循环图标（Lucide loop）
    svgPath: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    colorClass: {
      text: 'text-accent',
      bg: 'bg-accent',
      border: 'border-accent',
    },
  },
};

/**
 * Agent 核心类型定义
 *
 * 这里定义 ClaudeAgent 与 PiAgent 共用的类型。
 * 这些类型描述的接口都是与具体模型厂商无关、可跨所有 agent 实现复用的能力。
 * （对 Go 同学的类比：相当于 service 层公共的 domain types，对应不同 backend 实现。）
 */

import type { LoadedSource } from '../../sources/types.ts';
import type { Workspace } from '../../config/storage.ts';
import type { SessionConfig } from '../../sessions/storage.ts';

// 便捷地再导出 mode-types 中的公共类型；
// 这些是权限（permission）评估链路需要用到的类型。
export type {
  PermissionMode,
  ModeConfig,
  CompiledApiEndpointRule,
  CompiledBashPattern,
  MismatchAnalysis,
  PermissionPaths,
} from '../mode-types.ts';

// 权限模式相关的常量配置：顺序、各模式的展示配置、safe 模式规则。
export {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from '../mode-types.ts';

// 再导出 mode-manager 中的 ToolCheckResult 类型（工具执行前检查的返回结果）。
export type { ToolCheckResult } from '../mode-manager.ts';

/**
 * 恢复上下文时使用的消息结构。
 *
 * 当 SDK 会话恢复（resume）失败，需要把之前的对话重新注入新会话时，会用这个结构。
 * 类似 Go 里把已落盘的消息列表重新喂给一个新 session。
 */
export interface RecoveryMessage {
  /** 消息来源角色：'user' 或 'assistant' */
  type: 'user' | 'assistant';
  /** 该条消息的文本内容 */
  content: string;
}

/**
 * PermissionManager 的配置参数。
 */
export interface PermissionManagerConfig {
  /** 当前 workspace 的 ID，用于权限上下文判定 */
  workspaceId: string;
  /** 当前 session 的 ID，用于读取/写入模式状态（mode state） */
  sessionId: string;
  /** 该 session 的工作目录（绝对路径） */
  workingDirectory?: string;
  /** plans 目录路径；在 Explore 模式下允许向该目录写文件 */
  plansFolderPath?: string;
  /** data 目录路径；Explore 模式下允许 transform_data 工具向该目录输出 */
  dataFolderPath?: string;
}

/**
 * 单次工具权限检查的详细结果。
 */
export interface ToolPermissionResult {
  /** 是否允许执行该工具 */
  allowed: boolean;
  /** 若被拒绝，给出原因（用于 UI/日志展示） */
  reason?: string;
  /** 允许执行但需要用户确认（ask 模式下会用到） */
  requiresPermission?: boolean;
  /** 在权限确认弹窗中展示给用户的描述文本 */
  description?: string;
}

/**
 * SourceManager 的配置参数。
 */
export interface SourceManagerConfig {
  /** 调试用日志回调（类似 Go 中的 logger hook） */
  onDebug?: (message: string) => void;
}

/**
 * PromptBuilder 的配置参数（系统提示词/上下文拼装的输入）。
 */
export interface PromptBuilderConfig {
  /** workspace 配置对象 */
  workspace: Workspace;
  /** session 配置对象（可选） */
  session?: SessionConfig;
  /** 调试模式相关设置 */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };
  /** 系统提示词预设：'default' / 'mini' / 自定义字符串 */
  systemPromptPreset?: 'default' | 'mini' | string;
  /** 是否在 headless（无 UI）模式中运行 */
  isHeadless?: boolean;
  /** Optional pre-resolved project snapshot for prompt injection (lets tests pin a value) */
  project?: import('../../projects/types.ts').ProjectPromptContext;
}

/**
 * 构造系统提示词上下文（context block）时的可选项。
 *
 * 这些字段决定哪些信息会被注入到 system prompt 中（每轮可变 vs 稳定不变，
 * 详见 CLAUDE.md 中对 volatile / stable 的说明）。
 */
export interface ContextBlockOptions {
  /** 当前权限模式（也可通过 formatSessionState 注入到 session_state，二选一） */
  permissionMode?: string;
  /** plans 目录路径 */
  plansFolderPath?: string;
  /** data 目录路径（transform_data 工具的输出位置） */
  dataFolderPath?: string;
  /** 当前已激活（active）的 source slug 列表 */
  activeSources?: string[];
  /** 未激活（inactive）的 source 完整对象列表 */
  inactiveSources?: LoadedSource[];
  /** 是否启用本地 MCP（local MCP server） */
  localMcpEnabled?: boolean;
}

/**
 * PathProcessor 的配置参数（路径规范化处理器）。
 */
export interface PathProcessorConfig {
  /** 用户 home 目录，缺省时使用 os.homedir() */
  homeDir?: string;
}

/**
 * ConfigValidator 的配置参数（配置文件校验器）。
 */
export interface ConfigValidatorConfig {
  /** workspace 根路径，用于定位配置文件 */
  workspacePath?: string;
}

/**
 * 配置文件校验结果。
 */
export interface ConfigValidationResult {
  /** 配置是否通过校验 */
  valid: boolean;
  /** 校验失败时的错误列表 */
  errors?: string[];
  /** 校验通过但需提示的告警（合法但可能存在问题） */
  warnings?: string[];
}

/**
 * 识别出的配置文件类型。
 *
 * - 'json' / 'toml' / 'yaml'：对应格式的配置文件
 * - null：不是配置文件
 */
export type ConfigFileType = 'json' | 'toml' | 'yaml' | null;

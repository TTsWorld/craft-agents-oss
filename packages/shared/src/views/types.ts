/**
 * View Types
 *
 * 视图（View）是用户可配置的动态筛选器，基于 session 状态用 Filtrex 表达式计算得出。
 * 它们不会被持久化到 session 上， purely runtime（纯运行时）。
 *
 * 实际存储在 workspace 根目录的 views.json 中。
 */

import type { EntityColor } from '../colors/types.ts';

/**
 * 视图的配置结构，对应 views.json 里的一项。
 * 每个视图定义了一条 Filtrex 表达式，运行时会针对 session 上下文求值。
 *
 * interface 类似 Golang 的 interface：只描述“形状”，不实现。
 */
export interface ViewConfig {
  /** 唯一标识（slug），例如 "view-new" */
  id: string;

  /** 展示名称（会显示成 badge 文字，例如 "PLAN"、"NEW"） */
  name: string;

  /** 这个视图检测什么的可读说明 */
  description?: string;

  /** badge 渲染时的可选颜色 */
  color?: EntityColor;

  /**
   * 针对 session 上下文求值的 Filtrex 表达式。
   * 返回真值（truthy）时表示该视图匹配。
   * 支持点号访问嵌套字段，例如 tokenUsage.costUsd。
   * @example "hasUnread == true"
   * @example "tokenUsage.costUsd > 1"
   * @example "daysSince(lastUsedAt) > 7"
   */
  expression: string;
}

/**
 * 编译后的视图：原始配置 + 编译得到的 Filtrex 函数。
 * 编译后的 evaluate 是一个原生 JS 函数（热路径执行很快）。
 * 配置加载时只编译一次；执行时是 O(1) 调用。
 */
export interface CompiledView {
  config: ViewConfig;
  /** 编译后的 Filtrex 函数：接收 context 对象，返回 truthy / falsy */
  evaluate: (context: ViewEvaluationContext) => unknown;
}

/**
 * 表达式求值时用的上下文，由 SessionMeta + 运行时状态构建。
 * 视图表达式里能访问的所有字段都在这儿。
 *
 * 求值器每个 session 构建一次这个对象，然后传给所有编译好的视图函数。
 */
export interface ViewEvaluationContext {
  // === 字符串字段 ===
  /** Session 名称 */
  name: string;
  /** 预览文本（取第一条用户消息前 150 个字符） */
  preview: string;
  /** 状态 ID，例如 'todo'、'in-progress'、'done' */
  sessionStatus: string;
  /** @deprecated 请用 sessionStatus。保留是为了兼容老视图表达式。 */
  todoState: string;
  /**
   * 权限模式
   * 对外 canonical：'explore' | 'ask' | 'execute'
   * 内部存储：'safe' | 'ask' | 'allow-all'
   */
  permissionMode: string;
  /** 模型覆盖字符串 */
  model: string;
  /** 最后一条消息的角色：'user'、'assistant'、'plan'、'tool'、'error' */
  lastMessageRole: string;

  // === 数字字段 ===
  /** 最后活跃时间戳（毫秒） */
  lastUsedAt: number;
  /** Session 创建时间戳（毫秒） */
  createdAt: number;
  /** Session 里的消息总数 */
  messageCount: number;
  /** Session 上的标签数量 */
  labelCount: number;

  // === 布尔字段 ===
  /** 是否标星 */
  isFlagged: boolean;
  /** 是否有未读消息 */
  hasUnread: boolean;
  /** Agent 是否正在运行中 */
  isProcessing: boolean;
  /** 是否有一个待接受的 plan（lastMessageRole == 'plan'） */
  hasPendingPlan: boolean;

  // === 嵌套对象（用点号访问，例如 tokenUsage.costUsd） ===
  /** Token 使用统计 —— 可用 tokenUsage.costUsd、tokenUsage.totalTokens 等 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    contextTokens: number;
  };

  // === 数组字段 ===
  /** 标签 ID 数组（给 contains() 判断用） */
  labels: string[];
}

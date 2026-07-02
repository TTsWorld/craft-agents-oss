/**
 * View Evaluator
 *
 * 把 Filtrex 表达式编译成原生 JS 函数（配置加载时只编译一次），
 * 然后在每次渲染时针对 session 上下文求值。
 *
 * 架构：
 *   配置加载 → compileAllViews() → CompiledView[]（可缓存）
 *   每次渲染 → evaluateViews(context, compiled) → 匹配的 ViewConfig[]
 *
 * 性能：编译是一次性开销；求值是原生 JS 调用，非常快。
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import type { ViewConfig, CompiledView, ViewEvaluationContext } from './types.ts';
import { VIEW_FUNCTIONS } from './functions.ts';
import { debug } from '../utils/debug.ts';

/**
 * 编译单个视图表达式为原生 JS 函数。
 * 使用点号访问嵌套字段（如 tokenUsage.costUsd）和可选链（null-safe）。
 * 如果表达式无效则返回 null。
 *
 * `config: ViewConfig` 是 TS 的参数类型注解，类似 Golang 里 `func(config ViewConfig)`。
 * 返回值 `CompiledView | null` 表示要么返回编译结果，要么返回 null。
 */
export function compileView(config: ViewConfig): CompiledView | null {
  try {
    const fn = compileExpression(config.expression, {
      // 启用点号访问嵌套字段（例如 tokenUsage.costUsd）
      // 和可选链，避免访问 undefined 的属性时抛异常
      customProp: useDotAccessOperatorAndOptionalChaining,
      extraFunctions: VIEW_FUNCTIONS,
      // Filtrex 没有原生布尔类型 —— 不加这个，表达式里的 true/false 会被当成属性名查找，返回 undefined。
      constants: { true: true, false: false },
    });

    return {
      config,
      // `as` 是 TS 的类型断言：告诉编译器“把这个值当成某种类型”，
      // 类似 Golang 的类型断言 v.(T)，但这里是编译期行为。
      evaluate: fn as (context: ViewEvaluationContext) => unknown,
    };
  } catch (error) {
    debug(`[views] Failed to compile expression for "${config.id}": ${config.expression}`, error);
    return null;
  }
}

/**
 * 编译所有视图配置。无效表达式会打印警告并被跳过。
 * 一般在配置加载时调用一次，然后缓存结果。
 */
export function compileAllViews(configs: ViewConfig[]): CompiledView[] {
  const compiled: CompiledView[] = [];

  for (const config of configs) {
    const result = compileView(config);
    if (result) {
      compiled.push(result);
    }
    // 无效表达式已在 compileView 里打印日志，这里静默跳过
  }

  return compiled;
}

/**
 * 用 session 上下文对所有已编译视图求值。
 * 返回匹配视图的 config 数组（表达式返回 truthy 的）。
 *
 * 每次求值只是一次原生 JS 函数调用，非常快。
 * 单个表达式在运行时出错会被 catch 住，避免一个坏表达式打断整个视图流水线。
 */
export function evaluateViews(
  context: ViewEvaluationContext,
  compiled: CompiledView[]
): ViewConfig[] {
  const matches: ViewConfig[] = [];

  // 解构：从 compiled 的每个元素里直接取出 config 和 evaluate
  for (const { config, evaluate } of compiled) {
    try {
      const result = evaluate(context);
      if (result) {
        matches.push(config);
      }
    } catch {
      // 静默跳过 —— 单个表达式的运行时错误不应该破坏整个视图求值流水线
    }
  }

  return matches;
}

/**
 * 从 session 元数据构建视图求值上下文。
 * 把 SessionMeta 形状的对象映射成表达式期望的扁平上下文。
 *
 * 每个 session 每个渲染周期调用一次。
 * 上下文里还包含一些派生字段（如 hasPendingPlan），由原始 session 数据计算得出。
 */
export function buildViewContext(meta: {
  name?: string;
  preview?: string;
  sessionStatus?: string;
  permissionMode?: string;
  model?: string;
  lastMessageRole?: string;
  lastMessageAt?: number;
  createdAt?: number;
  messageCount?: number;
  isFlagged?: boolean;
  hasUnread?: boolean;
  isProcessing?: boolean;
  labels?: string[];
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    contextTokens?: number;
  };
}): ViewEvaluationContext {
  return {
    // 字符串字段（默认空字符串，防止表达式求值时出错）
    name: meta.name ?? '',
    preview: meta.preview ?? '',
    sessionStatus: meta.sessionStatus ?? '',
    todoState: meta.sessionStatus ?? '',  // 废弃别名 —— 让老表达式里用 todoState 的仍能工作
    permissionMode: meta.permissionMode ?? '',
    model: meta.model ?? '',
    lastMessageRole: meta.lastMessageRole ?? '',

    // 数字字段
    lastUsedAt: meta.lastMessageAt ?? 0,
    createdAt: meta.createdAt ?? 0,
    messageCount: meta.messageCount ?? 0,
    // `meta.labels?.length` 是可选链：如果 labels 为 undefined/null，整个表达式短路为 undefined，再 ?? 0
    labelCount: meta.labels?.length ?? 0,

    // 布尔字段
    isFlagged: meta.isFlagged ?? false,
    hasUnread: meta.hasUnread ?? false,
    isProcessing: meta.isProcessing ?? false,
    // 派生字段：最后一条消息是 plan 时，表示有待接受的计划
    hasPendingPlan: meta.lastMessageRole === 'plan',

    // 嵌套对象（给点号访问提供安全默认值）
    tokenUsage: {
      inputTokens: meta.tokenUsage?.inputTokens ?? 0,
      outputTokens: meta.tokenUsage?.outputTokens ?? 0,
      totalTokens: meta.tokenUsage?.totalTokens ?? 0,
      costUsd: meta.tokenUsage?.costUsd ?? 0,
      contextTokens: meta.tokenUsage?.contextTokens ?? 0,
    },

    // 数组字段
    labels: meta.labels ?? [],
  };
}

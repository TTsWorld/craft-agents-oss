/**
 * View Validation
 *
 * 在视图配置使用前对其表达式做校验（配置时校验）。
 * 捕获语法错误，并在出错时给出可用字段的提示。
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import { VIEW_FUNCTIONS } from './functions.ts';

/**
 * 视图表达式里可用的字段列表。
 * 用于文档展示，以及在表达式引用了未知字段时给出错误提示。
 */
export const AVAILABLE_FIELDS: Array<{ name: string; type: string; description: string }> = [
  // 字符串字段
  { name: 'name', type: 'string', description: 'Session 名称' },
  { name: 'preview', type: 'string', description: '第一条用户消息的预览文本' },
  { name: 'sessionStatus', type: 'string', description: '状态 ID（例如 "todo"、"in-progress"、"done"）' },
  { name: 'todoState', type: 'string', description: '（已废弃 —— 请用 sessionStatus）为向后兼容保留的状态别名' },
  { name: 'permissionMode', type: 'string', description: '权限模式（canonical: "explore"|"ask"|"execute"；内部: "safe"|"ask"|"allow-all"）' },
  { name: 'model', type: 'string', description: '模型覆盖字符串' },
  { name: 'lastMessageRole', type: 'string', description: '最后一条消息的角色（"user"、"assistant"、"plan"、"tool"、"error"）' },

  // 数字字段
  { name: 'lastUsedAt', type: 'number', description: '最后活跃时间戳（毫秒）' },
  { name: 'createdAt', type: 'number', description: 'Session 创建时间戳（毫秒）' },
  { name: 'messageCount', type: 'number', description: 'Session 里的消息总数' },
  { name: 'labelCount', type: 'number', description: 'Session 上的标签数量' },
  { name: 'tokenUsage.inputTokens', type: 'number', description: '输入 token 消耗数' },
  { name: 'tokenUsage.outputTokens', type: 'number', description: '输出 token 消耗数' },
  { name: 'tokenUsage.totalTokens', type: 'number', description: '总 token 数' },
  { name: 'tokenUsage.costUsd', type: 'number', description: '预估花费（美元）' },
  { name: 'tokenUsage.contextTokens', type: 'number', description: '上下文 token 使用量' },

  // 布尔字段
  { name: 'isFlagged', type: 'boolean', description: '是否标星' },
  { name: 'hasUnread', type: 'boolean', description: '是否有未读消息' },
  { name: 'isProcessing', type: 'boolean', description: 'Agent 是否正在运行' },
  { name: 'hasPendingPlan', type: 'boolean', description: '是否有待接受的 plan' },

  // 数组字段
  { name: 'labels', type: 'array', description: '标签 ID 数组（用于 contains() 判断）' },
];

/**
 * 视图表达式里可用的自定义函数列表。
 */
export const AVAILABLE_FUNCTIONS: Array<{ name: string; signature: string; description: string; example: string }> = [
  { name: 'daysSince', signature: 'daysSince(timestamp)', description: '距今多少天', example: 'daysSince(lastUsedAt) > 7' },
  { name: 'hoursSince', signature: 'hoursSince(timestamp)', description: '距今多少小时', example: 'hoursSince(lastUsedAt) > 24' },
  { name: 'contains', signature: 'contains(arr, value)', description: '数组/字符串是否包含某个值', example: 'contains(labels, "bug")' },
  { name: 'length', signature: 'length(arr)', description: '数组或字符串长度', example: 'length(labels) > 3' },
  { name: 'startsWith', signature: 'startsWith(str, prefix)', description: '字符串是否以某前缀开头', example: 'startsWith(name, "feat")' },
  { name: 'lower', signature: 'lower(str)', description: '字符串转小写', example: 'lower(model) == "opus"' },
];

/**
 * 表达式校验结果。
 */
export interface ValidationResult {
  /** 表达式是否合法 */
  valid: boolean;
  /** 不合法时的错误信息（Filtrex 解析错误） */
  error?: string;
}

/**
 * 通过尝试编译来校验视图表达式。
 * 如果表达式无效，返回带错误详情的校验结果。
 *
 * 这是纯语法检查，不会真正执行表达式。
 * 运行时错误（例如访问 undefined 的嵌套属性）会被求值器通过可选链优雅处理。
 */
export function validateViewExpression(expression: string): ValidationResult {
  if (!expression || typeof expression !== 'string') {
    return { valid: false, error: 'Expression must be a non-empty string' };
  }

  const trimmed = expression.trim();
  if (!trimmed) {
    return { valid: false, error: 'Expression must be a non-empty string' };
  }

  try {
    compileExpression(trimmed, {
      customProp: useDotAccessOperatorAndOptionalChaining,
      extraFunctions: VIEW_FUNCTIONS,
      // 必须和 evaluator.ts 保持一致 —— 如果不显式声明 true/false 常量，
      // Filtrex 会把表达式里的 true/false 当成属性查找，导致校验时接受了非法语义。
      constants: { true: true, false: false },
    });
    return { valid: true };
  } catch (error) {
    // `error instanceof Error` 是 JS 运行时类型判断，用于安全地取错误消息
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `Invalid expression: ${message}` };
  }
}

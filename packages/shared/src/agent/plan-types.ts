/**
 * Plan 类型定义（计划模式相关）
 *
 * 定义 Plan（计划）及其相关数据结构。
 * Plan 用于"结构化任务执行"场景：先让 Claude 生成一份分步计划交用户审核，
 * 用户批准后再逐步执行。可以把它类比成 Golang 里"先写 TODO 列表再动手"的工作流，
 * 但这里 TODO 列表会通过 stream 流式返回给前端 UI 展示。
 */

import { randomUUID } from 'crypto';

/**
 * 计划当前所处的状态机节点
 * 类比：像一个枚举，但 TS 用字符串字面量联合类型（更轻量、序列化友好）。
 */
export type PlanState =
  | 'creating'    // Claude 正在生成计划
  | 'refining'    // 用户提出了反馈，Claude 正在据此修改计划
  | 'ready'       // 计划已批准，等待执行
  | 'executing'   // 计划正在被执行
  | 'completed'   // 计划执行完毕
  | 'cancelled';  // 用户取消了该计划

/**
 * 计划中的单个步骤（一行 TODO）
 */
export interface PlanStep {
  /** 该步骤的唯一 id（用于前后端通信、事件定位） */
  id: string;
  /** 给人看的步骤描述：这一步要做什么 */
  description: string;
  /** 当前状态：待执行 / 进行中 / 已完成 / 已跳过 */
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  /** 可选的实现细节备注（给 Agent 看的提示） */
  details?: string;
  /** 这一步会改动的文件列表（供 UI 提示影响范围） */
  files?: string[];
  /** 预估复杂度，仅用于 UI 展示 */
  complexity?: 'low' | 'medium' | 'high';
}

/**
 * 一份完整的计划
 */
export interface Plan {
  /** 唯一 id */
  id: string;
  /** 简短标题 */
  title: string;
  /** 当前状态机节点 */
  state: PlanState;
  /** 有序的步骤列表（按执行顺序） */
  steps: PlanStep[];
  /** 触发该计划的原始用户请求（保留上下文） */
  context: string;
  /** 第几轮修订（0 = 初版，1+ = 收到反馈后修改的版本） */
  refinementRound: number;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最后修改时间戳（ms） */
  updatedAt: number;
  /** 修订历史（每轮反馈都记一条，便于回溯） */
  refinementHistory?: PlanRefinementEntry[];
}

/**
 * 一次"修订轮次"的记录
 */
export interface PlanRefinementEntry {
  /** 第几轮（从 1 开始） */
  round: number;
  /** Claude 当时提出的问题 */
  questions: string[];
  /** 用户的反馈/回答 */
  feedback: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 请用户审核/修订计划的请求
 */
export interface PlanRefinementRequest {
  /** 当前计划 */
  plan: Plan;
  /** Claude 想问用户的问题 */
  questions: string[];
  /** 可选的改进建议 */
  suggestions?: string[];
}

/**
 * 计划模式中通过 stream 流式发出的事件（discriminated union，按 type 区分）
 * 类比 Golang 的 tagged union，TS 用对象的 `type` 字段做判别。
 */
export type PlanEvent =
  | { type: 'plan_creating'; message: string }
  | { type: 'plan_ready'; plan: Plan; questions?: string[] }
  | { type: 'plan_refining'; plan: Plan; feedback: string }
  | { type: 'plan_approved'; plan: Plan }
  | { type: 'plan_cancelled' }
  | { type: 'plan_step_start'; stepId: string; description: string }
  | { type: 'plan_step_complete'; stepId: string }
  | { type: 'plan_complete'; plan: Plan };

/**
 * 启动计划模式的参数
 */
export interface PlanModeOptions {
  /** 要为之制定计划的任务描述 */
  task: string;
  /** 跳过修订、直接自动批准（用于简单任务） */
  autoApprove?: boolean;
  /** 强制决策前允许的最大修订轮数 */
  maxRefinementRounds?: number;
}

/**
 * 判断"一个任务是否需要走计划模式"的结果
 */
export interface PlanSuggestion {
  /** 是否建议进入计划模式 */
  shouldPlan: boolean;
  /** 建议原因 */
  reason?: string;
  /** 复杂度评估 */
  complexity?: 'simple' | 'moderate' | 'complex';
}

/**
 * 计划就绪后发送给 UI 的"审核请求"
 */
export interface PlanReviewRequest {
  /** 本次审核请求的唯一 id（用于响应对齐） */
  requestId: string;
  /** 待审核的计划 */
  plan: Plan;
  /** 可选的、需要用户回答的问题 */
  questions?: string[];
}

/**
 * 用户对一次计划审核的回复（同样是 discriminated union，按 action 区分）
 */
export type PlanReviewResult =
  | { action: 'approve'; modifiedPlan?: Plan }
  | { action: 'refine'; feedback: string }
  | { action: 'saveOnly'; modifiedPlan?: Plan }
  | { action: 'cancel' };

/**
 * 工厂函数：创建一份新计划
 */
export function createPlan(title: string, context: string): Plan {
  return {
    id: randomUUID(),
    title,
    state: 'creating',
    steps: [],
    context,
    refinementRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * 工厂函数：创建一个计划步骤
 */
export function createPlanStep(description: string, details?: string): PlanStep {
  return {
    id: randomUUID(),
    description,
    status: 'pending',
    details,
  };
}

/**
 * 不可变更新：把 plan 切到新状态，并刷新 updatedAt
 * 类比 Golang：函数式地返回新结构，不修改入参。
 */
export function updatePlanState(plan: Plan, state: PlanState): Plan {
  return {
    ...plan,
    state,
    updatedAt: Date.now(),
  };
}

/**
 * 不可变更新：追加一条修订记录，并把 refinementRound +1
 */
export function addRefinementEntry(
  plan: Plan,
  questions: string[],
  feedback: string
): Plan {
  const entry: PlanRefinementEntry = {
    round: plan.refinementRound + 1,
    questions,
    feedback,
    timestamp: Date.now(),
  };

  return {
    ...plan,
    refinementRound: plan.refinementRound + 1,
    refinementHistory: [...(plan.refinementHistory || []), entry],
    updatedAt: Date.now(),
  };
}

// ============================================
// 权限模式（Permission Mode）的 UI 文案 —— 唯一权威来源
// ============================================
// 权限模式决定工具执行行为。
// 用户可通过 SHIFT+TAB 在三种模式间循环切换：Safe → Ask → Allow All → Safe

import type { PermissionMode } from './mode-manager.ts';
import { PERMISSION_MODE_CONFIG } from './mode-types.ts';

/** 每种权限模式启用时展示给用户的文案 */
export const PERMISSION_MODE_MESSAGES: Record<PermissionMode, string> = {
  'safe': `${PERMISSION_MODE_CONFIG['safe'].displayName} mode active. Read-only exploration enabled.`,
  'ask': `${PERMISSION_MODE_CONFIG['ask'].displayName} mode active. Prompts for dangerous operations.`,
  'allow-all': `${PERMISSION_MODE_CONFIG['allow-all'].displayName} mode active. All operations permitted.`,
};

/** 模式切换时发给 Claude 的 system prompt（让模型理解当前模式的限制） */
export const PERMISSION_MODE_PROMPTS: Record<PermissionMode, string> = {
  'safe': `The user has switched to ${PERMISSION_MODE_CONFIG['safe'].displayName} mode (read-only). You can read files, search, and explore the codebase, but write operations (Bash, Write, Edit, API calls) are blocked. Focus on understanding and explaining rather than making changes.`,
  'ask': `The user has switched to ${PERMISSION_MODE_CONFIG['ask'].displayName} mode. Most operations are allowed, but dangerous bash commands will prompt for user approval. You have access to write operations.`,
  'allow-all': `The user has switched to ${PERMISSION_MODE_CONFIG['allow-all'].displayName} mode. All operations are permitted without prompts. Use with care.`,
};

/**
 * 自动化条件求值器
 *
 * 纯同步的条件求值引擎，灵感来自 Home Assistant 的条件系统。
 *
 * 支持：
 * - time：时间范围和星期检查
 * - state：事件 payload 字段检查，支持 from/to transition 写法
 * - and/or/not：逻辑组合，短路求值
 */

import type { AutomationCondition, TimeCondition, StateCondition, LogicalCondition } from './types.ts';
import { MAX_CONDITION_DEPTH_EXCLUSIVE } from './conditions-constants.ts';

// ============================================================================
// 常量
// ============================================================================

/**
 * 把用户友好的字段名映射到 transition 事件内部 payload 的字段对。
 * 当用户写 `field: "permissionMode"` 并带 from/to 时，实际比较的是
 * payload 里的 oldMode/newMode。
 */
const TRANSITION_FIELDS: Record<string, { to: string; from: string }> = {
  permissionMode: { to: 'newMode', from: 'oldMode' },
  sessionStatus: { to: 'newState', from: 'oldState' },
};

/** 星期缩写到 JS Date.getDay()/Intl 星期编号（1=周一..7=周日）的映射 */
const WEEKDAY_MAP: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

// ============================================================================
// 上下文
// ============================================================================

/** 传给条件求值的上下文 */
export interface ConditionContext {
  /** 事件 payload 字段 */
  payload: Record<string, unknown>;
  /** 可注入的当前时间（方便测试） */
  now?: Date;
  /** matcher 提供的候选时区 */
  matcherTimezone?: string;
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 对一组条件做顶层 AND 求值。
 * 如果数组为空或 undefined，直接返回 true。
 */
export function evaluateConditions(conditions: AutomationCondition[], context: ConditionContext): boolean {
  if (conditions.length === 0) return true;
  for (const condition of conditions) {
    if (!evaluateCondition(condition, context, 0)) return false;
  }
  return true;
}

// ============================================================================
// 内部分发
// ============================================================================

function evaluateCondition(condition: AutomationCondition, context: ConditionContext, depth: number): boolean {
  // 深度从 0 开始；允许的最大下标是 MAX_CONDITION_DEPTH_EXCLUSIVE - 1
  if (depth >= MAX_CONDITION_DEPTH_EXCLUSIVE) return false;

  switch (condition.condition) {
    case 'time':
      return evaluateTimeCondition(condition, context);
    case 'state':
      return evaluateStateCondition(condition, context);
    case 'and':
    case 'or':
    case 'not':
      return evaluateLogicalCondition(condition, context, depth);
    default:
      // 未知条件类型 - 安全失败（fail closed）
      return false;
  }
}

// ============================================================================
// 时间条件
// ============================================================================

function evaluateTimeCondition(condition: TimeCondition, context: ConditionContext): boolean {
  const now = context.now ?? new Date();
  const tz = condition.timezone ?? context.matcherTimezone;

  // 获取目标时区的当前时间
  const { hours, minutes, weekdayNum } = getTimeInTimezone(now, tz);

  // 检查星期过滤
  if (condition.weekday && condition.weekday.length > 0) {
    const allowed = new Set(condition.weekday.map(d => WEEKDAY_MAP[d]));
    if (!allowed.has(weekdayNum)) return false;
  }

  // 检查时间范围
  const hasAfter = condition.after !== undefined;
  const hasBefore = condition.before !== undefined;

  if (!hasAfter && !hasBefore) return true;

  const currentMinutes = hours * 60 + minutes;
  const afterMinutes = hasAfter ? parseTimeToMinutes(condition.after!) : 0;
  const beforeMinutes = hasBefore ? parseTimeToMinutes(condition.before!) : 0;

  if (hasAfter && hasBefore) {
    if (afterMinutes <= beforeMinutes) {
      // 普通区间：after <= current < before
      return currentMinutes >= afterMinutes && currentMinutes < beforeMinutes;
    } else {
      // 跨午夜区间：current >= after 或 current < before
      return currentMinutes >= afterMinutes || currentMinutes < beforeMinutes;
    }
  }

  if (hasAfter) return currentMinutes >= afterMinutes;
  // 只有 before
  return currentMinutes < beforeMinutes;
}

/** 把 "HH:MM" 解析为从 0 点开始的分钟数 */
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 获取某时区的小时、分钟和星期编号 */
function getTimeInTimezone(date: Date, timezone?: string): { hours: number; minutes: number; weekdayNum: number } {
  if (timezone) {
    try {
      // 用 Intl 转换到目标时区
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      const hours = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
      const minutes = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
      const weekdayStr = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3) ?? '';
      const weekdayNum = WEEKDAY_MAP[weekdayStr] ?? 0;
      return { hours, minutes, weekdayNum };
    } catch {
      // 时区非法，回落到本地时间
    }
  }

  // 本地时间兜底
  const hours = date.getHours();
  const minutes = date.getMinutes();
  // JS getDay(): 0=周日, 1=周一... 转为我们约定的 1=周一..7=周日
  const jsDay = date.getDay();
  const weekdayNum = jsDay === 0 ? 7 : jsDay;
  return { hours, minutes, weekdayNum };
}

// ============================================================================
// 状态条件
// ============================================================================

function evaluateStateCondition(condition: StateCondition, context: ConditionContext): boolean {
  const { field } = condition;       // 解构取出 field
  const { payload } = context;       // 解构取出 payload

  // 处理 from/to（transition 字段）
  const hasFrom = condition.from !== undefined;
  const hasTo = condition.to !== undefined;

  if (hasFrom || hasTo) {
    const mapping = TRANSITION_FIELDS[field];
    const toKey = mapping?.to ?? field;
    const fromKey = mapping?.from ?? field;

    if (hasTo && payload[toKey] !== condition.to) return false;
    if (hasFrom && payload[fromKey] !== condition.from) return false;
    return true;
  }

  // 处理 contains（数组包含）
  if (condition.contains !== undefined) {
    const arr = payload[field];
    if (!Array.isArray(arr)) return false;
    return arr.includes(condition.contains);
  }

  // 处理 not_value（取反）
  if (condition.not_value !== undefined) {
    const fieldValue = payload[field];
    if (fieldValue === undefined) return false;
    return fieldValue !== condition.not_value;
  }

  // 处理 value（精确匹配）
  if (condition.value !== undefined) {
    return payload[field] === condition.value;
  }

  // 没有指定操作符 - 安全失败
  return false;
}

// ============================================================================
// 逻辑条件
// ============================================================================

function evaluateLogicalCondition(condition: LogicalCondition, context: ConditionContext, depth: number): boolean {
  const { conditions } = condition; // 解构取出子条件数组

  switch (condition.condition) {
    case 'and':
      for (const sub of conditions) {
        if (!evaluateCondition(sub, context, depth + 1)) return false;
      }
      return true;

    case 'or':
      for (const sub of conditions) {
        if (evaluateCondition(sub, context, depth + 1)) return true;
      }
      return false;

    case 'not':
      for (const sub of conditions) {
        if (evaluateCondition(sub, context, depth + 1)) return false;
      }
      return true;

    default:
      return false;
  }
}

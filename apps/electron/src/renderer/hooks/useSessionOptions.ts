/**
 * Session Options Types
 *
 * 会话级设置的类型定义与辅助函数。
 * 实际 hook 在 AppShellContext.tsx 中以 useSessionOptionsFor() 提供。
 *
 * 新增会话选项步骤：
 * 1. 在下方 SessionOptions 接口中添加字段
 * 2. 更新 defaultSessionOptions
 * 3. 在 FreeFormInput.tsx（或需要的地方）添加 UI 控件
 */

import type { PermissionMode } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'

/**
 * 所有会话级设置汇总。
 */
export interface SessionOptions {
  /** 权限模式（'safe'、'ask'、'allow-all'）：决定 AI 执行工具前是否需要用户确认 */
  permissionMode: PermissionMode
  /** 后端权限模式状态的单调递增版本号，用于忽略旧事件 */
  permissionModeVersion?: number
  /** 会话级思考深度，持久化保存。详见 {@link ThinkingLevel} */
  thinkingLevel: ThinkingLevel
}

/** 新会话的默认值 */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // 默认询问模式（执行工具前弹窗确认）
  thinkingLevel: DEFAULT_THINKING_LEVEL, // 默认中等深度
}

/** 会话选项的部分更新类型 */
export type SessionOptionUpdates = Partial<SessionOptions>

/** 合并当前会话选项与增量更新 */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...current,
    ...updates,
  }
}

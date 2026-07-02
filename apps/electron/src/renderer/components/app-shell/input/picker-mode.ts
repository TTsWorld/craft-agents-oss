/**
 * picker-mode.ts
 *
 * 聊天输入框顶部模型选择器的纯函数决策表。
 * 把“当前连接是否可用、会话是否为空、有多少个连接”等状态映射成四种互斥 UI 模式，
 * 方便单元测试，也让触发按钮的 chevron 和弹窗内容保持一致。
 *
 * 优先级（从高到低）：
 *   1. unavailable   — 当前连接不可用或报错
 *   2. switcher      — 空会话且配置了多个连接，让用户在第一条消息锁定会话前先选连接
 *   3. locked-single — pi_compat 连接且只有 ≤1 个模型，会话已开始或只有一个连接
 *   4. flat          — 兜底：列出当前连接下的模型
 *
 * 注意：switcher 故意排在 locked-single 前面。修复 #727 之前顺序相反，
 * 导致默认使用单模型 pi_compat 连接的用户在新会话永远无法打开连接切换器。
 */

export type PickerMode = 'unavailable' | 'switcher' | 'locked-single' | 'flat'

/** 决定选择器模式的输入条件 */
export interface PickerModeInput {
  /** 当前连接是否不可用 */
  connectionUnavailable: boolean
  /** 仅当活跃连接是 pi_compat 且模型数 ≤1 时非空 */
  connectionDefaultModel: string | null
  /** 会话是否还没有任何消息 */
  isEmptySession: boolean
  /** 工作区里配置了多少个 LLM 连接 */
  connectionCount: number
}

/**
 * 根据输入状态推导模型选择器应该渲染哪种 UI。
 *
 * 与 Golang 的纯函数类似：无副作用、输入相同则输出相同，便于测试。
 */
export function derivePickerMode(input: PickerModeInput): PickerMode {
  if (input.connectionUnavailable) return 'unavailable'
  if (input.isEmptySession && input.connectionCount > 1) return 'switcher'
  if (input.connectionDefaultModel != null) return 'locked-single'
  return 'flat'
}

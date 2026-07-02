/** action 的作用域：决定快捷键在哪些地方生效。 */
export type ActionScope = 'global' | 'navigator' | 'chat' | 'sidebar'

/** 单个 action 的元数据定义。 */
export interface ActionDefinition {
  id: string
  label: string
  description?: string
  defaultHotkey: string | null  // null 表示没有默认快捷键
  category: string
  scope?: ActionScope           // 不填时默认是 'global'
  /** when 条件表达式，控制 action 什么时候能触发。
   *  不填表示任何场景都触发（默认）。示例：
   *  - '!inputFocus'                — 只在非文本输入框时触发
   *  - 'chatFocus && !hasSelection' — 在聊天区且没有选中文本时触发
   *  - 'navigatorFocus'             — 只在导航器聚焦时触发
   *  @see keybinding-context.ts 里的 evaluateWhen() */
  when?: string
}

/** action ID 类型：从 definitions.ts 的 actions 对象推导出来。
 *  写法 `keyof typeof import('./definitions').actions` 是 TS 技巧：
 *  `typeof` 取对象的类型，`keyof` 取这个类型的所有键，
 *  这样写 actionId 时就会有自动补全和类型检查。 */
export type ActionId = keyof typeof import('./definitions').actions

/** 某个 action 的处理器（handler）结构。 */
export interface ActionHandler {
  actionId: ActionId
  handler: () => void
  enabled?: () => boolean
}

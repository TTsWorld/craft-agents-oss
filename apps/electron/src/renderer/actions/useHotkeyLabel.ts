import { useActionRegistry } from './registry'
import type { ActionId } from './definitions'

/**
 * 获取某个 action 快捷键的显示字符串。
 *
 * @example
 * const hotkey = useHotkeyLabel('app.newChat') // Mac 上返回 "⌘N"
 *
 * @example
 * // 用在 tooltip 里
 * <Tooltip content={`New Chat ${useHotkeyLabel('app.newChat')}`}>
 */
export function useHotkeyLabel(actionId: ActionId): string | null {
  const { getHotkeyDisplay } = useActionRegistry()
  return getHotkeyDisplay(actionId)
}

/**
 * 同时获取 action 的显示名称和快捷键，用于菜单、按钮提示等。
 *
 * @example
 * const { label, hotkey } = useActionLabel('app.newChat')
 * // label: "New Chat", hotkey: "⌘N"
 */
export function useActionLabel(actionId: ActionId) {
  const { getAction, getHotkeyDisplay } = useActionRegistry()
  const action = getAction(actionId)
  return {
    label: action.label,
    // 'description' in action 是运行时属性检查，
    // 因为 ActionDefinition 里 description 是可选的（?:）。
    description: 'description' in action ? action.description : undefined,
    hotkey: getHotkeyDisplay(actionId),
  }
}

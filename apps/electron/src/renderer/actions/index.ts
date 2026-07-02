/**
 * actions 模块的聚合导出入口。
 *
 * 其他代码只需要 `import { useAction, actions } from '@/actions'` 即可，
 * 不用关心具体定义在哪个文件。这是 TS/JS 里常见的“ Barrel export ”模式。
 */
export { ActionRegistryProvider, useActionRegistry } from './registry'
export { useAction } from './useAction'
export { useHotkeyLabel, useActionLabel } from './useHotkeyLabel'
export { actions, actionList, actionsByCategory, type ActionId } from './definitions'
export type { ActionDefinition, ActionHandler, ActionScope } from './types'

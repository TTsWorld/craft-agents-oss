import { useEffect, useRef } from 'react'
import { useActionRegistry } from './registry'
import type { ActionId } from './definitions'

/**
 * 为某个 action 注册一个处理器（handler）。
 *
 * 用法类似订阅：组件挂载时注册，卸载时自动取消注册。
 *
 * @example
 * useAction('app.newChat', () => handleNewChat())
 *
 * @example
 * // 带启用条件
 * useAction('navigator.selectAll', selectAll, {
 *   enabled: () => zoneRef.current?.contains(document.activeElement) ?? false
 * })
 */
export function useAction(
  actionId: ActionId,
  handler: () => void,
  options?: { enabled?: () => boolean },
  deps: unknown[] = []
) {
  const { register } = useActionRegistry()
  // useRef 保存最新 handler/options，避免每次渲染都重新注册，
  // 同时保证触发时用的是最新函数。
  const handlerRef = useRef(handler)
  const optionsRef = useRef(options)

  // 保持 ref 的值始终是最新传入的 handler/options
  useEffect(() => {
    handlerRef.current = handler
    optionsRef.current = options
  }, [handler, options, ...deps])

  // 注册 handler；register 返回取消注册函数，作为 useEffect 的清理函数。
  useEffect(() => {
    return register({
      actionId,
      handler: () => handlerRef.current(),
      // `?.` 是可选链：只有 optionsRef.current 存在且 enabled 存在才启用；
      // `?? false` 是空值合并，防止 enabled 返回 undefined。
      enabled: optionsRef.current?.enabled ? () => optionsRef.current?.enabled?.() ?? false : undefined,
    })
  }, [actionId, register])
}

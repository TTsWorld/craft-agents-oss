import { type MutableRefObject, type RefCallback } from 'react'

type Ref<T> = RefCallback<T> | MutableRefObject<T> | null | undefined

/**
 * 把多个 React ref 合并成一个 ref callback。
 * 当一个元素需要同时满足多个 ref 需求时使用（例如焦点区 ref + 快捷键作用域 ref）。
 * 类似 Go 里的多订阅者回调：拿到新值后逐个通知所有 ref。
 */
export function mergeRefs<T>(...refs: Ref<T>[]): RefCallback<T> {
  return (value: T) => {
    refs.forEach(ref => {
      if (typeof ref === 'function') {
        ref(value)
      } else if (ref != null) {
        ref.current = value
      }
    })
  }
}

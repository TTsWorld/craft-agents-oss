/**
 * useAutoGrow.ts
 *
 * 自动撑高 textarea 的 React Hook。
 * 根据内容高度动态调整 textarea 高度，常用于聊天输入框。
 */

import { useEffect, useCallback, useRef } from 'react'

interface UseAutoGrowOptions {
  /** 最小高度（像素） */
  minHeight?: number
  /** 最大高度（像素），不设置则不限制 */
  maxHeight?: number
}

/**
 * 让 textarea 随内容自动增高。
 *
 * 用法示例：
 * ```tsx
 * const { ref, adjustHeight } = useAutoGrow({ minHeight: 72 })
 * <textarea ref={ref} onChange={(e) => { setValue(e.target.value); adjustHeight() }} />
 * ```
 */
export function useAutoGrow<T extends HTMLTextAreaElement>({
  minHeight = 72,
  maxHeight,
}: UseAutoGrowOptions = {}) {
  const ref = useRef<T>(null)

  const adjustHeight = useCallback(() => {
    const textarea = ref.current
    if (!textarea) return

    // 先把高度重置为 auto，才能拿到准确的 scrollHeight
    textarea.style.height = 'auto'

    // 计算新高度：至少 minHeight，超过 maxHeight 则截断
    let newHeight = Math.max(textarea.scrollHeight, minHeight)
    if (maxHeight) {
      newHeight = Math.min(newHeight, maxHeight)
    }

    textarea.style.height = `${newHeight}px`
  }, [minHeight, maxHeight])

  // 挂载和依赖变化时自动调整一次
  useEffect(() => {
    adjustHeight()
  }, [adjustHeight])

  return { ref, adjustHeight }
}

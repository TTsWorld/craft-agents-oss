import { useState, useCallback } from 'react'
import * as storage from '@/lib/local-storage'

/**
 * 可调整尺寸面板的布局状态管理。
 *
 * 从 localStorage 读取上次保存的面板比例；若数量不一致则回退到默认值。
 */
export function useResizablePanels(key: string, defaultSizes: number[]) {
  const [layout, setLayout] = useState<number[]>(() => {
    const saved = storage.get<number[]>(storage.KEYS.panelLayout, [], key)
    if (saved.length === defaultSizes.length) {
      return saved
    }
    return defaultSizes
  })

  const onLayoutChange = useCallback((sizes: number[]) => {
    setLayout(sizes)
    storage.set(storage.KEYS.panelLayout, sizes, key)
  }, [key])

  return { layout, onLayoutChange }
}

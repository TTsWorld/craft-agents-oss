import { useState, useCallback, useRef, useEffect } from "react"

interface UseRovingTabIndexOptions<T> {
  /** 要导航的列表项 */
  items: T[]
  /** 获取每项唯一 ID：(item, index) => id */
  getId: (item: T, index: number) => string
  /** 导航方向（影响方向键行为） */
  orientation?: 'vertical' | 'horizontal' | 'both'
  /** 是否在两端循环 */
  wrap?: boolean
  /** 方向键导航时调用，通常用于滚动到可视区域 */
  onNavigate?: (item: T, index: number) => void
  /** 在聚焦项上按 Enter/Space 时调用，通常用于选择 */
  onActivate?: (item: T, index: number) => void
  /** 按 Delete/Backspace 时调用 */
  onDelete?: (item: T, index: number) => void
  /** 初始激活索引 */
  initialIndex?: number
  /** 是否启用导航（通常在区域获得焦点时为 true） */
  enabled?: boolean
  /** 在聚焦项上打开上下文菜单 */
  onContextMenu?: (item: T, index: number, element: HTMLElement) => void
  /** 导航时是否移动焦点到列表项（默认 true）。设为 false 可让焦点留在别处（例如搜索框） */
  moveFocus?: boolean
  /** Shift+方向键扩展选择时调用（支持多选） */
  onExtendSelection?: (toIndex: number) => void
}

interface UseRovingTabIndexReturn<T> {
  /** 当前激活索引 */
  activeIndex: number
  /** 程序化设置激活索引 */
  setActiveIndex: (index: number) => void
  /** 获取要展开到每项上的 props */
  getItemProps: (item: T, index: number) => {
    id: string
    tabIndex: number
    ref: (el: HTMLElement | null) => void
    onKeyDown: (e: React.KeyboardEvent) => void
    onFocus: () => void
    'aria-selected': boolean
    role: string
  }
  /** 获取容器 props */
  getContainerProps: () => {
    role: string
    'aria-activedescendant': string | undefined
    onKeyDown: (e: React.KeyboardEvent) => void
  }
  /** 聚焦当前激活项 */
  focusActiveItem: () => void
}

/**
 * 实现列表的 roving tabindex 导航模式。
 *
 * 核心设计：导航（焦点）与选择分离
 * - 方向键移动焦点并触发 onNavigate（用于滚动到可视区域）
 * - Enter/Space 触发 onActivate（用于选择）
 * - 点击由外部组件处理
 *
 * 特性：
 * - 只有激活项 tabIndex=0，其余为 -1
 * - 方向键导航并调用 onNavigate
 * - Enter/Space 触发 onActivate
 * - Tab 离开列表进入下一个焦点区域
 * - Home/End 跳到首项/末项
 * - Shift+方向键调用 onExtendSelection 以支持多选
 * - 上下文菜单键（或 Shift+F10）打开上下文菜单
 */
export function useRovingTabIndex<T>({
  items,
  getId,
  orientation = 'vertical',
  wrap = true,
  onNavigate,
  onActivate,
  onDelete,
  initialIndex = 0,
  enabled = true,
  onContextMenu,
  moveFocus = true,
  onExtendSelection,
}: UseRovingTabIndexOptions<T>): UseRovingTabIndexReturn<T> {
  const [activeIndex, setActiveIndexState] = useState(() =>
    Math.min(initialIndex, Math.max(0, items.length - 1))
  )
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map())

  // 当列表项变化导致当前索引越界时，重置激活索引
  // 注意：这里只同步状态，不触发回调——这不是用户发起的导航
  useEffect(() => {
    if (items.length === 0) {
      setActiveIndexState(0)
    } else if (activeIndex >= items.length) {
      const newIndex = Math.max(0, items.length - 1)
      setActiveIndexState(newIndex)
    }
  }, [items.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // 程序化设置索引：只同步状态，不触发回调
  // 回调只在用户通过键盘导航时触发
  const setActiveIndex = useCallback((index: number) => {
    if (index >= 0 && index < items.length) {
      setActiveIndexState(index)
    }
  }, [items.length])

  const focusActiveItem = useCallback(() => {
    const item = items[activeIndex]
    if (item) {
      const id = getId(item, activeIndex)
      const element = itemRefs.current.get(id)
      element?.focus()
    }
  }, [activeIndex, items, getId])

  const navigateToIndex = useCallback((nextIndex: number) => {
    if (nextIndex >= 0 && nextIndex < items.length && nextIndex !== activeIndex) {
      setActiveIndexState(nextIndex)
      onNavigate?.(items[nextIndex], nextIndex)
      // 状态更新后聚焦到新项（moveFocus 为 false 时除外）
      if (moveFocus) {
        requestAnimationFrame(() => {
          const id = getId(items[nextIndex], nextIndex)
          itemRefs.current.get(id)?.focus()
        })
      }
    }
  }, [items, activeIndex, getId, onNavigate, moveFocus])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!enabled || items.length === 0) return

    const isVertical = orientation === 'vertical' || orientation === 'both'
    const isHorizontal = orientation === 'horizontal' || orientation === 'both'
    const isShiftKey = e.shiftKey

    let nextIndex = activeIndex
    let handled = false
    let isExtendSelection = false

    switch (e.key) {
      case 'ArrowDown':
        if (isVertical) {
          nextIndex = wrap
            ? (activeIndex + 1) % items.length
            : Math.min(activeIndex + 1, items.length - 1)
          handled = true
          isExtendSelection = isShiftKey && !!onExtendSelection
        }
        break

      case 'ArrowUp':
        if (isVertical) {
          nextIndex = wrap
            ? (activeIndex - 1 + items.length) % items.length
            : Math.max(activeIndex - 1, 0)
          handled = true
          isExtendSelection = isShiftKey && !!onExtendSelection
        }
        break

      case 'ArrowRight':
        if (isHorizontal) {
          nextIndex = wrap
            ? (activeIndex + 1) % items.length
            : Math.min(activeIndex + 1, items.length - 1)
          handled = true
          isExtendSelection = isShiftKey && !!onExtendSelection
        }
        break

      case 'ArrowLeft':
        if (isHorizontal) {
          nextIndex = wrap
            ? (activeIndex - 1 + items.length) % items.length
            : Math.max(activeIndex - 1, 0)
          handled = true
          isExtendSelection = isShiftKey && !!onExtendSelection
        }
        break

      case 'Home':
        nextIndex = 0
        handled = true
        isExtendSelection = isShiftKey && !!onExtendSelection
        break

      case 'End':
        nextIndex = items.length - 1
        handled = true
        isExtendSelection = isShiftKey && !!onExtendSelection
        break

      case 'Enter':
      case ' ':
        e.preventDefault()
        onActivate?.(items[activeIndex], activeIndex)
        handled = true
        break

      case 'Delete':
      case 'Backspace':
        if (onDelete) {
          e.preventDefault()
          onDelete(items[activeIndex], activeIndex)
          handled = true
        }
        break

      // 键盘触发上下文菜单（F10 或 ContextMenu 键）
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break // 仅 Shift+F10 触发上下文菜单
        if (onContextMenu) {
          e.preventDefault()
          const item = items[activeIndex]
          const id = getId(item, activeIndex)
          const element = itemRefs.current.get(id)
          if (element) {
            onContextMenu(item, activeIndex, element)
          }
          handled = true
        }
        break
    }

    if (handled) {
      e.preventDefault()
      e.stopPropagation()
      if (nextIndex !== activeIndex) {
        if (isExtendSelection) {
          // Shift+方向键：扩展选择，不调用 onNavigate
          onExtendSelection?.(nextIndex)
          // 更新激活索引以提供视觉反馈
          setActiveIndexState(nextIndex)
          // moveFocus 开启时聚焦到新项
          if (moveFocus) {
            requestAnimationFrame(() => {
              const id = getId(items[nextIndex], nextIndex)
              itemRefs.current.get(id)?.focus()
            })
          }
        } else {
          // 普通导航
          navigateToIndex(nextIndex)
        }
      }
    }
  }, [enabled, items, activeIndex, orientation, wrap, onActivate, onDelete, onContextMenu, getId, navigateToIndex, onExtendSelection, moveFocus])

  const getItemProps = useCallback((item: T, index: number) => {
    const id = getId(item, index)
    const isActive = index === activeIndex

    return {
      id: `item-${id}`,
      tabIndex: isActive ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        if (el) {
          itemRefs.current.set(id, el)
        } else {
          itemRefs.current.delete(id)
        }
      },
      onKeyDown: handleKeyDown,
      // onFocus 只同步 activeIndex，不触发选择
      // 这样组件可以在外部处理点击选择
      onFocus: () => {
        if (index !== activeIndex) {
          setActiveIndexState(index)
        }
      },
      // onClick 已移除，选择逻辑由外部组件处理
      'aria-selected': isActive,
      role: 'option' as const,
    }
  }, [activeIndex, getId, handleKeyDown])

  const getContainerProps = useCallback(() => ({
    role: 'listbox' as const,
    'aria-activedescendant': items[activeIndex] ? `item-${getId(items[activeIndex], activeIndex)}` : undefined,
    onKeyDown: handleKeyDown,
  }), [items, activeIndex, getId, handleKeyDown])

  return {
    activeIndex,
    setActiveIndex,
    getItemProps,
    getContainerProps,
    focusActiveItem,
  }
}

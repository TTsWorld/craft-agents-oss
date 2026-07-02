/**
 * useEntityListInteractions — 便捷 hook，把以下能力串起来：
 * - useRovingTabIndex（键盘导航）
 * - useMultiSelect（纯选择状态）
 * - 可选的搜索过滤
 *
 * 返回可展开到 EntityList 与 EntityRow 上的 props。
 *
 * 注意：不包含 useFocusZone —— 那需要应用级 FocusContext。
 * 需要焦点区域集成的使用者请在外部组合（见 SessionList）。
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import { useRovingTabIndex } from '@/hooks/keyboard'
import * as MultiSelect from '@/hooks/useMultiSelect'

// ============================================================================
// 类型
// ============================================================================

export interface UseEntityListInteractionsOptions<T> {
  /** 列表项（过滤前） */
  items: T[]
  /** 提取唯一 ID */
  getId: (item: T) => string

  /** 键盘导航（可选） */
  keyboard?: {
    /** 在激活项上按 Enter/Space 时调用 */
    onActivate?: (item: T, index: number) => void
    /** 方向键移动到新项时调用 */
    onNavigate?: (item: T, index: number) => void
    /** 是否启用键盘导航（默认 true） */
    enabled?: boolean
    /** 导航时是否保持 DOM 焦点在别处（例如搜索框）（默认 false） */
    virtualFocus?: boolean
  }

  /** 多选（传入 true 启用） */
  multiSelect?: boolean

  /** 搜索过滤（可选） */
  search?: {
    /** 当前搜索关键词 */
    query: string
    /** 过滤函数 —— 返回 true 保留该项 */
    fn: (item: T, query: string) => boolean
  }

  /**
   * 外部选择存储（可选）。
   * 传入后 hook 使用外部状态代替内部的 useState。
   * 这样可实现跨组件共享的原子化选择（例如 Jotai）。
   *
   * @example
   * const [state, setState] = useAtom(sessionSelectionAtom)
   * const interactions = useEntityListInteractions({ ..., selectionStore: { state, setState } })
   */
  selectionStore?: {
    state: MultiSelect.MultiSelectState
    setState: (fn: MultiSelect.MultiSelectState | ((prev: MultiSelect.MultiSelectState) => MultiSelect.MultiSelectState)) => void
  }

  /**
   * 覆盖高亮时使用的“已选中”ID。
   * 传入后 getRowProps 使用此值代替 selectionState.selected。
   * 用于多面板焦点跟踪场景：由聚焦面板决定哪项被高亮。
   */
  selectedIdOverride?: string | null
}

export interface EntityListInteractions<T> {
  /** 过滤后的列表项（搜索后）。作为 EntityList 的 items prop */
  items: T[]

  /** 展开到 EntityList 的 props */
  listProps: {
    containerRef?: React.Ref<HTMLDivElement>
    containerProps: Record<string, string>
  }

  /** 获取每项 EntityRow 的 props */
  getRowProps: (item: T, index: number) => {
    buttonProps: Record<string, unknown>
    isSelected: boolean
    isInMultiSelect: boolean
    onMouseDown: (e: React.MouseEvent) => void
  }

  /** 键盘状态 */
  keyboard: {
    activeIndex: number
    setActiveIndex: (index: number) => void
    focusActiveItem: () => void
  }

  /** 展开到搜索 <input> 的 props —— 把 ArrowDown/Up 转发给列表 */
  searchInputProps: {
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  }

  /** 选择状态（仅在 multiSelect 启用时有意义） */
  selection: {
    state: MultiSelect.MultiSelectState
    isMultiSelectActive: boolean
    selectedIds: Set<string>
    toggle: (id: string, index: number) => void
    range: (toIndex: number) => void
    selectAll: () => void
    clear: () => void
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useEntityListInteractions<T>({
  items: rawItems,
  getId,
  keyboard: keyboardOpts,
  multiSelect: multiSelectEnabled = false,
  search,
  selectionStore,
  selectedIdOverride,
}: UseEntityListInteractionsOptions<T>): EntityListInteractions<T> {
  // ---- 搜索过滤 ----
  const items = useMemo(() => {
    if (!search || !search.query.trim()) return rawItems
    return rawItems.filter(item => search.fn(item, search.query))
  }, [rawItems, search?.query, search?.fn]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 多选状态 ----
  // 优先使用外部存储（如 Jotai atom），否则用本地 useState
  const [internalState, setInternalState] = useState<MultiSelect.MultiSelectState>(
    MultiSelect.createInitialState
  )
  const selectionState = selectionStore?.state ?? internalState
  const setSelectionState = selectionStore?.setState ?? setInternalState

  const allIds = useMemo(() => items.map(getId), [items, getId])

  const toggle = useCallback((id: string, index: number) => {
    setSelectionState(prev => MultiSelect.toggleSelect(prev, id, index))
  }, [])

  const range = useCallback((toIndex: number) => {
    setSelectionState(prev => MultiSelect.rangeSelect(prev, toIndex, allIds))
  }, [allIds])

  const selectAllItems = useCallback(() => {
    setSelectionState(MultiSelect.selectAll(allIds))
  }, [allIds])

  const clearSelection = useCallback(() => {
    setSelectionState(prev => MultiSelect.clearMultiSelect(prev))
  }, [])

  const isMultiSelectActive = MultiSelect.isMultiSelectActive(selectionState)

  // ---- 键盘导航 ----
  const handleNavigate = useCallback((item: T, index: number) => {
    // 滚动到可视区域
    const id = getId(item)
    requestAnimationFrame(() => {
      const el = document.getElementById(`item-${id}`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })

    // 普通方向键导航时退出多选，然后单选当前导航到的项
    if (multiSelectEnabled && isMultiSelectActive) {
      clearSelection()
    }

    // 让选择跟随键盘光标
    setSelectionState(MultiSelect.singleSelect(id, index))

    keyboardOpts?.onNavigate?.(item, index)
  }, [getId, multiSelectEnabled, isMultiSelectActive, clearSelection, keyboardOpts?.onNavigate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleActivate = useCallback((item: T, index: number) => {
    if (multiSelectEnabled && !isMultiSelectActive) {
      // 按 Enter 时单选
      setSelectionState(MultiSelect.singleSelect(getId(item), index))
    }
    keyboardOpts?.onActivate?.(item, index)
  }, [multiSelectEnabled, isMultiSelectActive, getId, keyboardOpts?.onActivate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExtendSelection = useCallback((toIndex: number) => {
    if (multiSelectEnabled) {
      range(toIndex)
    }
  }, [multiSelectEnabled, range])

  const {
    activeIndex,
    setActiveIndex,
    getItemProps,
    getContainerProps,
    focusActiveItem,
  } = useRovingTabIndex({
    items,
    getId: (item) => getId(item),
    orientation: 'vertical',
    wrap: true,
    onNavigate: handleNavigate,
    onActivate: handleActivate,
    enabled: keyboardOpts?.enabled ?? true,
    moveFocus: !(keyboardOpts?.virtualFocus ?? false),
    onExtendSelection: multiSelectEnabled ? handleExtendSelection : undefined,
  })

  // ---- 鼠标交互 ----
  // 记录最后一次点击的索引，用于 Shift+点击区间选择 —— 与 activeIndex 分开，
  // 因为 activeIndex 跟随键盘，而这里跟随鼠标点击。
  const lastClickIndexRef = useRef<number>(-1)

  const getRowMouseDown = useCallback((item: T, index: number) => {
    return (e: React.MouseEvent) => {
      const id = getId(item)

      // 右键：保留多选状态，让上下文菜单处理批量操作
      if (e.button === 2) {
        if (multiSelectEnabled && isMultiSelectActive && !selectionState.selectedIds.has(id)) {
          // 多选状态下右键点击未选中项：把它加入选择
          toggle(id, index)
        }
        // 不改变选择，上下文菜单展示批量或单条操作
        return
      }

      const isMetaKey = e.metaKey || e.ctrlKey
      const isShiftKey = e.shiftKey

      if (multiSelectEnabled && isMetaKey) {
        e.preventDefault()
        toggle(id, index)
        lastClickIndexRef.current = index
        return
      }

      if (multiSelectEnabled && isShiftKey) {
        e.preventDefault()
        range(index)
        return
      }

      // 普通点击 —— 单选
      setSelectionState(MultiSelect.singleSelect(id, index))
      lastClickIndexRef.current = index
      setActiveIndex(index)
    }
  }, [getId, multiSelectEnabled, isMultiSelectActive, selectionState.selectedIds, toggle, range, setActiveIndex])

  // ---- 搜索输入框键盘转发 ----
  // 把搜索框的 ArrowDown/ArrowUp 转发给 roving tabindex 容器处理。
  // 与 SessionList 模式一致（SessionList.tsx:1598）。
  const searchInputOnKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // 转发给 roving tabindex 容器处理
      getContainerProps().onKeyDown(e as unknown as React.KeyboardEvent)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
      return
    }
    if (e.key === 'Enter') {
      // 转发 Enter 以激活聚焦项
      e.preventDefault()
      getContainerProps().onKeyDown(e as unknown as React.KeyboardEvent)
      return
    }
  }, [getContainerProps])

  // ---- 构建返回值 ----
  const containerProps = getContainerProps()

  const listProps = useMemo(() => ({
    containerRef: undefined as React.Ref<HTMLDivElement> | undefined,
    containerProps: {
      role: containerProps.role,
      'aria-activedescendant': containerProps['aria-activedescendant'] ?? '',
    },
  }), [containerProps.role, containerProps['aria-activedescendant']])

  const getRowProps = useCallback((item: T, index: number) => {
    const id = getId(item)
    const itemProps = getItemProps(item, index)
    const effectiveSelected = selectedIdOverride !== undefined
      ? selectedIdOverride
      : selectionState.selected
    const isSelected = multiSelectEnabled
      ? effectiveSelected === id
      : index === activeIndex
    const isInMultiSelect = multiSelectEnabled && isMultiSelectActive && selectionState.selectedIds.has(id)

    return {
      buttonProps: {
        id: itemProps.id,
        tabIndex: itemProps.tabIndex,
        ref: itemProps.ref,
        onKeyDown: itemProps.onKeyDown,
        onFocus: itemProps.onFocus,
        'aria-selected': itemProps['aria-selected'],
        role: itemProps.role,
      } as Record<string, unknown>,
      isSelected,
      isInMultiSelect,
      onMouseDown: getRowMouseDown(item, index),
    }
  }, [getId, getItemProps, multiSelectEnabled, selectionState, activeIndex, isMultiSelectActive, getRowMouseDown, selectedIdOverride])

  return {
    items,
    listProps,
    getRowProps,
    searchInputProps: {
      onKeyDown: searchInputOnKeyDown,
    },
    keyboard: {
      activeIndex,
      setActiveIndex,
      focusActiveItem,
    },
    selection: {
      state: selectionState,
      isMultiSelectActive,
      selectedIds: selectionState.selectedIds,
      toggle,
      range,
      selectAll: selectAllItems,
      clear: clearSelection,
    },
  }
}

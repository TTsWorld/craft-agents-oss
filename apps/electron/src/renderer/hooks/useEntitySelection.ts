/**
 * useEntitySelection — 基于 Jotai atom 的通用选择状态工厂。
 *
 * 为任意实体类型（session、source、skill 等）创建独立的 atom 与 hook。
 * 每次调用 createEntitySelection() 都会产生一组独立的 atom 和 hook。
 *
 * 返回的 hook：
 * - useSelection()         — 完整操作 hook（select、toggle、range、clear 等）
 * - useSelectionStore()    — 原始 { state, setState }，供 useEntityListInteractions 使用
 * - useIsMultiSelectActive() — 只读布尔值
 * - useSelectedIds()       — 只读 Set<string>
 * - useSelectionCount()    — 只读数量
 */

import { atom, useAtom, useAtomValue } from 'jotai'
import { useCallback, useMemo } from 'react'
import {
  type MultiSelectState,
  createInitialState,
  singleSelect,
  toggleSelect,
  rangeSelect,
  selectAll,
  clearMultiSelect,
  removeFromSelection,
  isMultiSelectActive,
  getSelectionCount,
  isItemSelected,
} from './useMultiSelect'

export function createEntitySelection() {
  const selectionAtom = atom<MultiSelectState>(createInitialState())

  function useSelection() {
    const [state, setState] = useAtom(selectionAtom)

    const actions = useMemo(() => ({
      select: (id: string, index: number) => {
        setState(singleSelect(id, index))
      },
      toggle: (id: string, index: number) => {
        setState(prev => toggleSelect(prev, id, index))
      },
      selectRange: (toIndex: number, items: string[]) => {
        setState(prev => rangeSelect(prev, toIndex, items))
      },
      selectAll: (items: string[]) => {
        setState(selectAll(items))
      },
      clearMultiSelect: () => {
        setState(prev => clearMultiSelect(prev))
      },
      removeFromSelection: (ids: string[]) => {
        setState(prev => removeFromSelection(prev, ids))
      },
      reset: () => {
        setState(createInitialState())
      },
    }), [setState])

    return {
      state,
      ...actions,
      isMultiSelectActive: isMultiSelectActive(state),
      selectionCount: getSelectionCount(state),
      isSelected: (id: string) => isItemSelected(state, id),
    }
  }

  function useSelectionStore() {
    const [state, setState] = useAtom(selectionAtom)
    return { state, setState }
  }

  function useIsMultiSelectActive_(): boolean {
    const state = useAtomValue(selectionAtom)
    return isMultiSelectActive(state)
  }

  function useSelectedIds_(): Set<string> {
    const state = useAtomValue(selectionAtom)
    return state.selectedIds
  }

  function useSelectionCount_(): number {
    const state = useAtomValue(selectionAtom)
    return getSelectionCount(state)
  }

  return {
    useSelection,
    useSelectionStore,
    useIsMultiSelectActive: useIsMultiSelectActive_,
    useSelectedIds: useSelectedIds_,
    useSelectionCount: useSelectionCount_,
  }
}

// ============================================================================
// 实例：每种实体类型一个
// ============================================================================

export const sessionSelection = createEntitySelection()
export const sourceSelection = createEntitySelection()
export const skillSelection = createEntitySelection()
export const automationSelection = createEntitySelection()

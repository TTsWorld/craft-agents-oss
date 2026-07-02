/**
 * Session 选择相关 hook。
 *
 * 从通用的 useEntitySelection 工厂重新导出。
 * 保留旧的 useSession() hook 以兼容已有代码。
 */

import { useCallback } from 'react'
import { createInitialState, singleSelect } from './useMultiSelect'
import { sessionSelection } from './useEntitySelection'

/**
 * 旧版类型别名，仅用于向后兼容
 */
type Config = {
  selected: string | null
}

/**
 * 旧版 hook - 保持与现有代码的向后兼容。
 * 返回 [{ selected }, setSession] 元组。
 *
 * @deprecated 需要完整多选支持时请使用 useSessionSelection()
 */
export function useSession(): [Config, (config: Config) => void] {
  const { state, setState } = sessionSelection.useSelectionStore()

  const legacySetSession = useCallback((config: Config) => {
    if (config.selected === null) {
      setState(createInitialState())
    } else {
      setState(singleSelect(config.selected, -1))
    }
  }, [setState])

  return [{ selected: state.selected }, legacySetSession]
}

// 用已有名称重新导出工厂生成的 hook
export const useSessionSelection = sessionSelection.useSelection
export const useSessionSelectionStore = sessionSelection.useSelectionStore
export const useIsMultiSelectActive = sessionSelection.useIsMultiSelectActive
export const useSelectedIds = sessionSelection.useSelectedIds
export const useSelectionCount = sessionSelection.useSelectionCount

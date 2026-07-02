/**
 * 会话列表的多选状态管理。
 *
 * 本模块提供一组纯函数用于管理多选状态，支持：
 * - Shift+点击 区间选择
 * - Cmd/Ctrl+点击 切换选择
 * - 键盘导航并扩展选择
 */

export type MultiSelectState = {
  /** 当前激活/聚焦的会话 ID */
  selected: string | null
  /** 所有已选会话 ID 集合 */
  selectedIds: Set<string>
  /** Shift+点击区间选择的锚点 ID */
  anchorId: string | null
  /** 区间选择的锚点索引（在扁平列表中的位置） */
  anchorIndex: number
}

/** 创建空的多选状态 */
export function createInitialState(): MultiSelectState {
  return {
    selected: null,
    selectedIds: new Set(),
    anchorId: null,
    anchorIndex: -1,
  }
}

/**
 * 单选：清空所有选择，只选中指定项。
 * 把该项设为后续 Shift+点击的锚点。
 */
export function singleSelect(id: string, index: number): MultiSelectState {
  return {
    selected: id,
    selectedIds: new Set([id]),
    anchorId: id,
    anchorIndex: index,
  }
}

/**
 * 切换选择：添加或移除某项（Cmd/Ctrl+点击）。
 * 把被切换项设为新的锚点。
 * 禁止取消最后一个选中项（至少保留一项选中）。
 */
export function toggleSelect(state: MultiSelectState, id: string, index: number): MultiSelectState {
  const newSelectedIds = new Set(state.selectedIds)

  if (newSelectedIds.has(id)) {
    // 只剩最后一项时不允许取消选择
    if (newSelectedIds.size > 1) {
      newSelectedIds.delete(id)
      // 若取消的是当前激活项，则把激活项换为集合中剩下的某一项
      const newSelected = state.selected === id
        ? [...newSelectedIds][0]
        : state.selected
      return {
        selected: newSelected,
        selectedIds: newSelectedIds,
        anchorId: id,
        anchorIndex: index,
      }
    }
    // 不能移除最后一项，状态不变
    return state
  } else {
    // 添加到选择
    newSelectedIds.add(id)
    return {
      selected: id,
      selectedIds: newSelectedIds,
      anchorId: id,
      anchorIndex: index,
    }
  }
}

/**
 * 区间选择：选中锚点与目标索引之间的所有项（Shift+点击）。
 * 锚点保持不变，激活项移动到目标位置。
 */
export function rangeSelect(
  state: MultiSelectState,
  toIndex: number,
  items: string[]
): MultiSelectState {
  if (items.length === 0) {
    return state
  }

  // 把目标索引限制在有效范围内
  const clampedToIndex = Math.max(0, Math.min(toIndex, items.length - 1))

  // 用基于键的查找定位锚点（可应对列表重排或索引过期）
  let anchorIndex: number
  if (state.anchorIndex >= 0 && state.anchorIndex < items.length &&
      items[state.anchorIndex] === state.anchorId) {
    // 快路径：缓存索引仍有效
    anchorIndex = state.anchorIndex
  } else if (state.anchorId) {
    // 按 ID 查找锚点（应对重排）
    const foundIndex = items.indexOf(state.anchorId)
    anchorIndex = foundIndex >= 0 ? foundIndex : clampedToIndex
  } else {
    // 没有锚点，把目标位置作为锚点（首次 Shift+点击/方向键）
    anchorIndex = clampedToIndex
  }

  // 确定区间方向
  const startIndex = Math.min(anchorIndex, clampedToIndex)
  const endIndex = Math.max(anchorIndex, clampedToIndex)

  // 选中区间内的所有项
  const newSelectedIds = new Set<string>()
  for (let i = startIndex; i <= endIndex; i++) {
    newSelectedIds.add(items[i])
  }

  return {
    selected: items[clampedToIndex],
    selectedIds: newSelectedIds,
    anchorId: state.anchorId ?? items[anchorIndex],
    anchorIndex: anchorIndex,
  }
}

/**
 * 扩展选择：从锚点开始扩展一项（Shift+方向键）。
 * 与 rangeSelect 行为相同，只是保留区间外的已有选择。
 */
export function extendSelection(
  state: MultiSelectState,
  toIndex: number,
  items: string[]
): MultiSelectState {
  // Shift+方向键与 rangeSelect 行为一致，但锚点固定
  return rangeSelect(state, toIndex, items)
}

/**
 * 全选：选中所有提供的项。
 * 把第一项设为锚点。
 */
export function selectAll(items: string[]): MultiSelectState {
  if (items.length === 0) {
    return createInitialState()
  }

  return {
    selected: items[0],
    selectedIds: new Set(items),
    anchorId: items[0],
    anchorIndex: 0,
  }
}

/**
 * 清除多选：只保留当前激活项。
 * 如果没有激活项，则全部清空。
 */
export function clearMultiSelect(state: MultiSelectState): MultiSelectState {
  if (!state.selected) {
    return createInitialState()
  }

  return {
    selected: state.selected,
    selectedIds: new Set([state.selected]),
    anchorId: state.selected,
    anchorIndex: state.anchorIndex,
  }
}

/**
 * 从选择中移除指定 ID。
 * 在会话被删除时使用。
 */
export function removeFromSelection(
  state: MultiSelectState,
  idsToRemove: string[]
): MultiSelectState {
  const removeSet = new Set(idsToRemove)
  const newSelectedIds = new Set(
    [...state.selectedIds].filter(id => !removeSet.has(id))
  )

  // 若当前激活项被移除，则选择剩余第一项或 null
  const newSelected = removeSet.has(state.selected ?? '')
    ? [...newSelectedIds][0] ?? null
    : state.selected

  // 若锚点被移除，则重置为当前激活项
  const newAnchorId = removeSet.has(state.anchorId ?? '')
    ? newSelected
    : state.anchorId

  return {
    selected: newSelected,
    selectedIds: newSelectedIds,
    anchorId: newAnchorId,
    anchorIndex: state.anchorIndex, // 索引可能过期，下次交互时会更新
  }
}

/** 检查是否处于多选模式（选中项超过一个） */
export function isMultiSelectActive(state: MultiSelectState): boolean {
  return state.selectedIds.size > 1
}

/** 获取已选中项数量 */
export function getSelectionCount(state: MultiSelectState): number {
  return state.selectedIds.size
}

/** 检查指定项是否被选中 */
export function isItemSelected(state: MultiSelectState, id: string): boolean {
  return state.selectedIds.has(id)
}

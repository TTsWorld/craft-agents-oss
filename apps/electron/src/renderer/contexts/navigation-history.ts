// 导航历史工具
// 负责生成“语义化历史键”并判断是否允许执行初始路由恢复。
// 这里的 key 用于合并重复的 pushState 记录，避免无意义的 history 条目。

// 构建语义化历史键所需的输入字段
interface SemanticHistoryKeyInput {
  /** 当前 workspace 的 slug，用于隔离不同 workspace 的历史状态 */
  workspaceSlug: string | null
  /** 所有面板当前的路由字符串数组 */
  panelRoutes: string[]
  /** 焦点面板在 panelRoutes 中的索引 */
  focusedPanelIndex: number
  /** 右侧边栏参数，空字符串表示没有打开侧边栏 */
  sidebarParam: string
}

// 判断是否能执行初始路由恢复所需的输入字段
interface InitialRestoreGateInput {
  /** 应用是否已准备好导航 */
  isReady: boolean
  /** session 元数据是否已加载完成 */
  isSessionsReady: boolean
  /** 当前 workspace ID */
  workspaceId: string | null
  /** 是否已经执行过初始路由恢复（避免重复执行） */
  initialRouteRestored: boolean
}

/**
 * 根据当前面板状态生成一个语义化历史键，用于去重 pushState 记录。
 *
 * 同一个路由但焦点面板不同会被视为不同状态，因此 key 里包含 focusedPanelIndex。
 */
export function buildSemanticHistoryKey({
  workspaceSlug,
  panelRoutes,
  focusedPanelIndex,
  sidebarParam,
}: SemanticHistoryKeyInput): string {
  return [
    workspaceSlug ?? '',
    panelRoutes.join('|'),
    String(focusedPanelIndex),
    sidebarParam,
  ].join('::')
}

/**
 * 判断当前是否允许执行初始路由恢复。
 */
export function canRunInitialRestore({
  isReady,
  isSessionsReady,
  workspaceId,
  initialRouteRestored,
}: InitialRestoreGateInput): boolean {
  return isReady && isSessionsReady && !!workspaceId && !initialRouteRestored
}

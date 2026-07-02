/**
 * session-list-collapse.ts — 会话列表折叠状态工具
 *
 * 所属目录：renderer/utils
 * 运行环境：Electron 的 renderer（渲染）进程。这里只负责生成稳定的 scope 字符串，
 *         真正的持久化通常由主进程或前端状态库完成。
 * 作用：构建一个确定性的 scope 后缀，用于持久化会话列表中各分组的折叠/展开状态。
 *       防止不同 workspace、不同筛选条件或不同分组模式之间的折叠状态互相串扰。
 */
import type { SessionFilter } from '../../shared/types'

/** 构建 scope 时所需的上下文选项 */
export interface CollapsedGroupScopeOptions {
  /** 当前 workspace 的 ID；不同 workspace 的折叠状态应隔离 */
  workspaceId?: string
  /** 当前会话筛选条件；不同筛选视图的折叠状态应隔离 */
  currentFilter?: SessionFilter
  /** 分组模式：按日期 / 按状态 / 按未读 / 按项目 */
  groupingMode: 'date' | 'status' | 'unread' | 'project'
}

/**
 * 将会话筛选条件序列化为 scope 字符串。
 * 不同种类的筛选条件使用不同前缀，便于区分。
 */
export function serializeSessionFilterForScope(filter?: SessionFilter): string {
  if (!filter) return 'allSessions'

  switch (filter.kind) {
    case 'state':
      return `state:${encodeURIComponent(filter.stateId)}`
    case 'label':
      return `label:${encodeURIComponent(filter.labelId)}`
    case 'view':
      return `view:${encodeURIComponent(filter.viewId)}`
    default:
      return filter.kind
  }
}

/**
 * 构建用于持久化折叠状态的 scope 后缀。
 * 结果包含 workspace、筛选条件、分组模式三段信息，确保各场景互不干扰。
 */
export function buildCollapsedGroupsScopeSuffix({
  workspaceId,
  currentFilter,
  groupingMode,
}: CollapsedGroupScopeOptions): string {
  const workspaceSegment = workspaceId ? encodeURIComponent(workspaceId) : 'global'
  const filterSegment = serializeSessionFilterForScope(currentFilter)
  return `ws=${workspaceSegment}|filter=${filterSegment}|group=${groupingMode}`
}

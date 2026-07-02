/**
 * Route Parser —— 路由解析器。
 *
 * 将路由字符串解析为结构化的导航对象，供 navigate() 与深链接处理器使用。
 *
 * 支持的路由格式：
 * - Action: action/{name}[/{id}] —— 触发副作用
 * - Compound: {filter}[/session/{sessionId}] —— 表达完整导航状态的组合视图路由
 */

import type {
  NavigationState,
  SessionFilter,
  SourceFilter,
  AutomationFilter,
  RightSidebarPanel,
} from './types'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

// =============================================================================
// 路由类型
// =============================================================================

// 路由大类：'action' 表示动作路由，'view' 表示视图路由
export type RouteType = 'action' | 'view'

// 解析后的简单路由对象
export interface ParsedRoute {
  type: RouteType
  name: string
  id?: string
  params: Record<string, string>
}

// =============================================================================
// 组合式路由类型（新格式）
// =============================================================================

// 导航器类型：分别对应 sessions、sources、skills、automations、projects、settings 六大模块
export type NavigatorType = 'sessions' | 'sources' | 'skills' | 'automations' | 'projects' | 'settings'

export interface ParsedCompoundRoute {
  // 导航器类型
  navigator: NavigatorType
  // sessions 导航器下的筛选条件（仅当 navigator 为 sessions 时有效）
  sessionFilter?: SessionFilter
  // sources 导航器下的筛选条件（仅当 navigator 为 sources 时有效）
  sourceFilter?: SourceFilter
  // automations 导航器下的筛选条件（仅当 navigator 为 automations 时有效）
  automationFilter?: AutomationFilter
  /** 会话展示模式（仅用于 sessions 导航器）。'board' = 看板视图。 */
  viewMode?: 'list' | 'board'
  /** 详情页信息（null 表示空状态，只展示列表） */
  details: {
    type: string
    id: string
  } | null
}

// =============================================================================
// 组合式路由解析
// =============================================================================

// 表示组合式路由的前缀集合
const COMPOUND_ROUTE_PREFIXES = [
  'allSessions', 'flagged', 'archived', 'state', 'label', 'view', 'board', 'sources', 'skills', 'automations', 'projects', 'settings'
]

/**
 * 判断一段路由是否属于组合式路由（新格式）。
 *
 * 通过取第一个 segment 并检查是否在已知前缀列表中实现。
 */
export function isCompoundRoute(route: string): boolean {
  const firstSegment = route.split('?')[0].split('/')[0]
  return COMPOUND_ROUTE_PREFIXES.includes(firstSegment)
}

/**
 * 将组合式路由字符串解析为结构化的导航对象。
 *
 * 示例：
 *   'allSessions' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: null }
 *   'allSessions/session/abc123' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: { type: 'session', id: 'abc123' } }
 *   'flagged/session/abc123' -> { navigator: 'sessions', sessionFilter: { kind: 'flagged' }, details: { type: 'session', id: 'abc123' } }
 *   'sources' -> { navigator: 'sources', details: null }
 *   'sources/api' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'api' }, details: null }
 *   'sources/mcp' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'mcp' }, details: null }
 *   'sources/local' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'local' }, details: null }
 *   'sources/source/github' -> { navigator: 'sources', details: { type: 'source', id: 'github' } }
 *   'sources/api/source/gmail' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'api' }, details: { type: 'source', id: 'gmail' } }
 *   'settings' -> { navigator: 'settings', details: null }  // 仅导航器视图
 *   'settings/shortcuts' -> { navigator: 'settings', details: { type: 'shortcuts', id: 'shortcuts' } }
 */
export function parseCompoundRoute(route: string): ParsedCompoundRoute | null {
  // Compound routes are pure slash-segment paths; defensively strip any query tail
  // so a stray `?x=y` never leaks into segment parsing (e.g. into a labelId).
  const [pathPart] = route.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const first = segments[0]

  // 看板视图 —— 独立路由。以看板模式查看所有会话。
  // 编码为独立前缀（而非 `allSessions/board`），这样就不会与下面基于位置的
  // `{filter}/session/{id}` 详情解析产生冲突。
  if (first === 'board') {
    return {
      navigator: 'sessions',
      sessionFilter: { kind: 'allSessions' },
      viewMode: 'board',
      details: null,
    }
  }

  // Settings 设置导航器
  if (first === 'settings') {
    const subpage = segments[1]
    if (subpage === undefined) {
      // 裸 `settings` 路由 —— 紧凑模式下的仅导航器视图 / 桌面端的 App 回退页。
      return { navigator: 'settings', details: null }
    }
    if (!isValidSettingsSubpage(subpage)) return null
    return {
      navigator: 'settings',
      details: { type: subpage, id: subpage },
    }
  }

  // Sources 数据源导航器 —— 支持类型过滤：api、mcp、local
  if (first === 'sources') {
    if (segments.length === 1) {
      return { navigator: 'sources', details: null }
    }

    // 检查是否带类型过滤：sources/api、sources/mcp、sources/local
    const validSourceTypes = ['api', 'mcp', 'local']
    if (validSourceTypes.includes(segments[1])) {
      const sourceType = segments[1] as 'api' | 'mcp' | 'local'
      const sourceFilter: SourceFilter = { kind: 'type', sourceType }

      // 检查过滤视图内是否选中了某个 source：sources/api/source/{sourceSlug}
      if (segments[2] === 'source' && segments[3]) {
        return {
          navigator: 'sources',
          sourceFilter,
          details: { type: 'source', id: segments[3] },
        }
      }

      // 只有过滤条件，没有选中项
      return { navigator: 'sources', sourceFilter, details: null }
    }

    // 未过滤的 source 选中：sources/source/{sourceSlug}
    if (segments[1] === 'source' && segments[2]) {
      return {
        navigator: 'sources',
        details: { type: 'source', id: segments[2] },
      }
    }

    return null
  }

  // Skills 技能导航器
  if (first === 'skills') {
    if (segments.length === 1) {
      return { navigator: 'skills', details: null }
    }

    // skills/skill/{skillSlug}
    if (segments[1] === 'skill' && segments[2]) {
      return {
        navigator: 'skills',
        details: { type: 'skill', id: segments[2] },
      }
    }

    return null
  }

  // Projects 项目导航器
  if (first === 'projects') {
    if (segments.length === 1) {
      return { navigator: 'projects', details: null }
    }
    if (segments[1] === 'project' && segments[2]) {
      return {
        navigator: 'projects',
        details: { type: 'project', id: segments[2] },
      }
    }
    return null
  }

  // Automations 自动化导航器 —— 支持类型过滤：scheduled、event、agentic
  if (first === 'automations') {
    if (segments.length === 1) {
      return { navigator: 'automations', details: null }
    }

    // 检查是否带类型过滤：automations/scheduled、automations/event、automations/agentic
    const validAutomationTypes = ['scheduled', 'event', 'agentic']
    if (validAutomationTypes.includes(segments[1])) {
      const automationType = segments[1] as 'scheduled' | 'event' | 'agentic'
      const automationFilter: AutomationFilter = { kind: 'type', automationType }

      // 检查过滤视图内是否选中了某个 automation：automations/scheduled/automation/{automationId}
      if (segments[2] === 'automation' && segments[3]) {
        return {
          navigator: 'automations',
          automationFilter,
          details: { type: 'automation', id: segments[3] },
        }
      }

      // 只有过滤条件，没有选中项
      return { navigator: 'automations', automationFilter, details: null }
    }

    // 未过滤的 automation 选中：automations/automation/{automationId}
    if (segments[1] === 'automation' && segments[2]) {
      return {
        navigator: 'automations',
        details: { type: 'automation', id: segments[2] },
      }
    }

    return null
  }

  // Sessions 会话导航器（allSessions、flagged、state、label、view、archived）
  let sessionFilter: SessionFilter
  let detailsStartIndex: number

  switch (first) {
    case 'allSessions':
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 1
      break
    case 'flagged':
      sessionFilter = { kind: 'flagged' }
      detailsStartIndex = 1
      break
    case 'archived':
      sessionFilter = { kind: 'archived' }
      detailsStartIndex = 1
      break
    case 'state':
      if (!segments[1]) return null
      // 类型断言是安全的，因为值来自 URL，且已做存在性检查
      sessionFilter = { kind: 'state', stateId: segments[1] as SessionFilter & { kind: 'state' } extends { stateId: infer T } ? T : never }
      detailsStartIndex = 2
      break
    case 'label':
      if (!segments[1]) return null
      // Label ID 需要 URL 解码（预期为简单 slug，无特殊字符）
      sessionFilter = { kind: 'label', labelId: decodeURIComponent(segments[1]) }
      detailsStartIndex = 2
      break
    case 'view':
      if (!segments[1]) return null
      sessionFilter = { kind: 'view', viewId: decodeURIComponent(segments[1]) }
      detailsStartIndex = 2
      break
    default:
      return null
  }

  // 检查是否有详情段
  if (segments.length > detailsStartIndex) {
    const detailsType = segments[detailsStartIndex]
    const detailsId = segments[detailsStartIndex + 1]
    if (detailsType === 'session' && detailsId) {
      return {
        navigator: 'sessions',
        sessionFilter,
        details: { type: 'session', id: detailsId },
      }
    }
  }

  return {
    navigator: 'sessions',
    sessionFilter,
    details: null,
  }
}

/**
 * 从解析后的组合式路由对象重新构建路由字符串。
 */
export function buildCompoundRoute(parsed: ParsedCompoundRoute): string {
  if (parsed.navigator === 'settings') {
    if (!parsed.details) return 'settings'
    return `settings/${parsed.details.type}`
  }

  if (parsed.navigator === 'sources') {
    // 先根据过滤类型构造基础路径：sources、sources/api、sources/mcp、sources/local
    let base = 'sources'
    if (parsed.sourceFilter?.kind === 'type') {
      base = `sources/${parsed.sourceFilter.sourceType}`
    }
    if (!parsed.details) return base
    return `${base}/source/${parsed.details.id}`
  }

  if (parsed.navigator === 'skills') {
    if (!parsed.details) return 'skills'
    return `skills/skill/${parsed.details.id}`
  }

  if (parsed.navigator === 'automations') {
    // 先根据过滤类型构造基础路径：automations、automations/scheduled、automations/event、automations/agentic
    let base = 'automations'
    if (parsed.automationFilter?.kind === 'type') {
      base = `automations/${parsed.automationFilter.automationType}`
    }
    if (!parsed.details) return base
    return `${base}/automation/${parsed.details.id}`
  }

  if (parsed.navigator === 'projects') {
    if (!parsed.details) return 'projects'
    return `projects/project/${parsed.details.id}`
  }

  // Sessions 会话导航器
  // 看板是所有会话的独立视图；输出其自己的前缀。
  if (parsed.viewMode === 'board') return 'board'

  let base: string
  const filter = parsed.sessionFilter
  if (!filter) return 'allSessions'

  switch (filter.kind) {
    case 'allSessions':
      base = 'allSessions'
      break
    case 'flagged':
      base = 'flagged'
      break
    case 'archived':
      base = 'archived'
      break
    case 'state':
      base = `state/${filter.stateId}`
      break
    case 'label':
      base = `label/${encodeURIComponent(filter.labelId)}`
      break
    case 'view':
      base = `view/${encodeURIComponent(filter.viewId)}`
      break
    default:
      base = 'allSessions'
  }

  if (!parsed.details) return base
  return `${base}/session/${parsed.details.id}`
}

// =============================================================================
// 路由解析（兼容旧格式）
// =============================================================================

/**
 * 将路由字符串解析为结构化的 ParsedRoute。
 *
 * 示例：
 *   'allSessions' -> { type: 'view', name: 'allSessions', params: {} }
 *   'allSessions/session/abc123' -> { type: 'view', name: 'session', id: 'abc123', params: { filter: 'allSessions' } }
 *   'settings/shortcuts' -> { type: 'view', name: 'shortcuts', params: {} }
 *   'action/new-session' -> { type: 'action', name: 'new-session', params: {} }
 */
export function parseRoute(route: string): ParsedRoute | null {
  try {
    // 优先检查是否为组合式路由（推荐格式）
    if (isCompoundRoute(route)) {
      const compound = parseCompoundRoute(route)
      if (compound) {
        return convertCompoundToViewRoute(compound)
      }
    }

    // 解析 action 路由：action/{name}[/{id}]
    const [pathPart, queryPart] = route.split('?')
    const segments = pathPart.split('/').filter(Boolean)

    if (segments.length < 2) {
      return null
    }

    const type = segments[0]
    if (type !== 'action') {
      return null
    }

    const name = segments[1]
    const id = segments[2]

    // 解析 query 参数
    const params: Record<string, string> = {}
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart)
      searchParams.forEach((value, key) => {
        params[key] = value
      })
    }

    return { type: 'action', name, id, params }
  } catch {
    return null
  }
}

/**
 * 将解析后的组合式路由转换为 ParsedRoute 格式（type 为 'view'）。
 */
function convertCompoundToViewRoute(compound: ParsedCompoundRoute): ParsedRoute {
  // Settings 设置
  if (compound.navigator === 'settings') {
    const subpage = compound.details?.type || 'app'
    if (subpage === 'app') {
      return { type: 'view', name: 'settings', params: {} }
    }
    return { type: 'view', name: subpage, params: {} }
  }

  // Sources 数据源
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return { type: 'view', name: 'sources', params: {} }
    }
    return { type: 'view', name: 'source-info', id: compound.details.id, params: {} }
  }

  // Skills 技能
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { type: 'view', name: 'skills', params: {} }
    }
    return { type: 'view', name: 'skill-info', id: compound.details.id, params: {} }
  }

  // Automations 自动化
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return { type: 'view', name: 'automations', params: {} }
    }
    return { type: 'view', name: 'automation-info', id: compound.details.id, params: {} }
  }

  // Projects 项目
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { type: 'view', name: 'projects', params: {} }
    }
    return { type: 'view', name: 'project-info', id: compound.details.id, params: {} }
  }

  // Sessions 会话
  if (compound.sessionFilter) {
    const filter = compound.sessionFilter
    if (compound.details) {
      return {
        type: 'view',
        name: 'session',
        id: compound.details.id,
        params: {
          filter: filter.kind,
          ...(filter.kind === 'state' ? { stateId: filter.stateId } : {}),
          ...(filter.kind === 'label' ? { labelId: filter.labelId } : {}),
          ...(filter.kind === 'view' ? { viewId: filter.viewId } : {}),
        },
      }
    }
    return {
      type: 'view',
      name: filter.kind,
      id: filter.kind === 'state' ? filter.stateId : (filter.kind === 'label' ? filter.labelId : (filter.kind === 'view' ? filter.viewId : undefined)),
      params: {},
    }
  }

  return { type: 'view', name: 'allSessions', params: {} }
}

// =============================================================================
// NavigationState 解析（新的统一导航系统）
// =============================================================================

/**
 * 直接将路由字符串解析为 NavigationState（统一的导航状态）。
 *
 * 这是推荐的路由解析方式 —— 返回的状态同时决定三个面板：
 * 侧边栏（sidebar）、导航器（navigator）、主内容区（main content）。
 *
 * 支持：
 * - 组合式路由：allSessions、allSessions/session/abc、sources、sources/source/github、settings/shortcuts
 * - 右侧边栏参数：?sidebar=files 或 ?sidebar=history
 *
 * 对 action 路由（不映射到导航状态）和非法路由返回 null。
 */
export function parseRouteToNavigationState(
  route: string,
  sidebarParam?: string
): NavigationState | null {
  // 解析组合式路由
  if (isCompoundRoute(route)) {
    const compound = parseCompoundRoute(route)
    if (compound) {
      const state = convertCompoundToNavigationState(compound)
      // 如果提供了右侧边栏参数，则合并到状态
      const rightSidebar = parseRightSidebarParam(sidebarParam)
      if (rightSidebar) {
        return { ...state, rightSidebar }
      }
      return state
    }
  }

  // 按普通路由解析（可能是 action 或 view）
  const parsed = parseRoute(route)
  if (!parsed) return null

  // action 路由不对应导航状态
  if (parsed.type === 'action') return null

  // 将 view 路由转换为 NavigationState
  const state = convertParsedRouteToNavigationState(parsed)
  if (state) {
    const rightSidebar = parseRightSidebarParam(sidebarParam)
    if (rightSidebar) {
      return { ...state, rightSidebar }
    }
  }
  return state
}

/**
 * 将 ParsedCompoundRoute 转换为 NavigationState。
 */
function convertCompoundToNavigationState(compound: ParsedCompoundRoute): NavigationState {
  // Settings 设置
  if (compound.navigator === 'settings') {
    if (!compound.details) {
      return { navigator: 'settings', subpage: null }
    }
    return { navigator: 'settings', subpage: compound.details.type as SettingsSubpage }
  }

  // Sources 数据源 —— 如果存在筛选条件则一并带上
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return {
        navigator: 'sources',
        filter: compound.sourceFilter,
        details: null,
      }
    }
    return {
      navigator: 'sources',
      filter: compound.sourceFilter,
      details: { type: 'source', sourceSlug: compound.details.id },
    }
  }

  // Skills 技能
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { navigator: 'skills', details: null }
    }
    return {
      navigator: 'skills',
      details: { type: 'skill', skillSlug: compound.details.id },
    }
  }

  // Automations 自动化 —— 如果存在筛选条件则一并带上
  if (compound.navigator === 'automations') {
    if (!compound.details) {
      return {
        navigator: 'automations',
        filter: compound.automationFilter,
        details: null,
      }
    }
    return {
      navigator: 'automations',
      filter: compound.automationFilter,
      details: { type: 'automation', automationId: compound.details.id },
    }
  }

  // Projects 项目
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { navigator: 'projects', details: null }
    }
    return {
      navigator: 'projects',
      details: { type: 'project', projectSlug: compound.details.id },
    }
  }

  // Sessions 会话
  const filter = compound.sessionFilter || { kind: 'allSessions' as const }
  if (compound.details) {
    return {
      navigator: 'sessions',
      filter,
      details: { type: 'session', sessionId: compound.details.id },
    }
  }
  return {
    navigator: 'sessions',
    filter,
    viewMode: compound.viewMode,
    details: null,
  }
}

/**
 * 将 ParsedRoute（view 类型）转换为 NavigationState。
 */
function convertParsedRouteToNavigationState(parsed: ParsedRoute): NavigationState | null {
  // 只处理 view 路由（组合式路由在这里已经被转成 view 类型）
  if (parsed.type !== 'view') {
    return null
  }

  switch (parsed.name) {
    case 'settings':
      return { navigator: 'settings', subpage: 'app' }
    case 'workspace':
      return { navigator: 'settings', subpage: 'workspace' }
    case 'permissions':
      return { navigator: 'settings', subpage: 'permissions' }
    case 'labels':
      return { navigator: 'settings', subpage: 'labels' }
    case 'shortcuts':
      return { navigator: 'settings', subpage: 'shortcuts' }
    case 'preferences':
      return { navigator: 'settings', subpage: 'preferences' }
    case 'sources':
      return { navigator: 'sources', details: null }
    case 'source-info':
      if (parsed.id) {
        return {
          navigator: 'sources',
          details: {
            type: 'source',
            sourceSlug: parsed.id,
          },
        }
      }
      return { navigator: 'sources', details: null }
    case 'skills':
      return { navigator: 'skills', details: null }
    case 'skill-info':
      if (parsed.id) {
        return {
          navigator: 'skills',
          details: {
            type: 'skill',
            skillSlug: parsed.id,
          },
        }
      }
      return { navigator: 'skills', details: null }
    case 'automations':
      return { navigator: 'automations', details: null }
    case 'automation-info':
      if (parsed.id) {
        return {
          navigator: 'automations',
          details: {
            type: 'automation',
            automationId: parsed.id,
          },
        }
      }
      return { navigator: 'automations', details: null }
    case 'projects':
      return { navigator: 'projects', details: null }
    case 'project-info':
      if (parsed.id) {
        return {
          navigator: 'projects',
          details: { type: 'project', projectSlug: parsed.id },
        }
      }
      return { navigator: 'projects', details: null }
    case 'session':
      if (parsed.id) {
        // 从 params 重建筛选条件
        const filterKind = (parsed.params.filter || 'allSessions') as SessionFilter['kind']
        let filter: SessionFilter
        if (filterKind === 'state' && parsed.params.stateId) {
          filter = { kind: 'state', stateId: parsed.params.stateId }
        } else if (filterKind === 'label' && parsed.params.labelId) {
          filter = { kind: 'label', labelId: parsed.params.labelId }
        } else if (filterKind === 'view' && parsed.params.viewId) {
          filter = { kind: 'view', viewId: parsed.params.viewId }
        } else {
          filter = { kind: filterKind as 'allSessions' | 'flagged' | 'archived' }
        }
        return {
          navigator: 'sessions',
          filter,
          details: { type: 'session', sessionId: parsed.id },
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'allSessions':
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      }
    case 'flagged':
      return {
        navigator: 'sessions',
        filter: { kind: 'flagged' },
        details: null,
      }
    case 'archived':
      return {
        navigator: 'sessions',
        filter: { kind: 'archived' },
        details: null,
      }
    case 'state':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'state', stateId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'label':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'label', labelId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'view':
      if (parsed.id) {
        return {
          navigator: 'sessions',
          filter: { kind: 'view', viewId: parsed.id },
          details: null,
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    default:
      return null
  }
}

/**
 * 将 NavigationState 转换为 ParsedCompoundRoute。
 */
function navigationStateToCompoundRoute(state: NavigationState): ParsedCompoundRoute {
  if (state.navigator === 'settings') {
    if (state.subpage === null) {
      return { navigator: 'settings', details: null }
    }
    return {
      navigator: 'settings',
      details: { type: state.subpage, id: state.subpage },
    }
  }

  if (state.navigator === 'sources') {
    return {
      navigator: 'sources',
      sourceFilter: state.filter ?? undefined,
      details: state.details ? { type: 'source', id: state.details.sourceSlug } : null,
    }
  }

  if (state.navigator === 'skills') {
    return {
      navigator: 'skills',
      details: state.details?.type === 'skill' ? { type: 'skill', id: state.details.skillSlug } : null,
    }
  }

  if (state.navigator === 'automations') {
    return {
      navigator: 'automations',
      automationFilter: state.filter ?? undefined,
      details: state.details ? { type: 'automation', id: state.details.automationId } : null,
    }
  }

  if (state.navigator === 'projects') {
    return {
      navigator: 'projects',
      details: state.details ? { type: 'project', id: state.details.projectSlug } : null,
    }
  }

  // Sessions 会话
  return {
    navigator: 'sessions',
    sessionFilter: state.filter,
    viewMode: state.viewMode,
    details: state.details ? { type: 'session', id: state.details.sessionId } : null,
  }
}

/**
 * 从 NavigationState 构建路由字符串。
 */
export function buildRouteFromNavigationState(state: NavigationState): string {
  return buildCompoundRoute(navigationStateToCompoundRoute(state))
}

// =============================================================================
// 右侧边栏参数解析
// =============================================================================

/**
 * 从 URL query string 中解析右侧边栏参数。
 *
 * 示例：
 *   'history' -> { type: 'history' }
 *   'files' -> { type: 'files' }
 *   'files/src/main.ts' -> { type: 'files', path: 'src/main.ts' }
 *   'none' -> { type: 'none' }
 */
export function parseRightSidebarParam(sidebarStr?: string): RightSidebarPanel | undefined {
  if (!sidebarStr) return undefined

  if (sidebarStr === 'history') {
    return { type: 'history' }
  }
  if (sidebarStr.startsWith('files')) {
    const path = sidebarStr.substring(6) // 去掉 'files/' 前缀
    return { type: 'files', path: path || undefined }
  }
  if (sidebarStr === 'none') {
    return { type: 'none' }
  }

  return undefined
}

/**
 * 将右侧边栏面板对象编码为 URL query string 值。
 *
 * 对 'none' 类型返回 undefined，以便从 URL 中省略，保持 URL 简洁。
 */
export function buildRightSidebarParam(panel?: RightSidebarPanel): string | undefined {
  if (!panel || panel.type === 'none') return undefined

  switch (panel.type) {
    case 'history':
      return 'history'
    case 'files':
      return panel.path ? `files/${panel.path}` : 'files'
    default:
      return undefined
  }
}

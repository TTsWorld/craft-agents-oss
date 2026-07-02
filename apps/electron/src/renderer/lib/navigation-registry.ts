/**
 * 导航注册表
 *
 * 用类型安全的方式定义 navigator（导航器）与详情页之间的对应关系。
 * 这样能在编译期保证：新增页面必须在这里注册，关系不完整会导致编译失败。
 *
 * 结构：Navigator → Details Pages → Components
 *
 * 每个 navigator 包含：
 * - 合法的详情页类型列表
 * - 默认详情页（null 表示允许空状态）
 * - 自动选中第一项的逻辑
 */

import type { ComponentType } from 'react'
import type { SessionFilter } from '../../shared/types'

// =============================================================================
// 类型
// =============================================================================

/**
 * 传给 navigator 组件的 props
 */
export interface NavigatorProps {
  /** 选中详情项时的回调 */
  onSelectDetails: (detailsType: string, detailsId: string) => void
  /** 当前选中的详情 */
  selectedDetails?: { type: string; id: string }
}

/**
 * 传给详情页组件的 props
 */
export interface DetailsProps {
  /** 选中项的 ID */
  id: string
  /** 页面特有的额外 props */
  [key: string]: unknown
}

/**
 * 用于导航推断的上下文数据
 */
export interface NavigationData {
  /** 当前过滤条件下的所有会话 */
  sessions: Array<{ id: string; isFlagged?: boolean; stateId?: string }>
  /** 所有 sources */
  sources: Array<{ slug: string }>
  /** sessions 模式下的当前过滤条件 */
  sessionFilter?: SessionFilter
}

/**
 * 单个 navigator 的配置
 */
export interface NavigatorConfig<TDetailsPages extends Record<string, ComponentType<DetailsProps>>> {
  /** navigator 的显示名称 */
  displayName: string
  /** 合法的详情页类型及其对应组件 */
  detailsPages: TDetailsPages
  /** 导航到该 navigator 时的默认详情页（null 表示允许空状态） */
  defaultDetails: (keyof TDetailsPages & string) | null
  /** 获取自动选中的第一项 ID（为空时返回 null） */
  getFirstItem: (context: NavigationData) => string | null
}

// =============================================================================
// Navigator 类型
// =============================================================================

/**
 * 应用中所有的 navigator 类型
 */
export type NavigatorType = 'sessions' | 'sources' | 'settings'

/**
 * 映射到侧边栏路由的会话过滤种类
 */
export type SessionFilterKind = 'allSessions' | 'flagged' | 'state'

// =============================================================================
// 详情页元数据
// =============================================================================

/**
 * 每个详情页应导出的元数据。
 * 用于反向查找与校验。
 */
export interface DetailsPageMeta {
  /** 所属 navigator */
  navigator: NavigatorType
  /** 路由中使用的 slug */
  slug: string
}

// =============================================================================
// 注册表定义
// =============================================================================

/**
 * 占位组件，迁移期间确保类型安全。
 */
const PlaceholderComponent: ComponentType<DetailsProps> = () => null

/**
 * 中央导航注册表
 *
 * 重要：本对象定义了应用中所有合法的导航路径。
 * 新增页面需要：
 * 1. 创建组件
 * 2. 把它加入对应 navigator 的 detailsPages
 * 3. 在组件中导出 meta
 */
export const NavigationRegistry = {
  sessions: {
    displayName: 'Sessions',
    detailsPages: {
      session: PlaceholderComponent, // 未来替换为 ChatPage
    },
    defaultDetails: null, // 没有会话时显示空状态
    getFirstItem: (ctx: NavigationData) => {
      if (!ctx.sessions.length) return null
      // 根据当前会话过滤条件筛选
      const filter = ctx.sessionFilter
      if (!filter) return ctx.sessions[0]?.id ?? null

      let filtered = ctx.sessions
      switch (filter.kind) {
        case 'flagged':
          filtered = ctx.sessions.filter(s => s.isFlagged)
          break
        case 'state':
          filtered = ctx.sessions.filter(s => s.stateId === filter.stateId)
          break
        case 'allSessions':
        default:
          // allSessions 显示全部会话
          break
      }
      return filtered[0]?.id ?? null
    },
  },

  sources: {
    displayName: 'Sources',
    detailsPages: {
      source: PlaceholderComponent, // 未来替换为 SourceInfoPage
    },
    defaultDetails: null, // 没有 source 时显示空状态
    getFirstItem: (ctx: NavigationData) => ctx.sources[0]?.slug ?? null,
  },

  settings: {
    displayName: 'Settings',
    detailsPages: {
      app: PlaceholderComponent, // AppSettingsPage
      ai: PlaceholderComponent, // AiSettingsPage
      appearance: PlaceholderComponent, // AppearanceSettingsPage
      input: PlaceholderComponent, // InputSettingsPage
      workspace: PlaceholderComponent, // WorkspaceSettingsPage
      permissions: PlaceholderComponent, // PermissionsSettingsPage
      labels: PlaceholderComponent, // LabelsSettingsPage
      shortcuts: PlaceholderComponent, // ShortcutsPage
      preferences: PlaceholderComponent, // PreferencesPage
    },
    defaultDetails: 'app', // 设置页始终有默认项
    getFirstItem: () => 'app',
  },
} as const satisfies Record<NavigatorType, NavigatorConfig<Record<string, ComponentType<DetailsProps>>>>

// =============================================================================
// 类型工具
// =============================================================================

/**
 * 提取某个 navigator 下的详情页类型
 */
export type DetailsType<N extends NavigatorType> = keyof (typeof NavigationRegistry)[N]['detailsPages'] & string

/**
 * 所有 navigator 中可能的详情类型
 */
export type AnyDetailsType = DetailsType<'sessions'> | DetailsType<'sources'> | DetailsType<'settings'>

// =============================================================================
// 导航状态类型
// =============================================================================

/**
 * 完整的导航状态
 */
export type NavigationState =
  | { navigator: 'sessions'; sessionFilter: SessionFilter; details: { type: 'session'; id: string } | null }
  | { navigator: 'sources'; details: { type: 'source'; id: string } | null }
  | { navigator: 'settings'; details: { type: DetailsType<'settings'>; id: string } }

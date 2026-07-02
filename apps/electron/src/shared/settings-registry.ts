/**
 * Settings Registry —— 设置页面的唯一事实来源（Single Source of Truth）。
 *
 * 这里集中定义所有设置页面，其他文件应从本文件导入相关信息。
 *
 * 新增设置页面的步骤：
 * 1. 在 SETTINGS_PAGES 中新增一项
 * 2. 在 renderer/pages/settings/ 下创建页面组件
 * 3. 在 renderer/pages/settings/settings-pages.ts 的 SETTINGS_PAGE_COMPONENTS 中注册
 * 4. 在 renderer/components/icons/SettingsIcons.tsx 的 SETTINGS_ICONS 中添加图标
 *
 * 完成后，类型、路由、校验都会自动派生，无需再手动维护多处。
 */

// 设置页面定义
export interface SettingsPageDefinition {
  // 唯一标识，同时用于路由与导航
  id: string
  // 在设置导航中显示标题的 i18n key，渲染时通过 t() 解析
  labelKey: string
  // 在设置导航中显示简短描述的 i18n key，渲染时通过 t() 解析
  descriptionKey: string
}

/**
 * 所有设置页面的权威列表。
 * 这里的顺序决定设置导航中的显示顺序。
 *
 * 注意：labelKey / descriptionKey 是 i18n 翻译 key，必须在渲染时通过 t() 解析。
 * 不要在本模块调用 i18n.t()，因为本模块加载时 i18n 尚未初始化。
 */
export const SETTINGS_PAGES = [
  { id: 'app' as const, labelKey: 'settings.app.title', descriptionKey: 'settings.app.description' },
  { id: 'ai' as const, labelKey: 'settings.ai.title', descriptionKey: 'settings.ai.description' },
  { id: 'appearance' as const, labelKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description' },
  { id: 'input' as const, labelKey: 'settings.input.title', descriptionKey: 'settings.input.description' },
  { id: 'workspace' as const, labelKey: 'settings.workspace.title', descriptionKey: 'settings.workspace.description' },
  { id: 'permissions' as const, labelKey: 'settings.permissions.title', descriptionKey: 'settings.permissions.description' },
  { id: 'labels' as const, labelKey: 'settings.labels.title', descriptionKey: 'settings.labels.description' },
  { id: 'messaging' as const, labelKey: 'settings.messaging.title', descriptionKey: 'settings.messaging.description' },
  { id: 'server' as const, labelKey: 'settings.server.title', descriptionKey: 'settings.server.description' },
  { id: 'shortcuts' as const, labelKey: 'settings.shortcuts.title', descriptionKey: 'settings.shortcuts.description' },
  { id: 'preferences' as const, labelKey: 'settings.preferences.title', descriptionKey: 'settings.preferences.description' },
] satisfies readonly SettingsPageDefinition[]

/**
 * 设置子页面类型 —— 从 SETTINGS_PAGES 自动派生。
 * 这样就不用在 types.ts 里手写联合类型，避免新增页面时遗漏。
 */
export type SettingsSubpage = (typeof SETTINGS_PAGES)[number]['id']

// 合法的设置子页面 ID 数组，用于运行时校验
export const VALID_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = SETTINGS_PAGES.map(p => p.id)

/**
 * 类型守卫（Type Guard）：判断一个字符串是否是合法的设置子页面。
 *
 * 返回 `value is SettingsSubpage` 后，TS 会在后续分支中将 value 收窄为 SettingsSubpage 类型，
 * 类似 Go 的类型断言，但由编译器在静态阶段感知。
 */
export function isValidSettingsSubpage(value: string): value is SettingsSubpage {
  return VALID_SETTINGS_SUBPAGES.includes(value as SettingsSubpage)
}

// 根据 ID 获取设置页面定义
export function getSettingsPage(id: SettingsSubpage): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`Unknown settings page: ${id}`)
  return page
}

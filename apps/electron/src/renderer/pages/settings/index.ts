/**
 * 设置页面索引
 *
 * SettingsNavigator 与所有设置子页面的统一出口。
 * 每个页面除了默认导出组件外，还导出 meta 供导航注册表使用。
 */

export { default as SettingsNavigator } from './SettingsNavigator'
export { default as AppSettingsPage, meta as AppSettingsMeta } from './AppSettingsPage'
export { default as AiSettingsPage, meta as AiSettingsMeta } from './AiSettingsPage'
export { default as AppearanceSettingsPage, meta as AppearanceMeta } from './AppearanceSettingsPage'
export { default as InputSettingsPage, meta as InputMeta } from './InputSettingsPage'
export { default as WorkspaceSettingsPage, meta as WorkspaceSettingsMeta } from './WorkspaceSettingsPage'
export { default as PermissionsSettingsPage, meta as PermissionsMeta } from './PermissionsSettingsPage'
export { default as LabelsSettingsPage, meta as LabelsMeta } from './LabelsSettingsPage'
export { default as ShortcutsPage, meta as ShortcutsMeta } from './ShortcutsPage'
export { default as PreferencesPage, meta as PreferencesMeta } from './PreferencesPage'

// 重新导出导航元信息类型，方便外部统一引用
export type { DetailsPageMeta } from '@/lib/navigation-registry'

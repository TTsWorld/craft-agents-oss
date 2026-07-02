/**
 * 页面入口索引
 *
 * 汇总所有页面组件并通过命名导出供 MainContentPanel 使用。
 * 类似 Go 中把多个子包的能力统一 expose 到一个 package 入口。
 */

export { default as ChatPage } from './ChatPage'
export { default as SourceInfoPage } from './SourceInfoPage'
// 设置相关页面，统一从 settings 子目录导出
export {
  SettingsNavigator,
  AppSettingsPage,
  AiSettingsPage,
  AppearanceSettingsPage,
  InputSettingsPage,
  WorkspaceSettingsPage,
  PermissionsSettingsPage,
  LabelsSettingsPage,
  ShortcutsPage,
  PreferencesPage,
} from './settings'

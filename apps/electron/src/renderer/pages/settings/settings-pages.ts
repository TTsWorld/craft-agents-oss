/**
 * 设置页面组件注册表
 *
 * 把设置子页面 ID（来自 shared/settings-registry）映射到对应的 React 组件。
 * TypeScript 会保证 SETTINGS_PAGES 中定义的每个页面都在这里存在对应组件。
 *
 * 新增设置页面的步骤：
 * 1. 在 shared/settings-registry.ts 的 SETTINGS_PAGES 中添加
 * 2. 创建页面组件（如 NewSettingsPage.tsx）
 * 3. 在下方的 SETTINGS_PAGE_COMPONENTS 中注册
 * 4. 在 components/icons/SettingsIcons.tsx 中添加图标
 */

import type { ComponentType } from 'react'
import type { SettingsSubpage } from '../../../shared/settings-registry'

import AppSettingsPage from './AppSettingsPage'
import AiSettingsPage from './AiSettingsPage'
import AppearanceSettingsPage from './AppearanceSettingsPage'
import InputSettingsPage from './InputSettingsPage'
import WorkspaceSettingsPage from './WorkspaceSettingsPage'
import PermissionsSettingsPage from './PermissionsSettingsPage'
import LabelsSettingsPage from './LabelsSettingsPage'
import MessagingSettingsPage from './MessagingSettingsPage'
import ServerSettingsPage from './ServerSettingsPage'
import ShortcutsPage from './ShortcutsPage'
import PreferencesPage from './PreferencesPage'

/**
 * 子页面 ID 到 React 组件的映射。
 * 如果 shared 中新增了一个 ID 但没有在这里写对应组件，TypeScript 会报错。
 */
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType> = {
  app: AppSettingsPage,
  ai: AiSettingsPage,
  appearance: AppearanceSettingsPage,
  input: InputSettingsPage,
  workspace: WorkspaceSettingsPage,
  permissions: PermissionsSettingsPage,
  labels: LabelsSettingsPage,
  messaging: MessagingSettingsPage,
  server: ServerSettingsPage,
  shortcuts: ShortcutsPage,
  preferences: PreferencesPage,
}

/**
 * 根据子页面 ID 获取对应组件
 */
export function getSettingsPageComponent(subpage: SettingsSubpage): ComponentType {
  return SETTINGS_PAGE_COMPONENTS[subpage]
}

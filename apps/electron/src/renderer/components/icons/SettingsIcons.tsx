/**
 * SettingsIcons —— 设置页面共享的 Lucide 图标映射。
 *
 * 在以下两处使用：
 * - AppMenu（Logo 下拉菜单里的设置子菜单）
 * - SettingsNavigator（设置页左侧边栏）
 *
 * 对 Go 同学的小提示：
 * - `Record<K, V>` 是 TS 内置类型，表示“键为 K、值为 V 的字典/映射”，类似 Go 的 `map[K]V`。
 * - `React.ComponentType<IconProps>` 表示“接收 IconProps 的 React 组件类型”。
 */

import {
  Building2,
  Keyboard,
  MessageSquare,
  Palette,
  Server,
  ShieldCheck,
  Sparkles,
  Tag,
  ToggleRight,
  UserCircle,
} from 'lucide-react'
import type { SettingsSubpage } from '../../../shared/types'

type IconProps = { className?: string }

export const AppSettingsIcon = ({ className }: IconProps) => <ToggleRight className={className} />
export const AiSettingsIcon = ({ className }: IconProps) => <Sparkles className={className} />
export const AppearanceIcon = ({ className }: IconProps) => <Palette className={className} />
export const InputIcon = ({ className }: IconProps) => <Keyboard className={className} />
export const WorkspaceIcon = ({ className }: IconProps) => <Building2 className={className} />
export const PermissionsIcon = ({ className }: IconProps) => <ShieldCheck className={className} />
export const LabelsIcon = ({ className }: IconProps) => <Tag className={className} />
export const MessagingSettingsIcon = ({ className }: IconProps) => <MessageSquare className={className} />
export const ServerSettingsIcon = ({ className }: IconProps) => <Server className={className} />
export const ShortcutsIcon = ({ className }: IconProps) => <Keyboard className={className} />
export const PreferencesIcon = ({ className }: IconProps) => <UserCircle className={className} />

/** 设置子页面 ID 到对应图标组件的映射表，保证菜单和边栏图标一致 */
export const SETTINGS_ICONS: Record<SettingsSubpage, React.ComponentType<IconProps>> = {
  app: AppSettingsIcon,
  ai: AiSettingsIcon,
  appearance: AppearanceIcon,
  input: InputIcon,
  workspace: WorkspaceIcon,
  permissions: PermissionsIcon,
  labels: LabelsIcon,
  messaging: MessagingSettingsIcon,
  server: ServerSettingsIcon,
  shortcuts: ShortcutsIcon,
  preferences: PreferencesIcon,
}

/**
 * Settings Components
 *
 * 设置页可复用的 UI 组件集合。
 * 提供统一的样式和行为，方便在 renderer 进程（Electron 的前端界面）中组装设置页面。
 *
 * @example
 * import {
 *   SettingsSection,
 *   SettingsCard,
 *   SettingsToggle,
 *   SettingsRadioGroup,
 *   SettingsRadioCard,
 * } from '@/components/settings'
 */

// 结构类组件
export {
  SettingsSection,
  SettingsGroup,
  SettingsDivider,
  type SettingsSectionProps,
  type SettingsGroupProps,
  type SettingsDividerProps,
} from './SettingsSection'

export {
  SettingsCard,
  SettingsCardContent,
  SettingsCardFooter,
  type SettingsCardProps,
} from './SettingsCard'

// 行类组件
export {
  SettingsRow,
  SettingsRowLabel,
  type SettingsRowProps,
} from './SettingsRow'

export {
  SettingsToggle,
  type SettingsToggleProps,
} from './SettingsToggle'

// 选择类组件
export {
  SettingsRadioGroup,
  SettingsRadioCard,
  SettingsRadioOption,
  type SettingsRadioGroupProps,
  type SettingsRadioCardProps,
  type SettingsRadioOptionProps,
} from './SettingsRadioGroup'

export {
  SettingsSegmentedControl,
  SettingsSegmentedControlCard,
  type SettingsSegmentedControlProps,
  type SettingsSegmentedOption,
  type SettingsSegmentedControlCardProps,
  type SettingsSegmentedCardOption,
} from './SettingsSegmentedControl'

export {
  SettingsSelect,
  SettingsSelectRow,
  type SettingsSelectProps,
  type SettingsSelectOption,
  type SettingsSelectRowProps,
} from './SettingsSelect'

export {
  SettingsMenuSelect,
  SettingsMenuSelectRow,
  type SettingsMenuSelectProps,
  type SettingsMenuSelectOption,
  type SettingsMenuSelectRowProps,
} from './SettingsMenuSelect'

// 输入类组件
export {
  SettingsInput,
  SettingsInputRow,
  SettingsSecretInput,
  type SettingsInputProps,
  type SettingsInputRowProps,
  type SettingsSecretInputProps,
} from './SettingsInput'

export {
  SettingsTextarea,
  type SettingsTextareaProps,
} from './SettingsTextarea'

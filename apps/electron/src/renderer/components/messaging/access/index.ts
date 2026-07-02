/**
 * messaging/access 子模块的导出入口。
 *
 * 把访问控制相关的组件和类型统一暴露出去，方便上层 `TelegramAccessSection`、
 * `MessagingSettingsPage` 等页面通过 `import { ... } from './access'` 一次性引入。
 */

export { AccessModeBanner } from './AccessModeBanner'
export { OwnersListEditor } from './OwnersListEditor'
export { PendingSendersList } from './PendingSendersList'
export { BindingAllowListPopover } from './BindingAllowListPopover'
export { TelegramAccessSection } from './TelegramAccessSection'
export type {
  BindingAccess,
  BindingAccessMode,
  PendingSender,
  PlatformAccessMode,
  PlatformOwner,
} from './types'

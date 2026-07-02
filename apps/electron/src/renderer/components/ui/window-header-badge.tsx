/**
 * 从 @craft-agent/ui 重新导出 PreviewHeader 组件。
 *
 * 为现有 Electron 组件提供向后兼容；实际实现已移到共享 UI 包。
 */

export {
  PreviewHeader as WindowHeader,
  PreviewHeaderBadge as WindowHeaderBadge,
  PREVIEW_BADGE_VARIANTS as BADGE_VARIANTS,
  type PreviewHeaderProps as WindowHeaderProps,
  type PreviewHeaderBadgeProps as WindowHeaderBadgeProps,
  type PreviewBadgeVariant as BadgeVariant,
} from '@craft-agent/ui'

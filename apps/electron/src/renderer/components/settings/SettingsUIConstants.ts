/**
 * SettingsUIConstants
 *
 * 设置页统一的样式常量，集中管理标签、描述等常用 Tailwind 类名。
 */

export const settingsUI = {
  /** 设置项标题的样式 */
  label: 'text-sm font-medium',

  /** 设置项副标题/说明的样式 */
  description: 'text-sm text-muted-foreground',

  /** 紧凑场景下的说明样式（如下拉菜单选项里的小字） */
  descriptionSmall: 'text-xs text-muted-foreground',

  /** 标签与描述之间的间距（作为描述的上外边距） */
  labelDescriptionGap: 'mt-0',

  /** 标签组容器的垂直间距 */
  labelGroup: 'space-y-0',
}

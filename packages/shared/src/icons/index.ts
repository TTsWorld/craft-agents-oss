/**
 * 图标模块入口文件：统一重新导出所有图标相关的类型与常量。
 *
 * 外部可以这样导入：
 *   import { IconSize, ResolvedEntityIcon } from '@craft-agent/shared/icons'
 *
 * 相当于 Go 包里一个常见的 `export.go` 或 `types.go`，把内部子包暴露成统一 API。
 */
export {
  type IconConfig,
  type ResolvedEntityIcon,
  type IconSize,
  ICON_SIZE_CLASSES,
  ICON_EMOJI_SIZES,
} from './types.ts'

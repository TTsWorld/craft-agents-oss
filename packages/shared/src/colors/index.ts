/**
 * 颜色模块入口
 *
 * 把本目录下的类型、解析、校验、默认值和迁移函数集中重新导出。
 * 外部可以通过 `import { EntityColor, resolveEntityColor } from '@craft-agent/shared/colors'` 统一引用。
 */
export {
  type SystemColorName,
  type SystemColor,
  type CustomColor,
  type EntityColor,
  SYSTEM_COLOR_NAMES,
} from './types.ts'

export {
  resolveEntityColor,
  parseSystemColor,
  isSystemColorName,
  isSystemColor,
  deriveDarkVariant,
  type ParsedSystemColor,
} from './resolve.ts'

export {
  isValidCSSColor,
  isValidSystemColor,
  isValidEntityColor,
  EntityColorSchema,
} from './validate.ts'

export {
  DEFAULT_STATUS_COLORS,
  DEFAULT_STATUS_FALLBACK,
  getDefaultStatusColor,
} from './defaults.ts'

export {
  migrateColorValue,
  migrateStatusColors,
  migrateLabelColors,
} from './migrate.ts'

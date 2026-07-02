/**
 * resources 模块入口（barrel 文件）
 *
 * 仅做重导出：把 type 定义从 types.ts 引出，把核心函数从 resource-bundle.ts 引出。
 * 类比 Go：相当于在一个 package 的 index.go 里用 typealias / 函数转发把子包能力暴露出来。
 */

export type {
  ResourceBundle,
  SourceBundleEntry,
  SkillBundleEntry,
  AutomationBundleEntry,
  ResourceImportMode,
  ExportResourcesOptions,
  ExportResult,
  ImportBucketResult,
  ResourceImportResult,
  ResourceImportDeps,
} from './types.ts'

export {
  exportResources,
  importResources,
  validateResourceBundle,
} from './resource-bundle.ts'

/**
 * Resource Bundle 类型定义
 *
 * Workspace 资源（source、skill、automation）在不同 workspace 之间迁移的便携格式。
 * 和 session 导出/导入采用的 bundle 模式一致：JSON 信封 + base64 编码的文件列表。
 */

import type { BundleFile } from '../utils/bundle-files.ts'
import type { FolderSourceConfig } from '../sources/types.ts'
import type { AutomationMatcher } from '../automations/types.ts'

// ============================================================
// Bundle 格式
// ============================================================

/**
 * Workspace 资源的便携表示。
 * JSON 信封，内含 base64 编码的文件；和 SessionBundle 同模式。
 */
export interface ResourceBundle {
  /** bundle 格式版本号 */
  version: 1
  /** 导出时间，Unix 时间戳（毫秒） */
  exportedAt: number
  /** 信息字段：被导出 workspace 的名字 */
  sourceWorkspace?: string
  /** 导出的资源，按类型分组 */
  resources: {
    /** source 列表 */
    sources?: SourceBundleEntry[]
    /** skill 列表 */
    skills?: SkillBundleEntry[]
    /** automation 列表（已脱敏：去掉了 webhook 认证信息） */
    automations?: AutomationBundleEntry[]
  }
}

/**
 * Bundle 中的一个 source。
 * config 已被脱敏（没有密钥、运行时状态已重置）。
 * files 包含 source 目录下除 config.json 外的所有非隐藏普通文件。
 */
export interface SourceBundleEntry {
  /** source slug（文件夹名，唯一标识） */
  slug: string
  /** 脱敏后的 source 配置：去掉凭证、重置认证状态 */
  config: FolderSourceConfig
  /** 除 config.json 外的所有非隐藏普通文件（如 guide.md、图标、权限文件、文档等） */
  files: BundleFile[]
}

/**
 * Bundle 中的一个 skill。
 * files 包含 skill 目录下所有文件（SKILL.md、图标、脚本、文档等）。
 * 不设独立 metadata 字段，需要时从 SKILL.md 解析。
 */
export interface SkillBundleEntry {
  /** skill slug（文件夹名） */
  slug: string
  /** skill 目录下的所有非隐藏普通文件 */
  files: BundleFile[]
}

/**
 * Bundle 中的一个 automation。
 * matcher 配置已脱敏（去掉了 webhook 认证）。
 */
export interface AutomationBundleEntry {
  /** automation ID（automations.json 里的 6 位十六进制短 ID） */
  id: string
  /** 显示名称（从 matcher.name 反规范化得到，仅作展示，不参与唯一性） */
  name?: string
  /** 该 automation 注册的事件类型 */
  event: string
  /** 完整的 matcher 配置（已脱敏：去掉了 webhook 认证） */
  matcher: AutomationMatcher
}

// ============================================================
// 导入/导出选项与结果
// ============================================================

/**
 * v1 导入冲突处理模式。
 * - 'skip'：保留已有资源，不覆盖
 * - 'overwrite'：用导入的资源替换已有资源
 */
export type ResourceImportMode = 'skip' | 'overwrite'

/**
 * 资源导出选项。
 */
export interface ExportResourcesOptions {
  /** 要导出的 source slug 列表，或 'all' 导出全部 */
  sources?: string[] | 'all'
  /** 要导出的 skill slug 列表，或 'all' 导出全部 */
  skills?: string[] | 'all'
  /** 要导出的 automation ID/名称列表；'all' 导出全部；true 等价于 'all' */
  automations?: boolean | string[] | 'all'
}

/**
 * 资源导出结果。
 */
export interface ExportResult {
  bundle: ResourceBundle
  /** 导出时的警告（跳过的资源、被剥离的密钥、不可移植路径等） */
  warnings: string[]
}

/**
 * 单类资源的导入结果，支持部分成功/部分失败。
 */
export interface ImportBucketResult {
  /** 成功导入的标识符（source/skill 用 slug，automation 用 ID） */
  imported: string[]
  /** 因已存在且 mode='skip' 而跳过的标识符 */
  skipped: string[]
  /** 导入失败的标识符及错误信息 */
  failed: Array<{ id: string; error: string }>
  /** 警告（非致命问题） */
  warnings: string[]
}

/**
 * 资源导入结果，按资源类型汇总。
 */
export interface ResourceImportResult {
  sources: ImportBucketResult
  skills: ImportBucketResult
  automations: ImportBucketResult
}

// ============================================================
// 导入依赖注入
// ============================================================

/**
 * 导入时注入的依赖，用于清理凭证。
 * 这样 resources 模块不必直接依赖 credential store，方便测试和解耦。
 */
export interface ResourceImportDeps {
  /**
   * 清除某个 workspace 下指定 source slug 的所有已存储凭证。
   * 在 source 被覆盖时调用，避免旧凭证泄漏。
   */
  clearSourceCredentials: (workspaceId: string, sourceSlug: string) => Promise<void>
}

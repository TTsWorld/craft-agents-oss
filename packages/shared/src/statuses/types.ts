/**
 * Status 类型定义
 *
 * 这里定义 workspace 中“任务状态”相关的所有类型。
 * 状态配置会保存在 {workspaceRootPath}/statuses/config.json。
 *
 * 图标格式：简单的字符串
 * - Emoji: "✅"、"🔥" - 直接作为文本渲染
 * - URL: "https://..." - 自动下载到 statuses/icons/{id}.{ext}
 * - 本地文件名: "in-progress.svg" - 从 statuses/icons/in-progress.svg 加载
 * - 本地文件: 当 icon 省略时，自动查找 statuses/icons/{id}.svg
 *
 * 优先级：显式本地文件名 > 按状态 ID 匹配的本地文件 > URL（会下载）> Emoji
 *
 * 颜色格式：EntityColor（系统颜色字符串或自定义颜色对象）
 * - 系统: "accent"、"foreground/50"、"info/80"（使用 CSS 变量，自动适配明暗主题）
 * - 自定义: { light: "#EF4444", dark: "#F87171" }（显式指定值）
 */

// import type { ... } 是 TS 的类型导入，只会在编译期使用，不会生成 JS 运行时代码。
import type { EntityColor } from '../colors/types.ts'

/**
 * 状态分类，决定该状态在 UI 里的过滤行为。
 * - 'open': 出现在收件箱（listInboxSessions）
 * - 'closed': 出现在归档（listCompletedSessions）
 *
 * export type ... = ... 类似 Go 的 type alias，给已有类型集合起个名字。
 */
export type StatusCategory = 'open' | 'closed';

/**
 * 单个状态的配置（会写入 statuses/config.json）
 *
 * interface 类似 Go 的 interface，用来描述“一个对象必须有哪些字段”。
 */
export interface StatusConfig {
  /** 唯一 ID（短横线风格：'todo'、'in-progress'、'my-custom-status'） */
  id: string;

  /** 显示名称 */
  label: string;

  /** 可选颜色。省略时使用颜色模块中的设计系统默认值。 */
  color?: EntityColor;

  /**
   * 图标：Emoji、URL 或 statuses/icons/ 下的本地文件名
   * - Emoji: "✅"、"🔥" - 直接作为文本渲染
   * - URL: "https://..." - 自动下载到 statuses/icons/{id}.{ext}
   * - 本地文件名: "in-progress.svg" → statuses/icons/in-progress.svg
   * - 省略时使用自动发现的本地文件（statuses/icons/{id}.svg）
   *
   * ? 表示可选字段，类似 Go struct 里的指针 / omitempty。
   */
  icon?: string;

  /** 分类（open = 收件箱，closed = 归档） */
  category: StatusCategory;

  /** 为 true 时表示固定状态，不能删除/重命名（如 todo、done、cancelled） */
  isFixed: boolean;

  /** 为 true 时表示默认状态，可修改但不能删除（如 in-progress、needs-review） */
  isDefault: boolean;

  /** 在 UI 中的显示顺序，数字越小越靠前 */
  order: number;
}

/**
 * 某个 workspace 的完整状态配置
 */
export interface WorkspaceStatusConfig {
  /** 用于数据迁移的模式版本号，从 1 开始 */
  version: number;

  /** 所有状态配置组成的数组 */
  statuses: StatusConfig[];

  /** 新建 session 时使用的默认状态 ID，通常是 'todo' */
  defaultStatusId: string;
}

/**
 * 创建新状态时的输入参数（由 CRUD 操作使用）
 */
export interface CreateStatusInput {
  label: string;
  color?: EntityColor;
  /** Emoji 或 URL */
  icon?: string;
  category: StatusCategory;
}

/**
 * 更新已有状态时的输入参数
 */
export interface UpdateStatusInput {
  label?: string;
  color?: EntityColor;
  /** Emoji 或 URL */
  icon?: string;
  category?: StatusCategory;
}

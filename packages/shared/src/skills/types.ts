/**
 * Skills 类型定义
 *
 * 定义 workspace skill 相关的 interface 与 type。
 * Skill 是用于扩展 Agent 能力的专项指令，通常写在 SKILL.md 中。
 */

/**
 * SKILL.md 顶部 YAML frontmatter 解析后的元数据。
 *
 * 类比 Go：interface 类似 Go 的 interface，定义了一组字段/方法契约；
 * 任何对象只要满足这些字段要求，就可以当作 SkillMetadata 使用。
 */
export interface SkillMetadata {
  /** skill 的显示名称 */
  name: string;
  /** skill 的简短描述，会显示在 skill 列表中 */
  description: string;
  /**
   * 可选的文件匹配模式数组。
   * 当用户打开匹配的文件时，这个 skill 可能会被自动触发。
   * 例如：["*.tsx", "src/api/*.ts"]
   */
  globs?: string[];
  /**
   * 可选的工具白名单。
   * skill 被激活时，这些工具可以直接执行，无需每次询问用户确认。
   * 对应 MCP / tool use 中的“always allow”权限模式。
   */
  alwaysAllow?: string[];
  /**
   * 可选的图标，只支持 emoji 或 URL。
   * - Emoji：直接在 UI 中渲染，例如 "🔧"。
   * - URL：会被自动下载为 icon.{ext} 本地文件。
   * 注意：不支持相对路径和内联 SVG。
   */
  icon?: string;
  /**
   * 可选的 source slug 数组。
   * 当这个 skill 被调用时，可以自动启用关联的 source（数据源）。
   */
  requiredSources?: string[];
}

/**
 * skill 的来源层级。
 *
 * 用 type 定义一个字符串联合类型，类似 Go 中定义一个只允许若干取值的 string 常量集合。
 * - global：用户家目录下的全局 skill（~/.agents/skills）。
 * - workspace：当前 workspace 下的 skill。
 * - project：当前项目（工作目录）下的 skill，优先级最高。
 */
export type SkillSource = 'global' | 'workspace' | 'project';

/**
 * 项目级与全局 skill 使用的插件名称。
 *
 * SDK 会根据注册的插件目录的 path.basename() 推导插件名。
 * 因为 {project}/.agents/ 和 ~/.agents/ 的 basename 都是 `.agents`，
 * 所以无论来自项目级还是全局的 skill，都会解析为 `.agents:skillSlug`。
 */
export const AGENTS_PLUGIN_NAME = '.agents';

/**
 * 已加载的 skill，包含解析后的 metadata 与正文。
 *
 * 可以把它看作 Go 里一个 struct：里面组合了 slug、metadata、content 等字段。
 */
export interface LoadedSkill {
  /** skill 目录名，也就是 slug，作为唯一标识 */
  slug: string;
  /** 从 YAML frontmatter 解析出的元数据 */
  metadata: SkillMetadata;
  /** SKILL.md 去除 frontmatter 后的正文内容 */
  content: string;
  /** 如果存在本地图标文件，这里是其绝对路径 */
  iconPath?: string;
  /** skill 目录的绝对路径 */
  path: string;
  /** 该 skill 是从哪个来源层级加载的 */
  source: SkillSource;
}

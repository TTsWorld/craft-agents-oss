/**
 * 统一的图标类型（Unified Icon Types）
 *
 * 这是 craft-agent 项目里“集中式图标系统”的共享类型定义。
 * 你可以把它理解成 Go 中某个包的 exported types：本文件只声明“长什么样”，
 * 具体绘制逻辑由 EntityIcon 组件和各实体封装层（SourceAvatar、SkillAvatar、StatusIcon）实现。
 *
 * 本模块是纯浏览器侧的（browser-safe，可直接在浏览器运行），不包含 Node.js 依赖。
 */

// ============================================================================
// 核心类型（Core Types）
// ============================================================================

/**
 * 实体配置里 icon 字段的类型，也就是“配置文件里怎么写图标”。
 *
 * 在 Go 里类似这样声明一个可选字段：
 *   type IconConfig struct {
 *       Icon *string // emoji 字符串或 URL，nil 表示自动发现本地文件
 *   }
 *
 * 这里的 `icon?: string` 表示该字段可选，等价于 Go 里的指针或 omitempty。
 */
export interface IconConfig {
  /** emoji 字符串、HTTP(S) URL，或 undefined（留空表示自动发现本地图标文件） */
  icon?: string
}

/**
 * 经过解析后、真正交给 EntityIcon 渲染的图标数据结构。
 *
 * 可以理解为“后端处理完返回给前端展示的 DTO”：
 * 原始配置（IconConfig）会经过 useEntityIcon hook 做缓存查找 / IPC 加载，
 * 最终转换成这个 ResolvedEntityIcon。
 */
export interface ResolvedEntityIcon {
  /** 图标类型：emoji（表情）、file（文件/图片）、fallback（降级占位） */
  kind: 'emoji' | 'file' | 'fallback'
  /**
   * 实际要显示的内容：
   * - emoji：emoji 字符串，例如 "🔧"；
   * - file：data URL（base64 编码的图片，或跟随主题的 SVG data URL）；
   * - fallback：undefined，表示没有具体值，由 UI 使用默认占位。
   */
  value?: string
  /**
   * 该图标是否响应 currentColor 样式。
   * - true：SVG 使用了 currentColor，父级颜色类（如 text-success）可以通过 CSS 级联改变图标颜色；
   * - false：emoji、位图、或颜色写死的 SVG，无法被外部颜色控制。
   */
  colorable: boolean
  /**
   * 经过净化处理（sanitized）后的原始 SVG 字符串，用于内联渲染。
   * 仅在 colorable=true 时存在，这样父级 CSS 颜色才能透传到 SVG 的 fill/stroke。
   * EntityIcon 会把它作为 dangerouslySetInnerHTML 插入（类似 Go 模板里的 HTML 原样输出，但要确保来源可信）。
   */
  rawSvg?: string
}

// ============================================================================
// 尺寸系统（Size System）
// ============================================================================

/** 图标的标准尺寸枚举，类似 Go 的 type alias + 联合类型限制 */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/**
 * 尺寸到 Tailwind 容器类名的映射表。
 * Record<IconSize, string> 表示“键必须是 IconSize，值必须是 string”，
 * 和 Go 的 map[IconSize]string 语义接近。
 */
export const ICON_SIZE_CLASSES: Record<IconSize, string> = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
  xl: 'h-7 w-7',
}

/**
 * 尺寸到 Tailwind emoji 字体大小的映射表。
 * 这些字号经过视觉平衡调整，让 emoji 在不同容器尺寸下看起来更协调。
 */
export const ICON_EMOJI_SIZES: Record<IconSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-[11px]',
  md: 'text-[13px]',
  lg: 'text-[16px]',
  xl: 'text-[18px]',
}

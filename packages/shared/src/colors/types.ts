/**
 * 实体颜色（Entity Color）统一类型定义
 *
 * 这是整个颜色系统的核心类型文件，所有与状态（status）、标签（label）相关的颜色配置都会用到。
 * 该模块只包含类型和常量，不依赖 Node.js，浏览器和主进程都可以安全导入。
 *
 * 颜色分为两种模式：
 * - 系统色（System colors）：引用设计系统的 CSS 变量，自动跟随主题的亮/暗模式。
 * - 自定义色（Custom colors）：直接写 CSS 颜色值，可选手动指定暗色版本；省略时自动推导。
 */

// ============================================================================
// 系统色（引用设计系统的 CSS 变量）
// ============================================================================

/**
 * 可用的系统色名称，对应 CSS 变量名。
 * 例如 'accent' 会渲染成 var(--accent)。
 *
 * `type` 在 TypeScript 里用来定义类型别名，类似 Golang 里给 string 取个别名。
 */
export type SystemColorName = 'accent' | 'info' | 'success' | 'destructive' | 'foreground'

/**
 * 所有合法系统色名称的运行时常量数组，用于校验。
 *
 * `readonly` 表示数组本身不可变；`as const` 是 TS 的“常量断言”，
 * 它会让数组里的每个元素都被推断成字面量类型，而不是普通的 string。
 */
export const SYSTEM_COLOR_NAMES: readonly SystemColorName[] = [
  'accent', 'info', 'success', 'destructive', 'foreground',
] as const

/**
 * 系统色字符串：颜色名，或带透明度后缀的颜色名。
 * 例如 "accent"、"foreground/50"、"info/80"。
 *
 * 这是一个模板字面量类型（template literal type），可以理解成对字符串格式的编译期约束。
 * 透明度范围是 0–100，最终通过 CSS color-mix 和 transparent 混合实现。
 */
export type SystemColor = `${SystemColorName}` | `${SystemColorName}/${number}`

// ============================================================================
// 自定义色（显式 CSS 值）
// ============================================================================

/**
 * 自定义颜色对象，里面直接写 CSS 颜色值。
 * 支持 hex、OKLCH、RGB、HSL 等格式。
 *
 * `interface` 在 TS 里和 Golang 的 interface 类似，用来描述对象的“形状”。
 * `dark?` 后面的 `?` 表示这是可选字段，类似 Golang struct 里可以省略的零值字段。
 * 如果省略 dark，系统会根据 light 值自动推导暗色版本。
 */
export interface CustomColor {
  /** 亮色模式下的颜色值（hex、OKLCH、RGB 或 HSL 均可） */
  light: string
  /** 暗色模式下的颜色值；省略时自动从 light 推导 */
  dark?: string
}

// ============================================================================
// 统一的 EntityColor 类型
// ============================================================================

/**
 * 所有实体配置统一使用的颜色类型。
 *
 * 可以是以下两种形式之一：
 * - 系统色字符串："accent"、"foreground/50"、"info/80"
 * - 自定义颜色对象：{ light: "#EF4444", dark: "#F87171" }
 *
 * 系统色通过 CSS 变量自动适配亮/暗主题；自定义色需要显式值（dark 可省略，自动推导）。
 *
 * `SystemColor | CustomColor` 这种写法叫“联合类型”（union type），
 * 表示变量可以是多种形态中的一种，类似 Golang 的 interface{} 但编译期会保留具体可能。
 */
export type EntityColor = SystemColor | CustomColor

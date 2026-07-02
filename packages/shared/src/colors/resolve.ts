/**
 * 实体颜色解析（Entity Color Resolution）
 *
 * 把 EntityColor 类型的配置值转换成可以直接放到 CSS / inline style 里的颜色字符串。
 * 所有实体颜色最终都通过 `style={{ color }}` 内联样式渲染，不用 Tailwind 颜色类，
 * 因为运行时加载的配置值无法被 Tailwind JIT 提前扫描到。
 *
 * 转换规则：
 * - 系统色 → CSS 变量引用（自动适配亮/暗主题）
 * - 带透明度的系统色 → 用 color-mix 与 transparent 混合（在 Chromium 中有效）
 * - 自定义色 → 根据当前主题返回 light 或 dark 值
 */

import { type EntityColor, type SystemColor, type SystemColorName, SYSTEM_COLOR_NAMES } from './types.ts'

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 将 EntityColor 解析为可用于内联样式的 CSS 颜色字符串。
 *
 * @param color - 配置里的 EntityColor 值
 * @param isDark - 当前是否为暗色主题
 * @returns CSS 颜色字符串，例如 "var(--accent)"、"color-mix(...)"、"#EF4444"
 *
 * @example
 * // 系统色（自动适配亮/暗）
 * resolveEntityColor('accent', false) // → "var(--accent)"
 *
 * // 带透明度的系统色
 * resolveEntityColor('foreground/50', false) // → "color-mix(in oklch, var(--foreground) 50%, transparent)"
 *
 * // 自定义色
 * resolveEntityColor({ light: '#EF4444', dark: '#F87171' }, true) // → "#F87171"
 */
export function resolveEntityColor(color: EntityColor, isDark: boolean): string {
  if (typeof color === 'string') {
    // 系统色：解析名称和可选的透明度
    const parsed = parseSystemColor(color)
    if (!parsed) {
      // 如果字符串不是合法系统色，回退到前景色变量
      return 'var(--foreground)'
    }

    const cssVar = `var(--${parsed.name})`

    if (parsed.opacity !== undefined) {
      // 通过 color-mix 应用透明度（在 Electron / Chromium 中无需构建步骤即可工作）
      return `color-mix(in oklch, ${cssVar} ${parsed.opacity}%, transparent)`
    }

    return cssVar
  }

  // 自定义色：根据当前主题选择 light 或 dark 值
  if (isDark) {
    return color.dark ?? deriveDarkVariant(color.light)
  }
  return color.light
}

// ============================================================================
// 解析
// ============================================================================

/**
 * 解析后的系统色：包含名称和可选的透明度。
 *
 * `interface` 描述对象结构；`opacity?: number` 表示透明度字段可选。
 */
export interface ParsedSystemColor {
  name: SystemColorName
  opacity?: number
}

/**
 * 把系统色字符串拆分成名称和透明度。
 * 如果字符串不是合法系统色，返回 null。
 *
 * @example
 * parseSystemColor('accent')        // → { name: 'accent' }
 * parseSystemColor('foreground/50') // → { name: 'foreground', opacity: 50 }
 * parseSystemColor('invalid')       // → null
 */
export function parseSystemColor(value: string): ParsedSystemColor | null {
  const slashIndex = value.indexOf('/')
  // 如果有 "/"，取前面部分作为颜色名；否则整个字符串就是颜色名
  const name = slashIndex === -1 ? value : value.slice(0, slashIndex)

  // 校验颜色名是否在合法列表中
  if (!isSystemColorName(name)) return null

  if (slashIndex === -1) {
    return { name }
  }

  const opacityStr = value.slice(slashIndex + 1)
  // 拒绝空或非数字的透明度，例如 "foreground/" 或 "foreground/abc"
  if (!opacityStr || !/^\d+$/.test(opacityStr)) return null
  const opacity = Number(opacityStr)
  if (opacity > 100) return null

  return { name, opacity }
}

// ============================================================================
// 类型守卫（Type Guards）
// ============================================================================

/**
 * 判断一个字符串是否是合法的 SystemColorName。
 *
 * 返回值类型 `value is SystemColorName` 是 TS 的“类型谓词”（type predicate），
 * 作用是：当函数返回 true 时，TS 会把参数收窄为 SystemColorName 类型，
 * 类似 Golang 的类型断言，但发生在编译期类型推导中。
 */
export function isSystemColorName(value: string): value is SystemColorName {
  // `as readonly string[]` 是类型断言，把 readonly SystemColorName[] 当成 readonly string[]
  // 这样 .includes(value) 才能接收任意 string，否则 TS 会抱怨类型不兼容。
  return (SYSTEM_COLOR_NAMES as readonly string[]).includes(value)
}

/**
 * 判断一个 EntityColor 值是系统色（字符串）还是自定义色（对象）。
 *
 * 同样使用类型谓词 `color is SystemColor`，返回 true 后 TS 就知道它是 string 形态。
 */
export function isSystemColor(color: EntityColor): color is SystemColor {
  return typeof color === 'string'
}

// ============================================================================
// 暗色模式推导
// ============================================================================

/**
 * 从亮色值自动推导暗色版本。
 * 目前只对 6 位/8 位 hex 颜色做亮化（向白色混合约 30%）。
 * 其他格式（OKLCH、RGB、HSL）直接返回原值，建议这些格式显式提供 dark。
 */
export function deriveDarkVariant(lightColor: string): string {
  // 6 位 hex：把 RGB 向白色混合
  if (/^#[0-9A-Fa-f]{6}$/.test(lightColor)) {
    return brightenHex(lightColor, 0.3)
  }
  if (/^#[0-9A-Fa-f]{8}$/.test(lightColor)) {
    // 8 位 hex 包含 alpha 通道：只亮化 RGB 部分，再拼回原来的 alpha
    return brightenHex(lightColor.slice(0, 7), 0.3) + lightColor.slice(7)
  }

  // 非 hex 格式直接返回原值，建议用户在配置里显式写 dark
  return lightColor
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 把 6 位 hex 颜色向白色混合，使其变亮。
 *
 * @param hex - 6 位 hex 颜色，例如 "#EF4444"
 * @param amount - 混合比例 0–1（0 表示不变，1 表示纯白）
 */
function brightenHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)

  const newR = Math.round(r + (255 - r) * amount)
  const newG = Math.round(g + (255 - g) * amount)
  const newB = Math.round(b + (255 - b) * amount)

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`
}

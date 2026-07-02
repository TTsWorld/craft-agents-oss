/**
 * 实体颜色校验（Entity Color Validation）
 *
 * 提供 Zod schema 和校验函数，用于确保 status/label 配置里的颜色值格式正确。
 * 配置加载、持久化、LLM 生成配置时都会调用这些工具做校验。
 */

import { z } from 'zod'
import { SYSTEM_COLOR_NAMES } from './types.ts'

// ============================================================================
// CSS 颜色格式校验
// ============================================================================

/** 匹配 hex 颜色：#RGB、#RRGGBB 或 #RRGGBBAA */
const HEX_PATTERN = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/

/** 匹配 OKLCH：oklch(L C H) 或 oklch(L C H / A) */
const OKLCH_PATTERN = /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+(\s*\/\s*[\d.]+%?)?\s*\)$/

/** 匹配 RGB/RGBA：rgb(r, g, b) 或 rgba(r, g, b, a) */
const RGB_PATTERN = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(\s*,\s*[\d.]+)?\s*\)$/

/** 匹配 HSL/HSLA：hsl(h, s%, l%) 或 hsla(h, s%, l%, a) */
const HSL_PATTERN = /^hsla?\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%(\s*,\s*[\d.]+)?\s*\)$/

/**
 * 判断字符串是否是合法的 CSS 颜色值。
 * 当前支持 hex、OKLCH、RGB/RGBA、HSL/HSLA 四种格式。
 */
export function isValidCSSColor(value: string): boolean {
  return (
    HEX_PATTERN.test(value) ||
    OKLCH_PATTERN.test(value) ||
    RGB_PATTERN.test(value) ||
    HSL_PATTERN.test(value)
  )
}

// ============================================================================
// 系统色校验
// ============================================================================

/** 系统色正则：颜色名，或颜色名/透明度 */
const SYSTEM_COLOR_PATTERN = /^([a-z]+)(\/(\d+))?$/

/**
 * 判断字符串是否是合法系统色（名称 + 可选 /透明度）。
 * 会校验名称是否在已知系统色列表中，以及透明度是否在 0–100 之间。
 */
export function isValidSystemColor(value: string): boolean {
  const match = SYSTEM_COLOR_PATTERN.exec(value)
  if (!match) return false

  const name = match[1]!
  // 这里用 `as readonly string[]` 把常量数组断言为 string[]，方便 .includes 接受任意字符串
  if (!(SYSTEM_COLOR_NAMES as readonly string[]).includes(name)) return false

  // 如果有透明度，校验范围
  if (match[3] !== undefined) {
    const opacity = Number(match[3])
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) return false
  }

  return true
}

// ============================================================================
// EntityColor 校验
// ============================================================================

/**
 * 判断一个值是否是合法的 EntityColor。
 * 接受系统色字符串或自定义颜色对象。
 */
export function isValidEntityColor(value: unknown): boolean {
  if (typeof value === 'string') {
    return isValidSystemColor(value)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // `as Record<string, unknown>` 是类型断言：告诉 TS 把这个对象当成“键为 string、值为 unknown”的字典
    const obj = value as Record<string, unknown>
    if (typeof obj.light !== 'string' || !isValidCSSColor(obj.light)) return false
    if (obj.dark !== undefined && (typeof obj.dark !== 'string' || !isValidCSSColor(obj.dark))) return false
    return true
  }
  return false
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * EntityColor 的 Zod schema。
 *
 * 这里用 `z.any().superRefine(...)` 而不是 `z.union(...)`，
 * 是因为 Zod 的 union 在报错时会同时给出两条分支的错误（“字符串不对”和“期望对象”），
 * 对 LLM 自修正不友好。用 superRefine 可以只返回一条清晰、可操作的错误信息。
 *
 * 合法形式：
 * - 系统色字符串："accent"、"foreground/50"、"info/80"
 * - 自定义颜色对象：{ light: "#EF4444", dark?: "#F87171" }
 */
export const EntityColorSchema = z.any().superRefine((val, ctx) => {
  // --- 字符串分支：按系统色校验 ---
  if (typeof val === 'string') {
    if (!isValidSystemColor(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid color "${val}". `
          + `System colors: ${SYSTEM_COLOR_NAMES.join(', ')} (with optional /opacity 0-100). `
          + `Examples: "accent", "foreground/50". `
          + `For custom hex colors use an object: { "light": "#RRGGBB" }. `
          + `See statuses.md for full color format reference.`,
      })
    }
    return
  }

  // --- 对象分支：按自定义色校验 ---
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>

    if (typeof obj.light !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom color object requires a "light" field with a valid CSS color. `
          + `Example: { "light": "#EF4444", "dark": "#F87171" }. `
          + `Supported formats: #RGB, #RRGGBB, #RRGGBBAA, oklch(...), rgb(...), hsl(...).`,
      })
      return
    }

    if (!isValidCSSColor(obj.light)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid "light" color "${obj.light}". `
          + `Supported CSS formats: #RGB, #RRGGBB, #RRGGBBAA, oklch(L C H), rgb(r, g, b), hsl(h, s%, l%). `
          + `Example: "#EF4444" or "oklch(0.7 0.15 20)".`,
      })
    }

    if (obj.dark !== undefined) {
      if (typeof obj.dark !== 'string' || !isValidCSSColor(obj.dark)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid "dark" color "${obj.dark}". `
            + `Must be a valid CSS color (same formats as "light"). `
            + `Omit "dark" entirely to auto-derive from light (+30% brightness).`,
        })
      }
    }
    return
  }

  // --- 其他类型：直接报错 ---
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Invalid color value (got ${typeof val}). `
      + `Must be a system color string ("accent", "foreground/50") `
      + `or a custom color object ({ "light": "#hex", "dark?": "#hex" }). `
      + `See statuses.md for full color format reference.`,
  })
})

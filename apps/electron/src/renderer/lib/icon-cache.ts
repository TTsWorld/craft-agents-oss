/**
 * 统一图标缓存
 *
 * 为 source、skill、status 三类实体提供单一缓存。
 * EntityIcon、SourceAvatar、SkillAvatar、StatusIcon、RichTextInput 都依赖这里。
 *
 * 图标以 data URL 形式缓存，便于在以下两种场景保持一致：
 * - React 组件（img src）
 * - HTML 字符串生成（内联 badge）
 *
 * 缓存键使用类型前缀避免冲突：
 * - source:{workspaceId}:{slug}
 * - skill:{workspaceId}:{slug}
 * - status:{workspaceId}:{relativePath}
 *
 * 注意：Label 不使用图标，只使用颜色（彩色圆点）。
 *
 * useEntityIcon() 是加载任意实体图标的单一入口，内部处理缓存查询、IPC 文件读取、SVG 主题化与 emoji 检测。
 */

import { useState, useEffect, useMemo } from 'react'
import { isEmoji } from '@craft-agent/shared/utils/icon-constants'
import type { ResolvedEntityIcon } from '@craft-agent/shared/icons'

// ============================================================================
// 类型
// ============================================================================

interface SourceConfig {
  slug: string
  name: string
  type: string
  icon?: string  // emoji 或 URL（本地图标文件会另外自动发现）
  provider?: string
  mcp?: {
    url?: string
  }
  api?: {
    baseUrl?: string
  }
}

interface SkillConfig {
  slug: string
  iconPath?: string
  metadata?: { icon?: string }
}

// ============================================================================
// 统一缓存
// ============================================================================

/**
 * 所有图标类型的统一缓存。
 * 键格式：`{type}:{workspaceId}:{identifier}`
 * - source:wsId:slug
 * - skill:wsId:slug
 * - status:wsId:relativePath
 */
export const iconCache = new Map<string, string>()

/**
 * 解析出的 logo URL 缓存（用于服务 URL 解析）。
 * 单独维护，因为它缓存的是 URL 解析结果而非图标数据，键格式也不同：`{serviceUrl}:{provider}`
 */
export const logoUrlCache = new Map<string, string | null>()

// ============================================================================
// 兼容旧 API 的导出（迁移期间保持向后兼容）
// 它们只是统一缓存的代理视图，不是独立的 Map。
// ============================================================================

/** @deprecated 请直接使用 iconCache 并加 'source:' 前缀 */
export const sourceIconCache = {
  get: (key: string) => iconCache.get(`source:${key}`),
  set: (key: string, value: string) => iconCache.set(`source:${key}`, value),
  has: (key: string) => iconCache.has(`source:${key}`),
  delete: (key: string) => iconCache.delete(`source:${key}`),
  clear: () => {
    // 仅清空 source 前缀的条目
    for (const key of iconCache.keys()) {
      if (key.startsWith('source:')) iconCache.delete(key)
    }
  },
}

/** @deprecated 请直接使用 iconCache 并加 'skill:' 前缀 */
export const skillIconCache = {
  get: (key: string) => iconCache.get(`skill:${key}`),
  set: (key: string, value: string) => iconCache.set(`skill:${key}`, value),
  has: (key: string) => iconCache.has(`skill:${key}`),
  delete: (key: string) => iconCache.delete(`skill:${key}`),
  clear: () => {
    // 仅清空 skill 前缀的条目
    for (const key of iconCache.keys()) {
      if (key.startsWith('skill:')) iconCache.delete(key)
    }
  },
}

// ============================================================================
// 缓存管理
// ============================================================================

/**
 * 清空所有图标缓存（所有实体类型）
 */
export function clearIconCaches(): void {
  iconCache.clear()
  logoUrlCache.clear()
  colorableCache.clear()
  rawSvgCache.clear()
}

/**
 * 仅清空 source 图标缓存。
 * @deprecated 等 rich-text-input.tsx 迁移到 useEntityIcon 后将移除。
 */
export function clearSourceIconCaches(): void {
  sourceIconCache.clear()
  logoUrlCache.clear()
  // 同时清理 colorable/rawSvg 缓存中的 source 项
  for (const key of colorableCache) {
    if (key.startsWith('source:')) colorableCache.delete(key)
  }
  for (const key of rawSvgCache.keys()) {
    if (key.startsWith('source:')) rawSvgCache.delete(key)
  }
}

/**
 * 仅清空 skill 图标缓存。
 * @deprecated 等 rich-text-input.tsx 迁移到 useEntityIcon 后将移除。
 */
export function clearSkillIconCaches(): void {
  skillIconCache.clear()
  for (const key of colorableCache) {
    if (key.startsWith('skill:')) colorableCache.delete(key)
  }
  for (const key of rawSvgCache.keys()) {
    if (key.startsWith('skill:')) rawSvgCache.delete(key)
  }
}

// ============================================================================
// Source 图标加载
// ============================================================================

// 缓存中 emoji 图标的前缀；调用方通过识别此前缀把图标渲染成文字
export const EMOJI_ICON_PREFIX = 'emoji:'

/**
 * 加载 source 图标到缓存。
 *
 * 解析优先级（config.icon 是最高权威）：
 * 1. config.icon 是 emoji → 返回 emoji 标记，由调用方渲染为文字
 * 2. config.icon 是本地路径（./icon.svg）→ 从 sources/{slug}/icon.svg 加载
 * 3. config.icon 是 URL → 直接返回 URL，让浏览器加载
 * 4. config.icon 未定义 → 自动发现 sources/{slug}/icon.{svg,png}
 * 5. 兜底 → 从服务 URL 解析 favicon
 *
 * 只要 config.icon 已设置（emoji、本地路径或 URL），就会自动跳过自动发现。
 *
 * @returns 返回图标 URL、emoji 标记（emoji:{emoji}）或 null
 */
export async function loadSourceIcon(
  source: { config: SourceConfig; workspaceId: string },
): Promise<string | null> {
  const { config, workspaceId } = source
  const cacheKey = `${workspaceId}:${config.slug}`

  // 先查缓存
  const cached = sourceIconCache.get(cacheKey)
  if (cached) return cached

  const icon = config.icon

  // 优先级 1：emoji 图标，返回标记供调用方渲染为文字
  if (icon && isEmoji(icon)) {
    const emojiMarker = `${EMOJI_ICON_PREFIX}${icon}`
    sourceIconCache.set(cacheKey, emojiMarker)
    return emojiMarker
  }

  // 优先级 2：config.icon 中显式写的本地路径，例如 "./icon.svg"
  if (icon?.startsWith('./')) {
    const iconFilename = icon.slice(2) // 去掉 './'
    const relativePath = `sources/${config.slug}/${iconFilename}`
    const loaded = await loadWorkspaceIcon(workspaceId, relativePath)
    if (loaded) {
      sourceIconCache.set(cacheKey, loaded)
      return loaded
    }
  }

  // 优先级 3：config.icon 是 URL，直接返回；配置 URL 优先于自动发现的本地文件
  if (icon && (icon.startsWith('http://') || icon.startsWith('https://'))) {
    sourceIconCache.set(cacheKey, icon)
    return icon
  }

  // 优先级 4：config.icon 未定义时自动发现本地图标文件
  // 保留对未显式配置 icon 的 source 的向后兼容
  if (!icon) {
    const localIconSvg = await loadWorkspaceIcon(workspaceId, `sources/${config.slug}/icon.svg`)
    if (localIconSvg) {
      sourceIconCache.set(cacheKey, localIconSvg)
      return localIconSvg
    }

    const localIconPng = await loadWorkspaceIcon(workspaceId, `sources/${config.slug}/icon.png`)
    if (localIconPng) {
      sourceIconCache.set(cacheKey, localIconPng)
      return localIconPng
    }
  }

  // 优先级 5：从服务 URL 解析 favicon
  const serviceUrl = deriveServiceUrl(config)
  if (!serviceUrl) return null

  // favicon 解析用 slug 更具体，比通用 provider 名更好
  const provider = config.slug ?? config.provider
  const logoCacheKey = `${serviceUrl}:${provider ?? ''}`

  // 查 logo URL 缓存
  const cachedLogoUrl = logoUrlCache.get(logoCacheKey)
  if (cachedLogoUrl !== undefined) {
    if (cachedLogoUrl) {
      sourceIconCache.set(cacheKey, cachedLogoUrl)
    }
    return cachedLogoUrl
  }

  try {
    const logoUrl = await window.electronAPI.getLogoUrl(serviceUrl, provider)
    logoUrlCache.set(logoCacheKey, logoUrl)
    if (logoUrl) {
      sourceIconCache.set(cacheKey, logoUrl)
    }
    return logoUrl
  } catch (error) {
    console.error(`[IconCache] 解析 logo URL 失败：`, error)
    logoUrlCache.set(logoCacheKey, null)
    return null
  }
}

/**
 * 通过 IPC 加载工作区图片的辅助函数。
 * 处理 SVG 主题化并返回 data URL；失败时返回 null。
 */
async function loadWorkspaceIcon(workspaceId: string, relativePath: string): Promise<string | null> {
  try {
    const result = await window.electronAPI.readWorkspaceImage(workspaceId, relativePath)
    // IPC 对缺失文件返回 null（静默兜底）
    if (!result) {
      return null
    }
    // SVG 需要注入前景色再转成 data URL；因为 background-image 不会继承 CSS currentColor
    if (relativePath.endsWith('.svg')) {
      return svgToThemedDataUrl(result)
    }
    return result
  } catch {
    // 安全错误或 IO 失败仍优雅兜底
    return null
  }
}

/**
 * 从缓存同步获取 source 图标。
 * 若未命中缓存则返回 null（需调用 loadSourceIcon 加载）。
 */
export function getSourceIconSync(workspaceId: string, slug: string): string | null {
  const cacheKey = `${workspaceId}:${slug}`
  return sourceIconCache.get(cacheKey) ?? null
}

// ============================================================================
// Skill 图标加载
// ============================================================================

/**
 * 加载 skill 图标到缓存。
 *
 * 解析优先级（与 loadSourceIcon 类似）：
 * 1. metadata.icon 是 emoji → 返回 emoji 标记
 * 2. metadata.icon 是 URL → 直接返回 URL
 * 3. 已知 iconPath → 从文件加载
 * 4. 自动发现 skills/{slug}/icon.{svg,png} → 从文件加载
 *
 * @returns 返回图标 URL、emoji 标记或 null
 */
export async function loadSkillIcon(
  skill: SkillConfig,
  workspaceId: string,
): Promise<string | null> {
  const cacheKey = `${workspaceId}:${skill.slug}`

  // 先查缓存
  const cached = skillIconCache.get(cacheKey)
  if (cached) return cached

  const iconValue = skill.metadata?.icon

  // 优先级 1：emoji 图标
  if (iconValue && isEmoji(iconValue)) {
    const emojiMarker = `${EMOJI_ICON_PREFIX}${iconValue}`
    skillIconCache.set(cacheKey, emojiMarker)
    return emojiMarker
  }

  // 优先级 2：metadata 中的 URL
  if (iconValue && (iconValue.startsWith('http://') || iconValue.startsWith('https://'))) {
    skillIconCache.set(cacheKey, iconValue)
    return iconValue
  }

  // 优先级 3：已知的 iconPath 指向的文件
  if (skill.iconPath) {
    const skillsMatch = skill.iconPath.match(/skills\/([^/]+)\/(.+)$/)
    if (skillsMatch) {
      const relativePath = `skills/${skillsMatch[1]}/${skillsMatch[2]}`
      const loaded = await loadWorkspaceIcon(workspaceId, relativePath)
      if (loaded) {
        skillIconCache.set(cacheKey, loaded)
        return loaded
      }
    }
  }

  // 优先级 4：没有显式配置 icon 时自动发现
  if (!iconValue) {
    const svgIcon = await loadWorkspaceIcon(workspaceId, `skills/${skill.slug}/icon.svg`)
    if (svgIcon) {
      skillIconCache.set(cacheKey, svgIcon)
      return svgIcon
    }

    const pngIcon = await loadWorkspaceIcon(workspaceId, `skills/${skill.slug}/icon.png`)
    if (pngIcon) {
      skillIconCache.set(cacheKey, pngIcon)
      return pngIcon
    }
  }

  return null
}

/**
 * 从缓存同步获取 skill 图标。
 * 若未命中缓存则返回 null（需调用 loadSkillIcon 加载）。
 */
export function getSkillIconSync(workspaceId: string, slug: string): string | null {
  const cacheKey = `${workspaceId}:${slug}`
  return skillIconCache.get(cacheKey) ?? null
}

// ============================================================================
// SVG 主题化
// ============================================================================

/**
 * 从 CSS 自定义属性获取当前前景色。
 * 返回 --foreground 的计算值或兜底色。
 */
export function getForegroundColor(): string {
  if (typeof document === 'undefined') {
    // SSR/Node 环境的兜底：暗色主题默认色
    return '#e3e2e5'
  }

  const computedColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--foreground')
    .trim()

  // 如果是 oklch 值就直接返回（浏览器能处理）；为空则返回兜底色
  return computedColor || '#e3e2e5'
}

/**
 * 处理 SVG 内容，注入主题前景色。
 *
 * 修复那些使用 currentColor 或没有 fill 的 SVG：
 * 当 SVG 作为 background-image 使用时，CSS 颜色继承不会生效，所以需要在这里注入实际颜色。
 *
 * @param svgContent - 原始 SVG 字符串
 * @param foregroundColor - 要注入的颜色（默认使用当前主题前景色）
 * @returns 处理后的 SVG 字符串
 */
export function themeSvgContent(
  svgContent: string,
  foregroundColor?: string
): string {
  const color = foregroundColor ?? getForegroundColor()

  let processed = svgContent

  // 把所有 currentColor 替换成实际颜色
  processed = processed.replace(/currentColor/gi, color)

  // 如果根元素没有 fill 属性，就补一个；避免依赖默认黑色填充的 SVG 显示异常
  processed = processed.replace(
    /<svg([^>]*)>/i,
    (match, attrs) => {
      // 已有 fill 属性（即使是 fill="none"）不再添加
      if (/\bfill\s*=/i.test(attrs)) {
        return match
      }
      return `<svg${attrs} fill="${color}">`
    }
  )

  return processed
}

/**
 * 把 SVG 内容转成带主题色的 data URL。
 * 先注入前景色，再做 base64 编码。
 */
export function svgToThemedDataUrl(svgContent: string, foregroundColor?: string): string {
  const themedSvg = themeSvgContent(svgContent, foregroundColor)
  return `data:image/svg+xml;base64,${btoa(themedSvg)}`
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 source 配置推导服务 URL（用于 favicon 解析）
 */
function deriveServiceUrl(config: SourceConfig): string | null {
  // MCP source：使用 mcp.url
  if (config.type === 'mcp' && config.mcp?.url) {
    return config.mcp.url
  }

  // API source：使用 api.baseUrl
  if (config.type === 'api' && config.api?.baseUrl) {
    return config.api.baseUrl
  }

  return null
}

// ============================================================================
// 统一实体图标 Hook
// ============================================================================

/** 自动发现图标时支持的文件扩展名 */
const ICON_FILE_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg']

/**
 * 预编译正则：从绝对路径中提取工作区相对图标路径。
 * 匹配 skills/、sources/、statuses/ 中任意一个目录前缀及其后续路径。
 */
const ICON_PATH_PATTERN = /(?:skills|sources|statuses)\/.+$/

/**
 * useEntityIcon hook 的选项。
 */
export interface UseEntityIconOptions {
  /** IPC 调用所需的工作区 ID */
  workspaceId: string
  /** 缓存命名空间，例如 'source'、'skill'、'status'、'label' */
  entityType: string
  /** 实体类型内的唯一标识（slug、statusId 等） */
  identifier: string
  /**
   * 已知的相对图标路径（用于已经解析好路径的实体）。
   * 例如 'skills/my-skill/icon.svg'。
   * 若提供，则只尝试该路径，不再自动发现。
   */
  iconPath?: string
  /**
   * 自动发现图标文件的目录（相对于工作区）。
   * 例如 'sources/linear' 会依次尝试 sources/linear/icon.svg、icon.png 等。
   * 若提供 iconPath，则忽略本项。
   */
  iconDir?: string
  /**
   * 实体配置中的图标值。可能是：
   * - emoji 字符串（如 "🔧"）→ 渲染为 emoji
   * - URL（这里忽略，假设已下载到本地文件）
   * - undefined → 从 iconDir 自动发现
   */
  iconValue?: string
  /**
   * 覆盖自动发现时使用的文件名（默认 'icon'）。
   * 例如 status 实体可设为 statusId，从而发现 '{statusId}.svg' 而非 'icon.svg'。
   */
  iconFileName?: string
}

/**
 * 统一的图标加载 Hook：所有实体类型的单一入口。
 *
 * 内部处理缓存查询、IPC 文件加载、SVG 主题化、可着色检测与 emoji 检测，
 * 返回 ResolvedEntityIcon，可直接交给 EntityIcon 组件渲染。
 *
 * 解析优先级（iconValue 是最高权威）：
 * 1. iconValue 是 emoji → { kind: 'emoji', value: emoji, colorable: false }
 * 2. iconValue 是 URL → { kind: 'file', value: url, colorable: false }
 * 3. 本地文件（iconPath）→ { kind: 'file', value: dataUrl, colorable }
 * 4. 在 iconDir 中自动发现（仅当 iconValue 为 undefined）→ { kind: 'file', value: dataUrl, colorable }
 * 5. 兜底 → { kind: 'fallback', colorable: false }
 *
 * 只要 iconValue 已配置，就优先于自动发现的本地文件。
 *
 * 用法：
 *   const icon = useEntityIcon({ workspaceId, entityType: 'skill', identifier: slug, iconPath })
 *   return <EntityIcon icon={icon} fallbackIcon={Zap} />
 */
export function useEntityIcon(opts: UseEntityIconOptions): ResolvedEntityIcon {
  const { workspaceId, entityType, identifier, iconPath, iconDir, iconValue, iconFileName } = opts

  // 该实体图标的稳定缓存键
  const cacheKey = `${entityType}:${workspaceId}:${identifier}`

  // 判断 iconValue 是不是 emoji 或 URL（同步判断，无需加载文件）
  const immediateValue = useMemo(() => {
    // 防御非字符串值（配置数据异常时可能出现）
    if (!iconValue || typeof iconValue !== 'string') return null
    if (isEmoji(iconValue)) return { type: 'emoji' as const, value: iconValue }
    if (iconValue.startsWith('http://') || iconValue.startsWith('https://')) {
      return { type: 'url' as const, value: iconValue }
    }
    return null
  }, [iconValue])

  // 初始状态：同步查缓存，或返回 emoji/url/兜底
  const [resolved, setResolved] = useState<ResolvedEntityIcon>(() => {
    if (immediateValue?.type === 'emoji') {
      return { kind: 'emoji', value: immediateValue.value, colorable: false }
    }
    if (immediateValue?.type === 'url') {
      // URL 直接作为 'file' 返回（可在 img src 中使用）
      return { kind: 'file', value: immediateValue.value, colorable: false }
    }
    // 查统一缓存里是否已经加载过
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      return {
        kind: 'file',
        value: cached,
        colorable,
        rawSvg: colorable ? rawSvgCache.get(cacheKey) : undefined,
      }
    }
    return { kind: 'fallback', colorable: false }
  })

  useEffect(() => {
    // emoji 不需要文件加载，直接更新状态
    if (immediateValue?.type === 'emoji') {
      setResolved({ kind: 'emoji', value: immediateValue.value, colorable: false })
      return
    }

    // 配置里的 URL 直接使用，不再加载文件
    if (immediateValue?.type === 'url') {
      setResolved({ kind: 'file', value: immediateValue.value, colorable: false })
      return
    }

    // 先查缓存
    const cached = iconCache.get(cacheKey)
    if (cached) {
      const colorable = colorableCache.has(cacheKey)
      setResolved({
        kind: 'file',
        value: cached,
        colorable,
        rawSvg: colorable ? rawSvgCache.get(cacheKey) : undefined,
      })
      return
    }

    // 缓存未命中，通过 IPC 从文件系统加载
    let cancelled = false

    async function loadIcon() {
      let result: { dataUrl: string; colorable: boolean; rawSvg?: string } | null = null

      if (iconPath) {
        // 已知路径：提取工作区相对部分后直接加载
        // iconPath 可能是绝对路径，需要提取出相对路径
        const relativeMatch = iconPath.match(ICON_PATH_PATTERN)
        const relativePath = relativeMatch ? relativeMatch[0] : iconPath

        result = await loadIconFile(workspaceId, relativePath)
      } else if (iconDir && !iconValue) {
        // 在目录中自动发现图标文件
        // 仅在 iconValue 为 undefined 时自动发现（配置优先）
        // iconFileName 覆盖默认 'icon' 前缀，例如 status 使用 statusId
        result = await discoverIconFile(workspaceId, iconDir, iconFileName)
      }

      if (cancelled) return

      if (result) {
        // 缓存加载结果及其可着色/原始 SVG 信息
        iconCache.set(cacheKey, result.dataUrl)
        if (result.colorable) {
          colorableCache.add(cacheKey)
        }
        if (result.rawSvg) {
          rawSvgCache.set(cacheKey, result.rawSvg)
        }
        setResolved({
          kind: 'file',
          value: result.dataUrl,
          colorable: result.colorable,
          rawSvg: result.rawSvg,
        })
      } else {
        setResolved({ kind: 'fallback', colorable: false })
      }
    }

    loadIcon()

    return () => { cancelled = true }
  }, [workspaceId, entityType, identifier, iconPath, iconDir, iconFileName, immediateValue, cacheKey, iconValue])

  return resolved
}

// ============================================================================
// useEntityIcon 内部辅助函数
// ============================================================================

/**
 * 记录哪些缓存图标是可着色的（使用 currentColor）。
 * 用 Set 存缓存键，实现 O(1) 查询。
 */
const colorableCache = new Set<string>()

/**
 * 保存可着色图标的原始 SVG 内容（已清理）。
 * 用于内联渲染，使 CSS 颜色类能级联到 SVG 的 fill/stroke。
 */
const rawSvgCache = new Map<string, string>()

/**
 * 按相对路径加载单个图标文件。
 * 处理 SVG 主题化、可着色检测与清理。
 *
 * 对于可着色 SVG（使用 currentColor），返回 rawSvg 用于内联渲染，
 * 这样 CSS 颜色类才能级联到 SVG 的 fill/stroke。
 */
async function loadIconFile(
  workspaceId: string,
  relativePath: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  try {
    const content = await window.electronAPI.readWorkspaceImage(workspaceId, relativePath)
    // IPC 对缺失文件返回 null（静默兜底）
    if (!content) {
      return null
    }

    if (relativePath.endsWith('.svg')) {
      // 检测 SVG 是否使用 currentColor（是否可着色）
      const colorable = content.includes('currentColor')
      // 对 data URL 使用场景做主题化：注入前景色
      const dataUrl = svgToThemedDataUrl(content)

      if (colorable) {
        // 为内联渲染清理 SVG（防止 XSS）
        const rawSvg = sanitizeSvgForInline(content)
        return { dataUrl, colorable, rawSvg }
      }

      return { dataUrl, colorable }
    }

    // 栅格图片（PNG、JPG）不可着色
    return { dataUrl: content, colorable: false }
  } catch {
    // 文件不存在或加载失败
    return null
  }
}

/**
 * 清理 SVG 内容，使其可以安全地通过 dangerouslySetInnerHTML 内联渲染。
 * 移除 script 标签、事件处理器、javascript: URL，并去掉宽高属性让 SVG 自适应容器。
 */
function sanitizeSvgForInline(svg: string): string {
  return svg
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\s+width="[^"]*"/gi, '')
    .replace(/\s+height="[^"]*"/gi, '')
}

/**
 * 在工作区目录中自动发现图标文件。
 * 通过 IPC 并行探测所有扩展名，再按优先级返回第一个成功的结果。
 * 默认文件名是 'icon'（例如 icon.svg），可覆盖为 identifier-based 命名（如 status 用 '{statusId}.svg'）。
 */
async function discoverIconFile(
  workspaceId: string,
  iconDir: string,
  fileName?: string
): Promise<{ dataUrl: string; colorable: boolean; rawSvg?: string } | null> {
  const name = fileName ?? 'icon'

  // 并行探测所有扩展名，把 N 次 IPC 往返降为 1 次
  const results = await Promise.allSettled(
    ICON_FILE_EXTENSIONS.map(ext =>
      loadIconFile(workspaceId, `${iconDir}/${name}${ext}`)
    )
  )

  // 按优先级返回第一个成功的结果：svg > png > jpg > jpeg
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) return result.value
  }
  return null
}

/**
 * 来源头像组件（SourceAvatar）。
 * 对 EntityIcon 的薄封装，根据来源类型（mcp/api/gmail/local）设置不同的默认图标，
 * 并支持：
 * - 当没有本地图标时，尝试解析 favicon 作为次级兜底
 * - 在 showStatus=true 时显示连接状态指示点
 * fluid 为 true 时会让图标填满父容器，常用于顶部大卡片。
 */

import * as React from 'react'
import { Globe, HardDrive, Mail, Plug } from 'lucide-react'
import { EntityIcon, type IconComponent } from '@/components/ui/entity-icon'
import { useEntityIcon, logoUrlCache } from '@/lib/icon-cache'
import { McpIcon } from '@/components/icons/McpIcon'
import type { LoadedSource } from '@craft-agent/shared/sources/types'
import type { IconSize, ResolvedEntityIcon } from '@craft-agent/shared/icons'
import { SourceStatusIndicator, deriveConnectionStatus } from './source-status-indicator'

// ============================================================================
// 类型
// ============================================================================

/** 来源类型。 */
export type SourceType = 'mcp' | 'api' | 'gmail' | 'local'

interface SourceAvatarProps {
  /** 已加载的来源对象。 */
  source: LoadedSource
  /** 尺寸（默认 'md'）。 */
  size?: IconSize
  /** 是否填满父容器（h-full w-full），优先级高于 size。 */
  fluid?: boolean
  /** 是否显示连接状态指示点。 */
  showStatus?: boolean
  /** 外层样式类。 */
  className?: string
}

// ============================================================================
// 按来源类型映射的默认图标
// ============================================================================

/** 各来源类型对应的默认图标。 */
const SOURCE_FALLBACKS: Record<string, IconComponent> = {
  mcp: McpIcon,
  api: Globe,
  gmail: Mail,
  local: HardDrive,
}

/**
 * 根据来源类型获取默认图标。
 */
export function getSourceFallbackIcon(type: SourceType): IconComponent {
  return SOURCE_FALLBACKS[type] ?? Plug
}

// ============================================================================
// 状态指示点尺寸映射
// ============================================================================

const STATUS_SIZE_CONFIG: Record<IconSize, 'xs' | 'sm' | 'md'> = {
  xs: 'xs',
  sm: 'xs',
  md: 'sm',
  lg: 'sm',
  xl: 'md',
}

// ============================================================================
// Favicon 兜底 Hook
// ============================================================================

/**
 * 根据来源的服务地址解析 favicon URL。
 * 仅在主图标未找到本地文件（kind 为 fallback）时才尝试解析。
 */
function useFaviconFallback(
  source: LoadedSource,
  primaryIcon: ResolvedEntityIcon
): string | null {
  const [faviconUrl, setFaviconUrl] = React.useState<string | null>(null)

  // 只有主图标降级为默认图标时才需要 favicon
  const needsFavicon = primaryIcon.kind === 'fallback'

  // 从 source.config 中提取稳定的基础类型依赖，避免对象引用变化导致重复渲染
  const slug = source.config.slug
  const provider = source.config.provider
  const mcpUrl = source.config.mcp?.url
  const apiBaseUrl = source.config.api?.baseUrl
  const sourceType = source.config.type

  React.useEffect(() => {
    if (!needsFavicon) {
      setFaviconUrl(null)
      return
    }

    // 根据来源类型提取服务地址
    let serviceUrl: string | null = null
    if (sourceType === 'mcp' && mcpUrl) serviceUrl = mcpUrl
    else if (sourceType === 'api' && apiBaseUrl) serviceUrl = apiBaseUrl

    if (!serviceUrl) {
      setFaviconUrl(null)
      return
    }

    const resolvedProvider = slug ?? provider
    const cacheKey = `${serviceUrl}:${resolvedProvider ?? ''}`

    // 先查缓存
    const cached = logoUrlCache.get(cacheKey)
    if (cached !== undefined) {
      setFaviconUrl(cached)
      return
    }

    // 通过 IPC 异步解析
    let cancelled = false
    window.electronAPI.getLogoUrl(serviceUrl, resolvedProvider)
      .then((result) => {
        if (cancelled) return
        logoUrlCache.set(cacheKey, result)
        setFaviconUrl(result)
      })
      .catch(() => {
        if (cancelled) return
        logoUrlCache.set(cacheKey, null)
        setFaviconUrl(null)
      })

    return () => { cancelled = true }
  }, [needsFavicon, slug, provider, mcpUrl, apiBaseUrl, sourceType])

  return faviconUrl
}

// ============================================================================
// 组件
// ============================================================================

/** 来源头像组件。 */
export function SourceAvatar({ source, size = 'md', fluid, showStatus, className }: SourceAvatarProps) {
  // 解析本地图标
  const icon = useEntityIcon({
    workspaceId: source.workspaceId,
    entityType: 'source',
    identifier: source.config.slug,
    iconDir: `sources/${source.config.slug}`,
    iconValue: source.config.icon,
  })

  // 没有本地图标时，尝试 favicon 作为次级兜底
  const faviconUrl = useFaviconFallback(source, icon)

  // 如果主图标 fallback 且成功拿到 favicon，就把它当作文件图标使用
  const finalIcon: ResolvedEntityIcon = icon.kind === 'fallback' && faviconUrl
    ? { kind: 'file', value: faviconUrl, colorable: false }
    : icon

  const FallbackIcon = SOURCE_FALLBACKS[source.config.type] ?? Plug

  const entityIcon = (
    <EntityIcon
      icon={finalIcon}
      size={size}
      fallbackIcon={FallbackIcon}
      alt={source.config.name}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )

  // 只有需要展示状态时才套一个相对定位容器
  if (showStatus) {
    const connectionStatus = deriveConnectionStatus(source)
    const statusSize = STATUS_SIZE_CONFIG[size]
    return (
      <span className="relative inline-flex shrink-0">
        {entityIcon}
        {connectionStatus && (
          <span className="absolute -bottom-0.5 -right-0.5">
            <SourceStatusIndicator
              status={connectionStatus}
              errorMessage={source.config.connectionError}
              size={statusSize}
            />
          </span>
        )}
      </span>
    )
  }

  return entityIcon
}

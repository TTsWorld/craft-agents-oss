/**
 * 统一实体图标组件（EntityIcon）。
 * 负责渲染三种类型的图标：
 * - emoji：以特定字号文本展示，默认带 bg-muted 容器
 * - file：通过 CrossfadeAvatar 展示图片，带平滑加载过渡
 * - fallback：使用传入的 fallbackIcon（Lucide 或自定义 SVG）作为兜底
 *
 * SourceAvatar、SkillAvatar、StatusIcon 等实体图标组件都是对它的薄封装，
 * 各自传入不同的 fallbackIcon 与额外装饰（状态点、颜色等）。
 */

import * as React from 'react'
import { CrossfadeAvatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import type { ResolvedEntityIcon, IconSize } from '@craft-agent/shared/icons'
import { ICON_SIZE_CLASSES, ICON_EMOJI_SIZES } from '@craft-agent/shared/icons'

/**
 * 接受 className prop 的任意 React 组件。
 * 兼容 Lucide 图标、自定义 SVG 组件（如 McpIcon）等。
 */
export type IconComponent = React.ComponentType<{ className?: string }>

// ============================================================================
// Props
// ============================================================================

/** EntityIcon 的 props。 */
export interface EntityIconProps {
  /** 由 useEntityIcon hook 解析后的图标对象。 */
  icon: ResolvedEntityIcon
  /** 尺寸（默认 'md'）。 */
  size?: IconSize
  /** 当 icon.kind === 'fallback' 时渲染的图标组件。 */
  fallbackIcon: IconComponent
  /** 自定义兜底 React 节点，传入后会覆盖 fallbackIcon。 */
  fallback?: React.ReactNode
  /** 无障碍替代文本。 */
  alt?: string
  /** 外层容器额外的 className。 */
  className?: string
  /**
   * 覆盖默认容器尺寸类。
   * 例如传 'h-full w-full' 让图标填满父容器。
   */
  containerClassName?: string
  /**
   * 为 true 时 emoji 不渲染容器装饰（无背景、圆环、圆角）。
   * 常用于侧边栏行内 emoji 图标。
   */
  chromeless?: boolean
  /**
   * 为 true 时不渲染任何外层容器，直接输出图标内容。
   * 用于父组件已提供完整样式的情况（如过滤菜单）。
   */
  bare?: boolean
}

// ============================================================================
// 组件
// ============================================================================

function EntityIconComponent({
  icon,
  size = 'md',
  fallbackIcon: FallbackIcon,
  fallback,
  alt,
  className,
  containerClassName,
  chromeless,
  bare,
}: EntityIconProps) {
  // 容器尺寸：如果传了覆盖类就用它，否则使用标准尺寸类
  const sizeClass = containerClassName ?? ICON_SIZE_CLASSES[size]

  // 标准容器样式：圆角 + 细边框 + 不收缩
  const containerBase = 'rounded-[4px] ring-1 ring-border/30 shrink-0'

  // --- emoji 图标渲染 ---
  if (icon.kind === 'emoji') {
    if (bare) {
      return <span className={cn(ICON_EMOJI_SIZES[size], 'leading-none', className)} title={alt}>{icon.value}</span>
    }
    return (
      <div
        className={cn(
          // chromeless 模式保留尺寸但去掉背景、圆环、圆角
          sizeClass,
          !chromeless && containerBase,
          !chromeless && 'bg-muted',
          'flex items-center justify-center',
          ICON_EMOJI_SIZES[size],
          'leading-none',
          className,
        )}
        title={alt}
      >
        {icon.value}
      </div>
    )
  }

  // --- 文件图标渲染 ---
  if (icon.kind === 'file') {
    // 可着色 SVG 且提供 rawSvg：直接内联渲染，让父组件的 Tailwind 颜色类通过 currentColor 继承到 SVG
    if (icon.colorable && icon.rawSvg) {
      if (bare) {
        return (
          <span
            className={cn("[&>svg]:h-3.5 [&>svg]:w-3.5", className)}
            title={alt}
            dangerouslySetInnerHTML={{ __html: icon.rawSvg }}
          />
        )
      }
      return (
        <div
          className={cn(sizeClass, !chromeless && containerBase, "[&>svg]:w-full [&>svg]:h-full", className)}
          title={alt}
          dangerouslySetInnerHTML={{ __html: icon.rawSvg }}
        />
      )
    }

    // 不可着色文件（栅格图、颜色写死的 SVG）：通过 CrossfadeAvatar 平滑加载
    const fallbackNode = fallback ?? (
      <FallbackIcon className="w-full h-full text-muted-foreground p-0.5" />
    )

    return (
      <CrossfadeAvatar
        src={icon.value}
        alt={alt}
        className={cn(sizeClass, !chromeless && containerBase, className)}
        fallbackClassName={!chromeless ? "bg-muted rounded-[4px]" : undefined}
        fallback={fallbackNode}
      />
    )
  }

  // --- fallback 渲染（没找到图标文件或 emoji） ---
  if (fallback) {
    if (bare) {
      return <>{fallback}</>
    }
    return (
      <div
        className={cn(sizeClass, !chromeless && containerBase, !chromeless && 'bg-muted', className)}
        title={alt}
      >
        {fallback}
      </div>
    )
  }

  // 默认：用 CrossfadeAvatar 渲染 Lucide 兜底图标（立即显示，无加载过程）
  if (bare) {
    return <FallbackIcon className={cn("h-3.5 w-3.5", className)} />
  }
  return (
    <CrossfadeAvatar
      src={null}
      alt={alt}
      className={cn(sizeClass, !chromeless && containerBase, className)}
      fallbackClassName={!chromeless ? "bg-muted rounded-[4px]" : undefined}
      fallback={<FallbackIcon className="w-full h-full text-muted-foreground p-0.5" />}
    />
  )
}

// 静态标记：让 LeftSidebar 能识别该组件接受 bare prop，
// 避免把 bare 传给 Lucide 图标（它们会把未知 prop 转发到 SVG DOM）
type EntityIconWithMarker = typeof EntityIconComponent & { acceptsBare: true }
/** 导出带标记的 EntityIcon。 */
export const EntityIcon = EntityIconComponent as EntityIconWithMarker
EntityIcon.acceptsBare = true

/**
 * FullscreenOverlayBaseHeader - 全屏浮层的头部组件
 *
 * 从结构化属性（typeBadge, filePath, title, subtitle）构建徽标行。
 * 文件路径徽标带双触发菜单：
 * - 左键点击 → Radix DropdownMenu，包含"打开"/"在 {文件管理器} 中显示"
 * - 右键点击 → Radix ContextMenu，包含相同项
 *
 * 两个菜单共享同一份内部项数组，仅包装方式不同。
 * onOpenFileExternal 和 onRevealInFinder 来自 PlatformContext——无需每个浮层单独传回调。
 */

import { useState, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Check, Copy, ExternalLink, FolderOpen, type LucideIcon } from 'lucide-react'
import { PreviewHeader, PreviewHeaderBadge, type PreviewBadgeVariant } from '../ui/PreviewHeader'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

/** 结构化类型徽标——工具/格式标识（如"Read"、"Image"、"Bash"） */
export interface OverlayTypeBadge {
  icon: LucideIcon
  label: string
  variant?: PreviewBadgeVariant
}

export interface FullscreenOverlayBaseHeaderProps {
  /** 关闭处理函数——在头部显示 X 按钮 */
  onClose: () => void
  /** 类型徽标——工具/格式标识 */
  typeBadge?: OverlayTypeBadge
  /** 文件路径——显示带"打开"+"在 {文件管理器} 中显示"的双触发菜单徽标 */
  filePath?: string
  /** 标题——显示为徽标。无文件路径时的回退选项。 */
  title?: string
  /** 标题徽标的点击处理函数 */
  onTitleClick?: () => void
  /** 副标题——附加信息徽标（如"第 1-50 行，共 200 行"） */
  subtitle?: string
  /** 右侧操作（如 diff 控件） */
  headerActions?: ReactNode
  /** 提供时，渲染内置复制按钮（与关闭按钮样式一致） */
  copyContent?: string
}

/**
 * 截断文件路径，仅在徽标中显示文件名。
 * 完整路径可通过 tooltip 查看。
 */
function displayPath(filePath: string): string {
  const parts = filePath.split('/')
  const name = parts.pop() || filePath
  // 可用时显示父目录 + 文件名（如 "src/App.tsx"）
  if (parts.length > 0) {
    const parent = parts.pop()
    return `${parent}/${name}`
  }
  return name
}

// ============================================================================
// 共享上下文菜单样式——与 StyledDropdown 的弹出层样式一致
// ============================================================================

const contextMenuContentClasses = cn(
  'popover-styled z-dropdown min-w-40 overflow-hidden p-1',
  'w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5',
  'animate-in fade-in-0 zoom-in-95'
)

const contextMenuItemClasses = cn(
  'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  'pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]',
  '[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0'
)

// ============================================================================
// FilePathBadge — 带双触发菜单的徽标（下拉菜单 + 上下文菜单）
// ============================================================================

interface FilePathBadgeProps {
  filePath: string
}

/**
 * FilePathBadge - 左键和右键点击均能打开菜单的徽标。
 *
 * 实现：在 Radix ContextMenu（右键触发）内包裹 Radix DropdownMenu（左键触发）。
 * 两者渲染相同的菜单项。
 * 使用 PlatformContext 的 onOpenFileExternal（而非 onOpenFile）——当已在浮层中
 * 查看文件时，"打开"应直接启动系统编辑器，而非重新触发应用内预览拦截器。
 */
function FilePathBadge({ filePath }: FilePathBadgeProps) {
  const { onOpenFileExternal, onRevealInFinder, fileManagerName } = usePlatform()
  const revealLabel = `Reveal in ${fileManagerName || 'Finder'}`

  const handleOpen = useCallback(() => {
    onOpenFileExternal?.(filePath)
  }, [onOpenFileExternal, filePath])

  const handleReveal = useCallback(() => {
    onRevealInFinder?.(filePath)
  }, [onRevealInFinder, filePath])

  // 共享菜单项——下拉菜单和上下文菜单渲染相同内容
  const hasMenuItems = !!onOpenFileExternal || !!onRevealInFinder

  const dropdownItems = (
    <>
      {onOpenFileExternal && (
        <StyledDropdownMenuItem onSelect={handleOpen}>
          <ExternalLink />
          Open
        </StyledDropdownMenuItem>
      )}
      {onRevealInFinder && (
        <StyledDropdownMenuItem onSelect={handleReveal}>
          <FolderOpen />
          {revealLabel}
        </StyledDropdownMenuItem>
      )}
    </>
  )

  const contextItems = (
    <>
      {onOpenFileExternal && (
        <ContextMenu.Item className={contextMenuItemClasses} onSelect={handleOpen}>
          <ExternalLink />
          Open
        </ContextMenu.Item>
      )}
      {onRevealInFinder && (
        <ContextMenu.Item className={contextMenuItemClasses} onSelect={handleReveal}>
          <FolderOpen />
          {revealLabel}
        </ContextMenu.Item>
      )}
    </>
  )

  const display = displayPath(filePath)

  // 无可用菜单项时（如 Web 查看器），仅显示静态徽标
  if (!hasMenuItems) {
    return <PreviewHeaderBadge label={display} title={filePath} shrinkable />
  }

  // 嵌套：ContextMenu（右键）包裹 DropdownMenu（左键）包裹徽标
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* 响应左键（下拉菜单）和右键（上下文菜单）的徽标 */}
            <button
              className={cn(
                'flex items-center gap-1.5 h-[26px] px-2.5 rounded-[6px]',
                'font-sans text-[13px] font-medium text-foreground/70',
                'bg-background shadow-minimal',
                'min-w-0 cursor-pointer group'
              )}
              title={filePath}
            >
              <span className="truncate group-hover:underline">{display}</span>
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent sideOffset={6} align="center" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
            {dropdownItems}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={contextMenuContentClasses}>
          {contextItems}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

// ============================================================================
// FullscreenOverlayBaseHeader
// ============================================================================

export function FullscreenOverlayBaseHeader({
  onClose,
  typeBadge,
  filePath,
  title,
  onTitleClick,
  subtitle,
  headerActions,
  copyContent,
}: FullscreenOverlayBaseHeaderProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!copyContent) return
    try {
      await navigator.clipboard.writeText(copyContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [copyContent])

  // 内置复制按钮 + 任何自定义头部操作，渲染在 PreviewHeader 的右侧操作区
  const rightActions = (
    <>
      {copyContent != null && (
        <button
          onClick={handleCopy}
          className={cn(
            'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
            'opacity-70 hover:opacity-100 transition-opacity',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
          title={copied ? t('common.copied') : t('common.copyAll')}
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      )}
      {headerActions}
    </>
  )

  return (
    <PreviewHeader onClose={onClose} height={48} rightActions={rightActions}>
      {typeBadge && (
        <PreviewHeaderBadge
          icon={typeBadge.icon}
          label={typeBadge.label}
          variant={typeBadge.variant}
        />
      )}
      {filePath ? (
        <FilePathBadge filePath={filePath} />
      ) : title ? (
        <PreviewHeaderBadge label={title} onClick={onTitleClick} shrinkable />
      ) : null}
      {subtitle && <PreviewHeaderBadge label={subtitle} />}
    </PreviewHeader>
  )
}

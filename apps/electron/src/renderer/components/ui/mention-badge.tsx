/**
 * MentionBadge — 展示已激活 @mention 的内联徽章
 *
 * 用户在输入框里 @skill 或 @source 后，会在输入框上方显示这些徽章，
 * 表示当前会话已经引用了哪些 Skill 或 Source。
 */
import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import type { MentionItemType } from './mention-menu'

// ============================================================================
// 类型
// ============================================================================

export interface MentionBadgeProps {
  /** mention 类型：skill / source */
  type: MentionItemType
  /** 显示文本 */
  label: string
  /** skill 类型 mention 的数据 */
  skill?: LoadedSkill
  /** source 类型 mention 的数据 */
  source?: LoadedSource
  /** Skill 头像需要的 workspace ID */
  workspaceId?: string
  /** 点击移除按钮时调用 */
  onRemove?: () => void
  /** 额外 className */
  className?: string
}

// ============================================================================
// MentionBadge 组件
// ============================================================================

/** 单个 mention 徽章 */
export function MentionBadge({
  type,
  label,
  skill,
  source,
  workspaceId,
  onRemove,
  className,
}: MentionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-6 pl-1 pr-1.5 rounded-[6px]',
        'bg-foreground/5 text-[12px] text-foreground',
        'transition-colors hover:bg-foreground/8',
        className
      )}
    >
      {/* 根据类型显示对应图标 */}
      {type === 'skill' && skill && (
        <SkillAvatar skill={skill} size="xs" workspaceId={workspaceId} />
      )}
      {type === 'source' && source && (
        <SourceAvatar source={source} size="xs" />
      )}

      {/* 标签文本 */}
      <span className="truncate max-w-[100px]">{label}</span>

      {/* 移除按钮 */}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 h-4 w-4 rounded-[3px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

// ============================================================================
// ActiveMentionBadges 组件
// ============================================================================

export interface ParsedMention {
  /** mention 唯一 id */
  id: string
  /** mention 类型 */
  type: MentionItemType
  /** 显示文本 */
  label: string
  /** skill 数据 */
  skill?: LoadedSkill
  /** source 数据 */
  source?: LoadedSource
}

export interface ActiveMentionBadgesProps {
  /** 要展示的解析后 mention 列表 */
  mentions: ParsedMention[]
  /** Skill 头像需要的 workspace ID */
  workspaceId?: string
  /** 移除某个 mention 时调用 */
  onRemove?: (id: string, type: MentionItemType) => void
  /** 容器额外 className */
  className?: string
}

/**
 * ActiveMentionBadges — 输入框上方的一行 mention 徽章
 *
 * 把所有已激活的 @mention（skill、source）展示为可移除徽章。
 * 没有 mention 时返回 null（不渲染）。
 */
export function ActiveMentionBadges({
  mentions,
  workspaceId,
  onRemove,
  className,
}: ActiveMentionBadgesProps) {
  if (mentions.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1 px-4 pt-2', className)}>
      {mentions.map((mention) => (
        <MentionBadge
          key={`${mention.type}-${mention.id}`}
          type={mention.type}
          label={mention.label}
          skill={mention.skill}
          source={mention.source}
          workspaceId={workspaceId}
          onRemove={onRemove ? () => onRemove(mention.id, mention.type) : undefined}
        />
      ))}
    </div>
  )
}

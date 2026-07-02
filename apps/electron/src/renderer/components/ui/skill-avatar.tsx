/**
 * SkillAvatar — Skill（技能）头像组件
 *
 * Skill 是带有 SKILL.md 说明文件、可被 Agent 调用的能力单元。
 * 这个组件是 EntityIcon 的薄封装：设置默认 fallbackIcon 为 Zap，
 * 并委托所有渲染给 EntityIcon。
 */

import { Zap } from 'lucide-react'
import { EntityIcon } from '@/components/ui/entity-icon'
import { useEntityIcon } from '@/lib/icon-cache'
import type { IconSize } from '@craft-agent/shared/icons'
import type { LoadedSkill } from '../../../shared/types'

interface SkillAvatarProps {
  /** 已加载的 Skill 对象 */
  skill: LoadedSkill
  /** 尺寸变体 */
  size?: IconSize
  /** 是否填满父容器（h-full w-full），会覆盖 size */
  fluid?: boolean
  /** 额外 className */
  className?: string
  /** 加载本地图标需要的 workspace ID */
  workspaceId?: string
}

/** Skill 头像 */
export function SkillAvatar({ skill, size = 'md', fluid, className, workspaceId }: SkillAvatarProps) {
  const icon = useEntityIcon({
    workspaceId: workspaceId ?? '',
    entityType: 'skill',
    identifier: skill.slug,
    iconPath: skill.iconPath,
    iconValue: skill.metadata.icon,
  })

  return (
    <EntityIcon
      icon={icon}
      size={size}
      fallbackIcon={Zap}
      alt={skill.metadata.name}
      className={className}
      containerClassName={fluid ? 'h-full w-full' : undefined}
    />
  )
}

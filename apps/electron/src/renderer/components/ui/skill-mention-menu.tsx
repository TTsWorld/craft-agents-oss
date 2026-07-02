/**
 * @deprecated 该文件已废弃，请使用 mention-menu.tsx。
 * 统一的 mention 菜单同时支持 skill 和 source，并带类型徽标。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import type { LoadedSkill } from '../../../shared/types'

// ============================================================================
// 类型
// ============================================================================

export interface InlineSkillMentionProps {
  /** 菜单是否打开 */
  open: boolean
  /** 打开状态变化回调 */
  onOpenChange: (open: boolean) => void
  /** 可选的 Skill 列表 */
  skills: LoadedSkill[]
  /** 选择某个 Skill 时调用 */
  onSelect: (slug: string) => void
  /** 当前过滤文本 */
  filter?: string
  /** 菜单位置 */
  position: { x: number; y: number }
  /** Workspace ID */
  workspaceId?: string
  /** 额外 className */
  className?: string
}

// ============================================================================
// 共享样式（与 slash-command-menu 保持一致）
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[240px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto p-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'

// ============================================================================
// Skill 过滤工具
// ============================================================================

function filterSkills(skills: LoadedSkill[], filter: string): LoadedSkill[] {
  if (!filter) return skills
  const lowerFilter = filter.toLowerCase()
  return skills.filter(
    skill =>
      skill.slug.toLowerCase().includes(lowerFilter) ||
      skill.metadata.name.toLowerCase().includes(lowerFilter)
  )
}

// ============================================================================
// InlineSkillMention — 跟随光标的 Skill 自动完成菜单
// ============================================================================

/** 内联 Skill mention 菜单（已废弃） */
export function InlineSkillMention({
  open,
  onOpenChange,
  skills,
  onSelect,
  filter = '',
  position,
  workspaceId,
  className,
}: InlineSkillMentionProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSkills = filterSkills(skills, filter)

  // filter 变化时重置选中项
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // 键盘导航
  React.useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < filteredSkills.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredSkills.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (filteredSkills[selectedIndex]) {
            onSelect(filteredSkills[selectedIndex].slug)
            onOpenChange(false)
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, filteredSkills, selectedIndex, onSelect, onOpenChange])

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // 没结果或未打开时不渲染
  if (!open || filteredSkills.length === 0) return null

  // 根据窗口高度计算 bottom 位置，菜单显示在光标上方
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition }}
    >
      <div className={MENU_LIST_STYLE}>
        {filteredSkills.map((skill, index) => {
          const isSelected = index === selectedIndex
          return (
            <div
              key={skill.slug}
              onClick={() => {
                onSelect(skill.slug)
                onOpenChange(false)
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                MENU_ITEM_STYLE,
                isSelected && MENU_ITEM_SELECTED
              )}
            >
              <div className="shrink-0">
                <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{skill.metadata.name}</div>
                {skill.metadata.description && (
                  <div className="text-[11px] text-foreground/50 truncate">
                    {skill.metadata.description}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// 管理内联 Skill mention 状态的 Hook
// ============================================================================

/** 可与 useInlineSkillMention 配合使用的输入元素接口 */
export interface SkillMentionInputElement {
  getBoundingClientRect: () => DOMRect
  value: string
  selectionStart: number
}

export interface UseInlineSkillMentionOptions {
  inputRef: React.RefObject<SkillMentionInputElement | null>
  skills: LoadedSkill[]
  onSelect: (slug: string) => void
}

export interface UseInlineSkillMentionReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (slug: string) => string
}

/** 管理 @skill 自动完成菜单状态的 Hook（已废弃） */
export function useInlineSkillMention({
  inputRef,
  skills,
  onSelect,
}: UseInlineSkillMentionOptions): UseInlineSkillMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  // 为 handleSelect 保存当前输入状态
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // 匹配文本开头或空白后的 @，后跟可选单词字符和连字符
    const atMatch = textBeforeCursor.match(/(?:^|\s)@([\w-]*)$/)

    if (atMatch && skills.length > 0) {
      const matchStart = textBeforeCursor.lastIndexOf('@')
      setAtStart(matchStart)
      setFilter(atMatch[1] || '')

      if (inputRef.current) {
        const rect = inputRef.current.getBoundingClientRect()

        // 简化位置计算
        const lineHeight = 20
        const charWidth = 8
        const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
        const charsOnCurrentLine = textBeforeCursor.split('\n').pop()?.length || 0

        // 菜单位于当前行上方
        setPosition({
          x: rect.left + Math.min(charsOnCurrentLine * charWidth, rect.width - 100),
          y: rect.top + (linesBeforeCursor + 1) * lineHeight,
        })
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setAtStart(-1)
    }
  }, [inputRef, skills.length])

  const handleSelect = React.useCallback((slug: string): string => {
    // 在 @ 位置插入 @slug，替换已输入的部分文本
    let result = ''
    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)
      result = before + '@' + slug + ' ' + after
    }

    onSelect(slug)
    setIsOpen(false)

    return result
  }, [onSelect, atStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setAtStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    handleInputChange,
    close,
    handleSelect,
  }
}

/**
 * @ 提及菜单组件集合。
 * 包含行内提及自动补全菜单（InlineMentionMenu）以及状态管理 hook useInlineMention。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { FadingText } from '@/components/ui/fading-text'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource, FileSearchResult } from '../../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'

// ============================================================================
// 类型
// ============================================================================

/** 提及项类型。 */
export type MentionItemType = 'skill' | 'source' | 'file' | 'folder'

/** 单个提及项。 */
export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  description?: string
  // 类型相关的附加数据
  skill?: LoadedSkill
  source?: LoadedSource
  file?: { path: string; type: 'file' | 'directory'; relativePath: string }
}

/** 提及分组。 */
export interface MentionSection {
  id: string
  label: string
  items: MentionItem[]
}

/** InlineMentionMenu 的 props。 */
export interface InlineMentionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: MentionSection[]
  onSelect: (item: MentionItem) => void
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  maxWidth?: number
  className?: string
  /** 是否正在搜索文件。 */
  isSearching?: boolean
}

// ============================================================================
// 共享样式
// ============================================================================

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
// 每项标签右侧的类型徽标，例如 "Skill"、"Source"
const MENU_TYPE_BADGE = 'rounded-[4px] shadow-minimal bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0'

// ============================================================================
// 路径工具函数
// ============================================================================

/** 从相对路径中提取父目录，例如 "src/components/Button.tsx" → "src/components/"。 */
function getParentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  return relativePath.slice(0, lastSlash + 1)
}

/** 检查 query 字符是否按顺序出现在 target 中。
 *  若 target 按顺序包含 query 所有字符则返回 true。
 *  比较区分大小写，如需忽略大小写请先转小写。 */
function subsequenceMatch(target: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/** 用 query 过滤已缓存的文件搜索结果并转为 MentionItem。
 *  优先使用子串匹配（score 2），再用子序列匹配兜底（score 1），
 *  这样 "appav" 也能找到 "app availability.md"。 */
function filterCacheResults(cache: FileSearchResult[], query: string): MentionItem[] {
  const lowerQuery = query.trimEnd().toLowerCase()
  if (!lowerQuery) return []

  const scored = cache
    .map(f => {
      const name = f.name.toLowerCase()
      const path = f.relativePath.toLowerCase()
      let score = 0
      if (name.includes(lowerQuery) || path.includes(lowerQuery)) {
        score = 2
      } else if (subsequenceMatch(name, lowerQuery) || subsequenceMatch(path, lowerQuery)) {
        score = 1
      }
      return { f, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  return scored.map(({ f }) => ({
    id: f.path,
    type: f.type === 'directory' ? 'folder' as const : 'file' as const,
    label: f.name,
    description: f.relativePath,
    file: { path: f.path, type: f.type, relativePath: f.relativePath },
  }))
}

// ============================================================================
// 过滤工具函数
// ============================================================================

/**
 * 计算匹配优先级得分（越高越好）。
 * 3 = 以过滤词开头（首词）
 * 2 = 词边界匹配（空格/连字符/下划线后的后续词）
 * 1 = 包含过滤词（词中）
 * 0 = 无匹配
 */
function getMatchScore(text: string, filter: string): number {
  const lowerText = text.toLowerCase()
  if (lowerText.startsWith(filter)) return 3
  const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordBoundaryPattern = new RegExp(`[\\s\\-_]${escapedFilter}`)
  if (wordBoundaryPattern.test(lowerText)) return 2
  if (lowerText.includes(filter)) return 1
  return 0
}

/** 按 label/id/description 过滤分组。 */
function filterSections(sections: MentionSection[], filter: string): MentionSection[] {
  if (!filter) return sections
  const lowerFilter = filter.trimEnd().toLowerCase()
  if (!lowerFilter) return sections

  // 收集跨分组的所有匹配项
  const allItems = sections.flatMap(section => section.items)
  const matchingItems = allItems.filter(item =>
    item.label?.toLowerCase().includes(lowerFilter) ||
    item.id?.toLowerCase().includes(lowerFilter) ||
    item.description?.toLowerCase().includes(lowerFilter)
  )

  // 按匹配优先级排序：首词 > 后续词 > 包含
  matchingItems.sort((a, b) => {
    const aLabelScore = getMatchScore(a.label, lowerFilter)
    const bLabelScore = getMatchScore(b.label, lowerFilter)
    const aIdScore = getMatchScore(a.id, lowerFilter)
    const bIdScore = getMatchScore(b.id, lowerFilter)

    const aScore = Math.max(aLabelScore, aIdScore)
    const bScore = Math.max(bLabelScore, bIdScore)
    if (aScore !== bScore) return bScore - aScore

    // 同优先级按 label 字母排序
    return a.label.localeCompare(b.label)
  })

  // 过滤时把所有结果放进一个虚拟分组，隐藏原分组标题
  if (matchingItems.length === 0) return []
  return [{ id: 'results', label: 'Results', items: matchingItems }]
}

/** 把所有分组拍平成一个数组。 */
function flattenItems(sections: MentionSection[]): MentionItem[] {
  return sections.flatMap(section => section.items)
}

/**
 * 判断指定位置的 @ 字符是否是有效的提及触发器。
 * 有效触发：
 * - 输入框开头（位置 0）
 * - @ 前面是空白字符（空格、制表符、换行）
 * - @ 前面是左括号或引号：( " '
 * 无效触发：
 * - 在单词中间，例如 "test@example.com"
 */
export function isValidMentionTrigger(textBeforeCursor: string, atPosition: number): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (charBefore === undefined) return false
  // 允许 @ 前面是空白或左括号/引号
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

// ============================================================================
// InlineMentionMenu 组件
// ============================================================================

/** 行内 @ 提及自动补全菜单。 */
export function InlineMentionMenu({
  open,
  onOpenChange,
  sections,
  onSelect,
  filter = '',
  position,
  workspaceId,
  maxWidth = 280,
  className,
}: InlineMentionMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenItems(filteredSections)

  // 过滤变化时重置选中项
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // 键盘导航；没有可选项时不监听，让 Enter 继续传递给输入框
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            onSelect(flatItems[selectedIndex])
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
  }, [open, flatItems, selectedIndex, onSelect, onOpenChange])

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

  // 键盘导航时让选中项滚动到可视区域
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  // 根据窗口高度计算 bottom 位置，让菜单出现在光标上方
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        width: maxWidth,
        maxWidth,
      }}
    >
      {/* 菜单标题，固定在滚动区上方 */}
      <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
        {t('chat.mentionFilesSkillsSources')}
      </div>

      <div ref={listRef} className={MENU_LIST_STYLE}>
        {flatItems.length === 0 && filter && (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">{t('chat.noResults')}</div>
        )}
        {flatItems.map((item, itemIndex) => {
          const isSelected = itemIndex === selectedIndex

          return (
            <div
              key={`${item.type}-${item.id}`}
              data-selected={isSelected}
              onClick={() => {
                onSelect(item)
                onOpenChange(false)
              }}
              onMouseEnter={() => setSelectedIndex(itemIndex)}
              className={cn(
                MENU_ITEM_STYLE,
                isSelected && MENU_ITEM_SELECTED
              )}
            >
              {/* 根据类型渲染图标 */}
              <div className="shrink-0">
                {item.type === 'skill' && item.skill && (
                  <SkillAvatar skill={item.skill} size="sm" workspaceId={workspaceId} />
                )}
                {item.type === 'source' && item.source && (
                  <SourceAvatar source={item.source} size="sm" />
                )}
                {item.type === 'folder' && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="text-muted-foreground">
                    <path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/>
                  </svg>
                )}
                {item.type === 'file' && (
                  <FileMenuIcon name={item.label} />
                )}
              </div>

              {/* 标签与可选路径/徽章 */}
              {(item.type === 'file' || item.type === 'folder') ? (
                <>
                  {/* 文件/文件夹：先显示文件名，溢出时父目录渐隐 */}
                  <span className="shrink-0">{item.label}</span>
                  {item.file?.relativePath && getParentDir(item.file.relativePath) && (
                    <FadingText className="text-[11px] text-muted-foreground min-w-0 opacity-50" fadeWidth={20}>
                      {getParentDir(item.file.relativePath)}
                    </FadingText>
                  )}
                </>
              ) : (
                <>
                  {/* 技能/来源：标签 + 类型徽标 */}
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{item.label}</span>
                  </div>
                  <span className={MENU_TYPE_BADGE}>
                    {item.type === 'skill' ? t('common.skill') : t('common.source')}
                  </span>
                </>
              )}
            </div>
          )
        })}

      </div>
    </div>
  )
}

// ============================================================================
// 文件图标组件：根据扩展名选择图标变体
// ============================================================================

/** 已知代码文件扩展名，使用代码文件图标（< >）。 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** 已知图片文件扩展名，使用图片图标。 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

/** 根据文件名后缀判断文件图标类型。 */
function getFileIconType(name: string): 'code' | 'image' | 'generic' {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'generic'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'generic'
}

/** 根据扩展名渲染对应文件图标（代码、图片或通用文档）。 */
function FileMenuIcon({ name }: { name: string }) {
  const iconType = getFileIconType(name)

  if (iconType === 'code') {
    // 代码文件图标（带 < > 的文档）
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
        <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
      </svg>
    )
  }

  if (iconType === 'image') {
    // 图片文件图标（风景框与山/太阳）
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
        <path d="M8 8.5C8 8.77614 7.77614 9 7.5 9C7.22386 9 7 8.77614 7 8.5C7 8.22386 7.22386 8 7.5 8C7.77614 8 8 8.22386 8 8.5Z" fill="currentColor"/>
        <path d="M20.9998 16.1004L17.9497 13.0503C16.6163 11.7169 15.9496 11.0503 15.1212 11.0503C14.2928 11.0503 13.6261 11.7169 12.2928 13.0503L5.34323 20M8 8.5C8 8.77614 7.77614 9 7.5 9C7.22386 9 7 8.77614 7 8.5C7 8.22386 7.22386 8 7.5 8C7.77614 8 8 8.22386 8 8.5ZM10.5 20.5H13.5C17.2712 20.5 19.1569 20.5 20.3284 19.3284C21.5 18.1569 21.5 16.2712 21.5 12.5V11.5C21.5 7.72876 21.5 5.84315 20.3284 4.67157C19.1569 3.5 17.2712 3.5 13.5 3.5H10.5C6.72876 3.5 4.84315 3.5 3.67157 4.67157C2.5 5.84315 2.5 7.72876 2.5 11.5V12.5C2.5 16.2712 2.5 18.1569 3.67157 19.3284C4.84315 20.5 6.72876 20.5 10.5 20.5Z"/>
      </svg>
    )
  }

  // 通用文件图标（带折角的文档）
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
    </svg>
  )
}

// ============================================================================
// 管理行内提及状态的 Hook
// ============================================================================

/** 可与 useInlineMention 配合使用的输入元素接口。 */
export interface MentionInputElement {
  /** 获取元素包围盒 */
  getBoundingClientRect: () => DOMRect
  /** 可选：获取光标位置包围盒 */
  getCaretRect?: () => DOMRect | null
  /** 当前输入值 */
  value: string
  /** 当前选区起始位置 */
  selectionStart: number
}

/** useInlineMention 的选项。 */
export interface UseInlineMentionOptions {
  /** 输入元素 ref（textarea 或 RichTextInput 句柄）。 */
  inputRef: React.RefObject<MentionInputElement | null>
  /** 可用的 Skill 列表。 */
  skills: LoadedSkill[]
  /** 可用的 Source 列表。 */
  sources: LoadedSource[]
  /** 文件搜索的基础路径（工作目录）。 */
  basePath?: string
  /** 选择某个 mention 项时调用。 */
  onSelect: (item: MentionItem) => void
  /** 用于完整限定 Skill 名的工作区 ID。 */
  workspaceId?: string
}

/** useInlineMention 的返回值。 */
export interface UseInlineMentionReturn {
  /** 菜单是否打开 */
  isOpen: boolean
  /** 当前过滤文本 */
  filter: string
  /** 菜单位置 */
  position: { x: number; y: number }
  /** 分组列表 */
  sections: MentionSection[]
  /** 是否正在搜索文件。 */
  isSearching: boolean
  /** 输入变化时调用 */
  handleInputChange: (value: string, cursorPosition: number) => void
  /** 关闭菜单 */
  close: () => void
  /** 选择某个项后返回新的输入值和光标位置 */
  handleSelect: (item: MentionItem) => { value: string; cursorPosition: number }
}

/** 管理行内 @ 提及状态的自定义 Hook。 */
export function useInlineMention({
  inputRef,
  skills,
  sources,
  basePath,
  onSelect,
  workspaceId,
}: UseInlineMentionOptions): UseInlineMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  // committedFilter 只在 IPC 返回后（或无需 IPC 时立即）更新。
  // 这样可避免视觉跳动：在结果准备好前菜单展示所有项，随后一帧内同时应用过滤词与文件结果。
  const [committedFilter, setCommittedFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  const [fileResults, setFileResults] = React.useState<MentionItem[]>([])
  const fileSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // 当前菜单会话的 IPC 文件搜索结果缓存。
  // 用户增删字符时可直接在客户端过滤，无需等待新的 IPC 往返。菜单关闭时清空。
  const fileCache = React.useRef<FileSearchResult[]>([])
  // 保存当前输入状态，供 handleSelect 使用
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // 卸载时清理挂起的定时器
  React.useEffect(() => {
    return () => {
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
      }
    }
  }, [])

  // 根据可用数据（技能、来源、文件搜索结果）构建分组
  const sections = React.useMemo((): MentionSection[] => {
    const result: MentionSection[] = []

    // 技能分组
    if (skills.length > 0) {
      result.push({
        id: 'skills',
        label: 'Skills',
        items: skills.map(skill => ({
          id: skill.slug,
          type: 'skill' as const,
          label: skill.metadata.name,
          description: skill.metadata.description,
          skill,
        })),
      })
    }

    // 来源分组
    if (sources.length > 0) {
      result.push({
        id: 'sources',
        label: 'Sources',
        items: sources
          .filter(source => source.config.slug && source.config.name)
          .map(source => ({
            id: source.config.slug,
            type: 'source' as const,
            label: source.config.name,
            description: source.config.tagline,
            source,
          })),
      })
    }

    // 文件分组（来自异步搜索结果）
    if (fileResults.length > 0) {
      result.push({
        id: 'files',
        label: 'Files',
        items: fileResults,
      })
    }

    return result
  }, [skills, sources, fileResults])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // 先保存当前输入状态
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // 匹配 @ 后最多 100 个字符（单词字符、连字符、斜杠、点、空格）。
    // 允许空格是为了支持带空格的文件名，例如 @app availability.md。
    // 当空格导致无匹配时菜单会自动关闭（Slack 风格）。
    const atMatch = textBeforeCursor.match(/@([\w\-\/.\s]{0,100})?$/)

    // 检查 @ 触发器是否有效
    const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
    const isValidTrigger = atMatch && isValidMentionTrigger(textBeforeCursor, matchStart)

    if (isValidTrigger) {
      const filterText = atMatch[1] || ''

      // Slack 风格的自动关闭：当查询包含空格、且文件缓存已填充但过滤后无匹配时，
      // 直接关闭菜单。这样既能避免“无限空格”问题，又允许 "app availability.md" 这类多词查询。
      // Skill/Source 名称极少包含空格，因此以文件缓存作为判断依据。
      if (filterText.includes(' ') && fileCache.current.length > 0) {
        const fileMatches = filterCacheResults(fileCache.current, filterText)
        if (fileMatches.length === 0) {
          setIsOpen(false)
          setFilter('')
          setCommittedFilter('')
          setAtStart(-1)
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          setFileResults([])
          fileCache.current = []
          return
        }
      }

      setAtStart(matchStart)
      setFilter(filterText)

      // 缓存优先的文件搜索：如果之前 IPC 调用已经把结果缓存，就在客户端即时过滤（无 IPC、无防抖）。
      // 否则发起带防抖的 IPC 请求填充缓存。菜单关闭时会清空缓存。
      window.electronAPI.debugLog('[mention] filterText:', filterText, 'basePath:', basePath, 'cacheSize:', fileCache.current.length)
      if (basePath && filterText.length >= 1) {
        if (fileCache.current.length > 0) {
          // 缓存存在 —— 在客户端即时过滤，无需 IPC
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          const filtered = filterCacheResults(fileCache.current, filterText)
          window.electronAPI.debugLog('[mention] cache hit:', filtered.length, 'items')
          setFileResults(filtered)
          setCommittedFilter(filterText)
        } else {
          // 首次搜索 —— 发起带防抖的 IPC 请求填充缓存
          if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current)

          fileSearchTimeout.current = setTimeout(async () => {
            try {
              window.electronAPI.debugLog('[mention] calling IPC searchFiles:', basePath, filterText)
              const results = await window.electronAPI.searchFiles(basePath, filterText)
              window.electronAPI.debugLog('[mention] IPC returned:', results?.length, 'results')
              fileCache.current = results
              const filtered = filterCacheResults(fileCache.current, filterText)
              window.electronAPI.debugLog('[mention] after cache filter:', filtered.length, 'items')
              setFileResults(filtered)
              setCommittedFilter(filterText)
            } catch (err) {
              window.electronAPI.debugLog('[mention] IPC searchFiles error:', String(err))
            }
          }, 150)
        }
      } else {
        window.electronAPI.debugLog('[mention] skipping file search (no basePath or empty filter)')
        if (fileSearchTimeout.current) {
          clearTimeout(fileSearchTimeout.current)
          fileSearchTimeout.current = null
        }
        setFileResults([])
        setCommittedFilter(filterText)
      }

      if (inputRef.current) {
        // 尝试从输入元素获取真实光标位置
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // 使用真实光标位置
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // 回退：用输入元素左边缘位置估算
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setCommittedFilter('')
      setAtStart(-1)
      // 菜单关闭时清空文件搜索状态和缓存
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
        fileSearchTimeout.current = null
      }
      setFileResults([])
      fileCache.current = []
    }
  }, [inputRef, basePath])

  const handleSelect = React.useCallback((item: MentionItem): { value: string; cursorPosition: number } => {
    let result = ''
    let newCursorPosition = 0

    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)

      const buildMentionText = (kind: 'skill' | 'source' | 'file' | 'folder', value: string): string =>
        '[' + kind + ':' + value + '] '

      // 使用方括号语法按类型构建 mention 文本。
      // Skill 使用完全限定名（workspaceId:slug），因为 SDK 的 Skill 工具需要这种格式来解析工作区范围的 Skill。
      let mentionText: string
      if (item.type === 'skill') {
        // 插件名取决于 Skill 来自哪一层级：workspace → workspaceId，project/global → ".agents"
        const pluginName = item.skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
        const qualifiedName = pluginName ? `${pluginName}:${item.id}` : item.id
        mentionText = buildMentionText('skill', qualifiedName)
      } else if (item.type === 'source') {
        mentionText = buildMentionText('source', item.id)
      } else if (item.type === 'file') {
        // 文件 mention 使用相对路径
        mentionText = buildMentionText('file', item.file?.relativePath || item.id)
      } else if (item.type === 'folder') {
        mentionText = buildMentionText('folder', item.file?.relativePath || item.id)
      } else {
        mentionText = buildMentionText('skill', item.id)
      }

      result = before + mentionText + after
      newCursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setCommittedFilter('')
    // 清空文件搜索状态和缓存，防止下次打开时显示过期结果
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []

    return { value: result, cursorPosition: newCursorPosition }
  }, [onSelect, atStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setCommittedFilter('')
    setAtStart(-1)
    // 清空文件搜索状态和缓存，防止下次打开时显示过期结果
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []
  }, [])

  return {
    isOpen,
    filter: committedFilter,
    position,
    sections,
    isSearching: false,
    handleInputChange,
    close,
    handleSelect,
  }
}

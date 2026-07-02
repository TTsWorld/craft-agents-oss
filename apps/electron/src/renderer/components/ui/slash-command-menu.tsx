/**
 * 斜杠命令菜单组件集合。
 * 提供按钮触发的命令面板（SlashCommandMenu）与行内自动补全（InlineSlashCommand），
 * 以及管理行内斜杠命令状态的 useInlineSlashCommand hook。
 */
import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { Check, Minimize2 } from 'lucide-react'
import { Icon_Folder } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { PERMISSION_MODE_CONFIG, PERMISSION_MODE_ORDER, type PermissionMode } from '@craft-agent/shared/agent/modes'

// ============================================================================
// 类型
// ============================================================================

/** 斜杠命令 ID。 */
export type SlashCommandId = PermissionMode | 'compact'

/** 斜杠菜单项类型。 */
export type SlashItemType = 'command' | 'folder'

/** 单个斜杠命令。 */
export interface SlashCommand {
  id: SlashCommandId
  label: string
  description: string
  icon: React.ReactNode
  shortcut?: string
  /** 命令颜色（十六进制字符串）。 */
  color?: string
}

/** 斜杠菜单中的文件夹项。 */
export interface SlashFolderItem {
  id: string
  type: 'folder'
  label: string
  description: string
  path: string
}

/** 带标题的分组，用于行内斜杠菜单。 */
export interface SlashSection {
  id: string
  label: string
  items: (SlashCommand | SlashFolderItem)[]
}

/** 命令分组。 */
export interface CommandGroup {
  id: string
  commands: SlashCommand[]
}

// ============================================================================
// 权限模式图标组件
// ============================================================================

interface PermissionModeIconProps {
  mode: PermissionMode
  className?: string
}

/** 根据权限模式渲染对应的 SVG 图标。 */
function PermissionModeIcon({ mode, className }: PermissionModeIconProps) {
  const config = PERMISSION_MODE_CONFIG[mode]
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

// ============================================================================
// 默认命令
// ============================================================================

// 菜单图标尺寸常量
const MENU_ICON_SIZE = 'h-3.5 w-3.5'

// 根据集中式权限模式配置生成命令列表
const permissionModeCommands: SlashCommand[] = PERMISSION_MODE_ORDER.map(mode => {
  const config = PERMISSION_MODE_CONFIG[mode]
  return {
    id: mode,
    label: config.displayName,
    description: config.description,
    icon: <PermissionModeIcon mode={mode} className={MENU_ICON_SIZE} />,
  }
})

// 紧凑上下文命令
const compactCommand: SlashCommand = {
  id: 'compact',
  label: 'Compact Context',
  description: 'Summarize conversation context to free up token budget',
  icon: <Minimize2 className={MENU_ICON_SIZE} />,
}

/** 默认斜杠命令列表。 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  ...permissionModeCommands,
  compactCommand,
]

/** 默认斜杠命令分组。 */
export const DEFAULT_SLASH_COMMAND_GROUPS: CommandGroup[] = [
  { id: 'modes', commands: permissionModeCommands },
]

// ============================================================================
// 共享样式
// ============================================================================

const MENU_CONTAINER_STYLE = 'min-w-[200px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[260px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-2 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
const MENU_SECTION_HEADER = 'px-3 py-1.5 mb-0.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5'

// ============================================================================
// 共享过滤工具函数
// ============================================================================

/** 按 label/id 过滤命令。 */
function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  if (!filter) return commands
  const lowerFilter = filter.toLowerCase()
  return commands.filter(
    cmd =>
      cmd.label.toLowerCase().includes(lowerFilter) ||
      cmd.id.toLowerCase().includes(lowerFilter)
  )
}

/** 判断一个菜单项是否为文件夹。 */
function isFolder(item: SlashCommand | SlashFolderItem): item is SlashFolderItem {
  return 'type' in item && item.type === 'folder'
}

/** 按 label/id/description 过滤分组，同时保留分组结构。 */
function filterSections(sections: SlashSection[], filter: string): SlashSection[] {
  if (!filter) return sections
  const lowerFilter = filter.toLowerCase()

  // 在每个分组内过滤项，保留原有分组结构
  return sections
    .map(section => ({
      ...section,
      items: section.items.filter(item =>
        item.label.toLowerCase().includes(lowerFilter) ||
        item.id.toLowerCase().includes(lowerFilter) ||
        item.description?.toLowerCase().includes(lowerFilter)
      ),
    }))
    .filter(section => section.items.length > 0)
}

/** 把所有分组拍平成一个数组。 */
function flattenSections(sections: SlashSection[]): (SlashCommand | SlashFolderItem)[] {
  return sections.flatMap(section => section.items)
}

// ============================================================================
// 共享命令项内容
// ============================================================================

const MODE_COMMAND_IDS = new Set<string>(['safe', 'ask', 'allow-all'])

/** 渲染单个命令项的图标、标签和选中勾。 */
function CommandItemContent({ command, isActive }: { command: SlashCommand; isActive: boolean }) {
  const { t } = useTranslation()
  const label = MODE_COMMAND_IDS.has(command.id) ? t(`mode.${command.id}`, command.label) : command.label
  return (
    <>
      <div className="shrink-0 text-muted-foreground">{command.icon}</div>
      <div className="flex-1 min-w-0">{label}</div>
      {isActive && (
        <div className="shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center">
          <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
        </div>
      )}
    </>
  )
}

// ============================================================================
// SlashCommandMenu 组件（按钮触发的弹出菜单）
// ============================================================================

/** SlashCommandMenu 的 props。 */
export interface SlashCommandMenuProps {
  /** 扁平命令列表（与 commandGroups 二选一）。 */
  commands?: SlashCommand[]
  /** 带分隔的分组命令。 */
  commandGroups?: CommandGroup[]
  activeCommands?: SlashCommandId[]
  onSelect: (commandId: SlashCommandId) => void
  showFilter?: boolean
  filterPlaceholder?: string
  className?: string
}

/** 斜杠命令菜单。 */
export function SlashCommandMenu({
  commands,
  commandGroups,
  activeCommands = [],
  onSelect,
  showFilter = false,
  filterPlaceholder,
  className,
}: SlashCommandMenuProps) {
  const { t } = useTranslation()
  const effectiveFilterPlaceholder = filterPlaceholder ?? t("commands.searchCommands")
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 如果提供了分组，就在每个分组内过滤；否则使用扁平命令
  const filteredGroups = React.useMemo(() => {
    if (commandGroups) {
      return commandGroups.map(group => ({
        ...group,
        commands: filterCommands(group.commands, filter),
      })).filter(group => group.commands.length > 0)
    }
    return null
  }, [commandGroups, filter])

  const filteredCommands = React.useMemo(() => {
    if (commands && !commandGroups) {
      return filterCommands(commands, filter)
    }
    return null
  }, [commands, commandGroups, filter])

  // 汇总所有命令用于计算 defaultValue
  const allFilteredCommands = filteredGroups
    ? filteredGroups.flatMap(g => g.commands)
    : (filteredCommands ?? [])

  // 默认选中第一个已激活命令；没有则选中第一个命令
  const defaultValue = activeCommands[0] ?? allFilteredCommands[0]?.id

  React.useEffect(() => {
    // 在触屏设备上不要自动聚焦过滤输入框，避免弹出虚拟键盘
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (showFilter && inputRef.current && !isTouchDevice) {
      inputRef.current.focus()
    }
  }, [showFilter])

  if (allFilteredCommands.length === 0 && !showFilter) return null

  // 渲染单个命令项
  const renderCommandItem = (cmd: SlashCommand) => {
    const isActive = activeCommands.includes(cmd.id)
    return (
      <CommandPrimitive.Item
        key={cmd.id}
        value={cmd.id}
        onSelect={() => onSelect(cmd.id)}
        data-tutorial={`permission-mode-${cmd.id}`}
        className={cn(
          MENU_ITEM_STYLE,
          'outline-none',
          'data-[selected=true]:bg-foreground/5'
        )}
      >
        <CommandItemContent command={cmd} isActive={isActive} />
      </CommandPrimitive.Item>
    )
  }

  return (
    <CommandPrimitive
      className={cn(MENU_CONTAINER_STYLE, className)}
      shouldFilter={false}
      defaultValue={defaultValue}
    >
      {showFilter && (
        <div className="border-b border-border/50 px-3 py-2">
          <CommandPrimitive.Input
            ref={inputRef}
            value={filter}
            onValueChange={setFilter}
            placeholder={effectiveFilterPlaceholder}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        {allFilteredCommands.length === 0 ? (
          <CommandPrimitive.Empty className="py-4 text-center text-sm text-muted-foreground">
            No commands found
          </CommandPrimitive.Empty>
        ) : filteredGroups ? (
          // 分组渲染，并在组之间插入分隔线
          filteredGroups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {group.commands.map(renderCommandItem)}
              {/* 分隔线：只有后面还有其他分组时才显示 */}
              {groupIndex < filteredGroups.length - 1 && (
                <div className="h-px bg-border/50 my-1 mx-2" />
              )}
            </React.Fragment>
          ))
        ) : (
          // 扁平列表渲染
          filteredCommands?.map(renderCommandItem)
        )}
      </CommandPrimitive.List>
    </CommandPrimitive>
  )
}

// ============================================================================
// InlineSlashCommand —— 跟随光标的自动补全
// ============================================================================

/** InlineSlashCommand 的 props。 */
export interface InlineSlashCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: SlashSection[]
  activeCommands?: SlashCommandId[]
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  filter?: string
  position: { x: number; y: number }
  className?: string
}

/** 行内斜杠命令自动补全菜单。 */
export function InlineSlashCommand({
  open,
  onOpenChange,
  sections,
  activeCommands = [],
  onSelectCommand,
  onSelectFolder,
  filter = '',
  position,
  className,
}: InlineSlashCommandProps) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenSections(filteredSections)

  // 过滤变化时重置选中项
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // 让当前选中项滚动到可视区域
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // 处理选中命令或文件夹
  const handleSelect = React.useCallback((item: SlashCommand | SlashFolderItem) => {
    if (isFolder(item)) {
      onSelectFolder(item.path)
    } else {
      onSelectCommand(item.id)
    }
    onOpenChange(false)
  }, [onSelectCommand, onSelectFolder, onOpenChange])

  // 键盘导航
  // 没有可选项时不监听，允许 Enter 继续传递给输入框的默认处理
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
            handleSelect(flatItems[selectedIndex])
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
  }, [open, flatItems, selectedIndex, handleSelect, onOpenChange])

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

  // 没有结果或未打开时不渲染
  if (!open || flatItems.length === 0) return null

  // 根据窗口高度计算 bottom 位置，让菜单出现在光标上方
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  // 跨分组累计当前项索引
  let currentItemIndex = 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{ left: Math.round(position.x) - 10, bottom: bottomPosition, minWidth: 220, maxWidth: 260 }}
    >
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {filteredSections.map((section) => (
          <React.Fragment key={section.id}>
            {/* 分组标题 */}
            <div className={MENU_SECTION_HEADER}>
              {section.label}
            </div>

            {/* 分组项 */}
            {section.items.map((item) => {
              const itemIndex = currentItemIndex++
              const isSelected = itemIndex === selectedIndex

              if (isFolder(item)) {
                // 文件夹项：单行显示路径
                return (
                  <div
                    key={`${section.id}-${item.id}`}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <div className="shrink-0 text-muted-foreground">
                      <Icon_Folder className={MENU_ICON_SIZE} strokeWidth={1.75} />
                    </div>
                    <div className="flex-1 min-w-0 truncate">
                      <span>{item.label}</span>
                      <span className="text-muted-foreground ml-1.5">{item.description}</span>
                    </div>
                  </div>
                )
              } else {
                // 命令项
                const isActive = activeCommands.includes(item.id)
                return (
                  <div
                    key={item.id}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <CommandItemContent command={item} isActive={isActive} />
                  </div>
                )
              }
            })}

          </React.Fragment>
        ))}
      </div>
      {/* 常驻底部提示：@ 用于技能和文件 */}
      <div className="h-px bg-border/50 mx-2" />
      <div className="px-3 py-2.5 select-none text-xs text-muted-foreground">
        Use @ for skills and files
      </div>
    </div>
  )
}

// ============================================================================
// 管理行内斜杠命令状态的 Hook
// ============================================================================

/** 可与 useInlineSlashCommand 配合使用的输入元素接口。 */
export interface SlashCommandInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

/**
 * 格式化路径用于展示，把 home 目录简写为 ~。
 */
function formatPathForDisplay(path: string, homeDir?: string): string {
  if (homeDir && path.startsWith(homeDir)) {
    return '~' + path.slice(homeDir.length)
  }
  return path
}

/**
 * 从路径中提取文件夹名。
 */
function getFolderName(path: string): string {
  return path.split('/').pop() || path
}

/** useInlineSlashCommand 的选项。 */
export interface UseInlineSlashCommandOptions {
  /** 输入元素 ref（textarea 或 RichTextInput 句柄）。 */
  inputRef: React.RefObject<SlashCommandInputElement | null>
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  activeCommands?: SlashCommandId[]
  recentFolders?: string[]
  homeDir?: string
}

/** useInlineSlashCommand 的返回值。 */
export interface UseInlineSlashCommandReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: SlashSection[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  activeCommands: SlashCommandId[]
  handleSelectCommand: (commandId: SlashCommandId) => string
  handleSelectFolder: (path: string) => string
}

/** 管理行内斜杠命令状态的自定义 Hook。 */
export function useInlineSlashCommand({
  inputRef,
  onSelectCommand,
  onSelectFolder,
  activeCommands = [],
  recentFolders = [],
  homeDir,
}: UseInlineSlashCommandOptions): UseInlineSlashCommandReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [slashStart, setSlashStart] = React.useState(-1)
  // 保存当前输入状态，供 handleSelect 使用
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // 根据命令与文件夹构建菜单分组
  const sections = React.useMemo((): SlashSection[] => {
    const result: SlashSection[] = []

    // 模式分组
    result.push({
      id: 'modes',
      label: 'Modes',
      items: permissionModeCommands,
    })

    // 命令分组
    result.push({
      id: 'commands',
      label: 'Commands',
      items: [compactCommand],
    })

    // 最近工作目录分组：按文件夹名字母排序
    if (recentFolders.length > 0) {
      const sortedFolders = [...recentFolders]
        .sort((a, b) => {
          const nameA = getFolderName(a).toLowerCase()
          const nameB = getFolderName(b).toLowerCase()
          return nameA.localeCompare(nameB)
        })

      result.push({
        id: 'folders',
        label: 'Recent Working Directories',
        items: sortedFolders.map(path => ({
          id: path,
          type: 'folder' as const,
          label: getFolderName(path),
          description: formatPathForDisplay(path, homeDir),
          path,
        })),
      })
    }

    return result
  }, [recentFolders, homeDir])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // 先保存当前状态
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\w*)$/)

    // 只有存在可展示分组时才打开菜单
    const hasItems = sections.some(s => s.items.length > 0)

    if (slashMatch && hasItems) {
      const filterText = slashMatch[1] || ''
      // 打开前先检查是否有过滤结果，确保无匹配时 Enter 键仍能被输入框正常处理
      const filteredSections = filterSections(sections, filterText)
      const hasFilteredItems = filteredSections.some(s => s.items.length > 0)

      if (!hasFilteredItems) {
        // 过滤后无结果：关闭菜单，避免拦截 Enter
        setIsOpen(false)
        setFilter('')
        setSlashStart(-1)
        return
      }

      const matchStart = textBeforeCursor.lastIndexOf('/')
      setSlashStart(matchStart)
      setFilter(filterText)

      if (inputRef.current) {
        // 优先获取输入元素的真实光标位置
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // 回退：使用输入元素左边缘位置估算
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
      setSlashStart(-1)
    }
  }, [inputRef, sections])

  const handleSelectCommand = React.useCallback((commandId: SlashCommandId): string => {
    // 在触发任何状态变更前先捕获值，避免竞态
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    onSelectCommand(commandId)
    setIsOpen(false)

    return result
  }, [onSelectCommand, slashStart])

  const handleSelectFolder = React.useCallback((path: string): string => {
    // 文件夹选择只切换工作目录，不插入文本
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      // 仅移除 /command 文本
      result = (before + after).trim()
    }

    // 触发工作目录切换
    onSelectFolder(path)
    setIsOpen(false)

    return result
  }, [onSelectFolder, slashStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setSlashStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    sections,
    handleInputChange,
    close,
    activeCommands,
    handleSelectCommand,
    handleSelectFolder,
  }
}

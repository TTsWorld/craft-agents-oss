import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactDOM from 'react-dom'
import { cn } from '../../lib/utils'

/**
 * SimpleDropdown - 无外部依赖的轻量下拉菜单
 *
 * 特性：
 * - 点击外部检测
 * - Portal 渲染以保证正确的层叠顺序
 * - 键盘导航（Escape/ArrowUp/ArrowDown/Enter）
 * - 位置自适应（靠近边缘时翻转）
 */

interface SimpleDropdownContextValue {
  close: () => void
  highlightedId: string | null
  setHighlightedId: (id: string) => void
  setItemRef: (id: string, el: HTMLButtonElement | null) => void
}

const SimpleDropdownContext = React.createContext<SimpleDropdownContextValue | null>(null)

export interface SimpleDropdownItemProps {
  /** 点击处理函数 */
  onClick: (e?: React.MouseEvent) => void
  /** 菜单项内容 */
  children: React.ReactNode
  /** 可选图标（渲染在标签之前） */
  icon?: React.ReactNode
  /** 危险操作变体 - 红色文本 */
  variant?: 'default' | 'destructive'
  /** 附加 className */
  className?: string
  /** 可选的 ref 回调，用于访问底层 button 元素 */
  buttonRef?: (el: HTMLButtonElement | null) => void
  /** 可选的悬停回调 */
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

export function SimpleDropdownItem({
  onClick,
  children,
  icon,
  variant = 'default',
  className,
  buttonRef,
  onMouseEnter,
}: SimpleDropdownItemProps) {
  const dropdownCtx = React.useContext(SimpleDropdownContext)
  const itemId = React.useId()

  const setCombinedRef = React.useCallback((el: HTMLButtonElement | null) => {
    buttonRef?.(el)
    dropdownCtx?.setItemRef(itemId, el)
  }, [buttonRef, dropdownCtx, itemId])

  const handleClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onClick(e)
    dropdownCtx?.close()
  }, [onClick, dropdownCtx])

  const handleMouseEnter = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    dropdownCtx?.setHighlightedId(itemId)
    onMouseEnter?.(e)
  }, [dropdownCtx, itemId, onMouseEnter])

  const isHighlighted = dropdownCtx?.highlightedId === itemId

  return (
    <button
      ref={setCombinedRef}
      type="button"
      data-simple-dropdown-item="true"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={() => dropdownCtx?.setHighlightedId(itemId)}
      className={cn(
        'flex items-center gap-2 w-full px-2.5 py-1.5 text-left text-[13px] rounded-[4px]',
        'hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none',
        'transition-colors',
        isHighlighted && 'bg-foreground/[0.05]',
        variant === 'destructive' && 'text-destructive hover:text-destructive',
        className
      )}
    >
      {icon && (
        <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">
          {icon}
        </span>
      )}
      <span className="flex-1">{children}</span>
    </button>
  )
}

export interface SimpleDropdownProps {
  /** 触发器元素 */
  trigger: React.ReactNode
  /** 菜单项 */
  children: React.ReactNode
  /** 相对于触发器的对齐方式 */
  align?: 'start' | 'end'
  /** 菜单的附加 className */
  className?: string
  /** 是否禁用下拉菜单 */
  disabled?: boolean
  /** 打开状态变化时的回调 */
  onOpenChange?: (open: boolean) => void
  /** 是否启用内置的 ArrowUp/ArrowDown/Enter 键盘导航（默认：true） */
  keyboardNavigation?: boolean
}

export function SimpleDropdown({
  trigger,
  children,
  align = 'end',
  className,
  disabled = false,
  onOpenChange,
  keyboardNavigation = true,
}: SimpleDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  // 通知父组件打开状态变化
  const setIsOpenWithCallback = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    setIsOpen(prev => {
      const newValue = typeof open === 'function' ? open(prev) : open
      if (newValue !== prev) {
        onOpenChange?.(newValue)
      }
      return newValue
    })
  }, [onOpenChange])

  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 菜单项注册表（支持嵌套的 SimpleDropdownItem 用法）
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const itemOrder = useRef<string[]>([])

  const getNavigableIds = useCallback(() => {
    return itemOrder.current.filter((id) => itemRefs.current.has(id))
  }, [])

  const setItemRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) {
      itemRefs.current.set(id, el)
      if (!itemOrder.current.includes(id)) itemOrder.current.push(id)
      if (!highlightedId) setHighlightedId(id)
      return
    }

    itemRefs.current.delete(id)
    itemOrder.current = itemOrder.current.filter(existingId => existingId !== id)

    setHighlightedId((prev) => {
      if (prev !== id) return prev
      const nextIds = getNavigableIds()
      return nextIds[0] ?? null
    })
  }, [getNavigableIds, highlightedId])

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return

    const rect = triggerRef.current.getBoundingClientRect()
    const menuWidth = 160 // 菜单近似宽度

    let left = align === 'end' ? rect.right - menuWidth : rect.left
    const top = rect.bottom + 4

    // 使菜单保持在视口内
    if (left < 8) left = 8
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8
    }

    setPosition({ top, left })
  }, [align])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (disabled) return

    if (!isOpen) {
      // 打开前先计算位置，避免从错误位置开始动画
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const menuWidth = 160
        let left = align === 'end' ? rect.right - menuWidth : rect.left
        const top = rect.bottom + 4
        if (left < 8) left = 8
        if (left + menuWidth > window.innerWidth - 8) {
          left = window.innerWidth - menuWidth - 8
        }
        setPosition({ top, left })
      }
    }
    setIsOpenWithCallback(prev => !prev)
  }, [disabled, isOpen, align, setIsOpenWithCallback])

  const handleClose = useCallback(() => {
    setIsOpenWithCallback(false)
  }, [setIsOpenWithCallback])

  // 打开时更新位置（处理窗口缩放等边缘情况）
  useEffect(() => {
    if (isOpen) {
      updatePosition()
    }
  }, [isOpen, updatePosition])

  // 菜单打开时重置键盘高亮
  useEffect(() => {
    if (!isOpen) {
      setHighlightedId(null)
      itemRefs.current.clear()
      itemOrder.current = []
      return
    }

    setHighlightedId((prev) => {
      if (prev) return prev
      const ids = getNavigableIds()
      return ids[0] ?? null
    })
  }, [isOpen, getNavigableIds])

  // 键盘导航时保持高亮项可见。
  useEffect(() => {
    if (!isOpen || !highlightedId) return
    itemRefs.current.get(highlightedId)?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, highlightedId])

  // 点击外部检测 + 键盘导航
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
        return
      }

      if (!menuRef.current) return
      const target = e.target as Node | null
      if (!target || !menuRef.current.contains(target)) return

      if (!keyboardNavigation) return

      const navigableIds = getNavigableIds()
      if (navigableIds.length === 0) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const currentIndex = highlightedId ? navigableIds.indexOf(highlightedId) : -1
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const nextIndex = currentIndex < 0
          ? 0
          : (currentIndex + delta + navigableIds.length) % navigableIds.length
        setHighlightedId(navigableIds[nextIndex] ?? null)
        return
      }

      if (e.key === 'Enter') {
        if (!highlightedId) return
        e.preventDefault()
        itemRefs.current.get(highlightedId)?.click()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen, handleClose, getNavigableIds, highlightedId, keyboardNavigation])

  const contextValue = useMemo<SimpleDropdownContextValue>(() => ({
    close: handleClose,
    highlightedId,
    setHighlightedId,
    setItemRef,
  }), [handleClose, highlightedId, setItemRef])

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleToggle}
        className={cn('inline-flex', disabled && 'opacity-50 pointer-events-none')}
      >
        {trigger}
      </div>

      {isOpen && position && ReactDOM.createPortal(
        <SimpleDropdownContext.Provider value={contextValue}>
          <div
            ref={menuRef}
            className={cn(
              'fixed z-50 min-w-[140px] p-1',
              'bg-background rounded-[8px] shadow-strong border border-border/50',
              'animate-in fade-in-0 zoom-in-95 duration-100',
              className
            )}
            style={{ top: position.top, left: position.left }}
          >
            {children}
          </div>
        </SimpleDropdownContext.Provider>,
        document.body
      )}
    </>
  )
}

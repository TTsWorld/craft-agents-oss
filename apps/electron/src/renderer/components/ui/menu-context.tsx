/**
 * MenuComponents Context
 *
 * 提供同时适用于 DropdownMenu 和 ContextMenu 的菜单原语
 * （MenuItem、Separator、Sub、SubTrigger、SubContent）。
 *
 * 这样 SessionMenu、SourceMenu、SkillMenu 等菜单内容组件可以在下拉菜单和右键菜单两种场景下
 * 复用同一份代码，避免重复实现。
 *
 * 用法：
 * - 下拉菜单内容用 <DropdownMenuProvider> 包裹
 * - 右键菜单内容用 <ContextMenuProvider> 包裹
 * - 在菜单内容里调用 useMenuComponents() 获取对应原语
 */

import * as React from 'react'
import {
  DropdownMenuSub,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from './styled-dropdown'
import {
  StyledContextMenuSub,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
  StyledContextMenuSubTrigger,
  StyledContextMenuSubContent,
} from './styled-context-menu'

/**
 * 可通过 context 提供的菜单组件类型。
 * 这些都是带样式的变体，匹配项目设计系统。
 */
export interface MenuComponents {
  MenuItem: typeof StyledDropdownMenuItem | typeof StyledContextMenuItem
  Separator: typeof StyledDropdownMenuSeparator | typeof StyledContextMenuSeparator
  Sub: typeof DropdownMenuSub | typeof StyledContextMenuSub
  SubTrigger: typeof StyledDropdownMenuSubTrigger | typeof StyledContextMenuSubTrigger
  SubContent: typeof StyledDropdownMenuSubContent | typeof StyledContextMenuSubContent
}

// 默认用下拉菜单组件兜底，保证向后兼容
const MenuComponentsContext = React.createContext<MenuComponents>({
  MenuItem: StyledDropdownMenuItem,
  Separator: StyledDropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: StyledDropdownMenuSubTrigger,
  SubContent: StyledDropdownMenuSubContent,
})

/**
 * 从 context 获取当前菜单组件集合。
 * 如果没有 Provider，默认返回下拉菜单组件。
 */
export function useMenuComponents(): MenuComponents {
  return React.useContext(MenuComponentsContext)
}

// 下拉菜单组件集合
const dropdownComponents: MenuComponents = {
  MenuItem: StyledDropdownMenuItem,
  Separator: StyledDropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: StyledDropdownMenuSubTrigger,
  SubContent: StyledDropdownMenuSubContent,
}

// 右键菜单组件集合
const contextMenuComponents: MenuComponents = {
  MenuItem: StyledContextMenuItem,
  Separator: StyledContextMenuSeparator,
  Sub: StyledContextMenuSub,
  SubTrigger: StyledContextMenuSubTrigger,
  SubContent: StyledContextMenuSubContent,
}

/**
 * 下拉菜单 Provider。
 * 用 DropdownMenuProvider 包裹下拉菜单内容，内部会拿到下拉菜单原语。
 */
export function DropdownMenuProvider({ children }: { children: React.ReactNode }) {
  return (
    <MenuComponentsContext.Provider value={dropdownComponents}>
      {children}
    </MenuComponentsContext.Provider>
  )
}

/**
 * 右键菜单 Provider。
 * 用 ContextMenuProvider 包裹右键菜单内容，内部会拿到右键菜单原语。
 */
export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  return (
    <MenuComponentsContext.Provider value={contextMenuComponents}>
      {children}
    </MenuComponentsContext.Provider>
  )
}

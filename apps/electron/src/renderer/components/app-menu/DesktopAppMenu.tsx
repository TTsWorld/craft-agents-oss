import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { isMac } from "@/lib/platform"
import { useActionLabel } from "@/actions"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuShortcut,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import { CraftAgentsSymbol } from "../icons/CraftAgentsSymbol"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { SETTINGS_ICONS } from "../icons/SettingsIcons"
import { TopBarButton } from "../ui/TopBarButton"
import {
  EDIT_MENU,
  VIEW_MENU,
  WINDOW_MENU,
  SETTINGS_ITEMS,
  ROOT_MENU,
  HELP_LINKS,
  DEBUG_MENU,
  getShortcutDisplay,
} from "../../../shared/menu-schema"
import type { MenuItem, MenuSection } from "../../../shared/menu-schema"
import type { AppMenuProps } from "./types"

/** 桌面端 Craft logo 下拉菜单。 */

/**
 * 桌面端菜单里除了 role（系统级操作）之外，需要业务层提供回调的动作。
 *
 * 例如：切换专注模式、切换侧边栏。
 */
type MenuActionHandlers = {
  toggleFocusMode?: () => void
  toggleSidebar?: () => void
}

/**
 * 系统级 role 命令到 electronAPI 的映射。
 *
 * 这些对应 Electron 主进程的窗口/编辑操作：撤销、重做、剪切、复制、粘贴、
 * 全选、缩放、最小化、最大化等。点击菜单项时直接调用 preload 暴露的 IPC。
 */
const roleHandlers: Record<string, () => void> = {
  undo: () => window.electronAPI.menuUndo(),
  redo: () => window.electronAPI.menuRedo(),
  cut: () => window.electronAPI.menuCut(),
  copy: () => window.electronAPI.menuCopy(),
  paste: () => window.electronAPI.menuPaste(),
  selectAll: () => window.electronAPI.menuSelectAll(),
  zoomIn: () => window.electronAPI.menuZoomIn(),
  zoomOut: () => window.electronAPI.menuZoomOut(),
  resetZoom: () => window.electronAPI.menuZoomReset(),
  minimize: () => window.electronAPI.menuMinimize(),
  zoom: () => window.electronAPI.menuMaximize(),
}

/**
 * 根据图标名称从 lucide-react 中取出对应的图标组件。
 *
 * @param name lucide 图标名，如 'Settings'。
 * @returns 图标组件，若找不到则返回 null。
 */
function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

/**
 * 渲染单个二级菜单项。
 *
 * 支持四种类型：
 * - separator：分隔线
 * - url：外部链接，点击后通过 electronAPI.openUrl 打开
 * - role：系统级操作，映射到 roleHandlers
 * - action：业务动作，如切换专注模式/侧边栏
 */
function renderSubmenuItem(
  item: MenuItem,
  index: number,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  if (item.type === 'separator') {
    return <StyledDropdownMenuSeparator key={`sep-${index}`} />
  }

  if (item.type === 'url') {
    const Icon = getIcon(item.icon)
    return (
      <StyledDropdownMenuItem key={item.id} onClick={() => window.electronAPI.openUrl(item.url)}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
      </StyledDropdownMenuItem>
    )
  }

  const Icon = getIcon(item.icon)
  const shortcut = getShortcutDisplay(item, isMac)

  if (item.type === 'role') {
    const handler = roleHandlers[item.role]
    const safeHandler = handler ?? (() => {
      console.warn(`[DesktopAppMenu] No handler registered for role: ${item.role}`)
    })
    return (
      <StyledDropdownMenuItem key={item.role} onClick={safeHandler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  if (item.type === 'action') {
    const handler = item.id === 'toggleFocusMode'
      ? actionHandlers.toggleFocusMode
      : item.id === 'toggleSidebar'
        ? actionHandlers.toggleSidebar
        : undefined
    return (
      <StyledDropdownMenuItem key={item.id} onClick={handler}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(item.labelKey)}
        {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
      </StyledDropdownMenuItem>
    )
  }

  return null
}

/**
 * 渲染一个顶级菜单分组（如 Edit / View / Window）。
 *
 * 使用 DropdownMenuSub 实现悬浮子菜单。
 */
function renderMenuSection(
  section: MenuSection,
  actionHandlers: MenuActionHandlers,
  t: (key: string) => string,
): React.ReactNode {
  const Icon = getIcon(section.icon)
  return (
    <DropdownMenuSub key={section.id}>
      <StyledDropdownMenuSubTrigger>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {t(section.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {section.items.map((item, index) => renderSubmenuItem(item, index, actionHandlers, t))}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * 桌面端 AppMenu：点击 Craft logo 弹出的下拉菜单。
 *
 * 包含 New Chat / New Window、Edit、View、Window、Settings、Help、Debug、Quit 等子菜单。
 * 行为与重构前直接内联在 TopBar.tsx 里的版本保持一致。
 * 标签、热键、更新动作统一从 menu-schema.ts 读取，保证桌面端与移动端共用同一份数据源。
 */
export function DesktopAppMenu({
  onNewChat,
  onNewWindow,
  onOpenSettings,
  onOpenSettingsSubpage,
  onOpenKeyboardShortcuts,
  onToggleSidebar,
  onToggleFocusMode,
}: AppMenuProps) {
  const { t } = useTranslation()
  const [isDebugMode, setIsDebugMode] = useState(false)

  // 从全局 action 系统读取各菜单项的快捷键显示文本。
  const newChatHotkey = useActionLabel('app.newChat').hotkey
  const newWindowHotkey = useActionLabel('app.newWindow').hotkey
  const settingsHotkey = useActionLabel('app.settings').hotkey
  const keyboardShortcutsHotkey = useActionLabel('app.keyboardShortcuts').hotkey
  const quitHotkey = useActionLabel('app.quit').hotkey

  // 组件挂载后询问主进程是否处于 Debug 模式，决定是否显示 Debug 子菜单。
  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode)
  }, [])

  const actionHandlers: MenuActionHandlers = {
    toggleFocusMode: onToggleFocusMode,
    toggleSidebar: onToggleSidebar,
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TopBarButton aria-label={t("menu.craftMenu")}>
          <CraftAgentsSymbol className="h-4 text-accent" />
        </TopBarButton>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" minWidth="min-w-48">
        <StyledDropdownMenuItem onClick={onNewChat}>
          <SquarePenRounded className="h-3.5 w-3.5" />
          {t(ROOT_MENU.newChat.labelKey)}
          {newChatHotkey && <DropdownMenuShortcut className="pl-6">{newChatHotkey}</DropdownMenuShortcut>}
        </StyledDropdownMenuItem>
        {onNewWindow && (
          <StyledDropdownMenuItem onClick={onNewWindow}>
            <Icons.AppWindow className="h-3.5 w-3.5" />
            {t(ROOT_MENU.newWindow.labelKey)}
            {newWindowHotkey && <DropdownMenuShortcut className="pl-6">{newWindowHotkey}</DropdownMenuShortcut>}
          </StyledDropdownMenuItem>
        )}

        <StyledDropdownMenuSeparator />

        {renderMenuSection(EDIT_MENU, actionHandlers, t)}
        {renderMenuSection(VIEW_MENU, actionHandlers, t)}
        {renderMenuSection(WINDOW_MENU, actionHandlers, t)}

        <StyledDropdownMenuSeparator />

        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Icons.Settings className="h-3.5 w-3.5" />
            {t("sidebar.settings")}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent>
            <StyledDropdownMenuItem onClick={onOpenSettings}>
              <Icons.Settings className="h-3.5 w-3.5" />
              {t("menu.settings")}
              {settingsHotkey && <DropdownMenuShortcut className="pl-6">{settingsHotkey}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            {SETTINGS_ITEMS.map((item) => {
              const Icon = SETTINGS_ICONS[item.id]
              return (
                <StyledDropdownMenuItem
                  key={item.id}
                  onClick={() => onOpenSettingsSubpage(item.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(item.labelKey)}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Icons.HelpCircle className="h-3.5 w-3.5" />
            {t("menu.help")}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent>
            {HELP_LINKS.map((link) => {
              const Icon = getIcon(link.icon)
              return (
                <StyledDropdownMenuItem
                  key={link.id}
                  onClick={() => window.electronAPI.openUrl(link.url)}
                >
                  {Icon && <Icon className="h-3.5 w-3.5" />}
                  {t(link.labelKey)}
                  <Icons.ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                </StyledDropdownMenuItem>
              )
            })}
            <StyledDropdownMenuItem onClick={onOpenKeyboardShortcuts}>
              <Icons.Keyboard className="h-3.5 w-3.5" />
              {t(ROOT_MENU.keyboardShortcuts.labelKey)}
              {keyboardShortcutsHotkey && <DropdownMenuShortcut className="pl-6">{keyboardShortcutsHotkey}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>

        {isDebugMode && renderDebugSubmenu(t)}

        <StyledDropdownMenuSeparator />

        <StyledDropdownMenuItem onClick={() => window.electronAPI.menuQuit()}>
          <Icons.LogOut className="h-3.5 w-3.5" />
          {t(ROOT_MENU.quit.labelKey)}
          {quitHotkey && <DropdownMenuShortcut className="pl-6">{quitHotkey}</DropdownMenuShortcut>}
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * 渲染 Debug 子菜单。
 *
 * 三个动作（checkForUpdates / installUpdate / toggleDevTools）直接调用 window.electronAPI，
 * 不走普通菜单项的 IPC 通道。
 */
function renderDebugSubmenu(t: (key: string) => string): React.ReactNode {
  const SectionIcon = getIcon(DEBUG_MENU.icon)
  return (
    <DropdownMenuSub>
      <StyledDropdownMenuSubTrigger>
        {SectionIcon && <SectionIcon className="h-3.5 w-3.5" />}
        {t(DEBUG_MENU.labelKey)}
      </StyledDropdownMenuSubTrigger>
      <StyledDropdownMenuSubContent>
        {DEBUG_MENU.items.map((item, index) => {
          if (item.type === 'separator') {
            return <StyledDropdownMenuSeparator key={`sep-${index}`} />
          }
          if (item.type !== 'action') return null
          const Icon = getIcon(item.icon)
          const shortcut = isMac ? item.shortcutDisplayMac : item.shortcutDisplayOther
          const handler = debugHandlers[item.id]
          if (!handler) {
            console.warn(`[DesktopAppMenu] No debug handler for id: ${item.id}`)
            return null
          }
          return (
            <StyledDropdownMenuItem key={item.id} onClick={handler}>
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {t(item.labelKey)}
              {shortcut && <DropdownMenuShortcut className="pl-6">{shortcut}</DropdownMenuShortcut>}
            </StyledDropdownMenuItem>
          )
        })}
      </StyledDropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Debug 菜单项 ID 到具体 electronAPI 调用的映射。 */
const debugHandlers: Record<string, () => void> = {
  checkForUpdates: () => window.electronAPI.checkForUpdates(),
  installUpdate: () => window.electronAPI.installUpdate(),
  toggleDevTools: () => window.electronAPI.menuToggleDevTools(),
}

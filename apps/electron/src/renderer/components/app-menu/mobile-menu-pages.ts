import {
  ROOT_MENU,
  HELP_LINKS,
  DEBUG_MENU,
  SETTINGS_ITEMS,
  type SettingsMenuItem,
} from '../../../shared/menu-schema'

/** 根据共享 menu-schema 构建移动端菜单页面数据。 */

/** 移动端菜单页面的 ID。 */
export type MobileMenuPageId = 'root' | 'settings' | 'help' | 'debug'

/**
 * 点击某一行后的动作类型。
 *
 * 渲染器会把这些声明式描述映射成具体的回调/副作用。
 * 用一份数据同时喂给桌面端和移动端，未来若要新增菜单形态也能复用。
 */
export type MobileMenuAction =
  | { kind: 'navigate'; to: MobileMenuPageId }
  | { kind: 'callback'; key: 'newChat' | 'newWindow' | 'openSettings' }
  | { kind: 'settingsSubpage'; subpage: SettingsMenuItem['id'] }
  | { kind: 'url'; url: string }
  | { kind: 'electronApi'; method: 'checkForUpdates' | 'installUpdate' | 'menuToggleDevTools' }

export interface MobileMenuRow {
  id: string
  iconName: string
  labelKey: string
  description?: string
  action: MobileMenuAction
}

export interface MobileMenuPage {
  id: MobileMenuPageId
  /** 页面标题对应的 i18n key，渲染时通过 t(titleKey) 取得实际文本。 */
  titleKey: string
  rows: MobileMenuRow[]
}

interface BuildOptions {
  hasNewWindow: boolean
  isDebugMode: boolean
}

/**
 * 根据共享的 menu-schema 构造移动端菜单页面图。
 *
 * 桌面端的 Edit/View/Window 子菜单在移动端被有意省略：
 * - Edit（撤销/重做/剪切/复制/粘贴/全选）：触摸屏由系统原生编辑菜单处理。
 * - View（缩放、侧边栏/专注模式切换）：缩放由浏览器原生手势；紧凑布局下侧边栏/专注模式无意义。
 * - Window（最小化/最大化）：浏览器标签页里不存在这一语义。
 * - Quit：在浏览器标签页里同样无意义。
 *
 * 新增帮助链接只需往 HELP_LINKS 里加数据；新增设置子页面只需往 SETTINGS_ITEMS 里加数据。
 * 这里会自动把它们展开成对应的页面行。
 */
export function buildMobileMenuPages({ hasNewWindow, isDebugMode }: BuildOptions): MobileMenuPage[] {
  const rootRows: MobileMenuRow[] = [
    {
      id: ROOT_MENU.newChat.id,
      iconName: 'SquarePen',
      labelKey: ROOT_MENU.newChat.labelKey,
      action: { kind: 'callback', key: 'newChat' },
    },
  ]
  if (hasNewWindow) {
    rootRows.push({
      id: ROOT_MENU.newWindow.id,
      iconName: ROOT_MENU.newWindow.icon,
      labelKey: ROOT_MENU.newWindow.labelKey,
      action: { kind: 'callback', key: 'newWindow' },
    })
  }
  // 触摸设备没有实体键盘，Keyboard Shortcuts 页在移动端没有意义，因此不显示。
  rootRows.push(
    {
      id: 'settings',
      iconName: 'Settings',
      labelKey: 'sidebar.settings',
      action: { kind: 'navigate', to: 'settings' },
    },
    {
      id: 'help',
      iconName: 'HelpCircle',
      labelKey: 'menu.help',
      action: { kind: 'navigate', to: 'help' },
    },
  )
  if (isDebugMode) {
    rootRows.push({
      id: 'debug',
      iconName: DEBUG_MENU.icon,
      labelKey: DEBUG_MENU.labelKey,
      action: { kind: 'navigate', to: 'debug' },
    })
  }

  const settingsRows: MobileMenuRow[] = [
    {
      id: 'settings-overview',
      iconName: 'Settings',
      labelKey: 'menu.settings',
      action: { kind: 'callback', key: 'openSettings' },
    },
    ...SETTINGS_ITEMS.map<MobileMenuRow>((item) => ({
      id: `settings-${item.id}`,
      iconName: item.icon,
      labelKey: item.labelKey,
      description: item.descriptionKey,
      action: { kind: 'settingsSubpage', subpage: item.id },
    })),
  ]

  const helpRows: MobileMenuRow[] = HELP_LINKS.map<MobileMenuRow>((link) => ({
    id: link.id,
    iconName: link.icon,
    labelKey: link.labelKey,
    action: { kind: 'url', url: link.url },
  }))

  const debugRows: MobileMenuRow[] = DEBUG_MENU.items
    .filter((item) => item.type === 'action')
    .map<MobileMenuRow>((item) => {
      // 经过上面 filter，这里 item 已经被收窄为 action 类型。
      const action = item as Extract<typeof item, { type: 'action' }>
      return {
        id: action.id,
        iconName: action.icon,
        labelKey: action.labelKey,
        action: {
          kind: 'electronApi',
          method:
            action.id === 'checkForUpdates' ? 'checkForUpdates' :
            action.id === 'installUpdate' ? 'installUpdate' :
            'menuToggleDevTools',
        },
      }
    })

  return [
    { id: 'root', titleKey: 'menu.craftMenu', rows: rootRows },
    { id: 'settings', titleKey: 'sidebar.settings', rows: settingsRows },
    { id: 'help', titleKey: 'menu.help', rows: helpRows },
    { id: 'debug', titleKey: DEBUG_MENU.labelKey, rows: debugRows },
  ]
}

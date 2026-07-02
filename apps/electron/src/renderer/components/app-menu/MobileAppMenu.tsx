import * as React from 'react'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useRegisterDismissibleLayer } from '@/context/DismissibleLayerContext'
import { CraftAgentsSymbol } from '../icons/CraftAgentsSymbol'
import { SquarePenRounded } from '../icons/SquarePenRounded'
import { SETTINGS_ICONS } from '../icons/SettingsIcons'
import { TopBarButton } from '../ui/TopBarButton'
import { MobileMenuPage } from './MobileMenuPage'
import { MobileMenuItem, type MobileMenuItemAffordance } from './MobileMenuItem'
import {
  buildMobileMenuPages,
  type MobileMenuPage as PageDefinition,
  type MobileMenuPageId,
  type MobileMenuRow,
} from './mobile-menu-pages'
import type { AppMenuProps } from './types'

/** 移动端 Craft logo 全屏抽屉菜单。 */

/** 抽屉弹出的弹簧动画配置：stiffness/damping 越大越“干脆”。 */
const SNAPPY_SPRING = { type: 'spring' as const, stiffness: 400, damping: 36, mass: 0.8 }
/** 背景遮罩淡入淡出时长。 */
const BACKDROP_FADE = { duration: 0.18 }

/**
 * 控制菜单状态机的 action 类型。
 *
 * 使用 discriminated union（可辨识联合）：通过 type 字段区分不同动作。
 * 类似 Go 里带 tag 的 interface{}，但 TS 会在编译期帮你收窄。
 */
type StackAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'push'; page: MobileMenuPageId }
  | { type: 'pop' }
  | { type: 'reset' }

/** 菜单抽屉的状态：是否打开、当前页面栈。 */
interface SheetState {
  isOpen: boolean
  /** 页面栈中的页面 ID，栈底永远是 'root'。 */
  stack: MobileMenuPageId[]
}

/** 初始状态：关闭，页面栈只有 root。 */
const INITIAL_STATE: SheetState = { isOpen: false, stack: ['root'] }

/**
 * 页面栈 reducer。
 *
 * React useReducer 的第二个参数是 action；这里用 switch 根据 action.type 返回新状态。
 * 注意对象展开 {...state} 只是浅拷贝，但因为 stack 会被新数组替换，所以是安全的。
 */
function stackReducer(state: SheetState, action: StackAction): SheetState {
  switch (action.type) {
    case 'open':
      return { isOpen: true, stack: ['root'] }
    case 'close':
      return { isOpen: false, stack: ['root'] }
    case 'push':
      // 防护：如果 motion 事件重复触发，避免重复压入同一页。
      if (state.stack[state.stack.length - 1] === action.page) return state
      return { ...state, stack: [...state.stack, action.page] }
    case 'pop':
      if (state.stack.length <= 1) return state
      return { ...state, stack: state.stack.slice(0, -1) }
    case 'reset':
      return INITIAL_STATE
  }
}

/**
 * 根据图标名从 lucide-react 取图标组件。
 *
 * keyof typeof Icons 是 TS 的“索引类型查询”，把对象所有 key 转成一个联合类型。
 */
function getIcon(name: string): React.ComponentType<{ className?: string }> | null {
  const IconComponent = Icons[name as keyof typeof Icons] as React.ComponentType<{ className?: string }> | undefined
  return IconComponent ?? null
}

/**
 * 渲染每一行左侧的图标。
 *
 * 对 newChat 使用本地圆角图标替代 lucide 的 SquarePen；
 * 对 settings-* 行使用自定义 SETTINGS_ICONS 映射。
 */
function renderRowIcon(iconName: string, rowId: string): React.ReactNode {
  if (rowId === 'newChat') {
    return <SquarePenRounded className="h-5 w-5" />
  }
  const settingsKey = rowId.startsWith('settings-') ? rowId.replace(/^settings-/, '') : null
  if (settingsKey && settingsKey !== 'overview') {
    const Icon = SETTINGS_ICONS[settingsKey as keyof typeof SETTINGS_ICONS]
    if (Icon) return <Icon className="h-5 w-5" />
  }
  const Icon = getIcon(iconName)
  return Icon ? <Icon className="h-5 w-5" /> : null
}

/**
 * 根据行的动作类型决定右侧提示图标。
 *
 * navigate → 进入下一页（chevron）
 * url      → 外部链接（external）
 * 其他     → 无
 */
function affordanceFor(action: MobileMenuRow['action']): MobileMenuItemAffordance {
  switch (action.kind) {
    case 'navigate':
      return 'chevron'
    case 'url':
      return 'external'
    default:
      return 'none'
  }
}

/**
 * 移动端 AppMenu：点击 Craft logo 后从底部/全屏滑出的导航栈抽屉。
 *
 * 仅在 AppShellContext.isCompactMode === true 时由 AppMenu 路由挂载。
 * 抽屉通过 createPortal 渲染到标记了 data-mobile-menu-root 的最近元素
 * （生产环境是 PanelStackContainer，playground 是 MobileWebUIFrame）；
 * 找不到时回退到 document.body。
 */
export function MobileAppMenu(props: AppMenuProps) {
  const { t } = useTranslation()
  const [state, dispatch] = useReducer(stackReducer, INITIAL_STATE)
  const [isDebugMode, setIsDebugMode] = useState(false)

  // 询问主进程是否处于 Debug 模式，控制 Debug 页面是否显示。
  useEffect(() => {
    window.electronAPI.isDebugMode().then(setIsDebugMode)
  }, [])

  // useMemo 缓存页面数据，仅在 onNewWindow 或 isDebugMode 变化时重新生成。
  const pages = useMemo(
    () => buildMobileMenuPages({ hasNewWindow: !!props.onNewWindow, isDebugMode }),
    [props.onNewWindow, isDebugMode],
  )

  const close = React.useCallback(() => dispatch({ type: 'close' }), [])
  const pop = React.useCallback(() => dispatch({ type: 'pop' }), [])

  // 注意：这里故意不与 window.history 打通。
  // NavigationContext 负责应用内的 history.pushState；如果在这里调用 history.back()，
  // 会与菜单动作触发的路由变化产生竞态（例如 Settings → AI），导致被回退。
  // iOS Safari 的侧滑返回会整页后退而不是弹出子页面，这是已知的 UX 取舍；
  // 关闭按钮和返回箭头才是官方支持的关闭路径。

  /**
   * 向 DismissibleLayerContext 注册当前层，使 Escape/返回键行为能正确嵌套。
   *
   * priority: 0 表示优先级低于权限/凭证弹窗（它们的优先级更高）。
   */
  const layerRegistration = useMemo(
    () => state.isOpen ? {
      id: 'mobile-app-menu',
      type: 'modal' as const,
      priority: 0,
      isOpen: true,
      close,
      canBack: () => state.stack.length > 1,
      back: () => {
        if (state.stack.length > 1) {
          pop()
          return true
        }
        return false
      },
    } : null,
    [state.isOpen, state.stack.length, close, pop],
  )
  useRegisterDismissibleLayer(layerRegistration)

  /**
   * 统一处理每一行的点击。
   *
   * 根据 MobileMenuRow.action 的 kind 分发到不同的副作用：
   * - navigate        → push 新页面
   * - callback        → 调用 props 里的回调并关闭抽屉
   * - settingsSubpage → 打开设置子页面并关闭抽屉
   * - url             → 通过 electronAPI 打开外部链接并关闭抽屉
   * - electronApi     → 调用主进程暴露的调试/更新方法（不关闭抽屉）
   */
  const dispatchAction = (row: MobileMenuRow) => {
    switch (row.action.kind) {
      case 'navigate':
        dispatch({ type: 'push', page: row.action.to })
        return
      case 'callback':
        switch (row.action.key) {
          case 'newChat': props.onNewChat(); break
          case 'newWindow': props.onNewWindow?.(); break
          case 'openSettings': props.onOpenSettings(); break
        }
        close()
        return
      case 'settingsSubpage':
        props.onOpenSettingsSubpage(row.action.subpage)
        close()
        return
      case 'url':
        window.electronAPI.openUrl(row.action.url)
        close()
        return
      case 'electronApi':
        switch (row.action.method) {
          case 'checkForUpdates': window.electronAPI.checkForUpdates(); break
          case 'installUpdate': window.electronAPI.installUpdate(); break
          case 'menuToggleDevTools': window.electronAPI.menuToggleDevTools(); break
        }
        return
    }
  }

  return (
    <>
      <TopBarButton
        onClick={() => state.isOpen ? close() : dispatch({ type: 'open' })}
        aria-label={t('menu.craftMenu')}
        data-state={state.isOpen ? 'open' : 'closed'}
        className="rounded-[8px]"
      >
        <CraftAgentsSymbol className="!h-5 !w-auto text-accent" />
      </TopBarButton>
      <MobileMenuSheet
        state={state}
        pages={pages}
        onPop={pop}
        onClose={close}
        onActivateRow={dispatchAction}
        t={t}
      />
    </>
  )
}

/** MobileMenuSheet 的 props。 */
interface SheetProps {
  state: SheetState
  pages: PageDefinition[]
  onPop: () => void
  onClose: () => void
  onActivateRow: (row: MobileMenuRow) => void
  t: (key: string) => string
}

/**
 * 渲染抽屉本体。
 *
 * 使用 createPortal 把抽屉挂载到指定 DOM 节点，避免被父元素的 CSS 上下文截断。
 * AnimatePresence 负责退出动画。
 */
function MobileMenuSheet({ state, pages, onPop, onClose, onActivateRow, t }: SheetProps) {
  const portalTarget = useMobileMenuPortalTarget(state.isOpen)
  if (!portalTarget) return null

  // 只要抽屉处于打开或退出动画期间就渲染；AnimatePresence 负责离场动画。
  const sheet = (
    <AnimatePresence>
      {state.isOpen && (
        <motion.div
          key="mobile-app-menu-sheet"
          className="absolute inset-0 z-modal"
          initial="closed"
          animate="open"
          exit="closed"
        >
          {/* 背景遮罩；当 portal 目标有可见兄弟元素时才有意义，否则只是低成本兜底。 */}
          <motion.div
            className="absolute inset-0 bg-foreground/30"
            variants={{ open: { opacity: 1 }, closed: { opacity: 0 } }}
            transition={BACKDROP_FADE}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-0 bg-background overflow-hidden"
            variants={{ open: { y: '0%' }, closed: { y: '100%' } }}
            transition={SNAPPY_SPRING}
          >
            <PageStack
              pages={pages}
              stack={state.stack}
              onPop={onPop}
              onClose={onClose}
              onActivateRow={onActivateRow}
              t={t}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  return createPortal(sheet, portalTarget)
}

/** 页面栈组件的 props。 */
interface PageStackProps {
  pages: PageDefinition[]
  stack: MobileMenuPageId[]
  onPop: () => void
  onClose: () => void
  onActivateRow: (row: MobileMenuRow) => void
  t: (key: string) => string
}

/**
 * 渲染页面栈，子页面滑入/滑出。
 *
 * 栈中所有页面都保持在 DOM 中，只是被上层页面盖住；
 * 这是导航栈常见的实现方式，保证返回时无需重新渲染。
 */
function PageStack({ pages, stack, onPop, onClose, onActivateRow, t }: PageStackProps) {
  return (
    <div className="absolute inset-0">
      {stack.map((pageId, depth) => {
        const page = pages.find((p) => p.id === pageId)
        if (!page) return null
        return (
          <motion.div
            key={pageId}
            className="absolute inset-0"
            initial={depth === 0 ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={SNAPPY_SPRING}
          >
            <MobileMenuPage
              title={t(page.titleKey)}
              showBack={depth > 0}
              onBack={onPop}
              onClose={onClose}
            >
              <ul className="py-2">
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <MobileMenuItem
                      icon={renderRowIcon(row.iconName, row.id)}
                      label={t(row.labelKey)}
                      affordance={affordanceFor(row.action)}
                      onClick={() => onActivateRow(row)}
                    />
                  </li>
                ))}
              </ul>
            </MobileMenuPage>
          </motion.div>
        )
      })}
    </div>
  )
}

/**
 * 解析抽屉应该挂载到哪个 DOM 节点。
 *
 * SSR/首屏安全：文档不可用时返回 null；
 * 每次打开抽屉都会重新查找，保证动态挂载的 demo 也能工作。
 */
function useMobileMenuPortalTarget(isOpen: boolean): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!isOpen) return
    const found = document.querySelector('[data-mobile-menu-root]')
    setTarget((found as HTMLElement | null) ?? document.body)
  }, [isOpen])
  return target
}

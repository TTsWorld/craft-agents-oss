/**
 * LeftSidebar — React 组件
 * 
 * 所属目录：app-shell
 */
import type { LucideIcon } from "lucide-react"
import * as React from "react"
import { AnimatePresence, motion, type Variants } from "motion/react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { ContextMenuProvider } from '@/components/ui/menu-context'
import { SidebarMenu, type SidebarMenuType } from './SidebarMenu'
import { SortableList, type SortableItemData } from '@/components/ui/sortable-list'

/** 侧边栏项的右键菜单配置 */
export interface SidebarContextMenuConfig {
  /** 侧边栏项类型，决定右键菜单里显示哪些操作 */
  type: SidebarMenuType
  /** 状态项的 ID（如 todo / done），当前未使用，保留供后续扩展 */
  statusId?: string
  /** 标签 ID；设置时表示这是一个具体标签（会启用“删除标签”） */
  labelId?: string
  /** “配置状态”回调，用于 allSessions / status / flagged 类型 */
  onConfigureStatuses?: () => void
  /** “全部标为已读”回调，用于 allSessions 类型 */
  onMarkAllRead?: () => void
  /** “配置标签”回调；从具体标签触发时会传入 labelId */
  onConfigureLabels?: (labelId?: string) => void
  /** “新建标签”回调；parentId 来自触发项的 labelId */
  onAddLabel?: (parentId?: string) => void
  /** “删除标签”回调；按 labelId 删除 */
  onDeleteLabel?: (labelId: string) => void
  /** “添加 Source”回调，用于 sources 类型 */
  onAddSource?: () => void
  /** “添加 Skill”回调，用于 skills 类型 */
  onAddSkill?: () => void
  /** “添加 Automation”回调，用于 automations 类型 */
  onAddAutomation?: () => void
  /** “添加项目”回调，用于 projects 类型 */
  onAddProject?: () => void
  /** Source 类型过滤，决定“了解更多”打开哪个文档页 */
  sourceType?: 'api' | 'mcp' | 'local'
  /** “编辑视图”回调，用于 views 类型 */
  onConfigureViews?: () => void
  /** 视图 ID；设置时表示这是一个具体视图（会启用“删除”） */
  viewId?: string
  /** “删除视图”回调 */
  onDeleteView?: (id: string) => void
}

/**
 * 可展开项的拖拽排序配置。
 * 当 LinkItem 带有 sortable 时，其子项会变成可拖拽排序的平面列表。
 */
export interface SortableConfig {
  /** 拖拽完成后回调，入参是按新顺序排列的 ID 数组 */
  onReorder: (orderedIds: string[]) => void
}

/**
 * LinkItem：侧边栏可点击项的数据结构。
 * 可以把它理解成导航菜单里的一个条目，支持图标、徽标、子项、右键菜单等。
 */
export interface LinkItem {
  id: string            // 导航唯一标识，例如 'nav:allSessions'
  title: string
  label?: string        // 右侧可选徽标，例如未读数量
  icon: LucideIcon | React.ReactNode  // Lucide 图标组件或自定义 React 元素
  iconColor?: string    // 图标颜色（CSS 颜色字符串）
  /** 图标是否跟随 currentColor 变色；Lucide 图标默认 true */
  iconColorable?: boolean
  variant: "default" | "ghost"  // default=高亮（选中态），ghost=低调（未选中态）
  onClick?: () => void
  // 可展开项的属性
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  items?: SidebarItem[]    // 子项数据（会被渲染成嵌套 LeftSidebar），支持分割线
  // 紧凑模式：上下内边距各少 4px，总高度更低
  compact?: boolean
  // 新手引导系统用属性
  dataTutorial?: string // data-tutorial 属性，供引导步骤定位
  // 右键菜单配置（可选）；提供后右键会弹出菜单
  contextMenu?: SidebarContextMenuConfig
  // 拖拽排序：平面列表重排，例如状态项
  sortable?: SortableConfig
  // 标题右侧可选元素（如标签类型图标），悬停时显示
  afterTitle?: React.ReactNode
}

/** 分割线项 */
export interface SeparatorItem {
  id: string
  type: 'separator'
}

/** SidebarItem：侧边栏项的联合类型 */
export type SidebarItem = LinkItem | SeparatorItem

/** 类型守卫：判断是否为分割线项 */
export const isSeparatorItem = (item: SidebarItem): item is SeparatorItem =>
  'type' in item && item.type === 'separator'

interface LeftSidebarProps {
  isCollapsed: boolean
  links: SidebarItem[]
  /** 获取每一项的导航属性（由父组件统一键盘导航提供） */
  getItemProps?: (id: string) => {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
  /** 当前拥有键盘焦点的项 ID */
  focusedItemId?: string | null
  /** 是否为嵌套侧边栏（可展开项的子项） */
  isNested?: boolean
}

// 子项的交错动画配置
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.01,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
}

/**
 * LeftSidebar：带图标的垂直导航按钮列表。
 *
 * 键盘导航由父组件（Chat.tsx）统一管理，这个组件只负责渲染。
 *
 * 样式与侧边栏里的 agent 项保持一致：
 * - py-[7px] px-2 text-[13px] rounded-md
 * - 图标：h-3.5 w-3.5
 *
 * Link 变体：
 * - "default"：高亮样式，用于激活/选中项
 * - "ghost"：低调样式，用于未选中项
 *
 * 可展开项：
 * - 悬停时显示 chevron 切换按钮（替换图标位置）
 * - 子项带展开/折叠动画
 * - 嵌套项左侧有缩进和竖线
 *
 * 拖拽排序：
 * - 可展开项可声明 sortable 启用平面拖拽
 * - 使用 @dnd-kit，DragOverlay 挂载到 document.body，避免被父容器裁剪
 * - 两阶段落动画：overlay 淡出，ghost 淡入
 */
export function LeftSidebar({ links, isCollapsed, getItemProps, focusedItemId, isNested }: LeftSidebarProps) {
  // 嵌套侧边栏用 motion.nav 包装，以应用交错动画
  const NavWrapper = isNested ? motion.nav : 'nav'
  const navProps = isNested ? {
    variants: containerVariants,
    initial: 'hidden',
    animate: 'visible',
    exit: 'exit',
  } : {}

  return (
    <div className={cn("flex flex-col select-none", !isNested && "py-1")}>
      <NavWrapper
        className={cn(
          "grid gap-0.5",
          isNested ? "pl-5 pr-0 relative" : "px-2"
        )}
        role="navigation"
        aria-label={isNested ? "Sub navigation" : "Main navigation"}
        {...navProps}
      >
        {/* 嵌套项左侧的竖线：位于 chevron 中心左侧 4px 处 */}
        {isNested && (
          <div
            className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
            aria-hidden="true"
          />
        )}
        {links.map((item) => {
          // 处理分割线项
          if (isSeparatorItem(item)) {
            return (
              <div key={item.id} className="py-1 px-2" aria-hidden="true">
                <div className="h-px bg-foreground/5" />
              </div>
            )
          }

          const link = item
          const itemProps = getItemProps?.(link.id)
          const isFocused = focusedItemId === link.id

          // 可展开项和不可展开项共用的按钮元素
          const buttonElement = (
            <SidebarButton
              link={link}
              itemProps={itemProps}
            />
          )

          // 判断展开后渲染排序列表还是普通嵌套侧边栏
          const expandedContent = link.expandable && link.items && link.expanded
            ? renderExpandedContent(link, getItemProps, focusedItemId, isNested)
            : null

          // 如果配置了右键菜单，就给按钮单独包一层。
          // ContextMenuTrigger 的 asChild 会把 data-state="open" 设在按钮上，
          // 这样只有被点击的项会高亮，而不是整个区域。
          const content = (
            <div className="group/section">
              {link.contextMenu ? (
                <ContextMenu modal={true}>
                  <ContextMenuTrigger asChild>
                    {buttonElement}
                  </ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <ContextMenuProvider>
                      <SidebarMenu
                        type={link.contextMenu.type}
                        statusId={link.contextMenu.statusId}
                        labelId={link.contextMenu.labelId}
                        onConfigureStatuses={link.contextMenu.onConfigureStatuses}
                        onMarkAllRead={link.contextMenu.onMarkAllRead}
                        onConfigureLabels={link.contextMenu.onConfigureLabels}
                        onAddLabel={link.contextMenu.onAddLabel}
                        onDeleteLabel={link.contextMenu.onDeleteLabel}
                        onAddSource={link.contextMenu.onAddSource}
                        onAddSkill={link.contextMenu.onAddSkill}
                        onAddAutomation={link.contextMenu.onAddAutomation}
                        onAddProject={link.contextMenu.onAddProject}
                        sourceType={link.contextMenu.sourceType}
                        onConfigureViews={link.contextMenu.onConfigureViews}
                        viewId={link.contextMenu.viewId}
                        onDeleteView={link.contextMenu.onDeleteView}
                      />
                    </ContextMenuProvider>
                  </StyledContextMenuContent>
                </ContextMenu>
              ) : (
                buttonElement
              )}
              {/* 可展开子项放在右键菜单作用域之外，
                * 避免子项也带上 data-state="open" */}
              {link.expandable && link.items && (
                <AnimatePresence initial={false}>
                  {link.expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      animate={{ height: 'auto', opacity: 1, marginTop: 2, marginBottom: isNested ? 4 : 8 }}
                      exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      {expandedContent}
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          )

          // 嵌套项用 motion.div 包装，参与交错动画
          return isNested ? (
            <motion.div key={link.id} variants={itemVariants}>
              {content}
            </motion.div>
          ) : (
            <React.Fragment key={link.id}>
              {content}
            </React.Fragment>
          )
        })}
      </NavWrapper>
    </div>
  )
}

// ============================================================
// 展开内容渲染器：决定用排序列表还是普通嵌套侧边栏
// ============================================================

function renderExpandedContent(
  link: LinkItem,
  getItemProps: LeftSidebarProps['getItemProps'],
  focusedItemId: string | null | undefined,
  isNested: boolean | undefined
): React.ReactNode {
  // 平面排序（例如状态项）：用 SortableList 包装
  if (link.sortable && link.items) {
    // 以第一条分割线为界：前面是可排序项，后面是尾随固定项（不可排序）
    const separatorIndex = link.items.findIndex(isSeparatorItem)
    const sortableItems = separatorIndex >= 0 ? link.items.slice(0, separatorIndex) : link.items
    const trailingItems = separatorIndex >= 0
      ? link.items.slice(separatorIndex + 1).filter((item): item is LinkItem => !isSeparatorItem(item))
      : []

    return (
      <SortableStatusList
        items={sortableItems}
        onReorder={link.sortable.onReorder}
        getItemProps={getItemProps}
        focusedItemId={focusedItemId}
        trailingItems={trailingItems.length > 0 ? trailingItems : undefined}
      />
    )
  }

  // 默认：普通嵌套侧边栏（无拖拽）
  return (
    <LeftSidebar
      isCollapsed={false}
      isNested={true}
      getItemProps={getItemProps}
      focusedItemId={focusedItemId}
      links={link.items!}
    />
  )
}

// ============================================================
// SortableStatusList：状态项的平面拖拽排序包装器
// ============================================================

interface SortableStatusListProps {
  items: SidebarItem[]
  onReorder: (orderedIds: string[]) => void
  getItemProps: LeftSidebarProps['getItemProps']
  focusedItemId: string | null | undefined
  /** 排序列表之后渲染的不可排序项（如 Flagged、Archived） */
  trailingItems?: LinkItem[]
}

function SortableStatusList({ items, onReorder, getItemProps, focusedItemId, trailingItems }: SortableStatusListProps) {
  // 只保留 LinkItem（分割线不参与拖拽）
  const linkItems = items.filter((item): item is LinkItem => !isSeparatorItem(item))

  // 转换成 SortableItemData 需要的格式（必须带 `id` 字段）
  const sortableItems: (LinkItem & SortableItemData)[] = linkItems.map(item => ({
    ...item,
    id: item.id,
  }))

  const handleReorder = React.useCallback((newItems: (LinkItem & SortableItemData)[]) => {
    // 提取原始 ID（去掉 'nav:state:' 这类导航前缀）传给后端/IPC
    const orderedIds = newItems.map(item => {
      // 取最后一段作为真实状态/标签 ID
      const parts = item.id.split(':')
      return parts[parts.length - 1]
    })
    onReorder(orderedIds)
  }, [onReorder])

  return (
    <div className="flex flex-col select-none">
      <div className="pl-5 pr-0 relative">
        {/* 嵌套项左侧竖线 */}
        <div
          className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
          aria-hidden="true"
        />
        <SortableList
          items={sortableItems}
          onReorder={handleReorder}
          className="grid gap-0.5"
          renderItem={(item) => (
            <div className="group/section">
              {item.contextMenu ? (
                <ContextMenu modal={true}>
                  <ContextMenuTrigger asChild>
                    <SidebarButton
                      link={item}
                      itemProps={getItemProps?.(item.id)}
                    />
                  </ContextMenuTrigger>
                  <StyledContextMenuContent>
                    <ContextMenuProvider>
                      <SidebarMenu
                        type={item.contextMenu.type}
                        statusId={item.contextMenu.statusId}
                        labelId={item.contextMenu.labelId}
                        onConfigureStatuses={item.contextMenu.onConfigureStatuses}
                        onMarkAllRead={item.contextMenu.onMarkAllRead}
                        onConfigureLabels={item.contextMenu.onConfigureLabels}
                        onAddLabel={item.contextMenu.onAddLabel}
                        onDeleteLabel={item.contextMenu.onDeleteLabel}
                        onAddSource={item.contextMenu.onAddSource}
                        onAddSkill={item.contextMenu.onAddSkill}
                        onAddAutomation={item.contextMenu.onAddAutomation}
                        sourceType={item.contextMenu.sourceType}
                        onConfigureViews={item.contextMenu.onConfigureViews}
                        viewId={item.contextMenu.viewId}
                        onDeleteView={item.contextMenu.onDeleteView}
                      />
                    </ContextMenuProvider>
                  </StyledContextMenuContent>
                </ContextMenu>
              ) : (
                <SidebarButton
                  link={item}
                  itemProps={getItemProps?.(item.id)}
                />
              )}
            </div>
          )}
          renderOverlay={(item) => (
            <SidebarButton
              link={item}
              isOverlay={true}
            />
          )}
        />
        {/* 不可排序的尾随项（如 Flagged、Archived） */}
        {trailingItems && trailingItems.length > 0 && (
          <>
            <div className="my-1 ml-2" aria-hidden="true">
              <div className="h-px bg-foreground/5" />
            </div>
            <div className="grid gap-0.5">
              {trailingItems.map(item => (
                <div key={item.id} className="group/section">
                  <SidebarButton
                    link={item}
                    itemProps={getItemProps?.(item.id)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================
// SidebarButton：抽出来的按钮组件，便于在拖拽场景复用
// ============================================================

interface SidebarButtonProps {
  link: LinkItem
  itemProps?: {
    tabIndex: number
    'data-focused': boolean
    ref: (el: HTMLElement | null) => void
  }
  /** 是否在 DragOverlay 中渲染（悬浮克隆体） */
  isOverlay?: boolean
}

// 必须用 forwardRef，这样 Radix 的 ContextMenuTrigger（asChild）才能把 ref
// 和 data-state="open" 等属性直接挂到这个 button 上。
const SidebarButton = React.forwardRef<HTMLButtonElement, SidebarButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ link, itemProps, isOverlay, className: extraClassName, ...radixProps }, forwardedRef) => {
    return (
      <button
        {...(isOverlay ? {} : (() => {
          // 把 itemProps 里的 ref 单独拆出来，以便和 forwardedRef 合并
          const { ref: _itemRef, ...rest } = itemProps || { ref: undefined }
          return rest
        })())}
        // 展开 Radix 传入的属性（data-state、onContextMenu、onPointerDown 等）
        {...radixProps}
        ref={(el) => {
          // 合并 Radix 的 forwardedRef 和键盘导航用的 itemProps.ref
          if (typeof forwardedRef === 'function') forwardedRef(el)
          else if (forwardedRef) forwardedRef.current = el
          if (!isOverlay && itemProps?.ref) itemProps.ref(el)
        }}
        onClick={isOverlay ? undefined : link.onClick}
        data-tutorial={link.dataTutorial}
        className={cn(
          "group flex w-full items-center gap-2 rounded-[6px] text-[13px] select-none outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // 紧凑模式总高度低 4px（py-[3px] 对比 py-[5px]）
          link.compact ? "py-[3px]" : "py-[5px]",
          "px-2",
          link.variant === "default"
            ? "bg-foreground/[0.07]"
            // 悬停、右键菜单打开（data-state）或编辑弹窗激活（data-edit-active）时高亮
            : "hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover data-[edit-active=true]:bg-sidebar-hover",
          extraClassName,
        )}
      >
        {/* 图标容器：可展开项悬停时切换成 chevron */}
        <span className="relative h-3.5 w-3.5 shrink-0 flex items-center justify-center">
          {link.expandable && !isOverlay ? (
            <>
              {/* 主图标：悬停时隐藏 */}
              <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity duration-150">
                {renderIcon(link)}
              </span>
              {/* 切换 chevron：悬停时显示；data-no-dnd 阻止点击时触发拖拽 */}
              <span
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer"
                data-no-dnd="true"
                data-touch-reveal="true"
                onClick={(e) => {
                  e.stopPropagation()
                  link.onToggle?.()
                }}
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                    link.expanded && "rotate-90"
                  )}
                />
              </span>
            </>
          ) : (
            renderIcon(link)
          )}
        </span>
        {link.title}
        {/* 标题右侧附加元素（如标签类型图标），悬停/菜单打开时显示 */}
        {link.afterTitle && (
          <span data-touch-reveal="true" className="ml-auto opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity">
            {link.afterTitle}
          </span>
        )}
        {/* 右侧徽标：显示数量或状态，悬停/菜单打开时显示 */}
        {link.label && (
          <span data-touch-reveal="true" className={cn(link.afterTitle ? 'ml-0' : 'ml-auto', 'text-xs text-foreground/30 opacity-0 group-hover/section:opacity-100 group-data-[state=open]:opacity-100 group-data-[edit-active=true]:opacity-100 transition-opacity')}>
            {link.label}
          </span>
        )}
      </button>
    )
  }
)

/**
 * 渲染图标的辅助函数：支持传入组件（函数/forwardRef）或 React 元素。
 * 颜色统一通过内联样式设置（颜色字符串来自 EntityColor）。
 */
function renderIcon(link: LinkItem) {
  const isComponent = typeof link.icon === 'function' ||
    (typeof link.icon === 'object' && link.icon !== null && 'render' in link.icon)
  // 未指定 iconColor 时的默认颜色：前景色 60% 透明度
  const defaultColor = 'color-mix(in oklch, var(--foreground) 60%, transparent)'

  // Lucide 组件始终允许着色；ReactNode 图标则看 iconColorable。
  // 为兼容旧数据，默认视为可着色（大多数图标都接受 color 样式）。
  const applyColor = link.iconColorable !== false
  const colorStyle = applyColor ? { color: link.iconColor || defaultColor } : undefined

  if (isComponent) {
    const Icon = link.icon as React.ComponentType<{ className?: string; style?: React.CSSProperties }>
    return (
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={colorStyle}
      />
    )
  }
  // 已经是 React 元素或原始 ReactNode 的情况
  // 用 bare={true} 克隆，去掉 EntityIcon 外层容器；外层 span 负责尺寸
  // 只给声明了 acceptsBare 的组件传 bare，避免把未知属性转发到 DOM（如 Lucide 图标 → SVG）
  const iconElement = link.icon as React.ReactNode
  const bareIcon = React.isValidElement(iconElement)
    ? (typeof iconElement.type === 'function' && (iconElement.type as { acceptsBare?: boolean }).acceptsBare)
      ? React.cloneElement(iconElement as React.ReactElement<{ bare?: boolean }>, { bare: true })
      : iconElement
    : iconElement
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
      style={colorStyle}
    >
      {bareIcon}
    </span>
  )
}

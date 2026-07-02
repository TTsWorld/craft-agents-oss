/**
 * SettingsNavigator
 *
 * 设置左侧导航面板：列出所有设置分类（App、Workspace、Shortcuts、Preferences 等），
 * 点击后在右侧详情面板展示对应页面。
 * 视觉样式与 SessionList/SourcesListPanel 保持一致。
 */

import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, AppWindow } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { DropdownMenuProvider } from '@/components/ui/menu-context'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { SettingsSubpage } from '../../../shared/types'
import { SETTINGS_ITEMS } from '../../../shared/menu-schema'
import { SETTINGS_ICONS } from '@/components/icons/SettingsIcons'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'navigator',
}

interface SettingsNavigatorProps {
  /**
   * 当前选中的设置子页面。`null` 表示纯 `settings` 路由（没有高亮行），
   * 在紧凑模式下导航面板单独显示、用户尚未钻取到子页面时会出现。
   */
  selectedSubpage: SettingsSubpage | null
  /** 选中子页面时的回调 */
  onSelectSubpage: (subpage: SettingsSubpage) => void
}

interface SettingsItem {
  id: SettingsSubpage
  label: string
  icon: React.ComponentType<{ className?: string }>
  description: string
}

interface SettingsItemRowProps {
  item: SettingsItem
  isSelected: boolean
  isFirst: boolean
  onSelect: () => void
}

/**
 * 单个设置项行：带下拉菜单。
 * 记录菜单打开状态，使菜单打开时“...”按钮保持可见。
 */
function SettingsItemRow({ item, isSelected, isFirst, onSelect }: SettingsItemRowProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const Icon = item.icon

  // 通过自定义协议 deep link 在新窗口打开设置页
  const handleOpenInNewWindow = () => {
    window.electronAPI.openUrl(`craftagents://settings/${item.id}?window=focused`)
  }

  return (
    <div className="settings-item" data-selected={isSelected || undefined}>
      {/* 分隔线：第一项不显示 */}
      {!isFirst && (
        <div className="settings-separator pl-12 pr-4">
          <Separator />
        </div>
      )}
      {/* 按钮外层：控制边距 */}
      <div className="settings-content relative group select-none pl-2 mr-2">
        {/* 图标：绝对定位，保证多行对齐 */}
        <div className="absolute left-[20px] top-[14px] z-10">
          <Icon
            className={cn(
              'w-4 h-4 shrink-0',
              isSelected ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
        </div>
        {/* 主按钮 */}
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            'flex w-full items-start gap-2 pl-2 pr-4 py-3 text-left text-sm outline-none rounded-[8px]',
            // 悬停过渡比默认 150ms 更快（75ms）
            'transition-[background-color] duration-75',
            isSelected
              ? 'bg-foreground/5 hover:bg-foreground/7'
              : 'hover:bg-foreground/2'
          )}
        >
          {/* 占位：给图标留空 */}
          <div className="w-6 h-5 shrink-0" />
          {/* 文字列 */}
          <div className="flex flex-col min-w-0 flex-1">
            <span
              className={cn(
                'font-medium',
                isSelected ? 'text-foreground' : 'text-foreground/80'
              )}
            >
              {item.label}
            </span>
            <span className="text-xs text-foreground/60 line-clamp-1">
              {item.description}
            </span>
          </div>
        </button>
        {/* 操作按钮：悬停或菜单打开时显示 */}
        <div
          data-touch-reveal="true"
          className={cn(
            'absolute right-2 top-2 transition-opacity z-10',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <div className="flex items-center rounded-[8px] overflow-hidden border border-transparent hover:border-border/50">
            <DropdownMenu modal={true} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <div className="p-1.5 hover:bg-foreground/10 data-[state=open]:bg-foreground/10 cursor-pointer">
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </div>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                <DropdownMenuProvider>
                  <StyledDropdownMenuItem onClick={handleOpenInNewWindow}>
                    <AppWindow className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
                  </StyledDropdownMenuItem>
                </DropdownMenuProvider>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettingsNavigator({
  selectedSubpage,
  onSelectSubpage,
}: SettingsNavigatorProps) {
  const { t } = useTranslation()

  // 把静态配置与图标、翻译组合成渲染用的列表数据
  const settingsItems: SettingsItem[] = useMemo(() =>
    SETTINGS_ITEMS.map((item) => ({
      id: item.id,
      label: t(item.labelKey),
      icon: SETTINGS_ICONS[item.id],
      description: t(item.descriptionKey),
    })),
    [t]
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="pt-2">
          {settingsItems.map((item, index) => (
            <SettingsItemRow
              key={item.id}
              item={item}
              isSelected={selectedSubpage === item.id}
              isFirst={index === 0}
              onSelect={() => onSelectSubpage(item.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

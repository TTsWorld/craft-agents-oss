/**
 * AppMenuMobilePreview — React 组件
 * AppMenuMobilePreview：在手机框架内预览生产环境 AppMenu 的 playground 组件。
 * 
 * 所属目录：mobile-webui
 * 本目录用于在桌面 Electron renderer 中模拟移动端的 WebUI 渲染。
 */
import * as React from 'react'
import { AppMenu } from '@/components/AppMenu'
// 从同目录导入手机框架组件和类型；type MobileDevice 是类型导入。
import { MobileWebUIFrame, type MobileDevice } from './MobileWebUIFrame'
import { MobilePlaygroundProviders } from './MobilePlaygroundProviders'

// 返回一个闭包函数，用于 playground 里占位的事件回调，避免每次都写匿名函数。
const log = (label: string) => () => console.log(`[Mobile AppMenu] ${label}`)

interface AppMenuMobilePreviewProps {
  /** Device frame size. */
  device?: MobileDevice
  /** Show the iPhone-style bezel + status-bar strip. */
  showBezel?: boolean
}

/**
 * Renders the production AppMenu inside a phone-shaped frame. The Craft logo
 * acts as the dropdown/sheet trigger — same component TopBar uses, with
 * compact-mode behavior enabled via the AppShell context override.
 * 把手机框架、全局状态 Provider、AppMenu 组合在一起，演示紧凑模式下的菜单交互。
 */
export function AppMenuMobilePreview({
  device = 'iphone-15',
  showBezel = true,
}: AppMenuMobilePreviewProps) {
  return (
    <MobilePlaygroundProviders>
      <MobileWebUIFrame device={device} showBezel={showBezel}>
        <div className="flex flex-col h-full">
          {/* Faux TopBar so the Craft logo trigger sits in a recognisable strip */}
          {/* 模拟顶部导航栏，让 Craft logo 触发器位于熟悉的位置。 */}
          <div className="h-11 shrink-0 px-2 flex items-center border-b border-border bg-background">
            <AppMenu
              onNewChat={log('onNewChat')}
              onNewWindow={log('onNewWindow')}
              onOpenSettings={log('onOpenSettings')}
              onOpenSettingsSubpage={(id) => console.log('[Mobile AppMenu] onOpenSettingsSubpage', id)}
              onOpenKeyboardShortcuts={log('onOpenKeyboardShortcuts')}
              onOpenStoredUserPreferences={log('onOpenStoredUserPreferences')}
              onToggleSidebar={log('onToggleSidebar')}
              onToggleFocusMode={log('onToggleFocusMode')}
            />
          </div>
          <div className="flex-1 flex items-start justify-center pt-12">
            <p className="text-xs text-muted-foreground/70 px-6 text-center">
              Tap the Craft logo (top-left) to open the menu.<br />
              Settings &amp; Help open as full-screen sub-pages in compact mode.
            </p>
          </div>
        </div>
      </MobileWebUIFrame>
    </MobilePlaygroundProviders>
  )
}

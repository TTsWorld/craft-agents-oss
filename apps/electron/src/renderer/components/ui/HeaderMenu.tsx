/**
 * HeaderMenu — 面板头部“…”下拉菜单。
 *
 * 内置“在新窗口打开”和可选的“了解更多”文档链接。
 * 页面相关的菜单项通过 children 传入，会渲染在分隔线上方。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, AppWindow, ExternalLink } from 'lucide-react'
import { HeaderIconButton } from './HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from './dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from './styled-dropdown'
import { type DocFeature, getDocUrl } from '@craft-agent/shared/docs/doc-links'

interface HeaderMenuProps {
  /** 路由字符串，用于“在新窗口打开” */
  route: string
  /** 页面专属菜单项（渲染在“在新窗口打开”上方） */
  children?: React.ReactNode
  /** 文档功能 key，传了会额外渲染“了解更多”入口 */
  helpFeature?: DocFeature
}

/** 面板头部菜单 */
export function HeaderMenu({ route, children, helpFeature }: HeaderMenuProps) {
  const { t } = useTranslation()
  const handleOpenInNewWindow = async () => {
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[HeaderMenu] openUrl failed:', error)
    }
  }

  const handleLearnMore = helpFeature ? () => {
    window.electronAPI?.openUrl(getDocUrl(helpFeature))
  } : undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <HeaderIconButton icon={<MoreHorizontal className="h-4 w-4" />} />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end">
        {children}
        {children && <StyledDropdownMenuSeparator />}
        <StyledDropdownMenuItem onClick={handleOpenInNewWindow}>
          <AppWindow className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.openInNewWindow")}</span>
        </StyledDropdownMenuItem>
        {helpFeature && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleLearnMore}>
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="flex-1">{t("common.learnMore")}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

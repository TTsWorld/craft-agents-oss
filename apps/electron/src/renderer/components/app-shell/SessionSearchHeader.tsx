/**
 * SessionSearchHeader - 会话列表搜索 UI 的纯展示组件。
 *
 * 渲染内容：
 * - 带静态搜索图标的搜索输入框
 * - 当搜索词激活时显示“加载中…”或“{count} 个结果”的状态行
 *
 * 主应用（SessionList）和 playground 都会复用该组件。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'

export interface SessionSearchHeaderProps {
  /** 当前搜索词 */
  searchQuery: string
  /** 搜索词变化时的回调 */
  onSearchChange?: (query: string) => void
  /** 点击关闭（X）按钮时的回调 */
  onSearchClose?: () => void
  /** 搜索输入框按键事件 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  /** 输入框获得焦点时的回调 */
  onFocus?: () => void
  /** 输入框失去焦点时的回调 */
  onBlur?: () => void
  /** 是否正在搜索内容 */
  isSearching?: boolean
  /** 搜索服务是否不可用（例如未找到 ripgrep） */
  isUnavailable?: boolean
  /** 结果数量（未搜索时显示） */
  resultCount?: number
  /** 结果数是否超过显示上限；为 true 时显示 "100+" 而不是精确数字 */
  exceededLimit?: boolean
  /** 输入框 ref，用于焦点管理 */
  inputRef?: React.RefObject<HTMLInputElement>
  /** 输入框占位文案 */
  placeholder?: string
  /** 输入框是否只读（playground 演示用） */
  readOnly?: boolean
}

/** SessionSearchHeader - 会话列表搜索头部 */
export function SessionSearchHeader({
  searchQuery,
  onSearchChange,
  onSearchClose,
  onKeyDown,
  onFocus,
  onBlur,
  isSearching = false,
  isUnavailable = false,
  resultCount,
  exceededLimit = false,
  inputRef,
  placeholder = 'Search titles and content...',
  readOnly = false,
}: SessionSearchHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 px-2 pt-2 pb-1.5 border-b border-border/50">
      {/* 搜索输入框 */}
      <div className="relative rounded-[8px] shadow-minimal bg-muted/50 has-[:focus-visible]:bg-background">
        {/* 搜索图标保持静态，不会变成 spinner */}
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          readOnly={readOnly}
          placeholder={placeholder}
          className="w-full h-8 pl-8 pr-8 text-sm bg-transparent border-0 rounded-[8px] outline-none focus-visible:ring-0 focus-visible:outline-none placeholder:text-muted-foreground/50"
        />
        {onSearchClose && (
          <button
            onClick={onSearchClose}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-foreground/10 rounded"
            title={t("session.closeSearch")}
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* 搜索状态行：搜索词不少于 2 个字符时显示 */}
      {searchQuery.length >= 2 && (
        <div className="px-2 pt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {isSearching ? (
            <>
              <Spinner className="text-[9px] text-foreground/50" />
              <span>{t('common.loading')}</span>
            </>
          ) : isUnavailable ? (
            <span className="text-destructive/70">{t('session.searchUnavailable')}</span>
          ) : (
            <span>{t('session.results', { count: exceededLimit ? '100+' : (resultCount ?? 0) })}</span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Header - 应用顶部导航栏，包含品牌 Logo 和主题/清除控制按钮。
 */

import { Sun, Moon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * CraftAgentLogo - Craft Agent 的 "C" 形 Logo 组件。
 *
 * @param className - 可选的 Tailwind 样式类名，用于控制尺寸和颜色。
 */
function CraftAgentLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(3.4502, 3)" fill="currentColor">
        <path
          d="M3.17890888,3.6 L3.17890888,0 L16,0 L16,3.6 L3.17890888,3.6 Z M9.642,7.2 L9.64218223,10.8 L0,10.8 L0,3.6 L16,3.6 L16,7.2 L9.642,7.2 Z M3.17890888,18 L3.178,14.4 L0,14.4 L0,10.8 L16,10.8 L16,18 L3.17890888,18 Z"
          fillRule="nonzero"
        />
      </g>
    </svg>
  )
}

/**
 * HeaderProps - Header 组件的属性接口。
 *
 * TypeScript 接口类似 Go 里的 struct 定义，用来约束组件接收哪些字段。
 */
interface HeaderProps {
  hasSession: boolean
  sessionTitle?: string
  isDark: boolean
  onToggleTheme: () => void
  onClear: () => void
}

export function Header({ hasSession, sessionTitle, isDark, onToggleTheme, onClear }: HeaderProps) {
  const { t } = useTranslation()
  return (
    <header className="shrink-0 grid grid-cols-[auto_1fr_auto] items-center px-4 py-3">
      {/* Logo 链接，点击后跳转到 Craft Agent 主站 */}
      <a
        href="https://agents.craft.do"
        className="hover:opacity-80 transition-opacity"
        title="Craft Agent"
      >
        <CraftAgentLogo className="w-6 h-6 text-[#9570BE]" />
      </a>

      {/* 会话标题，居中显示 */}
      <div className="flex justify-center">
        {sessionTitle && (
          <span className="text-sm font-semibold text-foreground truncate max-w-md">
            {sessionTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 已加载会话时显示清除按钮 */}
        {hasSession && (
          <button
            onClick={onClear}
            className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
            title={t('viewer.clearSession')}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* 主题切换按钮：深色/浅色 */}
        <button
          onClick={onToggleTheme}
          className="p-1.5 rounded-md bg-background shadow-minimal text-foreground/40 hover:text-foreground/70 transition-colors"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  )
}

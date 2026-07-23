import { useState, useCallback, useRef, useEffect, forwardRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, X, Globe } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '../../lib/utils'
import { useTranslation } from 'react-i18next'
import { Spinner } from './LoadingIndicator'

/* ------------------------------------------------------------------ */
/*  NavButton – 与 TopBarButton 样式一致的小型内部按钮               */
/* ------------------------------------------------------------------ */

interface NavButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

const NavButton = forwardRef<HTMLButtonElement, NavButtonProps>(
  ({ children, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'h-7 w-7 flex items-center justify-center rounded-[6px]',
        'hover:bg-foreground/5 focus:outline-none focus-visible:ring-0',
        'disabled:opacity-30 disabled:pointer-events-none',
        'transition-colors duration-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
NavButton.displayName = 'NavButton'

/* ------------------------------------------------------------------ */
/*  BrowserControls                                                    */
/* ------------------------------------------------------------------ */

export interface BrowserControlsProps {
  /** 地址栏中显示的当前 URL */
  url?: string
  /** 页面是否正在加载（切换停止/刷新按钮，并显示进度） */
  loading?: boolean
  /** 是否启用后退按钮 */
  canGoBack?: boolean
  /** 是否启用前进按钮 */
  canGoForward?: boolean
  /** 用户提交 URL 时调用 */
  onNavigate?: (url: string) => void
  /** 后退按钮点击 */
  onGoBack?: () => void
  /** 前进按钮点击 */
  onGoForward?: () => void
  /** 刷新按钮点击 */
  onReload?: () => void
  /** 停止按钮点击 */
  onStop?: () => void
  /** 受控的 URL 输入变化 */
  onUrlChange?: (url: string) => void
  /** 紧凑布局变体 */
  compact?: boolean
  /** 渲染在导航按钮之前的内容 */
  leadingContent?: ReactNode
  /** 渲染在地址栏之后的内容（如标签） */
  trailingContent?: ReactNode
  /** 是否显示动画加载进度条（默认 true） */
  showProgressBar?: boolean
  /** 地址栏组合（刷新 + 表单）上的附加 CSS 类 */
  urlBarClassName?: string
  /**
   * 最小左侧留白（px）。设置后启用窗口居中模式：
   * 后退/前进按钮改为绝对定位，刷新按钮 + 地址栏通过 CSS max()
   * 在组件完整宽度内居中；当组件较窄时回退到此留白值。
   */
  leftClearance?: number
  /**
   * 网站主题色（来自 `<meta name="theme-color">`）。
   * 设置后会像 Safari/Chrome 那样为工具栏背景着色。
   * 文本和图标会自动调整以保证对比度。
   */
  themeColor?: string | null
  /** 根元素上的附加 CSS 类 */
  className?: string
}

/**
 * 校验颜色字符串可安全用于 CSS 插值。
 * 仅允许 hex、rgb/rgba、hsl/hsla、oklch、oklab、lch、lab、color() —— 拒绝任何
 * 可能破坏 CSS 取值上下文的内容。
 */
const SAFE_CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^;{}]*\))$/i
function safeCssColor(color: string | null | undefined): string | null {
  if (!color) return null
  const trimmed = color.trim()
  if (!trimmed || !SAFE_CSS_COLOR_RE.test(trimmed)) return null
  return trimmed
}

/**
 * 将 CSS 颜色解析为 sRGB 相对亮度（0–1）。
 * 支持 hex（#rgb、#rrggbb）和 rgb/rgba（逗号或空格分隔）。
 * 对无法解析的格式（oklch、lch 等）返回 null。
 */
function colorLuminance(color: string): number | null {
  let r: number, g: number, b: number
  // hex
  const hm = /^#([0-9a-f]{3,8})$/i.exec(color)
  if (hm) {
    const h = hm[1]
    if (!h) return null

    if (h.length === 3) {
      r = Number.parseInt(h.charAt(0).repeat(2), 16)
      g = Number.parseInt(h.charAt(1).repeat(2), 16)
      b = Number.parseInt(h.charAt(2).repeat(2), 16)
    } else if (h.length >= 6) {
      r = Number.parseInt(h.slice(0, 2), 16)
      g = Number.parseInt(h.slice(2, 4), 16)
      b = Number.parseInt(h.slice(4, 6), 16)
    } else {
      return null
    }
  } else {
    // rgb/rgba —— 逗号或空格分隔
    const rm = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/)
    if (!rm) return null

    const rStr = rm[1]
    const gStr = rm[2]
    const bStr = rm[3]
    if (!rStr || !gStr || !bStr) return null

    r = Number(rStr)
    g = Number(gStr)
    b = Number(bStr)
  }
  const toLinear = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** 默认地址栏最大宽度（600px）的一半，用于 CSS max() 居中计算 */
const HALF_MAX_WIDTH = 300

export function BrowserControls({
  url: controlledUrl,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  onUrlChange,
  compact = false,
  leadingContent,
  trailingContent,
  showProgressBar = true,
  urlBarClassName,
  leftClearance,
  themeColor,
  className,
}: BrowserControlsProps) {
  const { t } = useTranslation()
  const [localUrl, setLocalUrl] = useState(controlledUrl ?? '')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 未聚焦时与受控 url 同步
  useEffect(() => {
    if (!isFocused && controlledUrl != null) {
      setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
    }
  }, [controlledUrl, isFocused])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = localUrl.trim()
      if (trimmed) {
        onNavigate?.(trimmed)
        inputRef.current?.blur()
      }
    },
    [localUrl, onNavigate],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setLocalUrl(value)
      onUrlChange?.(value)
    },
    [onUrlChange],
  )

  const handleFocus = useCallback(() => {
    setIsFocused(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [])

  const handleBlur = useCallback(() => {
    setIsFocused(false)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (controlledUrl != null) {
          setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
        }
        inputRef.current?.blur()
      }
    },
    [controlledUrl],
  )

  const safeThemeColor = safeCssColor(themeColor)
  const themeLum = safeThemeColor ? colorLuminance(safeThemeColor) : null
  const isDarkBg = themeLum != null && themeLum < 0.4
  const useWindowCenter = leftClearance != null

  /* 共用：刷新 / 停止按钮 */
  const reloadButton = (
    <NavButton
      aria-label={loading ? t('browser.stopLoading') : t('common.reload')}
      onClick={loading ? onStop : onReload}
    >
      {loading ? (
        <X className="h-[16px] w-[16px] text-foreground/70" style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined} strokeWidth={1.8} />
      ) : (
        <RotateCw className="h-[15px] w-[15px] text-foreground/70" style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined} strokeWidth={1.8} />
      )}
    </NavButton>
  )

  /* 共用：URL 输入表单 */
  const urlForm = (
    <form className="flex-1 min-w-0" onSubmit={handleSubmit}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={localUrl}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={t('browser.urlPlaceholder')}
          className={cn(
            'w-full rounded-[8px] bg-transparent px-3 pl-8 text-[13px] text-foreground/70 outline-none transition-all',
            compact ? 'h-[28px]' : 'h-[30px]',
            !safeThemeColor && (isFocused
              ? 'bg-background border border-transparent shadow-minimal'
              : 'border border-foreground/5'),
            safeThemeColor && 'border border-transparent',
          )}
          style={safeThemeColor ? {
            color: isFocused ? (isDarkBg ? '#fff' : '#000') : 'var(--tb-fg)',
            borderColor: 'var(--tb-input-border)',
            ...(isFocused ? { boxShadow: '0 0 0 1.5px var(--tb-focus-ring)' } : {}),
          } : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        <span className="absolute inset-y-0 left-3 flex items-center justify-center">
          {loading ? (
            <span className="flex items-center justify-center h-3.5 w-3.5" style={safeThemeColor ? { color: isFocused ? 'var(--tb-fg)' : 'var(--tb-fg-muted)' } : undefined}>
              <Spinner className="text-[11px] text-foreground/40" />
            </span>
          ) : (
            <Globe className="h-3.5 w-3.5 text-foreground/30" style={safeThemeColor ? { color: isFocused ? 'var(--tb-fg)' : 'var(--tb-fg-muted)' } : undefined} />
          )}
        </span>
      </div>
    </form>
  )

  /* 共用：进度条 */
  const progressBar = showProgressBar && (
    <AnimatePresence>
      {loading && (
        <motion.div
          className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent"
          style={{ backgroundSize: '220% 100%' }}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 0.9,
            backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
          }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: 0.2, ease: 'easeOut' },
            backgroundPosition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      )}
    </AnimatePresence>
  )

  /* ---- 布局 ---- */
  return (
    <div
      className={cn(
        'relative flex items-center gap-1',
        compact ? 'h-[40px] px-2' : 'h-[48px] border-b border-foreground/6 px-3',
        className,
      )}
      data-themed={safeThemeColor ? '' : undefined}
      style={{
        ...(safeThemeColor ? {
          backgroundColor: safeThemeColor,
          borderColor: isDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          '--tb-fg': isDarkBg ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)',
          '--tb-fg-muted': isDarkBg ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
          '--tb-hover': isDarkBg ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          '--tb-input-border': isDarkBg ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
          '--tb-focus-ring': isDarkBg ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)',
        } : {}),
        transition: 'background-color 200ms ease, border-color 200ms ease',
      } as React.CSSProperties}
    >
      {/* 主题化工具栏的作用域悬停样式 —— 按钮使用 --tb-hover */}
      {safeThemeColor && (
        <style dangerouslySetInnerHTML={{ __html: `
          [data-themed] button:hover:not(:disabled) { background: var(--tb-hover) !important; }
        `}} />
      )}
      {leadingContent}

      <NavButton aria-label={t('common.back')} disabled={!canGoBack} onClick={onGoBack} style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined}>
        <ChevronLeft className="h-[18px] w-[18px] text-foreground/70" style={safeThemeColor ? { color: 'inherit' } : undefined} strokeWidth={1.5} />
      </NavButton>
      <NavButton aria-label={t('common.forward')} disabled={!canGoForward} onClick={onGoForward} style={safeThemeColor ? { color: 'var(--tb-fg)' } : undefined}>
        <ChevronRight className="h-[18px] w-[18px] text-foreground/70" style={safeThemeColor ? { color: 'inherit' } : undefined} strokeWidth={1.5} />
      </NavButton>

      <div className="flex-1 flex items-center min-w-0">
        <div className={cn('mx-auto flex items-center gap-1 w-full', urlBarClassName)}>
          {reloadButton}
          {urlForm}
        </div>
      </div>

      {trailingContent}
      {progressBar}
    </div>
  )
}

import * as React from 'react'
import { useState, useCallback } from 'react'
import { Key, User, Lock, Eye, EyeOff, CheckCircle2, XCircle, type LucideIcon } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Message, CredentialResponse } from '../../../shared/types'
import type { AuthRequestType, AuthStatus } from '@craft-agent/core/types'
import { validateBasicAuthCredentials, getPasswordValue, getPasswordLabel, getPasswordPlaceholder } from '@/utils/auth-validation'

// ============================================================================
// 基础类型与样式
// ============================================================================

/** 认证卡片的四种视觉状态 */
type AuthCardVariant = 'default' | 'success' | 'error' | 'muted'

/**
 * 各状态的背景色、文字色与阴影色。
 * 背景色使用 oklch 透明色（success/error），或 CSS 变量；文字与阴影通过 CSS 类切换。
 */
const VARIANT_STYLES: Record<AuthCardVariant, { bg: string; textClass: string; shadowColor?: string }> = {
  default: { bg: 'var(--background)', textClass: 'text-foreground shadow-minimal' },
  success: { bg: 'oklch(from var(--success) l c h / 0.03)', textClass: 'text-[var(--success-text)] shadow-tinted', shadowColor: 'var(--success-rgb)' },
  error: { bg: 'oklch(from var(--destructive) l c h / 0.03)', textClass: 'text-[var(--destructive-text)] shadow-tinted', shadowColor: 'var(--destructive-rgb)' },
  muted: { bg: 'var(--foreground-3)', textClass: 'text-foreground/70 shadow-minimal' },
}

/** 卡片头部区域的 props：图标、标题、副标题、描述等 */
interface AuthCardHeaderProps {
  icon?: LucideIcon
  iconClassName?: string
  title: string
  titleSuffix?: string
  subtitle?: string
  subtitleSecondary?: string
  description?: string
}

/**
 * AuthCardHeader - 认证卡片的头部信息展示
 *
 * 左侧可选图标，右侧为标题、副标题、描述；整体继承父级文字颜色。
 */
function AuthCardHeader({
  icon: Icon,
  iconClassName,
  title,
  titleSuffix,
  subtitle,
  subtitleSecondary,
  description,
}: AuthCardHeaderProps) {
  return (
    <div className="flex gap-3">
      {/* 图标与第一行文字对齐，可选传 */}
      {Icon && <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', iconClassName)} />}
      <div className="flex-1 min-w-0">
        {/* 标题继承外层文字颜色 */}
        <div className="text-sm font-medium leading-5">
          {title}
          {titleSuffix && (
            <span className="text-xs text-muted-foreground ml-2">({titleSuffix})</span>
          )}
        </div>
        {/* 副标题使用继承颜色的 50% 透明度 */}
        {subtitle && (
          <div className="text-xs mt-0.5 opacity-50">
            {subtitle}
          </div>
        )}
        {subtitleSecondary && (
          <div className="text-xs mt-0.5 opacity-50">
            {subtitleSecondary}
          </div>
        )}
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
    </div>
  )
}

/** 卡片底部操作栏的 props：主按钮、次按钮、提示文字 */
interface AuthCardActionsProps {
  primary: {
    label: string
    icon?: LucideIcon
    onClick: () => void
    disabled?: boolean
    loading?: boolean
    dataTutorial?: string
  }
  secondary?: {
    label: string
    icon?: LucideIcon
    onClick: () => void
    disabled?: boolean
  }
  hint?: string
}

/**
 * AuthCardActions - 认证卡片底部按钮栏
 *
 * 渲染主按钮（支持 loading）、可选的次要按钮，以及最右侧的提示文案。
 */
function AuthCardActions({ primary, secondary, hint }: AuthCardActionsProps) {
  const PrimaryIcon = primary.icon
  const SecondaryIcon = secondary?.icon

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
      <Button
        size="sm"
        variant="default"
        className="h-7 gap-1.5"
        onClick={primary.onClick}
        disabled={primary.disabled}
        data-tutorial={primary.dataTutorial}
      >
        {primary.loading ? (
          <Spinner className="text-[10px]" />
        ) : PrimaryIcon ? (
          <PrimaryIcon className="h-3.5 w-3.5" />
        ) : null}
        {primary.label}
      </Button>
      {secondary && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={secondary.onClick}
          disabled={secondary.disabled}
        >
          {SecondaryIcon && <SecondaryIcon className="h-3.5 w-3.5" />}
          {secondary.label}
        </Button>
      )}
      {hint && (
        <>
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        </>
      )}
    </div>
  )
}

// ============================================================================
// 主组件
// ============================================================================

interface AuthRequestCardProps {
  message: Message
  /** 提交凭据响应的回调；由外层 chat 组件传入 */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  /** 当前 auth request 所属 session 的 id */
  sessionId: string
  /**
   * 该卡片是否可交互。
   * 通常只有最后一条消息且用户尚未回复时才为 true。默认 true。
   */
  isInteractive?: boolean
}

/**
 * AuthRequestCard - 聊天历史中的内联认证卡片
 *
 * 根据 authRequestType 渲染不同 UI：
 * - credential: API Key、Basic Auth、多 Header 等凭据输入表单
 * - oauth / oauth-google / oauth-slack / oauth-microsoft: 跳转浏览器完成 OAuth
 *
 * 根据 authStatus 展示不同状态：
 * - pending: 可交互表单/按钮
 * - completed: 成功状态
 * - cancelled: 已取消
 * - failed: 失败并显示错误信息
 */
export function AuthRequestCard({ message, onRespondToCredential, sessionId, isInteractive = true }: AuthRequestCardProps) {
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    authRequestId,
    authRequestType,
    authSourceSlug,
    authSourceName,
    authStatus,
    authCredentialMode,
    authHeaderName,
    authHeaderNames,
    authLabels,
    authDescription,
    authHint,
    authSourceUrl,
    authPasswordRequired,
    authError,
    authEmail,
    authWorkspace,
  } = message

  // 多 Header 模式：形如 { "DD-API-KEY": "", "DD-APPLICATION-KEY": "" }
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (authHeaderNames) {
      for (const name of authHeaderNames) {
        initial[name] = ''
      }
    }
    return initial
  })

  const isBasicAuth = authCredentialMode === 'basic'
  const isMultiHeader = authCredentialMode === 'multi-header'
  const passwordRequired = authPasswordRequired ?? true  // 默认 true，保持向后兼容

  // 校验逻辑：Basic Auth 校验用户名密码；多 Header 要求每个 header 非空；单字段要求 value 非空
  const isValid = isBasicAuth
    ? validateBasicAuthCredentials(username, password, passwordRequired)
    : isMultiHeader
    ? authHeaderNames?.every(name => headerValues[name]?.trim().length > 0) ?? false
    : value.trim().length > 0

  /** 提交凭据：根据模式组装 CredentialResponse，并通过回调发送给 main/session 层 */
  const handleSubmit = useCallback(() => {
    if (!isValid || !authRequestId || !onRespondToCredential) return

    setIsSubmitting(true)

    if (isBasicAuth) {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        username: username.trim(),
        password: getPasswordValue(password, passwordRequired),
        cancelled: false
      })
    } else if (isMultiHeader) {
      // 对所有 header 值做 trim
      const trimmedHeaders: Record<string, string> = {}
      for (const [key, val] of Object.entries(headerValues)) {
        trimmedHeaders[key] = val.trim()
      }
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        headers: trimmedHeaders,
        cancelled: false
      })
    } else {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        value: value.trim(),
        cancelled: false
      })
    }
  }, [isBasicAuth, isMultiHeader, username, password, value, headerValues, isValid, onRespondToCredential, sessionId, authRequestId, passwordRequired])

  /** 取消当前认证请求 */
  const handleCancel = useCallback(() => {
    if (!authRequestId || !onRespondToCredential) return
    onRespondToCredential(sessionId, authRequestId, { type: 'credential', cancelled: true })
  }, [onRespondToCredential, sessionId, authRequestId])

  /** 拦截 form 提交，避免页面刷新 */
  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit()
  }, [handleSubmit])

  /** 键盘快捷键：Enter 提交、Escape 取消 */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleSubmit()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [isValid, handleSubmit, handleCancel])

  /**
   * 处理 OAuth 登录按钮点击。
   * 这是“客户端驱动”的 OAuth：本地启动回调服务监听，token 仍由服务端持有，renderer 只负责拉起浏览器。
   */
  const handleOAuthClick = useCallback(async () => {
    if (!authRequestId || !authSourceSlug) {
      console.warn('[AuthRequestCard] handleOAuthClick bailed: missing', {
        authRequestId: authRequestId ?? 'MISSING',
        authSourceSlug: authSourceSlug ?? 'MISSING',
        sessionId,
      })
      return
    }
    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.performOAuth({
        sourceSlug: authSourceSlug,
        sessionId,
        authRequestId,
      })
      if (!result.success) {
        console.warn('[AuthRequestCard] performOAuth returned failure:', result.error)
      }
    } catch (error) {
      console.error('[AuthRequestCard] performOAuth threw:', error)
    } finally {
      setIsSubmitting(false)
    }
  }, [sessionId, authRequestId, authSourceSlug])

  // 获取表单字段标签：优先使用服务端下发的 authLabels，否则使用默认文案
  const credentialLabel = authLabels?.credential ||
    (authCredentialMode === 'bearer' ? 'Bearer Token' : 'API Key')
  const usernameLabel = authLabels?.username || 'Username'
  const basePasswordLabel = authLabels?.password || 'Password'
  const passwordLabel = getPasswordLabel(basePasswordLabel, passwordRequired)
  const passwordPlaceholder = getPasswordPlaceholder(basePasswordLabel, passwordRequired)

  // 将 authRequestType 映射为用户可读的认证方式名称
  const getAuthTypeLabel = (type: AuthRequestType | undefined) => {
    switch (type) {
      case 'oauth':
        return 'OAuth'
      case 'oauth-google':
        return 'Google Sign-In'
      case 'oauth-slack':
        return 'Slack Sign-In'
      case 'oauth-microsoft':
        return 'Microsoft Sign-In'
      case 'credential':
      default:
        return 'Authentication'
    }
  }

  const authTypeLabel = getAuthTypeLabel(authRequestType)

  // 根据状态决定卡片的视觉变体
  const variant: AuthCardVariant =
    authStatus === 'completed' ? 'success' :
    authStatus === 'cancelled' ? 'muted' :
    authStatus === 'failed' ? 'error' :
    'default'

  // 是否需要显示底部操作栏：pending 状态下，凭据表单或尚未开始的 OAuth 都需要按钮
  const isOAuth = authRequestType && authRequestType !== 'credential'
  const hasActions = authStatus === 'pending' && (
    !isOAuth || !isSubmitting
  )

  const { bg: variantBg, textClass: variantTextClass, shadowColor } = VARIANT_STYLES[variant]

  // 非交互态且非 pending 时：使用紧凑只读视图展示结果（如已完成/失败）
  if (!isInteractive && authStatus !== 'pending') {
    const StatusIcon = authStatus === 'completed' ? CheckCircle2 : XCircle
    const title =
      authStatus === 'completed' ? `${authSourceName} Connected` :
      authStatus === 'cancelled' ? `${authSourceName} Cancelled` :
      `${authSourceName} Failed`
    const subtitle =
      authStatus === 'completed' && authEmail ? `Signed in as ${authEmail}` :
      authStatus === 'failed' && authError ? authError :
      undefined

    return (
      <div
        className={cn('rounded-[8px] overflow-hidden w-fit select-none', variantTextClass)}
        style={{
          backgroundColor: variantBg,
          ...(shadowColor ? { '--shadow-color': shadowColor } as React.CSSProperties : {})
        }}
      >
        <div className="pl-4 pr-5 py-3">
          <AuthCardHeader
            icon={StatusIcon}
            title={title}
            subtitle={subtitle}
          />
        </div>
      </div>
    )
  }

  // 根据状态渲染卡片主体内容
  const renderContent = () => {
    // 已完成
    if (authStatus === 'completed') {
      return (
        <AuthCardHeader
          icon={CheckCircle2}
          title={`${authSourceName} Connected`}
          subtitle={authEmail ? `Signed in as ${authEmail}` : undefined}
          subtitleSecondary={authWorkspace ? `Workspace: ${authWorkspace}` : undefined}
        />
      )
    }

    // 已取消
    if (authStatus === 'cancelled') {
      return (
        <AuthCardHeader
          icon={XCircle}
          title={`${authSourceName} Cancelled`}
        />
      )
    }

    // 失败
    if (authStatus === 'failed') {
      return (
        <AuthCardHeader
          icon={XCircle}
          title={`${authSourceName} Failed`}
          subtitle={authError || undefined}
        />
      )
    }

    // OAuth 正在进行：等待浏览器完成授权
    if (isOAuth && isSubmitting) {
      return (
        <div className="flex gap-3">
          <Spinner className="text-[10px] shrink-0 mt-1" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-5">
              {`${authSourceName} Authenticating...`}
            </div>
            <div className="text-xs mt-0.5 opacity-50">
              Complete authentication in your browser
            </div>
          </div>
        </div>
      )
    }

    // OAuth 待开始：显示说明与登录按钮
    if (isOAuth) {
      return (
        <AuthCardHeader
          title={`${authSourceName} ${authTypeLabel}`}
          description={authDescription || undefined}
        />
      )
    }

    // 凭据输入：仅渲染头部说明，输入框由 renderCredentialFields 负责
    return (
      <AuthCardHeader
        title={`${authSourceName} Authentication`}
        description={authDescription || undefined}
      />
    )
  }

  // 渲染凭据输入表单字段
  const renderCredentialFields = () => {
    if (authStatus !== 'pending' || isOAuth) return null

    return (
      <div className="space-y-3">
        {isBasicAuth ? (
          <>
            {/* 用户名字段 */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-username-${authRequestId}`} className="text-xs">
                {usernameLabel}
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={`auth-username-${authRequestId}`}
                  name="username"
                  autoComplete="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9"
                  placeholder={`Enter ${usernameLabel.toLowerCase()}`}
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>
            </div>
            {/* 密码字段 */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-password-${authRequestId}`} className="text-xs">
                {passwordLabel}
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={`auth-password-${authRequestId}`}
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9 pr-9"
                  placeholder={passwordPlaceholder}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </>
        ) : isMultiHeader && authHeaderNames ? (
          /* 多 Header 字段，例如 Datadog 的 DD-API-KEY + DD-APPLICATION-KEY */
          <>
            {authHeaderNames.map((headerName, index) => (
              <div key={headerName} className="space-y-1.5">
                <Label htmlFor={`auth-header-${authRequestId}-${index}`} className="text-xs">
                  {headerName}
                </Label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id={`auth-header-${authRequestId}-${index}`}
                    name={headerName}
                    autoComplete="off"
                    type={showPassword ? 'text' : 'password'}
                    value={headerValues[headerName] || ''}
                    onChange={(e) => setHeaderValues(prev => ({
                      ...prev,
                      [headerName]: e.target.value
                    }))}
                    onKeyDown={handleKeyDown}
                    className="pl-9 pr-9"
                    placeholder={`Enter ${headerName}`}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : (
          /* 单字段凭据：API Key 或 Bearer Token */
          <div className="space-y-1.5">
            <Label htmlFor={`auth-value-${authRequestId}`} className="text-xs">
              {credentialLabel}
              {authCredentialMode === 'header' && authHeaderName && (
                <span className="text-muted-foreground ml-1">
                  ({authHeaderName})
                </span>
              )}
            </Label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id={`auth-value-${authRequestId}`}
                name="credential"
                autoComplete="current-password"
                type={showPassword ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="pl-9 pr-9"
                placeholder={`Enter ${credentialLabel.toLowerCase()}`}
                autoFocus
                disabled={isSubmitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        {/* 提示文字 */}
        {authHint && (
          <p className="text-[11px] text-muted-foreground">
            {authHint}
          </p>
        )}
      </div>
    )
  }

  // 渲染底部操作按钮
  const renderActions = () => {
    if (!hasActions) return null

    // OAuth 待开始：显示“Sign in with XXX”按钮
    if (isOAuth) {
      return (
        <AuthCardActions
          primary={{
            label: `Sign in with ${authTypeLabel.replace(' Sign-In', '')}`,
            onClick: handleOAuthClick,
            dataTutorial: 'oauth-sign-in-button',
          }}
          secondary={{
            label: 'Cancel',
            onClick: handleCancel,
          }}
        />
      )
    }

    // 凭据表单：显示 Save / Cancel，Save 受校验与提交状态控制
    return (
      <AuthCardActions
        primary={{
          label: isSubmitting ? 'Saving...' : 'Save',
          onClick: handleSubmit,
          disabled: !isValid || isSubmitting,
          loading: isSubmitting,
        }}
        secondary={{
          label: 'Cancel',
          onClick: handleCancel,
          disabled: isSubmitting,
        }}
        hint="Credentials are encrypted at rest"
      />
    )
  }

  // 当前是否为 pending 状态的凭据表单（需要 form 包装以支持密码管理器）
  const isCredentialForm = authStatus === 'pending' && !isOAuth

  const cardContent = (
    <>
      <div
        className={cn(
          hasActions ? 'p-4' : 'px-4 py-3',
          !isOAuth && authStatus === 'pending' && 'space-y-4'
        )}
      >
        {renderContent()}
        {renderCredentialFields()}
      </div>

      {hasActions && renderActions()}
    </>
  )

  return (
    <div
      className={cn('rounded-[8px] overflow-hidden', variantTextClass)}
      style={{
        backgroundColor: variantBg,
        ...(shadowColor ? { '--shadow-color': shadowColor } as React.CSSProperties : {})
      }}
    >
      {/* 用 form 包裹凭据表单，便于 1Password 等密码管理器识别；
          action 指向 source URL，用于按域名匹配已存凭据。 */}
      {isCredentialForm ? (
        <form
          onSubmit={handleFormSubmit}
          action={authSourceUrl || undefined}
          method="post"
        >
          {cardContent}
        </form>
      ) : (
        cardContent
      )}
    </div>
  )
}

/**
 * 使用 React.memo 缓存卡片，避免聊天列表滚动时重复渲染未变化的认证消息。
 * 只有当 message id、认证状态、sessionId、交互标志变化时才重新渲染。
 */
export const MemoizedAuthRequestCard = React.memo(AuthRequestCard, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.authStatus === next.message.authStatus &&
    prev.sessionId === next.sessionId &&
    prev.isInteractive === next.isInteractive
  )
})

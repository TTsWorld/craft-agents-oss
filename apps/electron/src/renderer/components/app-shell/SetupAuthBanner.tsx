/**
 * SetupAuthBanner — React 组件
 * 
 * 所属目录：app-shell
 */
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

/** BannerState：状态类型别名 */
export type BannerState =
  | 'hidden'
  | 'mcp_auth'
  | 'api_auth'
  | 'error'

interface SetupAuthBannerProps {
  state: BannerState
  reason?: string
  onAction: () => void
  /** 显示变体：'banner' 用于会话列表顶部，'inputAreaCover' 用于输入区覆盖样式 */
  variant?: 'banner' | 'inputAreaCover'
}

/**
 * SetupAuthBanner - 当某些来源需要授权/认证时显示的提示横幅
 *
 * 状态说明：
 * - 'hidden'：不显示
 * - 'mcp_auth'：MCP 来源需要授权
 * - 'api_auth'：API 来源需要凭据
 * - 'error'：出错了，允许重试
 */
export function SetupAuthBanner({
  state,
  reason,
  onAction,
  variant = 'banner'
}: SetupAuthBannerProps) {
  const { t } = useTranslation()
  if (state === 'hidden') return null

  // 根据状态返回标题文案
  const getTitle = () => {
    switch (state) {
      case 'mcp_auth':
        return t('auth.connectionRequired')
      case 'api_auth':
        return t('auth.apiCredentialsRequired')
      case 'error':
        return t('auth.somethingWentWrong')
      default:
        return ''
    }
  }

  // 根据状态返回描述文案；如果调用方传了 reason 则优先使用 reason
  const getDescription = () => {
    if (reason) return reason
    switch (state) {
      case 'mcp_auth':
        return t('auth.connectToServices')
      case 'api_auth':
        return t('auth.enterApiCredentials')
      case 'error':
        return t('auth.somethingWentWrongRetry')
      default:
        return ''
    }
  }

  // 根据状态返回按钮文案
  const getButtonText = () => {
    switch (state) {
      case 'mcp_auth':
        return t('auth.connect')
      case 'api_auth':
        return t('auth.addCredentials')
      case 'error':
        return t('common.retry')
      default:
        return t('auth.continue')
    }
  }

  // inputAreaCover 变体：使用聊天输入框风格的卡片样式
  if (variant === 'inputAreaCover') {
    return (
      <div className="rounded-xl border bg-background overflow-hidden">
        <div className="py-6 px-4 text-center font-sans">
          <h3 className="text-sm font-semibold text-foreground flex items-center justify-center gap-2">
            {getTitle()}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {getDescription()}
          </p>
          <Button
            onClick={onAction}
            size="sm"
            className="mt-4"
          >
            {getButtonText()}
          </Button>
        </div>
      </div>
    )
  }

  // banner 变体（默认）：会话列表顶部单行横幅，高 48px，通宽贴顶
  return (
    <div className="h-12 shrink-0 pl-4 pr-2 flex items-center justify-between gap-3 border-b border-foreground/10 bg-background select-none">
      <h3 className="text-sm font-medium text-foreground font-sans flex items-center gap-2 min-w-0">
        <span className="truncate">{getTitle()}</span>
      </h3>
      <Button
        onClick={onAction}
        size="sm"
        className="shrink-0 text-xs rounded-[8px]"
      >
        {getButtonText()}
      </Button>
    </div>
  )
}

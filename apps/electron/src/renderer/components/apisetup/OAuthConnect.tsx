/**
 * OAuthConnect - 可复用的 OAuth 连接控件
 *
 * 根据状态渲染两种内容：
 * 1. 等待授权码：显示授权码输入表单（form ID 供外部提交按钮绑定）。
 * 2. 非等待状态：如有错误则显示错误信息。
 *
 * 不包含布局外壳与操作按钮——由父组件控制按钮位置和加载状态。
 * 错误展示风格与 ApiKeyInput 一致（显示在内容区下方）。
 *
 * 使用位置：Onboarding CredentialsStep、Settings OAuth dialog
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** OAuth 连接状态：idle 空闲 / validating 校验中 / success 成功 / error 失败。 */
export type OAuthStatus = 'idle' | 'validating' | 'success' | 'error'

export interface OAuthConnectProps {
  /** 当前连接状态 */
  status: OAuthStatus
  /** 状态为 error 时展示的错误信息 */
  errorMessage?: string
  /** 是否正在等待用户粘贴授权码 */
  isWaitingForCode?: boolean
  /** 启动浏览器 OAuth 流程 */
  onStartOAuth: () => void
  /** 提交从浏览器获得的授权码 */
  onSubmitAuthCode?: (code: string) => void
  /** 取消 OAuth 流程（仅在等待授权码时可用） */
  onCancelOAuth?: () => void
  /** 授权码表单的 ID，默认 "auth-code-form" */
  formId?: string
}

export function OAuthConnect({
  status,
  errorMessage,
  isWaitingForCode,
  onSubmitAuthCode,
  formId = "auth-code-form",
}: OAuthConnectProps) {
  const { t } = useTranslation()
  const [authCode, setAuthCode] = useState('')

  const handleAuthCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (authCode.trim() && onSubmitAuthCode) {
      onSubmitAuthCode(authCode.trim())
    }
  }

  // 等待授权码时：展示输入表单
  if (isWaitingForCode) {
    return (
      <form id={formId} onSubmit={handleAuthCodeSubmit}>
        <div className="space-y-2">
          <Label htmlFor="auth-code">{t("apiSetup.authorizationCode")}</Label>
          <div className={cn(
            "relative rounded-md shadow-minimal transition-colors",
            "bg-foreground-2 focus-within:bg-background"
          )}>
            <Input
              id="auth-code"
              type="text"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder={t("apiSetup.pasteAuthCode")}
              className={cn(
                "border-0 bg-transparent shadow-none font-mono text-sm",
                status === 'error' && "focus-visible:ring-destructive"
              )}
              disabled={status === 'validating'}
              autoFocus
            />
          </div>
          {status === 'error' && errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
        </div>
      </form>
    )
  }

  // 非等待状态：有错误才展示
  const showError = status === 'error' && !!errorMessage

  // 没有内容可渲染时直接返回 null，避免空包裹 div
  if (!showError) return null

  return (
    <div className="space-y-3">
      {/* 错误信息展示在内容下方，与 API Key 输入框风格保持一致 */}
      <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive text-center">
        {errorMessage}
      </div>
    </div>
  )
}

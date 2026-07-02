import { cn } from "@/lib/utils"
import { WelcomeStep } from "./WelcomeStep"
import type { ApiSetupMethod } from "./APISetupStep"
import { ProviderSelectStep, type ProviderChoice } from "./ProviderSelectStep"
import { CredentialsStep, type CredentialStatus } from "./CredentialsStep"
import { LocalModelStep, type LocalModelSubmitData } from "./LocalModelStep"
import { CompletionStep } from "./CompletionStep"
import { GitBashWarning, type GitBashStatus } from "./GitBashWarning"
import type { ApiKeySubmitData } from "../apisetup"
import type { CustomEndpointApi } from '@config/llm-connections'

// 引导流程的步骤名，用联合类型限定只能取这些字符串
export type OnboardingStep =
  | 'welcome'
  | 'git-bash'
  | 'provider-select'
  | 'local-model'
  | 'credentials'
  | 'complete'

// 登录状态
export type LoginStatus = 'idle' | 'waiting' | 'success' | 'error'

// OnboardingWizard 的状态对象，由父组件持有并传入
export interface OnboardingState {
  step: OnboardingStep
  loginStatus: LoginStatus
  credentialStatus: CredentialStatus
  completionStatus: 'saving' | 'complete'
  apiSetupMethod: ApiSetupMethod | null
  isExistingUser: boolean
  errorMessage?: string
  gitBashStatus?: GitBashStatus
  isRecheckingGitBash?: boolean
  isCheckingGitBash?: boolean
}

// OnboardingWizard 的 props 接口
interface OnboardingWizardProps {
  /** 当前 wizard 的状态 */
  state: OnboardingState

  // 事件回调
  onContinue: () => void
  onBack: () => void
  onSelectApiSetupMethod: (method: ApiSetupMethod) => void
  onSubmitCredential: (data: ApiKeySubmitData) => void
  onStartOAuth?: (methodOverride?: ApiSetupMethod) => void
  onFinish: () => void

  // Claude OAuth 两步流程
  isWaitingForCode?: boolean
  onSubmitAuthCode?: (code: string) => void
  onCancelOAuth?: () => void

  // Copilot 设备流
  copilotDeviceCode?: { userCode: string; verificationUri: string }

  // Git Bash（Windows）
  onBrowseGitBash?: () => Promise<string | null>
  onUseGitBashPath?: (path: string) => void
  onRecheckGitBash?: () => void
  onClearError?: () => void

  // 提供商选择（新流程）
  onSelectProvider?: (choice: ProviderChoice) => void
  /** 在提供商选择页点击“稍后设置”时触发 */
  onSkipSetup?: () => void

  // 本地模型
  onSubmitLocalModel?: (data: LocalModelSubmitData) => void

  // 编辑模式：预填充已有连接值
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
  }

  className?: string
}

/**
 * OnboardingWizard - 全屏引导流程容器
 *
 * 负责按步骤串联 Craft Agent 的初始化配置：
 * 1. 欢迎页
 * 2. 提供商选择（Claude / ChatGPT / Copilot / API Key / 本地模型）
 * 3. 凭据页（API Key 或 OAuth）或本地模型页
 * 4. 完成页
 */
export function OnboardingWizard({
  state,
  onContinue,
  onBack,
  onSelectApiSetupMethod,
  onSubmitCredential,
  onStartOAuth,
  onFinish,
  // 两步 OAuth 流程
  isWaitingForCode,
  onSubmitAuthCode,
  onCancelOAuth,
  // Copilot 设备流
  copilotDeviceCode,
  // Git Bash（Windows）
  onBrowseGitBash,
  onUseGitBashPath,
  onRecheckGitBash,
  onClearError,
  // 提供商选择（新流程）
  onSelectProvider,
  onSkipSetup,
  // 本地模型
  onSubmitLocalModel,
  // 编辑模式
  editInitialValues,
  className
}: OnboardingWizardProps) {
  const renderStep = () => {
    switch (state.step) {
      case 'welcome':
        return (
          <WelcomeStep
            isExistingUser={state.isExistingUser}
            onContinue={onContinue}
            isLoading={state.isCheckingGitBash}
          />
        )

      case 'git-bash':
        return (
          <GitBashWarning
            status={state.gitBashStatus!}
            onBrowse={onBrowseGitBash!}
            onUsePath={onUseGitBashPath!}
            onRecheck={onRecheckGitBash!}
            onBack={onBack}
            isRechecking={state.isRecheckingGitBash}
            errorMessage={state.errorMessage}
            onClearError={onClearError}
          />
        )

      case 'provider-select':
        return (
          <ProviderSelectStep
            onSelect={onSelectProvider!}
            onSkip={onSkipSetup}
          />
        )

      case 'local-model':
        return (
          <LocalModelStep
            onSubmit={onSubmitLocalModel!}
            onBack={onBack}
            status={state.credentialStatus === 'validating' ? 'validating' : state.credentialStatus === 'error' ? 'error' : 'idle'}
            errorMessage={state.errorMessage}
          />
        )

      case 'credentials':
        return (
          <CredentialsStep
            apiSetupMethod={state.apiSetupMethod!}
            status={state.credentialStatus}
            errorMessage={state.errorMessage}
            onSubmit={onSubmitCredential}
            onStartOAuth={onStartOAuth}
            onBack={onBack}
            isWaitingForCode={isWaitingForCode}
            onSubmitAuthCode={onSubmitAuthCode}
            editInitialValues={editInitialValues}
            onCancelOAuth={onCancelOAuth}
            copilotDeviceCode={copilotDeviceCode}
          />
        )

      case 'complete':
        return (
          <CompletionStep
            status={state.completionStatus}
            onFinish={onFinish}
          />
        )

      default:
        return null
    }
  }

  return (
    <div
      className={cn(
        "bg-foreground-2 overflow-y-auto",
        !className?.includes('h-full') && "h-dvh",
        className
      )}
    >
      {/* macOS 透明窗口可拖拽的标题栏区域 */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />

      {/* 主内容区：内容较少时垂直居中；超出视口时自然滚动（适配移动端） */}
      <main className="flex min-h-full items-center justify-center p-4 sm:p-8">
        {renderStep()}
      </main>
    </div>
  )
}

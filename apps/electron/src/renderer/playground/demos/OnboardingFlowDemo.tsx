/**
 * OnboardingFlowDemo — Interactive walkthrough of the new onboarding flow.
 * OnboardingFlowDemo：新用户引导流程的交互式演示组件。
 *
 * Manages its own state so you can click through the entire sequence
 * in the playground without needing real IPC or OAuth.
 * 它自己管理状态，这样你可以在 playground 里点击体验完整流程，不需要真正的 IPC 或 OAuth。
 *
 * Flow: WelcomeStep → ProviderSelectStep → CredentialsStep / LocalModelStep → CompletionStep
 * 流程：欢迎页 → 服务商选择 → 凭证填写 / 本地模型配置 → 完成页
 */
// 从 react 导入三个最常用 Hooks：useState（状态）、useCallback（缓存回调）、useEffect（副作用）。
import { useState, useCallback, useEffect } from 'react'
// 导入 playground 的 mock 工具，确保 renderer 进程里有模拟的 Electron API。
import { ensureMockElectronAPI } from '../mock-utils'
// @/components/... 是 TypeScript 路径别名（path alias），避免写 ../../../。
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { ProviderSelectStep, type ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import { CredentialsStep } from '@/components/onboarding/CredentialsStep'
import { LocalModelStep } from '@/components/onboarding/LocalModelStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'
// type-only import：只导入类型，不会生成真实 JS 引用，打包器可以更好地做 tree-shaking。
import type { ApiSetupMethod } from '@/components/onboarding/APISetupStep'
import type { CredentialStatus } from '@/components/onboarding/CredentialsStep'

// 用字符串字面量联合类型（string literal union）定义演示步骤，IDE 会自动补全并检查拼写。
type DemoStep = 'welcome' | 'provider-select' | 'credentials' | 'local-model' | 'complete'

/** Map ProviderChoice → ApiSetupMethod for the credentials step */
/** 把用户选择映射到具体的 API 配置方式。Record<K, V> 是 TS 内置对象类型；Exclude<T, U> 表示从 ProviderChoice 里排除 'local'。 */
const CHOICE_TO_METHOD: Record<Exclude<ProviderChoice, 'local'>, ApiSetupMethod> = {
  claude: 'claude_oauth',
  chatgpt: 'pi_chatgpt_oauth',
  copilot: 'pi_copilot_oauth',
  api_key: 'pi_api_key',
}

/** OnboardingFlowDemo：函数 */
// 这是一个 React 函数组件（Function Component），在 TSX 文件里以大驼峰命名，返回 JSX。
export function OnboardingFlowDemo() {
  // useEffect 在组件挂载时执行一次（空依赖数组 []），用来初始化 mock Electron API。
  // 在 Electron 中，renderer 进程通过 preload 脚本暴露的 window.electronAPI 与 main 进程通信。
  useEffect(() => { ensureMockElectronAPI() }, [])

  // useState<类型>(初始值) 声明组件状态；尖括号里的类型注解让 TS 知道状态允许的值。
  const [step, setStep] = useState<DemoStep>('welcome')
  const [method, setMethod] = useState<ApiSetupMethod | null>(null)
  const [credStatus, setCredStatus] = useState<CredentialStatus>('idle')
  const [localStatus, setLocalStatus] = useState<'idle' | 'validating' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()

  // Track history for the step indicator
  // 记录用户选择了哪个服务商，用于步骤指示器和后续状态重置。
  const [providerChoice, setProviderChoice] = useState<ProviderChoice | null>(null)

  // useCallback 把事件处理函数缓存起来，避免每次渲染都创建新函数，同时让依赖项数组里的变量变化时才重新创建。
  const handleProviderSelect = useCallback((choice: ProviderChoice) => {
    // 先重置相关状态，再根据选择跳转到本地模型或凭证步骤。
    setProviderChoice(choice)
    setCredStatus('idle')
    setLocalStatus('idle')
    setErrorMessage(undefined)

    if (choice === 'local') {
      setMethod(null)
      setStep('local-model')
    } else {
      setMethod(CHOICE_TO_METHOD[choice])
      setStep('credentials')
    }
  }, [])

  // 返回上一步的 handler；switch 语句判断当前 step，避免 if/else 嵌套。
  const handleBack = useCallback(() => {
    switch (step) {
      case 'provider-select':
        setStep('welcome')
        break
      case 'credentials':
      case 'local-model':
        setStep('provider-select')
        setCredStatus('idle')
        setLocalStatus('idle')
        setErrorMessage(undefined)
        break
    }
  }, [step])

  // 模拟 OAuth 成功：先进入 validating，再成功，然后自动跳到完成页。
  const simulateOAuthSuccess = useCallback(() => {
    setCredStatus('validating')
    setTimeout(() => {
      setCredStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1500)
  }, [])

  // 模拟 API Key 提交成功；真实场景会把 key 发给 main 进程或后端验证。
  const simulateApiKeySubmit = useCallback(() => {
    setCredStatus('validating')
    setTimeout(() => {
      setCredStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1200)
  }, [])

  // 模拟本地模型配置提交成功；本地模型不需要网络 OAuth。
  const simulateLocalSubmit = useCallback(() => {
    setLocalStatus('validating')
    setTimeout(() => {
      setLocalStatus('success')
      setTimeout(() => setStep('complete'), 600)
    }, 1200)
  }, [])

  // 重置所有状态，回到第一步，用于“重新开始”。
  const handleRestart = useCallback(() => {
    setStep('welcome')
    setMethod(null)
    setProviderChoice(null)
    setCredStatus('idle')
    setLocalStatus('idle')
    setErrorMessage(undefined)
  }, [])

  const handleSkip = useCallback(() => {
    console.log('[Playground] Setup deferred — dismissing onboarding')
    // In the real app this calls onComplete() which dismisses onboarding
    // 在真实应用中这会调用 onComplete() 关闭引导并进入主界面。
    // and shows the main app. In the playground we restart the demo.
    // 在 playground 里我们重新开始演示。
    handleRestart()
  }, [handleRestart])

  // Step labels for the breadcrumb
  // 根据当前步骤动态生成面包屑标签；label 字符串保持英文，因为它们是 UI 文案。
  const activeStepLabel = step === 'local-model' ? 'Local Model' : 'Credentials'
  // TS 内联类型：数组元素必须包含 key（DemoStep）和 label（string）。
  const STEP_ORDER: { key: DemoStep; label: string }[] = [
    { key: 'welcome', label: 'Welcome' },
    { key: 'provider-select', label: 'Provider' },
    { key: step === 'local-model' ? 'local-model' : 'credentials', label: activeStepLabel },
    { key: 'complete', label: 'Done' },
  ]

  // findIndex 找出当前步骤在数组中的位置，用于高亮当前步骤。
  const currentIndex = STEP_ORDER.findIndex(s => s.key === step)

  // 组件返回 JSX。TSX 允许在 JS/TS 中写类似 HTML 的结构，className 里用的是 Tailwind CSS 工具类。
  return (
    <div className="flex flex-col h-full">
      {/* Step indicator bar */}
      {/* 顶部步骤指示条：shrink-0 表示 flex 布局中不收缩，border-b 加底部边框。 */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-foreground/[0.03] border-b border-border">
        <div className="flex items-center gap-1 text-xs">
          {/* 用 map 遍历步骤数组，每个元素需要稳定的 key，帮助 React 识别差异更新。 */}
          {STEP_ORDER.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/40 mx-1">→</span>}
              <span
                className={
                  // 三元表达式根据步骤状态切换样式：当前高亮、已完成变灰、未到达更淡。
                  i === currentIndex
                    ? 'font-semibold text-foreground'
                    : i < currentIndex
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                }
              >
                {s.label}
              </span>
            </span>
          ))}
        </div>
        <button
          onClick={handleRestart}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-foreground/5"
        >
          Restart
        </button>
      </div>

      {/* Step content */}
      {/* 主内容区：flex-1 占满剩余高度，条件渲染当前步骤对应的子组件。 */}
      <div className="flex-1 flex items-center justify-center p-8 bg-foreground-2 overflow-auto">
        {step === 'welcome' && (
          <WelcomeStep
            isExistingUser={false}
            onContinue={() => setStep('provider-select')}
          />
        )}

        {step === 'provider-select' && (
          <ProviderSelectStep onSelect={handleProviderSelect} onSkip={handleSkip} />
        )}

        {step === 'credentials' && method && (
          <CredentialsStep
            apiSetupMethod={method}
            status={credStatus}
            errorMessage={errorMessage}
            onSubmit={simulateApiKeySubmit}
            onStartOAuth={simulateOAuthSuccess}
            onBack={handleBack}
            isWaitingForCode={false}
            onSubmitAuthCode={() => simulateOAuthSuccess()}
            onCancelOAuth={handleBack}
            copilotDeviceCode={
              // 仅在 Copilot OAuth 校验中时展示模拟的设备码。
              method === 'pi_copilot_oauth' && credStatus === 'validating'
                ? { userCode: 'DEMO-1234', verificationUri: 'https://github.com/login/device' }
                : undefined
            }
          />
        )}

        {step === 'local-model' && (
          <LocalModelStep
            onSubmit={simulateLocalSubmit}
            onBack={handleBack}
            status={localStatus}
            errorMessage={errorMessage}
          />
        )}

        {step === 'complete' && (
          <CompletionStep
            status="complete"
            onFinish={handleRestart}
          />
        )}
      </div>
    </div>
  )
}

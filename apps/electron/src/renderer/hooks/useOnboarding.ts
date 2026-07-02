/**
 * useOnboarding Hook
 *
 * 管理引导向导（onboarding wizard）的状态机。
 * 流程：
 * 1. 欢迎页
 * 2. Git Bash（仅 Windows，未找到时）
 * 3. 选择 API 提供方
 * 4. 凭据（API Key 或 Claude OAuth）
 * 5. 完成
 */
import { useState, useCallback, useEffect } from 'react'
import type {
  OnboardingState,
  OnboardingStep,
  ApiSetupMethod,
} from '@/components/onboarding'
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep'
import type { ApiKeySubmitData } from '@/components/apisetup'
import type { CustomEndpointConfig } from '@config/llm-connections'
import type { SetupNeeds, LlmConnectionSetup, ClaudeOAuthIdentityDto } from '../../shared/types'

interface UseOnboardingOptions {
  /** 引导完成时调用 */
  onComplete: () => void
  /** 认证状态检查返回的初始设置需求 */
  initialSetupNeeds?: SetupNeeds
  /** 从指定步骤开始向导（默认 'welcome'） */
  initialStep?: OnboardingStep
  /** 预选 API 设置方式（编辑已有连接时有用） */
  initialApiSetupMethod?: ApiSetupMethod
  /** 用户在初始步骤点击返回时调用（关闭向导） */
  onDismiss?: () => void
  /** 配置保存到磁盘后立即调用（在向导关闭前）。
   *  可用来立即把计费/模型变化同步到 UI，无需等待 onComplete。 */
  onConfigSaved?: () => void
  /** 正在编辑的现有连接 slug（null 表示新建） */
  editingSlug?: string | null
  /** 已占用的 slug 集合（新建时用于生成唯一 slug） */
  existingSlugs?: Set<string>
}

interface UseOnboardingReturn {
  // 状态
  state: OnboardingState

  // 向导动作
  handleContinue: () => void
  handleBack: () => void

  // 选择提供方（新流程）
  handleSelectProvider: (choice: ProviderChoice) => void

  // API 设置方式（旧版 —— 保留给直接编辑）
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void

  // 凭据
  handleSubmitCredential: (data: ApiKeySubmitData) => void

  // 本地模型
  handleSubmitLocalModel: (data: LocalModelSubmitData) => void
  handleStartOAuth: (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => void

  // Claude OAuth（两步流程）
  isWaitingForCode: boolean
  handleSubmitAuthCode: (code: string) => void
  handleCancelOAuth: () => void

  // Copilot 设备码（设备流期间展示）
  copilotDeviceCode?: { userCode: string; verificationUri: string }

  // Git Bash（Windows）
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void

  // 跳过设置（"稍后设置"）
  handleSkipSetup: () => void

  // 完成
  handleFinish: () => void
  handleCancel: () => void

  // 直接编辑（跳过方式选择，跳到凭据页）
  jumpToCredentials: (method: ApiSetupMethod) => void

  // 重置
  reset: () => void
}

// 每种设置方式对应的基础 slug（ipc.ts 中用作模板键）
export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  anthropic_api_key: 'anthropic-api',
  claude_oauth: 'claude-max',
  pi_chatgpt_oauth: 'chatgpt-plus',
  pi_copilot_oauth: 'github-copilot',
  pi_api_key: 'pi-api-key',
}

/**
 * 为新连接生成唯一 slug。
 * 若基础 slug 已被占用，则追加 -2、-3 等。
 * 如果提供了 editingSlug，则复用该 slug（编辑现有连接）。
 */
export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  // 编辑现有连接 —— 复用其 slug
  if (editingSlug) return editingSlug

  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// 判断 baseUrl 是否是回环地址（localhost / 127.0.0.1 / ::1）
function isLoopbackEndpoint(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

// 把 ApiSetupMethod 映射到新的统一连接系统 LlmConnectionSetup
export function apiSetupMethodToConnectionSetup(
  method: ApiSetupMethod,
  options: {
    credential?: string
    baseUrl?: string
    connectionDefaultModel?: string
    models?: string[]
    piAuthProvider?: string
    modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
    customEndpoint?: CustomEndpointConfig
    iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    awsRegion?: string
    bedrockAuthMethod?: 'iam_credentials' | 'environment'
    oauthIdentity?: ClaudeOAuthIdentityDto
  },
  editingSlug: string | null,
  existingSlugs: Set<string>,
): LlmConnectionSetup {
  const slug = resolveSlugForMethod(method, editingSlug, existingSlugs)

  switch (method) {
    case 'anthropic_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        customEndpoint: options.customEndpoint,
      }
    case 'claude_oauth':
      return {
        slug,
        credential: options.credential,
        oauthIdentity: options.oauthIdentity,
      }
    case 'pi_chatgpt_oauth':
    case 'pi_copilot_oauth':
      return {
        slug,
        credential: options.credential,
      }
    case 'pi_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        piAuthProvider: options.piAuthProvider,
        modelSelectionMode: options.modelSelectionMode,
        customEndpoint: options.customEndpoint,
        iamCredentials: options.iamCredentials,
        awsRegion: options.awsRegion,
        bedrockAuthMethod: options.bedrockAuthMethod,
      }
  }
}

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'provider-select',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
}: UseOnboardingOptions): UseOnboardingReturn {
  // 向导主状态
  const [state, setState] = useState<OnboardingState>({
    step: initialStep,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false,
    isCheckingGitBash: true, // 在检查完成前保持为 true
  })

  // 在 mount 时检查 Windows 上的 Git Bash。若缺失，无论初始步骤是什么都重定向到 git-bash 步骤
  //（provider-select 跳过了欢迎页门槛）。
  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          // Windows 上缺失 Git Bash 时重定向到 git-bash 步骤
          ...(status.platform === 'win32' && !status.found ? { step: 'git-bash' as const } : {}),
        }))
      } catch (error) {
        console.error('[Onboarding] Failed to check Git Bash:', error)
        // 即使出错也允许继续（会跳过 git-bash 步骤）
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  // 使用新的统一 LLM 连接 API 保存配置。
  // 成功返回 true，失败返回 false（并在失败时设置 errorMessage）。
  // `methodOverride` 允许调用方显式传入 method，避免闭包过期问题
  //（例如从异步 OAuth 流程调用时，其闭包早于状态更新）。
  const handleSaveConfig = useCallback(async (
    credential?: string,
    options?: {
      baseUrl?: string
      connectionDefaultModel?: string
      models?: string[]
      piAuthProvider?: string
      modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
      customEndpoint?: CustomEndpointConfig
      iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
      awsRegion?: string
      bedrockAuthMethod?: 'iam_credentials' | 'environment'
      oauthIdentity?: ClaudeOAuthIdentityDto
    },
    methodOverride?: ApiSetupMethod,
    connectionSlugOverride?: string,
    updateOnly?: boolean,
  ): Promise<boolean> => {
    const method = methodOverride ?? state.apiSetupMethod
    if (!method) {
      return false
    }

    setState(s => ({ ...s, completionStatus: 'saving' }))

    try {
      // 根据 UI 状态构建连接配置
      const setup = apiSetupMethodToConnectionSetup(method, {
        credential,
        baseUrl: options?.baseUrl,
        connectionDefaultModel: options?.connectionDefaultModel,
        models: options?.models,
        piAuthProvider: options?.piAuthProvider,
        modelSelectionMode: options?.modelSelectionMode,
        customEndpoint: options?.customEndpoint,
        iamCredentials: options?.iamCredentials,
        awsRegion: options?.awsRegion,
        bedrockAuthMethod: options?.bedrockAuthMethod,
        oauthIdentity: options?.oauthIdentity,
      }, connectionSlugOverride ?? editingSlug, existingSlugs)
      // 使用新的统一 API
      const result = await window.electronAPI.setupLlmConnection(
        updateOnly ? { ...setup, updateOnly: true } : setup
      )

      if (result.success) {
        setState(s => ({ ...s, completionStatus: 'complete' }))
        // 立即通知调用方，使 UI 能反映计费/模型变化
        onConfigSaved?.()
        return true
      } else {
        console.error('[Onboarding] Save failed:', result.error)
        setState(s => ({
          ...s,
          completionStatus: 'saving',
          errorMessage: result.error || 'Failed to save configuration',
        }))
        return false
      }
    } catch (error) {
      console.error('[Onboarding] handleSaveConfig error:', error)
      setState(s => ({
        ...s,
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
      return false
    }
  }, [state.apiSetupMethod, onConfigSaved, editingSlug, existingSlugs])

  // 进入下一步
  const handleContinue = useCallback(async () => {
    switch (state.step) {
      case 'provider-select':
        // 由 handleSelectProvider 处理（卡片点击直接导航）
        break

      case 'welcome':
        // Windows 上若需要 Git Bash 则先进入该步骤
        if (state.gitBashStatus?.platform === 'win32' && !state.gitBashStatus?.found) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else {
          setState(s => ({ ...s, step: 'provider-select' }))
        }
        break

      case 'git-bash':
        setState(s => ({ ...s, step: 'provider-select' }))
        break

      case 'local-model':
        // 由 handleSubmitLocalModel 处理
        break

      case 'credentials':
        // 由 handleSubmitCredential 处理
        break

      case 'complete':
        onComplete()
        break
    }
  }, [state.step, state.gitBashStatus, state.apiSetupMethod, onComplete])

  // 返回上一步。如果在初始步骤则调用 onDismiss。
  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    switch (state.step) {
      case 'git-bash':
        if (onDismiss) {
          onDismiss()
        }
        break
      case 'provider-select':
        // Windows 上需要 Git Bash 时返回 git-bash 步骤
        if (state.gitBashStatus?.platform === 'win32' && state.gitBashStatus?.found === false) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else if (onDismiss) {
          onDismiss()
        }
        break
      case 'credentials':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'local-model':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
    }
  }, [state.step, state.gitBashStatus, initialStep, onDismiss])

  // 选择 API 设置方式（旧版 —— 保留给直接编辑流程）
  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => ({ ...s, apiSetupMethod: method }))
  }, [])

  // 提交凭据（API key + 可选端点配置）
  // 先测试连接再保存，便于提前发现问题
  const handleSubmitCredential = useCallback(async (data: ApiKeySubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    const isPiApiKeyFlow = state.apiSetupMethod === 'pi_api_key'

    try {
      // Bedrock（Pi+amazon-bedrock）跳过 API key 验证和连接测试
      if (data.bedrockAuthMethod) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          iamCredentials: data.iamCredentials,
          awsRegion: data.awsRegion,
          bedrockAuthMethod: data.bedrockAuthMethod,
        })
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // 编辑现有连接时 API key 可为空（空 = 保留原凭据）
      if (!data.apiKey.trim() && editingSlug) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          customEndpoint: data.customEndpoint,
        })
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // API key 验证规则按端点是否本地回环区分：
      // - 本地/回环自定义端点可以无 key（如 Ollama）
      // - 非本地端点必须提供 API key
      const isLoopbackCustomEndpoint = isLoopbackEndpoint(data.baseUrl)
      if (isPiApiKeyFlow) {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      } else {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      }

      // 启动轻量级子进程测试连接。
      // 自定义端点协议在运行时走 PiAgent，因此也用 Pi 测试。
      const setupTestProvider = data.customEndpoint ? 'pi' : (isPiApiKeyFlow ? 'pi' : 'anthropic')
      const testResult = await window.electronAPI.testLlmConnectionSetup({
        provider: setupTestProvider,
        apiKey: data.apiKey,
        baseUrl: data.baseUrl,
        model: data.models?.[0],
        piAuthProvider: data.piAuthProvider,
        customEndpoint: data.customEndpoint,
      })

      if (!testResult.success) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Connection test failed',
        }))
        return
      }

      const saved = await handleSaveConfig(data.apiKey, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.connectionDefaultModel,
        models: data.models,
        piAuthProvider: data.piAuthProvider,
        modelSelectionMode: data.modelSelectionMode,
        customEndpoint: data.customEndpoint,
      })

      if (saved) {
        setState(s => ({
          ...s,
          credentialStatus: 'success',
          step: 'complete',
        }))
      } else {
        // 保存失败 —— handleSaveConfig 已设置错误，停留在凭据页
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }, [handleSaveConfig, state.apiSetupMethod])

  // 保存配置、验证连接并更新状态。
  // 所有 OAuth 流程拿到 token 后共用。
  // `method` 显式传入以打破闭包过期链 —— OAuth await 跨越多次渲染，
  // handleSaveConfig 闭包里的 state.apiSetupMethod 可能已过期。
  const saveAndValidateConnection = useCallback(async (connectionSlug: string, method: ApiSetupMethod, credential?: string, updateOnly?: boolean, oauthIdentity?: ClaudeOAuthIdentityDto): Promise<boolean> => {
    const saved = await handleSaveConfig(credential, oauthIdentity ? { oauthIdentity } : undefined, method, connectionSlug, updateOnly)
    if (!saved) {
      setState(s => ({ ...s, credentialStatus: 'error' }))
      return false
    }
    const testResult = await window.electronAPI.testLlmConnection(connectionSlug)
    if (testResult.success) {
      setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      return true
    } else {
      setState(s => ({ ...s, credentialStatus: 'error', errorMessage: testResult.error || 'Connection test failed' }))
      return false
    }
  }, [handleSaveConfig])

  // 两步 OAuth 流程状态
  const [isWaitingForCode, setIsWaitingForCode] = useState(false)

  // Copilot 设备码（设备流期间展示）
  const [copilotDeviceCode, setCopilotDeviceCode] = useState<{ userCode: string; verificationUri: string } | undefined>()

  // 启动 OAuth 流程（根据所选方式是 Claude 或 ChatGPT）
  const handleStartOAuth = useCallback(async (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => {
    const effectiveMethod = methodOverride ?? state.apiSetupMethod

    if (methodOverride && methodOverride !== state.apiSetupMethod) {
      setState(s => ({
        ...s,
        apiSetupMethod: methodOverride,
        step: 'credentials',
        credentialStatus: 'validating',
        errorMessage: undefined,
      }))
    } else {
      setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))
    }

    if (!effectiveMethod) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Select an authentication method first.',
      }))
      return
    }

    try {
      // ChatGPT OAuth（单步流程：打开浏览器，自动捕获 token）
      if (effectiveMethod === 'pi_chatgpt_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startChatGptOAuth(connectionSlug)

        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: result.error || 'ChatGPT authentication failed',
          }))
        }
        return
      }

      // Copilot OAuth（设备流：用户在 GitHub 输入设备码后，后端轮询 token）
      if (effectiveMethod === 'pi_copilot_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug

        // 启动流程前先订阅设备码事件
        const cleanup = window.electronAPI.onCopilotDeviceCode((data) => {
          setCopilotDeviceCode(data)
        })

        try {
          const result = await window.electronAPI.startCopilotOAuth(connectionSlug)

          if (result.success) {
            await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
          } else {
            setState(s => ({
              ...s,
              credentialStatus: 'error',
              errorMessage: result.error || 'GitHub authentication failed',
            }))
          }
        } finally {
          cleanup()
          setCopilotDeviceCode(undefined)
        }
        return
      }

      // Claude OAuth（两步流程：打开浏览器，用户复制 code 回来）
      // 走到这里剩下的方法只能是 claude_oauth
      if (effectiveMethod !== 'claude_oauth') {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: 'This connection uses API keys, not OAuth.',
        }))
        return
      }

      const result = await window.electronAPI.startClaudeOAuth()

      if (result.success) {
        // 浏览器已成功打开，现在等待用户复制 code
        setIsWaitingForCode(true)
        setState(s => ({ ...s, credentialStatus: 'idle' }))
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to start OAuth',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'OAuth failed',
      }))
    }
  }, [state.apiSetupMethod, saveAndValidateConnection, editingSlug, existingSlugs])

  // 把 ProviderChoice 映射为 ApiSetupMethod 并导航到对应步骤
  const handleSelectProvider = useCallback((choice: ProviderChoice) => {
    const CHOICE_TO_METHOD: Record<Exclude<ProviderChoice, 'local'>, ApiSetupMethod> = {
      claude: 'claude_oauth',
      chatgpt: 'pi_chatgpt_oauth',
      copilot: 'pi_copilot_oauth',
      api_key: 'pi_api_key',
    }

    if (choice === 'local') {
      // 本地模型使用 anthropic_api_key + 自定义端点（Ollama 不需要 API key）
      setState(s => ({ ...s, step: 'local-model', apiSetupMethod: 'anthropic_api_key', credentialStatus: 'idle', errorMessage: undefined }))
      return
    }

    const method = CHOICE_TO_METHOD[choice]
    setState(s => ({
      ...s,
      apiSetupMethod: method,
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))

    // OAuth 方式立即启动
    if (choice === 'claude' || choice === 'chatgpt' || choice === 'copilot') {
      // 推迟到下一 tick，让 state 更新后再被 handleStartOAuth 读到
      setTimeout(() => handleStartOAuth(method), 0)
    }
  }, [handleStartOAuth])

  // 提交授权码（OAuth 第二步）
  const handleSubmitAuthCode = useCallback(async (code: string) => {
    if (!code.trim()) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Please enter the authorization code',
      }))
      return
    }

    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      const connectionSlug = apiSetupMethodToConnectionSetup('claude_oauth', {}, editingSlug, existingSlugs).slug
      const result = await window.electronAPI.exchangeClaudeCode(code.trim(), connectionSlug)

      if (result.success && result.token) {
        setIsWaitingForCode(false)
        await saveAndValidateConnection(connectionSlug, 'claude_oauth', result.token, !!editingSlug, result.identity)
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to exchange code',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to exchange code',
      }))
    }
  }, [saveAndValidateConnection, editingSlug, existingSlugs])

  // 提交本地模型配置（Ollama 或任意 OpenAI 兼容本地服务）
  const handleSubmitLocalModel = useCallback(async (data: LocalModelSubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      // 进入 local-model 步骤时 apiSetupMethod 已被设为 'anthropic_api_key'
      const saved = await handleSaveConfig(undefined, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.model,
        models: data.models,
        customEndpoint: { api: 'openai-completions' },
      })

      if (saved) {
        setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      } else {
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
  }, [handleSaveConfig])

  // 取消 OAuth 流程
  const handleCancelOAuth = useCallback(async () => {
    setIsWaitingForCode(false)
    setState(s => ({ ...s, credentialStatus: 'idle', errorMessage: undefined }))
    // 清理后端的 OAuth 状态
    await window.electronAPI.clearClaudeOAuthState()
  }, [])

  // Git Bash 相关处理（仅 Windows）
  const handleBrowseGitBash = useCallback(async () => {
    return window.electronAPI.browseForGitBash()
  }, [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      // 标记 Git Bash 已找到并继续
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'provider-select',
      }))
    } else {
      setState(s => ({
        ...s,
        errorMessage: result.error || 'Invalid path',
      }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        // 若找到则自动进入下一步
        step: status.found ? 'provider-select' : s.step,
      }))
    } catch (error) {
      console.error('[Onboarding] Failed to recheck Git Bash:', error)
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => ({ ...s, errorMessage: undefined }))
  }, [])

  // 跳过设置 —— 用户选择"稍后设置"
  const handleSkipSetup = useCallback(async () => {
    try {
      await window.electronAPI.deferSetup()
    } catch (error) {
      console.error('[Onboarding] Failed to defer setup:', error)
    }
    onComplete()
  }, [onComplete])

  // 完成引导
  const handleFinish = useCallback(() => {
    onComplete()
  }, [onComplete])

  // 取消引导
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  // 直接跳到凭据步骤并预设方式（用于编辑已有连接）
  const jumpToCredentials = useCallback((method: ApiSetupMethod) => {
    setState(s => ({
      ...s,
      step: 'credentials' as const,
      apiSetupMethod: method,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    }))
  }, [])

  // 重置引导状态（登出或弹窗关闭后使用）
  const reset = useCallback(() => {
    setState({
      step: initialStep,
      loginStatus: 'idle',
      credentialStatus: 'idle',
      completionStatus: 'saving',
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: false,
      errorMessage: undefined,
    })
    setIsWaitingForCode(false)
    // 清理任何待定的 OAuth 状态
    window.electronAPI.clearClaudeOAuthState().catch(() => {
      // 忽略错误 —— 状态可能不存在
    })
  }, [initialStep, initialApiSetupMethod])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleSubmitLocalModel,
    handleStartOAuth,
    // 两步 OAuth 流程
    isWaitingForCode,
    handleSubmitAuthCode,
    handleCancelOAuth,
    // Copilot 设备码
    copilotDeviceCode,
    // Git Bash（Windows）
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    reset,
  }
}

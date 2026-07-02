import { useState } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Check, CreditCard, Key, Cpu } from "lucide-react"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import type { LlmAuthType, LlmProviderType } from "@craft-agent/shared/config/llm-connections"

/** 分段控件（segmented control）的当前选中的提供商分组 */
export type ProviderSegment = 'anthropic' | 'pi'

// Beta 角标小组件
const BetaBadge = ({ label }: { label: string }) => (
  <span className="inline px-1.5 pt-[2px] pb-[3px] text-[10px] font-accent font-bold rounded-[4px] bg-accent text-background ml-1 relative -top-[1px]">
    {label}
  </span>
)

/**
 * API 设置方式。
 * 每种方式对应一组 LlmProviderType + LlmAuthType。
 *
 * - 'claude_oauth' → anthropic + oauth
 * - 'anthropic_api_key' → anthropic + api_key
 * - 'pi_chatgpt_oauth' → pi + oauth
 * - 'pi_copilot_oauth' → pi + oauth
 * - 'pi_api_key' → pi + api_key
 */
export type ApiSetupMethod =
  | 'anthropic_api_key'
  | 'claude_oauth'
  | 'pi_chatgpt_oauth'
  | 'pi_copilot_oauth'
  | 'pi_api_key'

/**
 * 把 ApiSetupMethod 映射为底层 LLM 连接类型。
 * 类似 Golang 里的 switch 枚举转换函数。
 */
export function apiSetupMethodToConnectionTypes(method: ApiSetupMethod): {
  providerType: LlmProviderType;
  authType: LlmAuthType;
} {
  switch (method) {
    case 'claude_oauth':
      return { providerType: 'anthropic', authType: 'oauth' };
    case 'anthropic_api_key':
      return { providerType: 'anthropic', authType: 'api_key' };
    case 'pi_chatgpt_oauth':
      return { providerType: 'pi', authType: 'oauth' };
    case 'pi_copilot_oauth':
      return { providerType: 'pi', authType: 'oauth' };
    case 'pi_api_key':
      return { providerType: 'pi', authType: 'api_key' };
  }
}

// 单个 API 设置选项的数据结构
interface ApiSetupOption {
  id: ApiSetupMethod
  name: string
  description: string
  icon: React.ReactNode
  providerType: LlmProviderType
}

// 每种设置方式对应的图标
const API_SETUP_ICONS: Record<ApiSetupMethod, React.ReactNode> = {
  claude_oauth: <CreditCard className="size-4" />,
  anthropic_api_key: <Key className="size-4" />,
  pi_chatgpt_oauth: <Cpu className="size-4" />,
  pi_copilot_oauth: <Cpu className="size-4" />,
  pi_api_key: <Key className="size-4" />,
}

// API 设置步骤的 props 接口
interface APISetupStepProps {
  selectedMethod: ApiSetupMethod | null
  onSelect: (method: ApiSetupMethod) => void
  onContinue: () => void
  onBack: () => void
  /** 默认展示的分组，默认 anthropic */
  initialSegment?: ProviderSegment
}

/**
 * 单个选项按钮组件
 */
function OptionButton({
  option,
  isSelected,
  onSelect,
}: {
  option: ApiSetupOption
  isSelected: boolean
  onSelect: (method: ApiSetupMethod) => void
}) {
  return (
    <button
      onClick={() => onSelect(option.id)}
      className={cn(
        "flex w-full items-start gap-4 rounded-xl p-4 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "hover:bg-foreground/[0.02] shadow-minimal",
        isSelected
          ? "bg-background"
          : "bg-foreground-2"
      )}
    >
      {/* 图标 */}
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          isSelected ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground"
        )}
      >
        {option.icon}
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{option.name}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {option.description}
        </p>
      </div>

      {/* 选中勾选标记 */}
      <div
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          isSelected
            ? "border-foreground bg-foreground text-background"
            : "border-muted-foreground/20"
        )}
      >
        {isSelected && <Check className="size-3" strokeWidth={3} />}
      </div>
    </button>
  )
}

/**
 * 提供商分组分段控件
 */
function ProviderSegmentedControl({
  activeSegment,
  onSegmentChange,
  segmentLabels,
}: {
  activeSegment: ProviderSegment
  onSegmentChange: (segment: ProviderSegment) => void
  segmentLabels: Record<ProviderSegment, string>
}) {
  const segments: ProviderSegment[] = ['anthropic', 'pi']

  return (
    <div className="flex rounded-xl bg-foreground/[0.03] p-1 mb-4">
      {segments.map((segment) => (
        <button
          key={segment}
          onClick={() => onSegmentChange(segment)}
          className={cn(
            "flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all",
            activeSegment === segment
              ? "bg-background shadow-minimal text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {segmentLabels[segment]}
        </button>
      ))}
    </div>
  )
}

/**
 * APISetupStep - 选择如何连接 AI 服务
 *
 * 使用分段控件按提供商过滤：
 * - Anthropic：Claude Pro/Max 或 API Key
 * - OpenAI：ChatGPT Plus/Pro 或 API Key
 * - GitHub Copilot：Copilot 订阅
 */
export function APISetupStep({
  selectedMethod,
  onSelect,
  onContinue,
  onBack,
  initialSegment = 'anthropic',
}: APISetupStepProps) {
  const { t } = useTranslation()
  const [activeSegment, setActiveSegment] = useState<ProviderSegment>(initialSegment)

  const SEGMENT_LABELS: Record<ProviderSegment, string> = {
    anthropic: t("onboarding.apiSetup.claude"),
    pi: t("onboarding.apiSetup.craftAgentsBackend"),
  }

  const SEGMENT_DESCRIPTIONS: Record<ProviderSegment, React.ReactNode> = {
    anthropic: <>{t("onboarding.apiSetup.claudeDesc")}</>,
    pi: <>{t("onboarding.apiSetup.piDesc")}<BetaBadge label={t("onboarding.apiSetup.beta")} /></>,
  }

  const API_SETUP_OPTIONS: ApiSetupOption[] = [
    {
      id: 'claude_oauth',
      name: t("onboarding.apiSetup.claudeProMax"),
      description: t("onboarding.apiSetup.claudeProMaxDesc"),
      icon: API_SETUP_ICONS.claude_oauth,
      providerType: 'anthropic',
    },
    {
      id: 'anthropic_api_key',
      name: t("onboarding.apiSetup.anthropicApiKey"),
      description: t("onboarding.apiSetup.anthropicApiKeyDesc"),
      icon: API_SETUP_ICONS.anthropic_api_key,
      providerType: 'anthropic',
    },
    {
      id: 'pi_chatgpt_oauth',
      name: 'ChatGPT Plus',
      description: t("onboarding.apiSetup.chatGPTPlusDesc"),
      icon: API_SETUP_ICONS.pi_chatgpt_oauth,
      providerType: 'pi',
    },
    {
      id: 'pi_copilot_oauth',
      name: 'GitHub Copilot',
      description: t("onboarding.apiSetup.githubCopilotDesc"),
      icon: API_SETUP_ICONS.pi_copilot_oauth,
      providerType: 'pi',
    },
    {
      id: 'pi_api_key',
      name: t("onboarding.apiSetup.apiKey"),
      description: t("onboarding.apiSetup.apiKeyDesc"),
      icon: API_SETUP_ICONS.pi_api_key,
      providerType: 'pi',
    },
  ]

  // 根据当前分组过滤可选项
  const filteredOptions = API_SETUP_OPTIONS.filter(o => o.providerType === activeSegment)

  // 切换分组时保留当前选择，不自动清空（用户可能切回来看）
  const handleSegmentChange = (segment: ProviderSegment) => {
    setActiveSegment(segment)
  }

  return (
    <StepFormLayout
      title={t("onboarding.apiSetup.title")}
      description={t("onboarding.apiSetup.description")}
      actions={
        <>
          <BackButton onClick={onBack} />
          <ContinueButton onClick={onContinue} disabled={!selectedMethod} />
        </>
      }
    >
      {/* 提供商分段控件 */}
      <ProviderSegmentedControl
        activeSegment={activeSegment}
        onSegmentChange={handleSegmentChange}
        segmentLabels={SEGMENT_LABELS}
      />

      {/* 分组描述 */}
      <div className="bg-foreground-2 rounded-[8px] p-4 mb-3">
        <p className="text-sm text-muted-foreground text-center">
          {SEGMENT_DESCRIPTIONS[activeSegment]}
        </p>
      </div>

      {/* 当前分组下的选项列表；min-h 让切换分组时高度保持一致 */}
      <div className="space-y-3 min-h-[180px]">
        {filteredOptions.map((option) => (
          <OptionButton
            key={option.id}
            option={option}
            isSelected={option.id === selectedMethod}
            onSelect={onSelect}
          />
        ))}
      </div>
    </StepFormLayout>
  )
}

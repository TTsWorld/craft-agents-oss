import { useTranslation } from "react-i18next"
import { CraftAgentsSymbol } from "@/components/icons/CraftAgentsSymbol"
import { StepFormLayout, ContinueButton } from "./primitives"

// 欢迎步骤的 props 接口
interface WelcomeStepProps {
  onContinue: () => void
  /** 是否是已有用户在更新设置 */
  isExistingUser?: boolean
  /** 是否处于加载状态（例如在 Windows 上检测 Git Bash 时） */
  isLoading?: boolean
}

/**
 * WelcomeStep - 引导流程的欢迎页
 *
 * 根据新用户 / 老用户展示不同文案：
 * - 新用户：欢迎使用 Craft Agents
 * - 老用户：更新 API 连接设置
 */
export function WelcomeStep({
  onContinue,
  isExistingUser = false,
  isLoading = false
}: WelcomeStepProps) {
  const { t } = useTranslation()

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      }
      title={isExistingUser ? t("onboarding.welcome.updateTitle") : t("onboarding.welcome.title")}
      description={
        isExistingUser
          ? t("onboarding.welcome.updateDescription")
          : t("onboarding.welcome.description")
      }
      actions={
        <ContinueButton onClick={onContinue} className="w-full" loading={isLoading} loadingText={t("common.checking")}>
          {isExistingUser ? t("onboarding.welcome.continue") : t("onboarding.welcome.getStarted")}
        </ContinueButton>
      }
    />
  )
}

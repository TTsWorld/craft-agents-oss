import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Spinner } from "@craft-agent/ui"
import { CraftAgentsSymbol } from "@/components/icons/CraftAgentsSymbol"
import { StepFormLayout } from "./primitives"

// 完成步骤的 props 接口
interface CompletionStepProps {
  status: 'saving' | 'complete'
  spaceName?: string
  onFinish: () => void
}

/**
 * CompletionStep - 引导结束后的成功页
 *
 * 展示两种状态：
 * - saving：正在保存配置，显示加载动画
 * - complete：配置完成，显示开始按钮
 */
export function CompletionStep({
  status,
  spaceName,
  onFinish
}: CompletionStepProps) {
  const { t } = useTranslation()
  const isSaving = status === 'saving'

  return (
    <StepFormLayout
      iconElement={isSaving ? (
        <div className="flex size-16 items-center justify-center">
          <Spinner className="text-2xl text-foreground" />
        </div>
      ) : (
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      )}
      title={isSaving ? t("onboarding.completion.settingUp") : t("onboarding.completion.allSet")}
      description={
        isSaving ? (
          t("onboarding.completion.savingConfig")
        ) : (
          t("onboarding.completion.startChat")
        )
      }
      actions={
        status === 'complete' ? (
          <Button onClick={onFinish} className="w-full max-w-[320px] bg-background shadow-minimal text-foreground hover:bg-foreground/5 rounded-lg" size="lg">
            {t("onboarding.welcome.getStarted")}
          </Button>
        ) : undefined
      }
    />
  )
}

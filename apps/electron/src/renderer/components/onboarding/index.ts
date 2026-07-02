// 导出 onboarding（首次启动引导）模块的公共组件与类型。
// 外部只需要从这个 index.ts 导入，不需要关心具体子文件。

// 复用的基础组件：图标、标题、表单布局、操作按钮等
export {
  StepIcon,
  StepHeader,
  StepFormLayout,
  StepActions,
  BackButton,
  ContinueButton,
  type StepIconVariant,
} from './primitives'

// 各个引导步骤组件
export { ProviderSelectStep, type ProviderChoice } from './ProviderSelectStep'
export { WelcomeStep } from './WelcomeStep'
export { APISetupStep, type ApiSetupMethod } from './APISetupStep'
export { CredentialsStep, type CredentialStatus } from './CredentialsStep'
export { CompletionStep } from './CompletionStep'
export { LocalModelStep, type LocalModelSubmitData } from './LocalModelStep'
export { ReauthScreen } from './ReauthScreen'
export { GitBashWarning, type GitBashStatus } from './GitBashWarning'

// 主容器：负责串联所有步骤
export { OnboardingWizard, type OnboardingState, type OnboardingStep, type LoginStatus } from './OnboardingWizard'

// 类型别名再导出，方便外部统一导入
export type {
  OnboardingStep as OnboardingStepType,
  OnboardingState as OnboardingStateType,
} from './OnboardingWizard'

export type {
  ApiSetupMethod as ApiSetupMethodType,
} from './APISetupStep'

export type {
  CredentialStatus as CredentialStatusType,
} from './CredentialsStep'

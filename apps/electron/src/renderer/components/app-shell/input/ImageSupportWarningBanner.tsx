/**
 * ImageSupportWarningBanner - 图片支持警告横幅。
 *
 * 当用户已选择图片附件，但当前自定义端点模型被配置为仅文本时，
 * 在输入框上方显示该警告，并提供一键开启图片支持的入口。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

/** ImageSupportWarningBannerProps：组件 props 类型定义 */
export interface ImageSupportWarningBannerProps {
  /** 当前模型显示名称，用于插值到提示文案中 */
  modelName: string
  /** 点击“启用图片支持”内联按钮的回调 */
  onEnable: () => void
}

/**
 * ImageSupportWarningBanner - 输入框上方的预检横幅。
 *
 * 显示条件由父组件 FreeFormInput 控制；本组件只负责绘制警告和 inline 操作。
 * 操作回调调用和模型选择器每行开关相同的 setModelSupportsImages 流程，
 * 保证两种入口对连接状态的写入一致。
 */
export function ImageSupportWarningBanner({
  modelName,
  onEnable,
}: ImageSupportWarningBannerProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-3 py-2 mx-2 mt-2 rounded-md bg-amber-500/10 text-foreground/70 text-xs">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span className="flex-1 min-w-0">
        {t('chat.imageWarning.title', { modelName })}
      </span>
      <button
        type="button"
        onClick={onEnable}
        className="shrink-0 underline underline-offset-2 hover:text-foreground"
      >
        {t('chat.imageWarning.action')}
      </button>
    </div>
  )
}

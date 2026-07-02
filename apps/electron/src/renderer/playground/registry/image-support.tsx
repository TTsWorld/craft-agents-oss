/**
 * image-support 注册项
 *
 * 这个文件演示“图片支持”相关的 UI：当当前模型是文本-only 时，
 * 输入框上方显示的警告横幅，以及模型选择器里的图片开关。
 * 涉及概念：model（LLM 模型）、vision（图像识别能力）、pi_compat（自定义端点兼容模式）。
 */
import * as React from 'react'
import { Check, Image as ImageIcon } from 'lucide-react'
import type { ComponentEntry } from './types'
import { ImageSupportWarningBanner } from '@/components/app-shell/input/ImageSupportWarningBanner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// ============================================================================
// Pre-flight banner - 在附件预览上方显示的警告横幅演示
// 当 active model 在 pi_compat 连接下被配置为 text-only 时出现。
// 横幅本身是无状态组件，是否展示由父组件决定；这里直接渲染以检查文案和布局。
// ============================================================================

function BannerDemo({
  modelName,
  onClickEnable,
}: {
  modelName: string
  onClickEnable?: () => void
}) {
  const [enabled, setEnabled] = React.useState(false)
  return (
    <div className="w-full max-w-[640px] mx-auto p-6">
      <div className="rounded-2xl border border-border/50 shadow-middle bg-background/40 backdrop-blur-sm">
        {!enabled && (
          <ImageSupportWarningBanner
            modelName={modelName}
            onEnable={() => {
              setEnabled(true)
              onClickEnable?.()
            }}
          />
        )}
        <div className="px-4 py-6 text-foreground/40 text-sm">
          {enabled
            ? 'Image support enabled — banner dismissed.'
            : 'Imagine the chat input here. Banner sits above any staged attachments.'}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Per-model picker row - 模型选择器里的一行
// 覆盖 pi_compat / 内置 provider 两种场景，以及 vision 开关的不同状态。
// ============================================================================

interface PickerRowProps {
  modelName: string
  isSelected: boolean
  showVisionToggle: boolean
  visionOn: boolean
}

function PickerRow({
  modelName,
  isSelected,
  showVisionToggle,
  visionOn: initialVisionOn,
}: PickerRowProps) {
  const { t } = useTranslation()
  const [visionOn, setVisionOn] = React.useState(initialVisionOn)
  return (
    <div className="w-[260px] mx-auto rounded-md bg-background/80 border border-border/50 px-1 py-1">
      <div className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer hover:bg-foreground/5">
        <div className="text-left">
          <div className="font-medium text-sm">{modelName}</div>
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {showVisionToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={visionOn
                    ? t('chat.modelPicker.supportsImagesOn')
                    : t('chat.modelPicker.supportsImagesOff')}
                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setVisionOn(v => !v)
                  }}
                >
                  <ImageIcon className={cn(
                    'h-3.5 w-3.5',
                    visionOn ? 'text-foreground/70' : 'text-foreground/30',
                  )} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {visionOn
                  ? t('chat.modelPicker.supportsImagesOn')
                  : t('chat.modelPicker.supportsImagesOff')}
              </TooltipContent>
            </Tooltip>
          )}
          {isSelected && (
            <Check className="h-3 w-3 text-foreground" />
          )}
        </div>
      </div>
    </div>
  )
}

/** image-support 组件注册列表。 */
export const imageSupportComponents: ComponentEntry[] = [
  {
    id: 'image-support-banner',
    name: 'Image Support — Pre-flight Banner',
    category: 'Chat Inputs',
    description:
      'Inline warning rendered above the chat input when the user has staged images on a custom-endpoint model that is configured as text-only. One-click action toggles the per-model supportsImages override.',
    component: BannerDemo,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        description: 'Display name of the active text-only model',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
    ],
    variants: [
      {
        name: 'Default',
        description: 'Generic text-only custom-endpoint model with images staged',
        props: { modelName: 'qwen3-coder' },
      },
      {
        name: 'Long model name',
        description: 'Verifies wrapping behaviour for long names',
        props: { modelName: 'minimax-text-01-very-long-id-no-images-here' },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'image-support-picker-row',
    name: 'Image Support — Picker Row',
    category: 'Chat Inputs',
    description:
      'A single chat-input model picker row with the per-model image-support toggle. The icon is gated to pi_compat connections — built-in providers (anthropic / pi) hide it because their catalogs are SDK-owned.',
    component: PickerRow,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
      {
        name: 'isSelected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'showVisionToggle',
        description: 'true for pi_compat (custom endpoints), false for built-in providers',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'visionOn',
        description: 'Per-model supportsImages override resolution',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'pi_compat — text-only (default)',
        description: 'Toggle visible, dim icon — image support disabled',
        props: { modelName: 'qwen3-coder', isSelected: false, showVisionToggle: true, visionOn: false },
      },
      {
        name: 'pi_compat — vision-on',
        description: 'Toggle visible, bright icon — per-model override true',
        props: { modelName: 'minimax-vision', isSelected: false, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'pi_compat — selected, vision-on',
        description: 'Both Check and bright icon visible',
        props: { modelName: 'minimax-vision', isSelected: true, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'Built-in provider (no toggle)',
        description: 'Anthropic or pi — no toggle rendered',
        props: { modelName: 'claude-haiku-4-5', isSelected: true, showVisionToggle: false, visionOn: false },
      },
    ],
    mockData: () => ({}),
  },
]

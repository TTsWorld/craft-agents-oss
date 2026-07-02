/**
 * useModelVisionToggle - 切换自定义端点模型图片支持开关的 hook。
 *
 * 实现原本内联在 FreeFormInput.tsx 里，抽离出来后桌面端下拉和紧凑抽屉模型选择器可以共享同一套逻辑，
 * 并与 @config/llm-connections 里的 setModelSupportsImages / modelSupportsImages 保持一致。
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  setModelSupportsImages,
  type LlmConnection,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

/** ToggleModelVision：切换模型图片支持的函数签名 */
export type ToggleModelVision = (
  connectionSlug: string,
  modelId: string,
  enabled: boolean,
) => Promise<void>

/**
 * useModelVisionToggle - 返回一个用于切换 pi_compat（自定义端点）连接下各模型图片支持的函数。
 *
 * 桌面端模型下拉菜单和紧凑模型选择器都复用这个 hook，避免重复实现。
 */
export function useModelVisionToggle(): ToggleModelVision {
  const { t } = useTranslation()
  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const refreshLlmConnections = appShellCtx?.refreshLlmConnections

  return React.useCallback(async (connectionSlug, modelId, enabled) => {
    if (!window.electronAPI) return
    const conn = llmConnections.find(c => c.slug === connectionSlug)
    if (!conn) return
    try {
      // 去掉运行时状态字段，只保留可序列化的连接配置
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...bare } = conn
      const updated = setModelSupportsImages(bare as LlmConnection, modelId, enabled)
      const result = await window.electronAPI.saveLlmConnection(updated)
      if (!result.success) {
        console.error('Failed to toggle model vision:', result.error)
        toast.error(t('chat.modelPicker.toggleVisionFailed'))
        return
      }
      await refreshLlmConnections?.()
    } catch (error) {
      console.error('Failed to toggle model vision:', error)
      toast.error(t('chat.modelPicker.toggleVisionFailed'))
    }
  }, [llmConnections, refreshLlmConnections, t])
}

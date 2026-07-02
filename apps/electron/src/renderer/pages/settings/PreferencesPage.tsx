/**
 * PreferencesPage
 *
 * 基于表单的用户偏好编辑器（对应 ~/.craft-agent/preferences.json）。
 * 功能：
 * - 为已知偏好提供固定输入框（姓名、时区、位置）
 * - 为备注提供自由文本区
 * - 变更时自动保存，并做防抖处理
 */

import * as React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsTextarea,
} from '@/components/settings'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

/** 页面元数据：设置导航中的“偏好设置”页面 */
export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'preferences',
}

/** 偏好设置表单状态 */
interface PreferencesFormState {
  name: string
  timezone: string
  city: string
  country: string
  notes: string
}

const emptyFormState: PreferencesFormState = {
  name: '',
  timezone: '',
  city: '',
  country: '',
  notes: '',
}

// 将 JSON 解析为表单状态
function parsePreferences(json: string): PreferencesFormState {
  try {
    const prefs = JSON.parse(json)
    return {
      name: prefs.name || '',
      timezone: prefs.timezone || '',
      city: prefs.location?.city || '',
      country: prefs.location?.country || '',
      notes: prefs.notes || '',
    }
  } catch {
    return emptyFormState
  }
}

// 将表单状态序列化为 JSON
function serializePreferences(state: PreferencesFormState): string {
  const prefs: Record<string, unknown> = {}

  if (state.name) prefs.name = state.name
  if (state.timezone) prefs.timezone = state.timezone

  if (state.city || state.country) {
    const location: Record<string, string> = {}
    if (state.city) location.city = state.city
    if (state.country) location.country = state.country
    prefs.location = location
  }

  if (state.notes) prefs.notes = state.notes
  prefs.updatedAt = Date.now()

  return JSON.stringify(prefs, null, 2)
}

/** 偏好设置页面 */
export default function PreferencesPage() {
  const { t } = useTranslation()
  const [formState, setFormState] = useState<PreferencesFormState>(emptyFormState)
  const [isLoading, setIsLoading] = useState(true)
  const [preferencesPath, setPreferencesPath] = useState<string | null>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialLoadRef = useRef(true)
  const formStateRef = useRef(formState)
  const lastSavedRef = useRef<string | null>(null)

  // 保持 formStateRef 与当前表单状态同步，供卸载清理逻辑使用
  useEffect(() => {
    formStateRef.current = formState
  }, [formState])

  // 挂载时加载已存储的用户偏好
  useEffect(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI.readPreferences()
        const parsed = parsePreferences(result.content)
        setFormState(parsed)
        setPreferencesPath(result.path)
        lastSavedRef.current = serializePreferences(parsed)
      } catch (err) {
        console.error('Failed to load stored user preferences:', err)
        setFormState(emptyFormState)
      } finally {
        setIsLoading(false)
        // 短暂延迟后标记初始加载完成
        setTimeout(() => {
          isInitialLoadRef.current = false
        }, 100)
      }
    }
    load()
  }, [])

  // 带防抖的自动保存
  useEffect(() => {
    // 初始加载期间跳过自动保存
    if (isInitialLoadRef.current || isLoading) return

    // 清除待执行的保存定时器
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    // 500ms 防抖后保存
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const json = serializePreferences(formState)
        const result = await window.electronAPI.writePreferences(json)
        if (result.success) {
          lastSavedRef.current = json
        } else {
          console.error('Failed to save preferences:', result.error)
        }
      } catch (err) {
        console.error('Failed to save preferences:', err)
      }
    }, 500)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [formState, isLoading])

  // 卸载时若存在未保存的变更则强制保存
  useEffect(() => {
    return () => {
      // 清除待执行的防抖保存
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // 检查是否存在未保存的变更并立即保存
      const currentJson = serializePreferences(formStateRef.current)
      if (lastSavedRef.current !== currentJson && !isInitialLoadRef.current) {
        // cleanup 中无法 await，直接触发保存
        window.electronAPI.writePreferences(currentJson).catch((err) => {
          console.error('Failed to save preferences on unmount:', err)
        })
      }
    }
  }, [])

  const updateField = useCallback(<K extends keyof PreferencesFormState>(
    field: K,
    value: PreferencesFormState[K]
  ) => {
    setFormState(prev => ({ ...prev, [field]: value }))
  }, [])

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="text-lg text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.preferences.title")} actions={<HeaderMenu route={routes.view.settings('preferences')} helpFeature="preferences" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
          {/* 基本信息 */}
          <SettingsSection
            title={t("settings.preferences.basicInfo")}
            description={t("settings.preferences.basicInfoDesc")}
          >
            <SettingsCard divided>
              <SettingsInput
                label={t("settings.preferences.name")}
                description={t("settings.preferences.nameDesc")}
                value={formState.name}
                onChange={(v) => updateField('name', v)}
                placeholder={t("settings.preferences.namePlaceholder")}
                inCard
              />
              <SettingsInput
                label={t("settings.preferences.timezone")}
                description={t("settings.preferences.timezoneDesc")}
                value={formState.timezone}
                onChange={(v) => updateField('timezone', v)}
                placeholder={t("settings.preferences.timezonePlaceholder")}
                inCard
              />
            </SettingsCard>
          </SettingsSection>

          {/* 位置信息 */}
          <SettingsSection
            title={t("settings.preferences.location")}
            description={t("settings.preferences.locationDesc")}
          >
            <SettingsCard divided>
              <SettingsInput
                label={t("settings.preferences.city")}
                description={t("settings.preferences.cityDesc")}
                value={formState.city}
                onChange={(v) => updateField('city', v)}
                placeholder={t("settings.preferences.cityPlaceholder")}
                inCard
              />
              <SettingsInput
                label={t("settings.preferences.country")}
                description={t("settings.preferences.countryDesc")}
                value={formState.country}
                onChange={(v) => updateField('country', v)}
                placeholder={t("settings.preferences.countryPlaceholder")}
                inCard
              />
            </SettingsCard>
          </SettingsSection>

          {/* 备注 */}
          <SettingsSection
            title={t("settings.preferences.notes")}
            description={t("settings.preferences.notesDesc")}
            action={
              // 用于 AI 辅助编辑备注的 EditPopover，次要操作为“编辑文件”
              preferencesPath ? (
                <EditPopover
                  trigger={<EditButton />}
                  {...getEditConfig('preferences-notes', preferencesPath)}
                  secondaryAction={{
                    label: t("common.editFile"),
                    filePath: preferencesPath!,
                  }}
                />
              ) : null
            }
          >
            <SettingsCard divided={false}>
              <SettingsTextarea
                value={formState.notes}
                onChange={(v) => updateField('notes', v)}
                placeholder={t("settings.preferences.notesPlaceholder")}
                rows={5}
                inCard
              />
            </SettingsCard>
          </SettingsSection>
        </div>
        </ScrollArea>
      </div>
    </div>
  )
}

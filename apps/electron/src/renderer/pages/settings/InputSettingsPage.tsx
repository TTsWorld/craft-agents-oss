/**
 * InputSettingsPage
 *
 * 输入行为设置：控制聊天输入框的工作方式。
 *
 * 设置项：
 * - 自动大写（开/关）
 * - 拼写检查（开/关）
 * - 发送消息快捷键（Enter 或 ⌘+Enter）
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { isMac } from '@/lib/platform'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsMenuSelectRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'input',
}

// ============================================
// 主组件
// ============================================

export default function InputSettingsPage() {
  const { t } = useTranslation()

  // 自动大写状态
  const [autoCapitalisation, setAutoCapitalisation] = useState(true)

  // 拼写检查状态（默认关闭）
  const [spellCheck, setSpellCheck] = useState(false)

  // 发送消息快捷键状态
  const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')

  // 挂载时加载设置
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, spellCheckEnabled, sendKey] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSpellCheck(),
          window.electronAPI.getSendMessageKey(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSpellCheck(spellCheckEnabled)
        setSendMessageKey(sendKey)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadSettings()
  }, [])

  const handleAutoCapitalisationChange = useCallback(async (enabled: boolean) => {
    setAutoCapitalisation(enabled)
    await window.electronAPI.setAutoCapitalisation(enabled)
  }, [])

  const handleSpellCheckChange = useCallback(async (enabled: boolean) => {
    setSpellCheck(enabled)
    await window.electronAPI.setSpellCheck(enabled)
  }, [])

  const handleSendMessageKeyChange = useCallback((value: string) => {
    const key = value as 'enter' | 'cmd-enter'
    setSendMessageKey(key)
    window.electronAPI.setSendMessageKey(key)
  }, [])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.input.title")} actions={<HeaderMenu route={routes.view.settings('input')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* 输入行为 */}
              <SettingsSection title={t("settings.input.typing")} description={t("settings.input.typingDesc")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.input.autoCapitalisation")}
                    description={t("settings.input.autoCapitalisationDesc")}
                    checked={autoCapitalisation}
                    onCheckedChange={handleAutoCapitalisationChange}
                  />
                  <SettingsToggle
                    label={t("settings.input.spellCheck")}
                    description={t("settings.input.spellCheckDesc")}
                    checked={spellCheck}
                    onCheckedChange={handleSpellCheckChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* 发送行为 */}
              <SettingsSection title={t("settings.input.sending")} description={t("settings.input.sendingDesc")}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t("settings.input.sendMessageWith")}
                    description={t("settings.input.sendMessageWithDesc")}
                    value={sendMessageKey}
                    onValueChange={handleSendMessageKeyChange}
                    options={[
                      { value: 'enter', label: t("settings.input.enterKey"), description: t("settings.input.enterKeyDesc") },
                      { value: 'cmd-enter', label: isMac ? t("settings.input.cmdEnterKey") : t("settings.input.ctrlEnterKey"), description: t("settings.input.cmdEnterKeyDesc") },
                    ]}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

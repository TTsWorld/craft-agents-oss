/**
 * LabelsSettingsPage
 *
 * 在工作区中展示标签配置，包含两张数据表：
 * 1. 标签层级（Label Hierarchy）—— 可展开/折叠的树形表，展示全部标签
 * 2. 自动应用规则（Auto-Apply Rules）—— 平铺表格，展示跨标签的所有正则规则
 *
 * 每个区块都提供“编辑”按钮，点击后弹出 EditPopover，可借助 AI 编辑底层 labels/config.json 文件。
 *
 * 数据通过 useLabels Hook 加载，并订阅实时配置变更。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { getDocUrl } from '@craft-agent/shared/docs/doc-links'
import { Loader2 } from 'lucide-react'
import { useAppShellContext, useActiveWorkspace } from '@/context/AppShellContext'
import { useLabels } from '@/hooks/useLabels'
import {
  LabelsDataTable,
  AutoRulesDataTable,
} from '@/components/info'
import {
  SettingsSection,
  SettingsCard,
} from '@/components/settings'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

/** 页面元数据：设置导航中的“标签”页面 */
export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'labels',
}

/** 标签设置页面 */
export default function LabelsSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const activeWorkspace = useActiveWorkspace()
  const { labels, isLoading } = useLabels(activeWorkspaceId)

  // 根据当前工作区根路径生成 EditPopover 配置
  const rootPath = activeWorkspace?.rootPath || ''
  const labelsEditConfig = getEditConfig('edit-labels', rootPath)
  const autoRulesEditConfig = getEditConfig('edit-auto-rules', rootPath)

  // 辅助操作：在系统编辑器中直接打开标签配置文件
  const editFileAction = rootPath ? {
    label: t("common.editFile"),
    filePath: `${rootPath}/labels/config.json`,
  } : undefined

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.labels.title")} actions={<HeaderMenu route={routes.view.settings('labels')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* 关于标签区块 */}
                  <SettingsSection title={t("settings.labels.aboutLabels")}>
                    <SettingsCard className="px-4 py-3.5">
                      <div className="text-sm text-muted-foreground leading-relaxed space-y-1.5">
                        <p>
                          {t("settings.labels.aboutText1")}
                        </p>
                        <p>
                          {t("settings.labels.aboutText2")}
                        </p>
                        <p>
                          {t("settings.labels.aboutText3")}
                        </p>
                        <p>
                          <button
                            type="button"
                            onClick={() => window.electronAPI?.openUrl(getDocUrl('labels'))}
                            className="text-foreground/70 hover:text-foreground underline underline-offset-2"
                          >
                            {t("chat.learnMore")}
                          </button>
                        </p>
                      </div>
                    </SettingsCard>
                  </SettingsSection>

                  {/* 标签层级区块 */}
                  <SettingsSection
                    title={t("settings.labels.labelHierarchy")}
                    description={t("settings.labels.labelHierarchyDesc")}
                    action={
                      <EditPopover
                        trigger={<EditButton />}
                        context={labelsEditConfig.context}
                        example={labelsEditConfig.example}
                        displayLabel={labelsEditConfig.displayLabel}
                        model={labelsEditConfig.model}
                        systemPromptPreset={labelsEditConfig.systemPromptPreset}
                        secondaryAction={editFileAction}
                      />
                    }
                  >
                    <SettingsCard className="p-0">
                      {labels.length > 0 ? (
                        <LabelsDataTable
                          data={labels}
                          searchable
                          maxHeight={350}
                          fullscreen
                          fullscreenTitle={t("settings.labels.labelHierarchy")}
                        />
                      ) : (
                        <div className="p-8 text-center text-muted-foreground">
                          <p className="text-sm">{t("settings.labels.noLabels")}</p>
                          <p className="text-xs mt-1 text-foreground/40">
                            {t("settings.labels.noLabelsDesc")}
                          </p>
                        </div>
                      )}
                    </SettingsCard>
                  </SettingsSection>

                  {/* 自动应用规则区块 */}
                  <SettingsSection
                    title={t("settings.labels.autoApplyRules")}
                    description={t("settings.labels.autoApplyRulesDesc")}
                    action={
                      <EditPopover
                        trigger={<EditButton />}
                        context={autoRulesEditConfig.context}
                        example={autoRulesEditConfig.example}
                        displayLabel={autoRulesEditConfig.displayLabel}
                        model={autoRulesEditConfig.model}
                        systemPromptPreset={autoRulesEditConfig.systemPromptPreset}
                        secondaryAction={editFileAction}
                      />
                    }
                  >
                    <SettingsCard className="p-0">
                      <AutoRulesDataTable
                        data={labels}
                        searchable
                        maxHeight={350}
                        fullscreen
                        fullscreenTitle={t("settings.labels.autoApplyRules")}
                      />
                    </SettingsCard>
                  </SettingsSection>
                </>
              )}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

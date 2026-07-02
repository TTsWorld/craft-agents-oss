/**
 * PermissionsSettingsPage
 *
 * Explore 模式（safe 模式）的权限配置页。
 * 展示两套规则：
 * 1. 默认规则：来自 ~/.craft-agent/permissions/default.json
 * 2. 当前 workspace 自定义规则：来自 workspace/permissions.json
 *
 * 默认规则可在个人配置目录中编辑；自定义规则通过 workspace 下的 permissions.json 编辑。
 */

import * as React from 'react'
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Loader2 } from 'lucide-react'
import { useAppShellContext, useActiveWorkspace } from '@/context/AppShellContext'
import { type PermissionsConfigFile } from '@craft-agent/shared/agent/modes'
import {
  PermissionsDataTable,
  type PermissionRow,
} from '@/components/info'
import {
  SettingsSection,
  SettingsCard,
} from '@/components/settings'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { getDocUrl } from '@craft-agent/shared/docs/doc-links'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'permissions',
}

/**
 * 从 ~/.craft-agent/permissions/default.json 构建默认权限数据。
 * 这些属于 Explore 模式规则，用户可自行定制。
 * 规则可以包含注释，会展示在表格中。
 *
 * 注意：这里只展示 allowed 规则；不在列表中的默认被拒绝。
 */
function buildDefaultPermissionsData(config: PermissionsConfigFile | null): PermissionRow[] {
  if (!config) return []

  const rows: PermissionRow[] = []

  // 辅助函数：从字符串或对象格式中提取 pattern 和 comment
  const extractPatternInfo = (item: string | { pattern: string; comment?: string }): { pattern: string; comment: string | null } => {
    if (typeof item === 'string') {
      return { pattern: item, comment: null }
    }
    return { pattern: item.pattern, comment: item.comment || null }
  }

  // 注意：默认规则不展示 blockedTools；不在 allowed 列表中的默认被拒绝

  // 允许的 Bash 命令模式
  config.allowedBashPatterns?.forEach((item) => {
    const { pattern, comment } = extractPatternInfo(item)
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // 允许的 MCP 工具模式
  config.allowedMcpPatterns?.forEach((item) => {
    const { pattern, comment } = extractPatternInfo(item)
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  // API 端点
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    rows.push({ access: 'allowed', type: 'api', pattern, comment: item.comment || null })
  })

  // 写路径
  config.allowedWritePaths?.forEach((item) => {
    const { pattern, comment } = extractPatternInfo(item)
    rows.push({ access: 'allowed', type: 'tool', pattern: `Write to: ${pattern}`, comment })
  })

  return rows
}

/**
 * 从 workspace permissions.json 构建自定义权限数据。
 * 这些规则是对默认规则的扩展。
 */
function buildCustomPermissionsData(config: PermissionsConfigFile, fallbackLabels: { blockedTool: string; bashPattern: string; mcpPattern: string; apiEndpoint: string; writePath: string }): PermissionRow[] {
  const rows: PermissionRow[] = []

  // 额外被屏蔽的工具
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.blockedTool : (item.comment || fallbackLabels.blockedTool)
    rows.push({ access: 'blocked', type: 'tool', pattern, comment })
  })

  // 额外允许的 Bash 模式
  config.allowedBashPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.bashPattern : (item.comment || fallbackLabels.bashPattern)
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // 额外允许的 MCP 模式
  config.allowedMcpPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.mcpPattern : (item.comment || fallbackLabels.mcpPattern)
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  // API 端点
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    rows.push({ access: 'allowed', type: 'api', pattern, comment: item.comment || fallbackLabels.apiEndpoint })
  })

  // 写路径以允许路径形式展示
  config.allowedWritePaths?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? fallbackLabels.writePath : (item.comment || fallbackLabels.writePath)
    // 作为特殊 "tool" 类型展示，因为涉及写/编辑操作
    rows.push({ access: 'allowed', type: 'tool', pattern: `Write to: ${pattern}`, comment })
  })

  return rows
}

export default function PermissionsSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const activeWorkspace = useActiveWorkspace()

  // 加载与数据状态
  const [isLoading, setIsLoading] = useState(true)
  const [defaultConfig, setDefaultConfig] = useState<PermissionsConfigFile | null>(null)
  const [defaultPermissionsPath, setDefaultPermissionsPath] = useState<string | null>(null)
  const [customConfig, setCustomConfig] = useState<PermissionsConfigFile | null>(null)

  // 从默认配置构建表格数据
  const defaultPermissionsData = useMemo(() => buildDefaultPermissionsData(defaultConfig), [defaultConfig])

  // 自定义权限的默认 fallback 文案（已翻译）
  const permissionFallbackLabels = useMemo(() => ({
    blockedTool: t("settings.permissions.customBlockedTool"),
    bashPattern: t("settings.permissions.customBashPattern"),
    mcpPattern: t("settings.permissions.customMcpPattern"),
    apiEndpoint: t("settings.permissions.customApiEndpoint"),
    writePath: t("settings.permissions.allowedWritePath"),
  }), [t])

  // 从 workspace 配置构建表格数据
  const customPermissionsData = useMemo(() => {
    if (!customConfig) return []
    return buildCustomPermissionsData(customConfig, permissionFallbackLabels)
  }, [customConfig, permissionFallbackLabels])

  // 同时加载默认权限和 workspace 权限配置
  useEffect(() => {
    const loadPermissions = async () => {
      if (!window.electronAPI) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        // 加载应用级默认权限，返回配置和路径
        const { config: defaults, path: defaultsPath } = await window.electronAPI.getDefaultPermissionsConfig()
        setDefaultConfig(defaults)
        setDefaultPermissionsPath(defaultsPath)

        // 如果有当前 workspace，加载其权限配置
        if (activeWorkspaceId) {
          const workspace = await window.electronAPI.getWorkspacePermissionsConfig(activeWorkspaceId)
          setCustomConfig(workspace)
        }
      } catch (error) {
        console.error('加载权限失败:', error)
      } finally {
        setIsLoading(false)
      }
    }

    loadPermissions()
  }, [activeWorkspaceId])

  // 监听默认权限文件变更
  useEffect(() => {
    if (!window.electronAPI?.onDefaultPermissionsChanged) return

    const unsubscribe = window.electronAPI.onDefaultPermissionsChanged(async () => {
      // 文件变化时重新加载默认权限
      const { config: defaults } = await window.electronAPI.getDefaultPermissionsConfig()
      setDefaultConfig(defaults)
    })

    return unsubscribe
  }, [])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.permissions.title")} actions={<HeaderMenu route={routes.view.settings('permissions')} helpFeature="permissions" />} />
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
                  {/* About Section */}
                  <SettingsSection title={t("settings.permissions.aboutPermissions")}>
                    <SettingsCard className="px-4 py-3.5">
                      <div className="text-sm text-muted-foreground leading-relaxed space-y-1.5">
                        <p>
                          {t("settings.permissions.aboutText1")}
                        </p>
                        <p>
                          {t("settings.permissions.aboutText2")}
                        </p>
                        <p>
                          <button
                            type="button"
                            onClick={() => window.electronAPI?.openUrl(getDocUrl('permissions'))}
                            className="text-foreground/70 hover:text-foreground underline underline-offset-2"
                          >
                            {t("common.learnMore")}
                          </button>
                        </p>
                      </div>
                    </SettingsCard>
                  </SettingsSection>

                  {/* Default Permissions Section */}
                  <SettingsSection
                    title={t("settings.permissions.defaultPermissions")}
                    description={t("settings.permissions.defaultPermissionsDesc")}
                    action={
                      // EditPopover for AI-assisted default permissions editing
                      defaultPermissionsPath ? (
                        <EditPopover
                          trigger={<EditButton />}
                          {...getEditConfig('default-permissions', defaultPermissionsPath)}
                          secondaryAction={{
                            label: t("common.editFile"),
                            filePath: defaultPermissionsPath,
                          }}
                        />
                      ) : null
                    }
                  >
                    <SettingsCard className="p-0">
                      {defaultPermissionsData.length > 0 ? (
                        <PermissionsDataTable
                          data={defaultPermissionsData}
                          searchable
                          maxHeight={350}
                          fullscreen
                          fullscreenTitle={t("settings.permissions.defaultPermissions")}
                        />
                      ) : (
                        <div className="p-8 text-center text-muted-foreground">
                          <p className="text-sm">{t("settings.permissions.noDefaultPermissions")}</p>
                          <p className="text-xs mt-1 text-foreground/40">
                            {t("settings.permissions.noDefaultPermissionsDesc")}
                          </p>
                        </div>
                      )}
                    </SettingsCard>
                  </SettingsSection>

                  {/* Custom Permissions Section */}
                  <SettingsSection
                    title={t("settings.permissions.workspaceCustomizations")}
                    description={t("settings.permissions.workspaceCustomizationsDesc")}
                    action={
                      (() => {
                        // Get centralized edit config - all strings defined in EditPopover.tsx
                        const { context, example, displayLabel } = getEditConfig('workspace-permissions', activeWorkspace?.rootPath || '')
                        return (
                          <EditPopover
                            trigger={<EditButton />}
                            example={example}
                            context={context}
                            displayLabel={displayLabel}
                            secondaryAction={activeWorkspace ? {
                              label: t("common.editFile"),
                              filePath: `${activeWorkspace.rootPath}/permissions.json`,
                            } : undefined}
                          />
                        )
                      })()
                    }
                  >
                    <SettingsCard className="p-0">
                      {customPermissionsData.length > 0 ? (
                        <PermissionsDataTable
                          data={customPermissionsData}
                          searchable
                          maxHeight={350}
                          fullscreen
                          fullscreenTitle={t("settings.permissions.workspaceCustomizations")}
                        />
                      ) : (
                        <div className="p-8 text-center text-muted-foreground">
                          <p className="text-sm">{t("settings.permissions.noCustomPermissions")}</p>
                          <p className="text-xs mt-1 text-foreground/40">
                            {t("settings.permissions.noCustomPermissionsDesc")}
                          </p>
                        </div>
                      )}
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

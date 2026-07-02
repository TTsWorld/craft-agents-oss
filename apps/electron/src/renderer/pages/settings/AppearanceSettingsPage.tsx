/**
 * AppearanceSettingsPage
 *
 * 外观设置页：主题模式、配色主题、字体、workspace 级主题覆盖，
 * 以及 CLI 工具图标映射。
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGUAGES, type LanguageCode } from '@craft-agent/shared/i18n'
import type { ColumnDef } from '@tanstack/react-table'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { useTheme } from '@/context/ThemeContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { Monitor, Sun, Moon } from 'lucide-react'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ToolIconMapping } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsMenuSelect,
  SettingsToggle,
} from '@/components/settings'
import { useAtom } from 'jotai'
import * as storage from '@/lib/local-storage'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { ColorPicker } from '@/components/ui/color-picker'
import { workspaceAvatarColorsAtom } from '@/atoms/workspace-avatar-colors'
import { kanbanColumnColorsAtom, kanbanColumnStatusAtom, kanbanLivePulseAtom } from '@/atoms/kanban'
import { showBackgroundFinishedChipAtom } from '@/atoms/background-finished'
import { KANBAN_COLUMNS } from '@/components/app-shell/kanban/status-column'
import { DEFAULT_KANBAN_COLUMN_COLORS } from '@/components/app-shell/kanban/kanban-colors'
import type { KanbanColumnId } from '@/components/app-shell/kanban/types'
import { setProjectColorTreatment, useProjectColorTreatment } from '@/hooks/useProjectColorTreatment'
import { PROJECT_COLOR_PALETTE, type ProjectColorTreatment } from '@/utils/project-colors'
import { Info_DataTable, SortableHeader } from '@/components/info/Info_DataTable'
import { Info_Badge } from '@/components/info/Info_Badge'
import type { PresetTheme } from '@config/theme'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'appearance',
}

// ============================================
// 工具图标表格
// ============================================

/**
 * 工具图标映射表格的列定义。
 * 展示图标预览、工具名称和触发该图标的 CLI 命令。
 */
const getToolIconColumns = (t: (key: string) => string): ColumnDef<ToolIconMapping>[] => [
  {
    accessorKey: 'iconDataUrl',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.iconHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5">
        <img
          src={row.original.iconDataUrl}
          alt={row.original.displayName}
          className="w-5 h-5 object-contain"
        />
      </div>
    ),
    size: 60,
    enableSorting: false,
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => <SortableHeader column={column} title={t("settings.appearance.toolHeader")} />,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 font-medium">
        {row.original.displayName}
      </div>
    ),
    size: 150,
  },
  {
    accessorKey: 'commands',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.commandsHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 flex flex-wrap gap-1">
        {row.original.commands.map(cmd => (
          <Info_Badge key={cmd} color="muted" className="font-mono">
            {cmd}
          </Info_Badge>
        ))}
      </div>
    ),
    meta: { fillWidth: true },
    enableSorting: false,
  },
]

// ============================================
// 主组件
// ============================================

export default function AppearanceSettingsPage() {
  const { t, i18n } = useTranslation()
  const toolIconColumns = useMemo(() => getToolIconColumns(t), [t])

  const {
    mode,
    setMode,
    colorTheme,
    setColorTheme,
    font,
    setFont,
    activeWorkspaceId,
    setWorkspaceColorTheme,
    themeLoadError,
    themeResolvedFrom,
  } = useTheme()
  const { workspaces, sessionStatuses } = useAppShellContext()

  // 把 workspace 图标读取为 data URL（renderer 中 file:// URL 不工作）
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // 预设主题列表，用于配色主题下拉框
  const [presetThemes, setPresetThemes] = useState<PresetTheme[]>([])

  // 每个 workspace 的主题覆盖（workspaceId -> themeId 或 undefined）
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string | undefined>>({})

  // 从主进程加载的工具图标映射
  const [toolIcons, setToolIcons] = useState<ToolIconMapping[]>([])

  // tool-icons.json 的解析路径（EditPopover 和“编辑文件”入口需要）
  const [toolIconsJsonPath, setToolIconsJsonPath] = useState<string | null>(null)

  // 连接图标显示开关
  const [showConnectionIcons, setShowConnectionIcons] = useState(() =>
    storage.get(storage.KEYS.showConnectionIcons, true)
  )
  const handleConnectionIconsChange = useCallback((checked: boolean) => {
    setShowConnectionIcons(checked)
    storage.set(storage.KEYS.showConnectionIcons, checked)
  }, [])

  // SessionList 中的项目颜色处理方式
  const projectColorTreatment = useProjectColorTreatment()
  const handleProjectColorTreatmentChange = useCallback((value: string) => {
    setProjectColorTreatment(value as ProjectColorTreatment)
  }, [])

  // 各 workspace 的头像颜色覆盖（持久化到 localStorage）
  const [workspaceAvatarColors, setWorkspaceAvatarColors] = useAtom(workspaceAvatarColorsAtom)
  const setWorkspaceAvatarColor = useCallback((workspaceId: string, hex: string) => {
    setWorkspaceAvatarColors(prev => ({ ...prev, [workspaceId]: hex }))
  }, [setWorkspaceAvatarColors])
  const clearWorkspaceAvatarColor = useCallback((workspaceId: string) => {
    setWorkspaceAvatarColors(prev => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
  }, [setWorkspaceAvatarColors])

  // 看板外观（通过 atomWithStorage 持久化到 localStorage）。
  const [kanbanColumnColors, setKanbanColumnColors] = useAtom(kanbanColumnColorsAtom)
  const setKanbanColumnColor = useCallback((column: KanbanColumnId, hex: string) => {
    setKanbanColumnColors(prev => ({ ...prev, [column]: hex }))
  }, [setKanbanColumnColors])
  const resetKanbanColumnColor = useCallback((column: KanbanColumnId) => {
    setKanbanColumnColors(prev => {
      const next = { ...prev }
      delete next[column]
      return next
    })
  }, [setKanbanColumnColors])
  const [kanbanLivePulse, setKanbanLivePulse] = useAtom(kanbanLivePulseAtom)

  // 任务拖入某一列时应用的按列状态。选空（''）会移除映射 → 移动时状态保持不变。
  const [kanbanColumnStatus, setKanbanColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const setColumnStatus = useCallback((column: KanbanColumnId, statusId: string) => {
    setKanbanColumnStatus(prev => {
      const next = { ...prev }
      if (statusId) next[column] = statusId
      else delete next[column]
      return next
    })
  }, [setKanbanColumnStatus])
  const columnStatusOptions = useMemo(
    () => [
      { value: '', label: t("settings.appearance.kanbanColumnStatusNone") },
      ...(sessionStatuses ?? []).map(s => ({ value: s.id, label: s.label })),
    ],
    [sessionStatuses, t]
  )

  // 富工具描述开关（持久化到 config.json，供 SDK 子进程读取）
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)
  useEffect(() => {
    window.electronAPI?.getRichToolDescriptions?.().then(setRichToolDescriptions)
  }, [])
  const handleRichToolDescriptionsChange = useCallback(async (checked: boolean) => {
    setRichToolDescriptions(checked)
    await window.electronAPI?.setRichToolDescriptions?.(checked)
  }, [])

  // “后台会话完成”徽标开关（仅 renderer 端外观偏好，通过 atomWithStorage
  // 持久化到 localStorage — 由 App.tsx 和 ChatPage 读取）。
  const [showBackgroundFinishedChip, setShowBackgroundFinishedChip] = useAtom(showBackgroundFinishedChipAtom)

  // 挂载时加载预设主题
  useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI) {
        setPresetThemes([])
        return
      }
      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
      } catch (error) {
        console.error('Failed to load preset themes:', error)
        setPresetThemes([])
      }
    }
    loadThemes()
  }, [])

  // 挂载时加载各 workspace 的主题覆盖
  useEffect(() => {
    const loadWorkspaceThemes = async () => {
      if (!window.electronAPI?.getAllWorkspaceThemes) return
      try {
        const themes = await window.electronAPI.getAllWorkspaceThemes()
        setWorkspaceThemes(themes)
      } catch (error) {
        console.error('Failed to load workspace themes:', error)
      }
    }
    loadWorkspaceThemes()
  }, [])

  // 挂载时加载工具图标映射并解析配置文件路径
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [mappings, homeDir] = await Promise.all([
          window.electronAPI.getToolIconMappings(),
          window.electronAPI.getHomeDir(),
        ])
        setToolIcons(mappings)
        setToolIconsJsonPath(`${homeDir}/.craft-agent/tool-icons/tool-icons.json`)
      } catch (error) {
        console.error('Failed to load tool icon mappings:', error)
      }
    }
    load()
  }, [])

  // workspace 主题变更处理
  // 当前 workspace 通过 ThemeContext 立即生效，其他 workspace 通过 IPC 持久化
  const handleWorkspaceThemeChange = useCallback(
    async (workspaceId: string, value: string) => {
      // 'default' 表示继承应用默认（存储中用 null 表示）
      const themeId = value === 'default' ? null : value

      // 切换当前 workspace 时通过 context 立即更新视觉
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorTheme(themeId)
      } else {
        // 其他 workspace 仅通过 IPC 持久化
        await window.electronAPI?.setWorkspaceColorTheme?.(workspaceId, themeId)
      }

      // 更新本地 UI 状态
      setWorkspaceThemes(prev => ({
        ...prev,
        [workspaceId]: themeId ?? undefined
      }))
    },
    [activeWorkspaceId, setWorkspaceColorTheme]
  )

  // 下拉框用的主题选项
  const themeOptions = useMemo(() => [
    { value: 'default', label: t("settings.appearance.useDefault") },
    ...presetThemes
      .filter(t => t.id !== 'default')
      .map(t => ({
        value: t.id,
        label: t.theme.name || t.id,
      })),
  ], [presetThemes, t])

  // 当前应用默认主题名称，用于展示（使用 'default' 时返回 null，避免“使用默认（默认）”这种冗余文案）
  const appDefaultLabel = useMemo(() => {
    if (colorTheme === 'default') return null
    const preset = presetThemes.find(t => t.id === colorTheme)
    return preset?.theme.name || colorTheme
  }, [colorTheme, presetThemes])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t("settings.appearance.title")}
        actions={<HeaderMenu route={routes.view.settings('appearance')} helpFeature="themes" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">

              {/* 默认主题 */}
              <SettingsSection title={t("settings.appearance.defaultTheme")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.appearance.mode")}>
                    <SettingsSegmentedControl
                      value={mode}
                      onValueChange={setMode}
                      options={[
                        { value: 'system', label: t("settings.appearance.system"), icon: <Monitor className="w-4 h-4" /> },
                        { value: 'light', label: t("settings.appearance.light"), icon: <Sun className="w-4 h-4" /> },
                        { value: 'dark', label: t("settings.appearance.dark"), icon: <Moon className="w-4 h-4" /> },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.colorTheme")}>
                    <SettingsMenuSelect
                      value={colorTheme}
                      onValueChange={setColorTheme}
                      options={themeOptions}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.font")}>
                    <SettingsSegmentedControl
                      value={font}
                      onValueChange={setFont}
                      options={[
                        { value: 'inter', label: t("settings.appearance.fontInter") },
                        { value: 'system', label: t("settings.appearance.fontSystem") },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.language")}>
                    <SettingsMenuSelect
                      value={(i18n.resolvedLanguage ?? i18n.language) as LanguageCode}
                      onValueChange={(value) => {
                        console.info('[i18n] Appearance dropdown change', {
                          from: i18n.resolvedLanguage ?? null,
                          to: value,
                        })
                        i18n.changeLanguage(value)
                        window.electronAPI?.changeLanguage?.(value)
                      }}
                      options={Object.entries(LANGUAGES).map(([code, config]) => ({
                        value: code,
                        label: config.nativeName,
                      }))}
                    />
                  </SettingsRow>
                </SettingsCard>
                {themeLoadError && (
                  <p className="mt-2 text-xs text-info">
                    {t("settings.appearance.themeWarning")} {themeLoadError} ({themeResolvedFrom === 'fallback' ? t("settings.appearance.usingBundledFallback") : t("settings.appearance.usingDefaultTheme")})
                  </p>
                )}
              </SettingsSection>

              {/* Workspace 主题 */}
              {workspaces.length > 0 && (
                <SettingsSection
                  title={t("settings.appearance.workspaceThemes")}
                  description={t("settings.appearance.workspaceThemesDesc")}
                >
                  <SettingsCard>
                    {workspaces.map((workspace) => {
                      const wsTheme = workspaceThemes[workspace.id]
                      const hasCustomTheme = wsTheme !== undefined
                      return (
                        <SettingsRow
                          key={workspace.id}
                          label={
                            <div className="flex items-center gap-2">
                              <ColorPicker
                                value={workspaceAvatarColors[workspace.id] || ''}
                                onChange={(hex) => setWorkspaceAvatarColor(workspace.id, hex)}
                                onClear={() => clearWorkspaceAvatarColor(workspace.id)}
                                clearLabel={t("settings.appearance.workspaceAvatarReset")}
                                presets={PROJECT_COLOR_PALETTE}
                                ariaLabel={t("settings.appearance.workspaceAvatarColor")}
                                trigger={
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded hover:ring-2 hover:ring-foreground/20 transition-shadow"
                                    aria-label={t("settings.appearance.workspaceAvatarColor")}
                                  >
                                    <WorkspaceAvatar
                                      workspaceId={workspace.id}
                                      workspaceName={workspace.name}
                                      src={workspaceIconMap.get(workspace.id)}
                                      className="w-4 h-4 rounded"
                                    />
                                  </button>
                                }
                              />
                              <span>{workspace.name}</span>
                            </div>
                          }
                        >
                          <SettingsMenuSelect
                            value={hasCustomTheme ? wsTheme : 'default'}
                            onValueChange={(value) => handleWorkspaceThemeChange(workspace.id, value)}
                            options={[
                              { value: 'default', label: appDefaultLabel ? t("settings.appearance.useDefaultWithTheme", { theme: appDefaultLabel }) : t("settings.appearance.useDefault") },
                              ...presetThemes
                                .filter(t => t.id !== 'default')
                                .map(t => ({
                                  value: t.id,
                                  label: t.theme.name || t.id,
                                })),
                            ]}
                          />
                        </SettingsRow>
                      )
                    })}
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* 界面 */}
              <SettingsSection title={t("settings.appearance.interface")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.appearance.connectionIcons")}
                    description={t("settings.appearance.connectionIconsDesc")}
                    checked={showConnectionIcons}
                    onCheckedChange={handleConnectionIconsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.richToolDescriptions")}
                    description={t("settings.appearance.richToolDescriptionsDesc")}
                    checked={richToolDescriptions}
                    onCheckedChange={handleRichToolDescriptionsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.backgroundFinishedChip")}
                    description={t("settings.appearance.backgroundFinishedChipDesc")}
                    checked={showBackgroundFinishedChip}
                    onCheckedChange={setShowBackgroundFinishedChip}
                  />
                  <SettingsRow
                    label={t("settings.appearance.projectColorTreatment")}
                    description={t("settings.appearance.projectColorTreatmentDesc")}
                  >
                    <SettingsMenuSelect
                      value={projectColorTreatment}
                      onValueChange={handleProjectColorTreatmentChange}
                      options={[
                        { value: 'stripe', label: t("settings.appearance.projectColorStripe") },
                        { value: 'stripe-tint', label: t("settings.appearance.projectColorStripeTint") },
                      ]}
                    />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Kanban board — column colors + live-pulse toggle */}
              <SettingsSection
                title={t("settings.appearance.kanbanBoard")}
                description={t("settings.appearance.kanbanBoardDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => {
                    const merged = kanbanColumnColors[column.id] ?? DEFAULT_KANBAN_COLUMN_COLORS[column.id]
                    return (
                      <SettingsRow key={column.id} label={t(column.labelKey)}>
                        <ColorPicker
                          value={merged}
                          onChange={(hex) => setKanbanColumnColor(column.id, hex)}
                          onClear={kanbanColumnColors[column.id] ? () => resetKanbanColumnColor(column.id) : undefined}
                          clearLabel={t("settings.appearance.kanbanColumnColorReset")}
                          presets={PROJECT_COLOR_PALETTE}
                          ariaLabel={t("settings.appearance.kanbanColumnColor", { column: t(column.labelKey) })}
                          align="end"
                        />
                      </SettingsRow>
                    )
                  })}
                  <SettingsToggle
                    label={t("settings.appearance.kanbanLivePulse")}
                    description={t("settings.appearance.kanbanLivePulseDesc")}
                    checked={kanbanLivePulse}
                    onCheckedChange={setKanbanLivePulse}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Kanban status automation — status applied on drag into a column */}
              <SettingsSection
                title={t("settings.appearance.kanbanColumnStatus")}
                description={t("settings.appearance.kanbanColumnStatusDesc")}
              >
                <SettingsCard>
                  {KANBAN_COLUMNS.map(column => (
                    <SettingsRow key={column.id} label={t(column.labelKey)}>
                      <SettingsMenuSelect
                        value={kanbanColumnStatus[column.id] ?? ''}
                        onValueChange={(value) => setColumnStatus(column.id, value)}
                        options={columnStatusOptions}
                      />
                    </SettingsRow>
                  ))}
                </SettingsCard>
              </SettingsSection>

              {/* 工具图标：展示 turn cards 中使用的命令 → 图标映射 */}
              <SettingsSection
                title={t("settings.appearance.toolIcons")}
                description={t("settings.appearance.toolIconsDesc")}
                action={
                  toolIconsJsonPath ? (
                    <EditPopover
                      trigger={<EditButton />}
                      {...getEditConfig('edit-tool-icons', toolIconsJsonPath)}
                      secondaryAction={{
                        label: t("settings.appearance.editFile"),
                        filePath: toolIconsJsonPath,
                      }}
                    />
                  ) : undefined
                }
              >
                <SettingsCard>
                  <Info_DataTable
                    columns={toolIconColumns}
                    data={toolIcons}
                    searchable={{ placeholder: t("settings.appearance.searchTools") }}
                    maxHeight={480}
                    emptyContent={t("settings.appearance.noToolIcons")}
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

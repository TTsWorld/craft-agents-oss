/**
 * MessagingSettingsPage
 *
 * 配置消息平台连接（Telegram、WhatsApp、Lark）并查看当前绑定的会话。
 *
 * 布局：
 *  - 每个平台对应一张 SettingsCard
 *  - 每张卡片渲染一行 PlatformRow：[品牌图标] [名称] [API · 状态]，
 *    未连接时显示“连接”按钮，已连接时显示三点菜单
 *  - Telegram 特化：机器人行下方直接展示私信绑定，再通过分隔线展示可折叠的 Supergroup 区块，
 *    展开后显示话题绑定；折叠箭头样式与 AiSettingsPage 的 WorkspaceOverrideCard 保持一致
 *  - WhatsApp / Lark：绑定会话在机器人行下方以平铺列表展示
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Hash,
  LockOpen,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  PowerOff,
  RefreshCcw,
  Settings2,
  Trash2,
} from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { MessagingPlatformIcon } from '@/components/messaging/MessagingPlatformIcon'
import { TelegramConnectDialog } from '@/components/messaging/TelegramConnectDialog'
import { LarkConnectDialog } from '@/components/messaging/LarkConnectDialog'
import { TelegramSupergroupPairingDialog } from '@/components/messaging/TelegramSupergroupPairingDialog'
import { WhatsAppConnectDialog } from '@/components/messaging/WhatsAppConnectDialog'
import {
  BindingAllowListPopover,
  TelegramAccessSection,
  type BindingAccess,
  type BindingAccessMode,
  type PlatformAccessMode,
  type PlatformOwner,
} from '@/components/messaging/access'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import {
  messagingBindingsAtom,
  setMessagingBindingsAtom,
  type MessagingBinding,
} from '@/atoms/messaging'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { MessagingPlatformRuntimeInfo } from '../../../shared/types'

/** 页面元数据：设置导航中的“消息平台”页面 */
export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'messaging',
}

/** 消息平台设置页面 */
export default function MessagingSettingsPage() {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const setBindings = useSetAtom(setMessagingBindingsAtom)
  const workspaceId = activeWorkspace?.id

  // 在页面层级统一拉取并订阅消息绑定数据，避免两个 PlatformRow 各自订阅两次
  React.useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    const load = async () => {
      try {
        const rows = await window.electronAPI.getMessagingBindings()
        if (!cancelled) setBindings(rows as MessagingBinding[])
      } catch {
        // 静默失败：首次加载时弹 Toast 会过于嘈杂
      }
    }
    load()
    const off = window.electronAPI.onMessagingBindingChanged((wsId) => {
      if (wsId === workspaceId) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [workspaceId, setBindings])

  if (!activeWorkspace) return null

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('settings.messaging.title')} />
      <ScrollArea className="flex-1">
        <div className="space-y-6 p-6">
          <SettingsSection title={t('settings.messaging.title')}>
            <SettingsCard>
              <PlatformRow platform="telegram" workspaceId={activeWorkspace.id} />
            </SettingsCard>
            <SettingsCard>
              <PlatformRow platform="whatsapp" workspaceId={activeWorkspace.id} />
            </SettingsCard>
            <SettingsCard>
              <PlatformRow platform="lark" workspaceId={activeWorkspace.id} />
            </SettingsCard>
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 平台行
// ---------------------------------------------------------------------------

type Platform = 'telegram' | 'whatsapp' | 'lark'

const PLATFORM_LABEL_KEYS: Record<Platform, string> = {
  telegram: 'settings.messaging.telegram.title',
  whatsapp: 'settings.messaging.whatsapp.title',
  lark: 'settings.messaging.lark.title',
}

// 机器人行头与所有子行共用的列几何参数：
// 16px 外边框 (`px-4`) + 22px 图标槽 + 12px 间距 (`gap-3`)。
// 次级图标以 16px 渲染并居中在同一 22px 槽内，保持视觉层级且不让列边缘错位。
const ROW_ICON_SIZE = 22
const SUB_ROW_ICON_SIZE = 16
const SUB_ROW_ICON_STROKE = 1.5

/** 22px 宽的占位元素，让行继承图标列尺寸而不实际渲染图标（用于与上方 Supergroup 名称对齐的话题行）。 */
function IconSpacer() {
  return <div className="shrink-0" style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }} />
}

/** 将 Lucide 图标以 `SUB_ROW_ICON_SIZE` 大小包裹在行内的 22px 槽中，使其与上方机器人图标在同一列居中。 */
function SubRowIcon({
  icon: Icon,
  size = SUB_ROW_ICON_SIZE,
  strokeWidth = SUB_ROW_ICON_STROKE,
}: {
  icon: typeof MessageSquare
  size?: number
  strokeWidth?: number
}) {
  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
    >
      <Icon
        className="text-foreground/50"
        strokeWidth={strokeWidth}
        style={{ width: size, height: size }}
      />
    </div>
  )
}

function CardSeparator() {
  return <div className="mx-4 h-px bg-border/50" />
}

function PlatformRow({ platform, workspaceId }: { platform: Platform; workspaceId: string }) {
  const { t } = useTranslation()
  const allBindings = useAtomValue(messagingBindingsAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const { navigateToSession } = useNavigation()
  const [runtime, setRuntime] = React.useState<MessagingPlatformRuntimeInfo>(() =>
    defaultRuntime(platform),
  )
  const [connectOpen, setConnectOpen] = React.useState(false)
  const [reconfigure, setReconfigure] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  // Telegram Supergroup 状态 —— 仅在 platform === 'telegram' 时有效。
  // 提升到 PlatformRow 层级，使 Supergroup 子行与机器人连接共用同一张 SettingsCard。
  const [supergroup, setSupergroup] = React.useState<{ chatId: string; title: string } | null>(null)
  const [supergroupDialogOpen, setSupergroupDialogOpen] = React.useState(false)

  // Telegram 工作区访问模式 —— 仅 Telegram 有效。
  // 提升到本组件，使下拉菜单决定是否显示“解锁”，并将受控值传给 TelegramAccessSection；与 supergroup 状态对称管理。
  const [telegramAccessMode, setTelegramAccessMode] =
    React.useState<PlatformAccessMode>('open')

  const refreshSupergroup = React.useCallback(async () => {
    if (platform !== 'telegram') return
    try {
      const sg = await window.electronAPI.getMessagingSupergroup()
      setSupergroup(sg ? { chatId: sg.chatId, title: sg.title } : null)
    } catch {
      // 静默失败：空状态即表示“未配置”
    }
  }, [platform])

  const refreshTelegramAccessMode = React.useCallback(async () => {
    if (platform !== 'telegram') return
    try {
      const mode = await window.electronAPI.getMessagingPlatformAccessMode('telegram')
      setTelegramAccessMode(mode as PlatformAccessMode)
    } catch {
      // 静默失败：默认值 'open' 已覆盖初始/未连接状态
    }
  }, [platform])

  React.useEffect(() => {
    refreshSupergroup()
  }, [refreshSupergroup, workspaceId])

  React.useEffect(() => {
    if (platform !== 'telegram') return
    void refreshTelegramAccessMode()
    // 锁定操作会把 open 绑定迁移为 inherit，触发 onMessagingBindingChanged；
    // 解锁不会迁移，但 PlatformRow 与 TelegramAccessSection 在写入 API 后都会调用 setTelegramAccessMode，
    // 因此受控属性无需额外事件即可保持同步。
    const off = window.electronAPI.onMessagingBindingChanged((wsId) => {
      if (wsId === workspaceId) void refreshTelegramAccessMode()
    })
    return () => off()
  }, [platform, workspaceId, refreshTelegramAccessMode])

  const platformBindings = React.useMemo(
    () =>
      allBindings
        .filter((b) => b.platform === platform)
        .sort((a, b) => b.createdAt - a.createdAt),
    [allBindings, platform],
  )

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getMessagingConfig().then((cfg) => {
      if (cancelled) return
      const next = cfg?.runtime?.[platform]
      setRuntime((next ?? defaultRuntime(platform)) as MessagingPlatformRuntimeInfo)
    })
    const off = window.electronAPI.onMessagingPlatformStatus((wsId, p, status) => {
      if (wsId !== workspaceId || p !== platform) return
      setRuntime(status)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [platform, workspaceId])

  // 沿用 AI 设置页的处理模式：先关闭菜单，再在下一帧执行操作，避免已知的菜单/对话框卸载竞态。
  const runAfterMenuClose = React.useCallback((action: () => void) => {
    setMenuOpen(false)
    requestAnimationFrame(action)
  }, [])

  const handleConnect = () => {
    setReconfigure(false)
    setConnectOpen(true)
  }

  const handleReconfigure = () => {
    setReconfigure(true)
    setConnectOpen(true)
  }

  const handleUnlock = async () => {
    try {
      await window.electronAPI.setMessagingPlatformAccessMode('telegram', 'open')
      toast.success(t('toast.messagingTelegramUnlocked'))
      setTelegramAccessMode('open')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const handleDisconnect = async () => {
    try {
      await window.electronAPI.disconnectMessagingPlatform(platform)
      toast.success(
        t(`settings.messaging.${platform}.disconnected`, {
          defaultValue: 'Disconnected',
        }),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const handleForget = async () => {
    try {
      await window.electronAPI.forgetMessagingPlatform(platform)
      toast.success(
        t(`settings.messaging.${platform}.disconnected`, {
          defaultValue: 'Disconnected',
        }),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const handleUnbind = async (binding: MessagingBinding) => {
    try {
      await window.electronAPI.unbindMessagingBinding(binding.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  const description = buildDescription(platform, runtime, t)
  const label = t(PLATFORM_LABEL_KEYS[platform])

  return (
    <>
      <div>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <MessagingPlatformIcon platform={platform} size={22} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{label}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {t(`settings.messaging.${platform}.apiType`)} · {description}
            </div>
          </div>

          {runtime.connected ? (
            <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded-md p-1.5 transition-colors hover:bg-foreground/[0.05] data-[state=open]:bg-foreground/[0.05]"
                  data-state={menuOpen ? 'open' : 'closed'}
                  aria-label={t('common.more')}
                >
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                {platform === 'telegram' ? (
                  <>
                    <StyledDropdownMenuItem onClick={() => runAfterMenuClose(handleReconfigure)}>
                      <Settings2 className="h-3.5 w-3.5" />
                      <span>{t('common.reconfigure')}</span>
                    </StyledDropdownMenuItem>
                    {telegramAccessMode === 'owner-only' && (
                      <StyledDropdownMenuItem onClick={() => runAfterMenuClose(handleUnlock)}>
                        <LockOpen className="h-3.5 w-3.5" />
                        <span>{t('settings.messaging.telegram.unlock')}</span>
                      </StyledDropdownMenuItem>
                    )}
                    <StyledDropdownMenuSeparator />
                    <StyledDropdownMenuItem onClick={handleDisconnect} variant="destructive">
                      <PowerOff className="h-3.5 w-3.5" />
                      <span>{t('common.disconnect')}</span>
                    </StyledDropdownMenuItem>
                  </>
                ) : (
                  <>
                    <StyledDropdownMenuItem onClick={() => runAfterMenuClose(handleConnect)}>
                      <RefreshCcw className="h-3.5 w-3.5" />
                      <span>{t('common.reconnect')}</span>
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuItem onClick={handleDisconnect}>
                      <PowerOff className="h-3.5 w-3.5" />
                      <span>{t('common.disable')}</span>
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuSeparator />
                    <StyledDropdownMenuItem onClick={handleForget} variant="destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{t('common.disconnect')}</span>
                    </StyledDropdownMenuItem>
                  </>
                )}
              </StyledDropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" size="sm" onClick={handleConnect}>
              <Plus className="h-3.5 w-3.5" />
              {t('common.connect')}
            </Button>
          )}
        </div>

        {platform === 'telegram' && runtime.connected ? (
          <>
            <TelegramAccessSection
              workspaceId={workspaceId}
              accessMode={telegramAccessMode}
              onAccessModeChange={setTelegramAccessMode}
            />
            <TelegramBindingsBody
              bindings={platformBindings}
              sessionMetaMap={sessionMetaMap}
              supergroup={supergroup}
              onPairSupergroup={() => setSupergroupDialogOpen(true)}
              onUnpairSupergroup={async () => {
                try {
                  await window.electronAPI.unbindMessagingSupergroup()
                  toast.success(
                    t('settings.messaging.telegram.supergroup.disconnected', {
                      defaultValue: 'Supergroup disconnected',
                    }),
                  )
                  refreshSupergroup()
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : t('common.error'))
                }
              }}
              onOpenSession={(b) => navigateToSession(b.sessionId)}
              onUnbind={handleUnbind}
            />
          </>
        ) : platformBindings.length > 0 ? (
          <>
            <CardSeparator />
            <div className="divide-y divide-border/50">
              {platformBindings.map((binding) => (
                <FlatBindingRow
                  key={binding.id}
                  binding={binding}
                  sessionMetaMap={sessionMetaMap}
                  onOpen={() => navigateToSession(binding.sessionId)}
                  onUnbind={() => handleUnbind(binding)}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      {platform === 'telegram' && (
        <>
          <TelegramConnectDialog
            open={connectOpen}
            onOpenChange={setConnectOpen}
            reconfigure={reconfigure}
          />
          <TelegramSupergroupPairingDialog
            open={supergroupDialogOpen}
            onOpenChange={setSupergroupDialogOpen}
            botUsername={runtime.identity}
            onPaired={refreshSupergroup}
          />
        </>
      )}
      {platform === 'whatsapp' && (
        <WhatsAppConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      )}
      {platform === 'lark' && (
        <LarkConnectDialog open={connectOpen} onOpenChange={setConnectOpen} reconfigure={reconfigure} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Telegram 绑定内容区 —— 私信会话 + 可折叠的 Supergroup
// ---------------------------------------------------------------------------

interface TelegramBindingsBodyProps {
  bindings: MessagingBinding[]
  sessionMetaMap: Map<string, SessionMeta>
  supergroup: { chatId: string; title: string } | null
  onPairSupergroup: () => void
  onUnpairSupergroup: () => void
  onOpenSession: (binding: MessagingBinding) => void
  onUnbind: (binding: MessagingBinding) => void
}

function bindingToAccess(binding: MessagingBinding): BindingAccess {
  return {
    mode: binding.accessMode ?? 'open',
    allowedSenderIds: binding.allowedSenderIds ?? [],
  }
}

function TelegramBindingsBody({
  bindings,
  sessionMetaMap,
  supergroup,
  onPairSupergroup,
  onUnpairSupergroup,
  onOpenSession,
  onUnbind,
}: TelegramBindingsBodyProps) {
  const [workspaceOwners, setWorkspaceOwners] = React.useState<PlatformOwner[]>([])

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const owners = await window.electronAPI.getMessagingPlatformOwners('telegram')
        if (!cancelled) setWorkspaceOwners(owners)
      } catch {
        // 静默失败：回退到空列表，BindingAllowListPopover 会优雅处理（显示“无已知用户”提示）
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [bindings])

  const handleAccessChange = React.useCallback(
    async (bindingId: string, next: BindingAccess) => {
      try {
        await window.electronAPI.setMessagingBindingAccess(bindingId, {
          mode: next.mode as BindingAccessMode,
          ...(next.mode === 'allow-list' ? { allowedSenderIds: next.allowedSenderIds } : {}),
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update access')
      }
    },
    [],
  )
  // Telegram 绑定按 `threadId` 一分为二：
  //   - undefined: 私信（direct session），每个工作区最多一个
  //   - number:    已配对 Supergroup 中的话题
  const directBindings = React.useMemo(() => bindings.filter((b) => b.threadId === undefined), [bindings])
  const topicBindings = React.useMemo(() => bindings.filter((b) => b.threadId !== undefined), [bindings])

  return (
    <>
      {directBindings.length > 0 && (
        <>
          <CardSeparator />
          <div className="divide-y divide-border/50">
            {directBindings.map((binding) => (
              <DirectSessionRow
                key={binding.id}
                binding={binding}
                sessionMetaMap={sessionMetaMap}
                workspaceOwners={workspaceOwners}
                onOpen={() => onOpenSession(binding)}
                onUnbind={() => onUnbind(binding)}
                onAccessChange={(next) => handleAccessChange(binding.id, next)}
              />
            ))}
          </div>
        </>
      )}

      <CardSeparator />
      {supergroup ? (
        <PairedSupergroupSection
          supergroup={supergroup}
          topicBindings={topicBindings}
          sessionMetaMap={sessionMetaMap}
          workspaceOwners={workspaceOwners}
          onUnpair={onUnpairSupergroup}
          onOpenSession={onOpenSession}
          onUnbindTopic={onUnbind}
          onAccessChange={handleAccessChange}
        />
      ) : (
        <UnpairedSupergroupRow onPair={onPairSupergroup} />
      )}
    </>
  )
}

function DirectSessionRow({
  binding,
  sessionMetaMap,
  workspaceOwners,
  onOpen,
  onUnbind,
  onAccessChange,
}: {
  binding: MessagingBinding
  sessionMetaMap: TelegramBindingsBodyProps['sessionMetaMap']
  workspaceOwners: PlatformOwner[]
  onOpen: () => void
  onUnbind: () => void
  onAccessChange: (next: BindingAccess) => void
}) {
  const { t } = useTranslation()
  const meta = sessionMetaMap.get(binding.sessionId)
  const sessionLabel = meta ? getSessionTitle(meta) : binding.channelName || binding.channelId
  // 此处布局约定与 Supergroup 行保持一致：绑定“类型”（私信会话）作为主标签，会话名作为副标题，
  // 使 Direct 行与 Supergroup 行在视觉上保持平行。
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <SubRowIcon icon={MessageSquare} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {t('settings.messaging.telegram.directSessionSubtitle', {
            defaultValue: 'Direct message session',
          })}
        </div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">{sessionLabel}</div>
      </div>
      <BindingAllowListPopover
        access={bindingToAccess(binding)}
        workspaceOwners={workspaceOwners}
        onChange={onAccessChange}
      />
      <RowActions onOpen={onOpen} onUnbind={onUnbind} />
    </div>
  )
}

function UnpairedSupergroupRow({ onPair }: { onPair: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <SubRowIcon icon={MessagesSquare} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          {t('settings.messaging.telegram.supergroup.label', { defaultValue: 'Supergroup' })}
        </div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          {t('settings.messaging.telegram.supergroup.notConfigured', {
            defaultValue: 'Not configured',
          })}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onPair}>
        <Plus className="h-3.5 w-3.5" />
        {t('settings.messaging.telegram.supergroup.pair', { defaultValue: 'Pair Supergroup' })}
      </Button>
    </div>
  )
}

function PairedSupergroupSection({
  supergroup,
  topicBindings,
  sessionMetaMap,
  workspaceOwners,
  onUnpair,
  onOpenSession,
  onUnbindTopic,
  onAccessChange,
}: {
  supergroup: { chatId: string; title: string }
  topicBindings: MessagingBinding[]
  sessionMetaMap: TelegramBindingsBodyProps['sessionMetaMap']
  workspaceOwners: PlatformOwner[]
  onUnpair: () => void
  onOpenSession: (binding: MessagingBinding) => void
  onUnbindTopic: (binding: MessagingBinding) => void
  onAccessChange: (bindingId: string, next: BindingAccess) => void
}) {
  const { t } = useTranslation()
  // 存在话题时默认展开，让用户立即看到自动化路由的目标位置；
  // 尚未绑定任何话题时保持折叠，避免空状态占用空间。
  const [isExpanded, setIsExpanded] = React.useState(topicBindings.length > 0)

  const subtitle =
    topicBindings.length === 0
      ? t('settings.messaging.telegram.supergroup.autoTopicNote')
      : t('settings.messaging.telegram.supergroup.topicsBound', {
          count: topicBindings.length,
          defaultValue: '{{count}} topics bound',
        })

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]"
      >
        <SubRowIcon icon={MessagesSquare} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <div className="truncate text-sm font-medium">{supergroup.title}</div>
            <div className="truncate text-xs text-foreground/50">({supergroup.chatId})</div>
          </div>
          <div className="mt-0.5 truncate text-xs text-foreground/50">{subtitle}</div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground/50" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50">
              {topicBindings.length === 0 ? (
                <div className="flex items-start gap-3 px-4 py-3 text-xs text-foreground/50">
                  <IconSpacer />
                  <span>
                    {t('settings.messaging.telegram.supergroup.noTopicsHint', {
                      defaultValue:
                        'No topics bound yet — automations with `telegramTopic` will create them.',
                    })}
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {topicBindings.map((binding) => (
                    <TopicBindingRow
                      key={binding.id}
                      binding={binding}
                      sessionMetaMap={sessionMetaMap}
                      workspaceOwners={workspaceOwners}
                      onOpen={() => onOpenSession(binding)}
                      onUnbind={() => onUnbindTopic(binding)}
                      onAccessChange={(next) => onAccessChange(binding.id, next)}
                    />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 px-4 py-2">
                <IconSpacer />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={onUnpair}
                >
                  {t('common.disconnect')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TopicBindingRow({
  binding,
  sessionMetaMap,
  workspaceOwners,
  onOpen,
  onUnbind,
  onAccessChange,
}: {
  binding: MessagingBinding
  sessionMetaMap: TelegramBindingsBodyProps['sessionMetaMap']
  workspaceOwners: PlatformOwner[]
  onOpen: () => void
  onUnbind: () => void
  onAccessChange: (next: BindingAccess) => void
}) {
  const meta = sessionMetaMap.get(binding.sessionId)
  const sessionLabel = meta ? getSessionTitle(meta) : binding.channelName || binding.channelId
  const topicName = binding.channelName || binding.channelId
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <IconSpacer />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{sessionLabel}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground/50">
          <Hash className="h-3 w-3" />
          <span className="truncate">
            {topicName} <span className="text-foreground/30">·</span> Topic #{binding.threadId}
          </span>
        </div>
      </div>
      <BindingAllowListPopover
        access={bindingToAccess(binding)}
        workspaceOwners={workspaceOwners}
        onChange={onAccessChange}
      />
      <RowActions onOpen={onOpen} onUnbind={onUnbind} />
    </div>
  )
}

function FlatBindingRow({
  binding,
  sessionMetaMap,
  onOpen,
  onUnbind,
}: {
  binding: MessagingBinding
  sessionMetaMap: TelegramBindingsBodyProps['sessionMetaMap']
  onOpen: () => void
  onUnbind: () => void
}) {
  // WhatsApp + Lark 使用（无 Supergroup/话题概念）—— 紧凑行样式与 Telegram 拆分前一致。
  const meta = sessionMetaMap.get(binding.sessionId)
  const sessionLabel = meta ? getSessionTitle(meta) : binding.channelName || binding.channelId
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 pl-[52px]">
      <div className="min-w-0 truncate text-sm">{sessionLabel}</div>
      <RowActions onOpen={onOpen} onUnbind={onUnbind} />
    </div>
  )
}

function RowActions({ onOpen, onUnbind }: { onOpen: () => void; onUnbind: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" onClick={onOpen}>
        <ArrowUpRight className="h-3.5 w-3.5" />
        {t('settings.messaging.bindings.openSession')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={onUnbind}
      >
        {t('common.disconnect')}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function buildDescription(
  platform: Platform,
  runtime: MessagingPlatformRuntimeInfo,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (runtime.connected) {
    if (platform === 'whatsapp' && runtime.identity) {
      return t('dialog.whatsapp.connectedAs', { name: runtime.identity })
    }
    if (platform === 'telegram' && runtime.identity) {
      return t('settings.messaging.telegram.validBot', { username: runtime.identity })
    }
    return t(`settings.messaging.${platform}.connected`, { defaultValue: 'Connected' })
  }
  if (runtime.state === 'connecting') {
    return t('dialog.whatsapp.starting', { defaultValue: 'Connecting…' })
  }
  if (runtime.state === 'error' && runtime.lastError) {
    return runtime.lastError
  }
  return t(`settings.messaging.${platform}.notConnected`, { defaultValue: 'Not connected' })
}

function defaultRuntime(platform: Platform): MessagingPlatformRuntimeInfo {
  return {
    platform,
    configured: false,
    connected: false,
    state: 'disconnected',
    updatedAt: Date.now(),
  }
}

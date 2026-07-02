/**
 * TelegramAccessSection
 *
 * 真实运行环境（非 playground）下的包装组件，从 messaging registry 加载：
 *  - 已授权用户列表（owners）
 *  - 工作空间级访问模式（accessMode）
 *  - 待审批发送者（pending senders）
 * 然后在 Settings → Messaging 的 Telegram 卡片内部渲染工作空间级访问控制。
 *
 * UI 分为三部分：
 *  1. AccessModeBanner：仅在 `accessMode === 'open'` 或存在 open binding 时显示
 *  2. 可折叠的“Allowed users”行（图标 + 箭头，参考 PairedSupergroupSection）
 *     展开后显示 OwnersListEditor，带 topic 行风格的缩进
 *  3. PendingSendersList + 标题（仅当有 pending 发送者时渲染）
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, MessageSquare, Users } from 'lucide-react'
import { messagingBindingsAtom } from '@/atoms/messaging'
import {
  AccessModeBanner,
  OwnersListEditor,
  PendingSendersList,
  type PendingSender,
  type PlatformAccessMode,
  type PlatformOwner,
} from './'

const ROW_ICON_SIZE = 22
const SUB_ROW_ICON_SIZE = 16
const SUB_ROW_ICON_STROKE = 1.5

/**
 * 判断两条 pending 记录是否对应同一行。
 * 必须 platform、userId、reason、bindingId 都相同才算同一行；
 * 同一个发送者在不同 binding 里的记录要分开展示。
 */
function sameRow(a: PendingSender, b: PendingSender): boolean {
  return (
    a.platform === b.platform &&
    a.userId === b.userId &&
    (a.reason ?? 'not-owner') === (b.reason ?? 'not-owner') &&
    (a.bindingId ?? null) === (b.bindingId ?? null)
  )
}

interface Props {
  workspaceId: string
  // 工作空间级 Telegram 访问模式。由父组件控制，确保 banner、折叠副标题、
  // 平台行下拉菜单里的“锁定/解锁”都读取同一个数据源。
  accessMode: PlatformAccessMode
  onAccessModeChange: (mode: PlatformAccessMode) => void
}

export function TelegramAccessSection({ workspaceId, accessMode, onAccessModeChange }: Props) {
  const { t } = useTranslation()
  const allBindings = useAtomValue(messagingBindingsAtom)
  const [owners, setOwners] = React.useState<PlatformOwner[]>([])
  const [pending, setPending] = React.useState<PendingSender[]>([])

  // banner 在以下两种情况下都要保持显示：
  // 1) 工作空间级 accessMode === 'open'
  // 2) 某个旧的 binding 仍然是 'open' 模式
  // 如果不检查第 2 点，用户点击“锁定”后 banner 会消失，但实际上具体 binding 仍在放行陌生人。
  const hasOpenBinding = React.useMemo(
    () => allBindings.some((b) => b.platform === 'telegram' && b.accessMode === 'open'),
    [allBindings],
  )
  const showBanner = accessMode === 'open' || hasOpenBinding

  // 同时拉取 owner 列表和 pending 列表；任一失败时回退为空数组，避免组件崩溃。
  const loadAll = React.useCallback(async () => {
    const [o, p] = await Promise.all([
      window.electronAPI.getMessagingPlatformOwners('telegram').catch(() => []),
      window.electronAPI.getMessagingPendingSenders('telegram').catch(() => []),
    ])
    setOwners(o)
    setPending(p)
  }, [])

  React.useEffect(() => {
    void loadAll()
    // 监听 binding 变化和 pending 变化事件，仅当事件对应当前工作空间时刷新数据
    const offBinding = window.electronAPI.onMessagingBindingChanged((wsId) => {
      if (wsId === workspaceId) void loadAll()
    })
    const offPending = window.electronAPI.onMessagingPendingChanged?.((wsId) => {
      if (wsId === workspaceId) void loadAll()
    })
    return () => {
      offBinding()
      offPending?.()
    }
  }, [workspaceId, loadAll])

  // 点击 banner 的“锁定”按钮：把工作空间 Telegram 访问模式设为 owner-only
  const handleLockDown = async () => {
    try {
      await window.electronAPI.setMessagingPlatformAccessMode('telegram', 'owner-only')
      toast.success(t('toast.messagingTelegramLockedDown'))
      onAccessModeChange('owner-only')
      await loadAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
  }

  // 从 owner 列表移除某个用户：先本地过滤，再调用 IPC 持久化
  const handleRemoveOwner = async (userId: string) => {
    const next = owners.filter((o) => o.userId !== userId)
    try {
      await window.electronAPI.setMessagingPlatformOwners('telegram', next)
      setOwners(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove owner')
    }
  }

  // 允许某个 pending 发送者：根据 reason/bindingId 构造 entryKey，调用 IPC
  // 然后只移除我们刚刚操作的那一行（同一发送者的其他 reason/binding 组合仍保留）
  const handleAllow = async (sender: PendingSender) => {
    try {
      const entryKey = {
        ...(sender.reason ? { reason: sender.reason } : {}),
        ...(sender.bindingId ? { bindingId: sender.bindingId } : {}),
      }
      const result = await window.electronAPI.allowMessagingPendingSender(
        'telegram',
        sender.userId,
        entryKey,
      )
      setOwners(result.owners)
      setPending((prev) =>
        prev.filter((p) => !sameRow(p, sender)),
      )
      toast.success(`Allowed ${sender.displayName || sender.username || sender.userId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to allow sender')
    }
  }

  // 忽略某个 pending 发送者：仅把它从 pending 列表移除，不授予任何权限
  const handleIgnore = async (sender: PendingSender) => {
    try {
      await window.electronAPI.dismissMessagingPendingSender(
        'telegram',
        sender.userId,
        {
          ...(sender.reason ? { reason: sender.reason } : {}),
          ...(sender.bindingId ? { bindingId: sender.bindingId } : {}),
        },
      )
      setPending((prev) => prev.filter((p) => !sameRow(p, sender)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to dismiss sender')
    }
  }

  return (
    <>
      {showBanner && (
        <AccessModeBanner
          onLockDown={handleLockDown}
          // 如果工作空间已锁定但某个 binding 仍是 open，替换说明文字，
          // 让管理员知道真正需要操作的是 binding 行，而不是工作空间开关。
          {...(accessMode === 'owner-only' && hasOpenBinding
            ? {
                description: t(
                  'settings.messaging.telegram.access.banner.descriptionLegacyBinding',
                ),
              }
            : {})}
        />
      )}

      <SectionDivider />
      <AllowedUsersCollapsible
        owners={owners}
        accessMode={accessMode}
        onRemove={handleRemoveOwner}
      />

      {pending.length > 0 && (
        <>
          <SectionDivider />
          <SectionHeader
            title={t('settings.messaging.telegram.access.pendingRequestsTitle')}
            subtitle={t('settings.messaging.telegram.access.pendingRequestsSubtitle', {
              count: pending.length,
            })}
          />
          <PendingSendersList
            pending={pending}
            onAllow={handleAllow}
            onIgnore={handleIgnore}
          />
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 可折叠的“Allowed users”区域
// 结构与 PairedSupergroupSection 保持一致，让 Telegram 卡片内的两行看起来像兄弟组件。
// ---------------------------------------------------------------------------

function AllowedUsersCollapsible({
  owners,
  accessMode,
  onRemove,
}: {
  owners: PlatformOwner[]
  accessMode: PlatformAccessMode
  onRemove: (userId: string) => void
}) {
  const { t } = useTranslation()
  // 有 owner 时默认展开，方便管理员一眼看到列表；为空时默认收起，
  // 由 banner 或 pending 列表承担“需要操作”的提示职责。
  const [isExpanded, setIsExpanded] = React.useState(owners.length > 0)

  const subtitle =
    accessMode === 'open'
      ? t('settings.messaging.telegram.access.allowedUsersSubtitleOpen')
      : owners.length === 0
        ? t('settings.messaging.telegram.access.allowedUsersSubtitleEmpty')
        : t('settings.messaging.telegram.access.allowedUsersSubtitle', { count: owners.length })

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]"
      >
        <SubRowIcon icon={Users} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t('settings.messaging.telegram.access.allowedUsersTitle')}
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
              <OwnersListEditor
                owners={owners}
                enforced={accessMode === 'owner-only'}
                onRemove={onRemove}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 共享的行级基础组件
// 保持局部化，避免从 MessagingSettingsPage 引入页面级组件；
// 几何尺寸必须完全一致（22px 图标列）。
// ---------------------------------------------------------------------------

function SubRowIcon({
  icon: Icon,
  size = SUB_ROW_ICON_SIZE,
  strokeWidth = SUB_ROW_ICON_STROKE,
}: {
  // typeof MessageSquare 表示“一个 lucide 图标组件类型”
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

function SectionDivider() {
  return <div className="mx-4 h-px bg-border/50" />
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="px-4 pt-3 pb-1">
      <div className="text-xs font-medium uppercase tracking-wide text-foreground/50">
        {title}
      </div>
      <div className="mt-0.5 text-xs text-foreground/50">{subtitle}</div>
    </div>
  )
}

/**
 * AllowListPreview (playground only)
 * AllowListPreview：仅在 playground 中使用，预览 Telegram 的允许列表 / 访问控制 UI。
 *
 * Self-contained preview of the new Telegram allow-list / access-control UI.
 * 这是一个自包含的预览组件，用来展示 Telegram 白名单与访问控制的新 UI。
 *
 * Mounts the same shared components (`AccessModeBanner`, `OwnersListEditor`,
 * `PendingSendersList`, `BindingAllowListPopover`) that Phase 3 will wire
 * into the real `MessagingSettingsPage`. Backed entirely by playground mock
 * state via `__playgroundMessaging` so designers can flip variants without
 * any backend running.
 * 它挂载与 Phase 3 真实 MessagingSettingsPage 相同的共享组件，数据完全来自 playground 的 mock 状态。
 */

// import * as React 把整个 React 命名空间导入，调用时写 React.useState，适合需要频繁使用 React API 的文件。
import * as React from 'react'
// motion/react 是动画库 Framer Motion 的 React 绑定；motion.div 是带动画能力的 div。
import { motion, AnimatePresence } from 'motion/react'
// sonner 是一个轻量 toast 通知库，toast.success/info 会在屏幕右下角弹出提示。
import { toast } from 'sonner'
// lucide-react 提供 SVG 图标，以大驼峰命名导入后可直接当 React 组件使用。
import {
  ChevronDown,
  ChevronRight,
  Hash,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { MessagingPlatformIcon } from '@/components/messaging/MessagingPlatformIcon'
// type 前缀的导入表示只引入类型；这些类型在编译后会被擦除。
import {
  AccessModeBanner,
  BindingAllowListPopover,
  OwnersListEditor,
  PendingSendersList,
  type BindingAccess,
  type PendingSender,
  type PlatformAccessMode,
  type PlatformOwner,
} from '@/components/messaging/access'
// ../../mock-utils 是同一 playground 目录下的 mock 工具，用来在 playground 里模拟 main 进程状态。
import { playgroundAllowListHandle } from '../../mock-utils'

// 用字面量联合类型定义 playground 预设，方便在侧边栏切换不同状态。
type AccessModePreset = 'open' | 'owner-only-empty' | 'owner-only-with-owner'
type PendingPreset = 'none' | 'one' | 'three'
type BindingPreset = 'inherit' | 'allow-list' | 'open'

// 行内图标尺寸常量，统一 22px。
const ROW_ICON_SIZE = 22

// 当前用户 ID，与下面的 PRIMARY_OWNER 保持一致。
const CURRENT_USER_ID = '7654321' // matches PRIMARY_OWNER below

// 示例白名单拥有者；TypeScript 通过 :PlatformOwner 进行类型检查，确保字段完整。
const PRIMARY_OWNER: PlatformOwner = {
  userId: '7654321',
  displayName: 'Gyula',
  username: 'gyula',
  addedAt: Date.now() - 12 * 60 * 60 * 1000,
}

// 示例待处理发送者列表；数组类型注解 PendingSender[] 让 TS 检查每个元素。
const SAMPLE_PENDING: PendingSender[] = [
  {
    platform: 'telegram',
    userId: '111222333',
    displayName: 'Alex Müller',
    username: 'alex_m',
    lastAttemptAt: Date.now() - 2 * 60 * 1000,
    attemptCount: 3,
  },
  {
    platform: 'telegram',
    userId: '444555666',
    displayName: 'Sara Park',
    username: 'sarap',
    lastAttemptAt: Date.now() - 30 * 60 * 1000,
    attemptCount: 1,
  },
  {
    platform: 'telegram',
    userId: '777888999',
    displayName: 'Random Spammer',
    lastAttemptAt: Date.now() - 4 * 60 * 60 * 1000,
    attemptCount: 14,
  },
]

// 根据 playground 预设构建 owner 列表；open/空 owner-only 返回空数组。
function buildOwners(preset: AccessModePreset): PlatformOwner[] {
  switch (preset) {
    case 'open':
    case 'owner-only-empty':
      return []
    case 'owner-only-with-owner':
      return [PRIMARY_OWNER]
  }
}

// 根据预设返回 0/1/3 条待处理请求，slice(0, 1) 取数组前一项。
function buildPending(preset: PendingPreset): PendingSender[] {
  switch (preset) {
    case 'none':
      return []
    case 'one':
      return SAMPLE_PENDING.slice(0, 1)
    case 'three':
      return SAMPLE_PENDING
  }
}

// BindingAccess 决定某个会话/主题的访问模式：inherit（继承）、allow-list（白名单）、open（开放）。
function buildBindingAccess(preset: BindingPreset): BindingAccess {
  switch (preset) {
    case 'inherit':
      return { mode: 'inherit', allowedSenderIds: [] }
    case 'allow-list':
      return { mode: 'allow-list', allowedSenderIds: [PRIMARY_OWNER.userId] }
    case 'open':
      return { mode: 'open', allowedSenderIds: [] }
  }
}

// 把 playground 的预设映射到真实的访问模式：只有 open 保持 open，其余都是 owner-only。
function presetToAccessMode(preset: AccessModePreset): PlatformAccessMode {
  return preset === 'open' ? 'open' : 'owner-only'
}

/** AllowListPreviewProps：组件 props 类型定义 */
/** 用 interface 定义组件 props，相当于 Go 里 struct 的字段声明。 */
export interface AllowListPreviewProps {
  accessMode: AccessModePreset
  pending: PendingPreset
  dmBindingAccess: BindingPreset
  topicBindingAccess: BindingPreset
}

/** AllowListPreview：函数 */
/** React 函数组件接收 props 对象，并用解构赋值直接拿到各字段。 */
export function AllowListPreview({
  accessMode,
  pending,
  dmBindingAccess,
  topicBindingAccess,
}: AllowListPreviewProps) {
  // React.useMemo 缓存计算结果；只有 accessMode/pending 变化时才重新生成初始数据。
  const initialOwners = React.useMemo(() => buildOwners(accessMode), [accessMode])
  const initialPending = React.useMemo(() => buildPending(pending), [pending])
  const platformAccessMode = presetToAccessMode(accessMode)

  // 组件内部状态；setXxx 用来更新，状态变更会触发重新渲染。
  const [owners, setOwners] = React.useState<PlatformOwner[]>(initialOwners)
  const [pendingList, setPendingList] = React.useState<PendingSender[]>(initialPending)
  const [mode, setMode] = React.useState<PlatformAccessMode>(platformAccessMode)
  // useState 可以传入函数作为初始值（惰性初始化），只在首次渲染时执行一次。
  const [dmAccess, setDmAccess] = React.useState<BindingAccess>(() =>
    buildBindingAccess(dmBindingAccess),
  )
  const [topicAccess, setTopicAccess] = React.useState<BindingAccess>(() =>
    buildBindingAccess(topicBindingAccess),
  )

  // Keep state in sync with variant prop changes (so users can flip presets
  // from the playground sidebar without remounting the component).
  // 当 playground 侧边栏切换预设时，同步更新组件状态，无需重新挂载组件。
  React.useEffect(() => setOwners(initialOwners), [initialOwners])
  React.useEffect(() => setPendingList(initialPending), [initialPending])
  React.useEffect(() => setMode(platformAccessMode), [platformAccessMode])
  React.useEffect(
    () => setDmAccess(buildBindingAccess(dmBindingAccess)),
    [dmBindingAccess],
  )
  React.useEffect(
    () => setTopicAccess(buildBindingAccess(topicBindingAccess)),
    [topicBindingAccess],
  )

  // Sync mock state for any IPC consumers (Phase 3 wiring will read these).
  // 把状态同步到 playground 的 mock handle；后续 IPC 消费者（比如 main 进程模拟）可以读取。
  React.useEffect(() => {
    playgroundAllowListHandle.setOwners('telegram', owners)
  }, [owners])
  React.useEffect(() => {
    playgroundAllowListHandle.setPending('telegram', pendingList)
  }, [pendingList])
  React.useEffect(() => {
    playgroundAllowListHandle.setAccessMode('telegram', mode)
  }, [mode])

  // 锁定机器人：把访问模式改为仅允许 owner，如果没有 owner 则默认把自己加进去。
  const handleLockDown = () => {
    setMode('owner-only')
    if (owners.length === 0) {
      // Best-effort seed with the current user (the most common case).
      setOwners([PRIMARY_OWNER])
    }
    toast.success('Bot locked down to allowed users only')
  }

  // 从允许列表移除某个用户；filter 返回新数组，符合 React 不可变更新原则。
  const handleRemoveOwner = (userId: string) => {
    setOwners((prev) => prev.filter((o) => o.userId !== userId))
    toast.info('Removed from allowed users')
  }

  // 允许某个待处理发送者：把他加入 owners 并从 pendingList 移除。
  const handleAllow = (sender: PendingSender) => {
    setOwners((prev) => [
      ...prev,
      {
        userId: sender.userId,
        displayName: sender.displayName,
        username: sender.username,
        addedAt: Date.now(),
      },
    ])
    setPendingList((prev) => prev.filter((s) => s.userId !== sender.userId))
    toast.success(`Allowed ${sender.displayName || sender.username || sender.userId}`)
  }

  // 忽略待处理请求：按用户 ID、原因、bindingId 多重条件过滤。
  const handleIgnore = (sender: PendingSender) => {
    setPendingList((prev) =>
      prev.filter(
        (s) =>
          !(
            s.userId === sender.userId &&
            (s.reason ?? 'not-owner') === (sender.reason ?? 'not-owner') &&
            (s.bindingId ?? null) === (sender.bindingId ?? null)
          ),
      ),
    )
  }

  // JSX 渲染；SettingsSection/SettingsCard 是本项目共享的设置页面布局组件。
  return (
    <div className="space-y-6 p-6">
      <SettingsSection title="Messaging">
        <SettingsCard>
          <BotHeader />

          {mode === 'open' && <AccessModeBanner onLockDown={handleLockDown} />}

          <CardSeparator />
          <AllowedUsersCollapsible
            owners={owners}
            mode={mode}
            currentUserId={CURRENT_USER_ID}
            onRemove={handleRemoveOwner}
          />

          {pendingList.length > 0 && (
            <>
              <CardSeparator />
              <SectionHeader
                title="Pending requests"
                subtitle={`${pendingList.length} ${pendingList.length === 1 ? 'sender was' : 'senders were'} rejected — review to allow.`}
              />
              <PendingSendersList
                pending={pendingList}
                onAllow={handleAllow}
                onIgnore={handleIgnore}
              />
            </>
          )}

          <CardSeparator />
          <BindingRow
            icon={MessageSquare}
            title="Direct message session"
            subtitle="Gyula DM — Telegram chat"
            access={dmAccess}
            workspaceOwners={owners}
            onChange={setDmAccess}
          />
          <CardSeparator />
          <SupergroupHeader />
          <BindingRow
            icon={Hash}
            indent
            title="GitHub Issue Triage (craft-agents-oss)"
            subtitle="GithubIssues · Topic #16"
            access={topicAccess}
            workspaceOwners={owners}
            onChange={setTopicAccess}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// 下面是几个局部子组件，只在当前文件使用，因此不需要 export。
// ---------------------------------------------------------------------------

// 卡片分隔线，使用 Tailwind 的 h-px（1px 高）和 bg-border/50（50% 透明度边框色）。
function CardSeparator() {
  return <div className="mx-4 h-px bg-border/50" />
}

// 区域标题子组件；props 类型直接在参数里内联声明。
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

// 机器人头部信息行，展示平台图标、名称和状态。
function BotHeader() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <MessagingPlatformIcon platform="telegram" size={ROW_ICON_SIZE} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Telegram</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          Bot API · Valid bot: @CraftAgentsBot
        </div>
      </div>
      <button
        type="button"
        className="rounded-md p-1.5 transition-colors hover:bg-foreground/[0.05]"
        aria-label="More"
      >
        <MoreHorizontal className="h-4 w-4 text-foreground/50" />
      </button>
    </div>
  )
}

// 超级群组（supergroup）头部，展示群组名称和已绑定主题数量。
function SupergroupHeader() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
      >
        <MessagesSquare className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="truncate text-sm font-medium">Craft Agents</div>
          <div className="truncate text-xs text-foreground/50">(-1003783993623)</div>
        </div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">1 topic bound</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AllowedUsersCollapsible — mirrors TelegramAccessSection's collapsible row
// so the playground demo and production stay visually identical.
// AllowedUsersCollapsible：可折叠的允许用户列表，和生产环境保持一致。
// ---------------------------------------------------------------------------

function AllowedUsersCollapsible({
  owners,
  mode,
  currentUserId,
  onRemove,
}: {
  owners: PlatformOwner[]
  mode: PlatformAccessMode
  currentUserId: string
  onRemove: (userId: string) => void
}) {
  // 初始展开状态：有 owner 时默认展开。
  const [isExpanded, setIsExpanded] = React.useState(owners.length > 0)

  // 根据当前模式动态生成副标题文案；UI 字符串保持英文。
  const subtitle =
    mode === 'open'
      ? 'Not enforced — bot is publicly accessible.'
      : owners.length === 0
        ? 'No one can use this bot yet — pair from Telegram or accept a pending request.'
        : `${owners.length} ${owners.length === 1 ? 'user' : 'users'} allowed`

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]"
      >
        <div
          className="shrink-0 flex items-center justify-center"
          style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
        >
          <Users className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Allowed users</div>
          <div className="mt-0.5 truncate text-xs text-foreground/50">{subtitle}</div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground/50" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" />
        )}
      </button>

      {/* AnimatePresence + motion.div 实现展开/折叠的高度和透明度过渡动画。 */}
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
                enforced={mode === 'owner-only'}
                currentUserId={currentUserId}
                onRemove={onRemove}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// BindingRow：绑定会话/主题行，控制单个会话的访问权限。
function BindingRow({
  icon: Icon,
  indent,
  title,
  subtitle,
  access,
  workspaceOwners,
  onChange,
}: {
  icon: typeof MessageSquare
  indent?: boolean
  title: string
  subtitle: string
  access: BindingAccess
  workspaceOwners: PlatformOwner[]
  onChange: (next: BindingAccess) => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
      >
        {indent ? null : (
          <Icon className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">{subtitle}</div>
      </div>
      <BindingAllowListPopover
        access={access}
        workspaceOwners={workspaceOwners}
        onChange={onChange}
      />
      <Button variant="ghost" size="sm">
        Open
      </Button>
    </div>
  )
}

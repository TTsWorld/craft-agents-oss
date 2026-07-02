/**
 * MessagingTelegramReworkedPreview (playground only)
 * MessagingTelegramReworkedPreview：Telegram 消息设置卡片的新布局原型（仅 playground）。
 *
 * Prototype layout for the Telegram messaging settings card. The current
 * production layout (see `MessagingSettingsPage`) renders direct-session
 * bindings and supergroup topic bindings as one flat list under the bot
 * row, which gets noisy fast. This rework groups them:
 * 当前生产环境把直接会话和超级群组主题绑定平铺展示，信息噪音大；这里重新分组：
 *
 *   1. Bot header (unchanged shape)
 *   2. Direct sessions (DMs paired straight to the bot)
 *   3. Separator
 *   4. Supergroup section
 *      - When unpaired: a "Pair Supergroup" CTA row.
 *      - When paired: collapsible chevron row that expands to the
 *        topic-bound bindings, mirroring AiSettingsPage's
 *        `WorkspaceOverrideCard` chevron pattern.
 *
 * Self-contained on purpose — does NOT import `MessagingSettingsPage` or
 * touch any production atom. Lets us iterate on the design without
 * shipping until the user signs off.
 * 这个组件是自包含的，不依赖任何生产 atom，方便在确认设计前快速迭代。
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Hash,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { MessagingPlatformIcon } from '@/components/messaging/MessagingPlatformIcon'

// All rows reserve this much width for the icon column so the column reads
// as a single straight edge. The Telegram bot logo fills the slot at the top
// (22px); secondary icons (MessageSquare, Users) render visibly smaller and
// at a lighter stroke inside the same slot for clear primary/secondary
// hierarchy — see SubRowIcon.
// 所有行预留 22px 宽的图标列，让列表左侧对齐成一条直线；次级图标实际更小更轻。
const ROW_ICON_SIZE = 22
const SUB_ROW_ICON_SIZE = 16
const SUB_ROW_ICON_STROKE = 1.5

// ---------------------------------------------------------------------------
// Types + mock data
// 类型与模拟数据
// ---------------------------------------------------------------------------

// 直接会话（DM）数据类型。
interface DirectSession {
  id: string
  sessionTitle: string
}

// 超级群组主题绑定数据类型。
interface TopicBinding {
  id: string
  sessionTitle: string
  topicName: string
  threadId: number
}

const DIRECT_SESSIONS: DirectSession[] = [
  { id: 'd1', sessionTitle: 'Interceptor Failure Analysis' },
  { id: 'd2', sessionTitle: 'Daily standup notes' },
  { id: 'd3', sessionTitle: 'Triage backlog refresh' },
]

const TOPIC_BINDINGS: TopicBinding[] = [
  {
    id: 't1',
    sessionTitle: 'GitHub Issue Triage (craft-agents-oss)',
    topicName: 'GithubIssues',
    threadId: 16,
  },
  { id: 't2', sessionTitle: 'Evening weather', topicName: 'Weather', threadId: 11 },
  {
    id: 't3',
    sessionTitle: 'Error pattern review (Sentry digest)',
    topicName: 'Errors',
    threadId: 22,
  },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** MessagingTelegramReworkedPreviewProps：组件 props 类型定义 */
export interface MessagingTelegramReworkedPreviewProps {
  telegramConnected: boolean
  supergroupPaired: boolean
  /** How many direct (DM) sessions to show (0 hides the section). */
  directSessions: number
  /** How many topic-bound bindings under the supergroup. */
  supergroupTopics: number
}

/** MessagingTelegramReworkedPreview：函数 */
export function MessagingTelegramReworkedPreview({
  telegramConnected,
  supergroupPaired,
  directSessions,
  supergroupTopics,
}: MessagingTelegramReworkedPreviewProps) {
  // Math.max/Math.min 把传入数字限制在 [0, 数组长度] 范围内，再用 slice 截取对应数量。
  const directs = DIRECT_SESSIONS.slice(0, Math.max(0, Math.min(directSessions, DIRECT_SESSIONS.length)))
  const topics = TOPIC_BINDINGS.slice(0, Math.max(0, Math.min(supergroupTopics, TOPIC_BINDINGS.length)))

  return (
    <div className="space-y-6 p-6">
      <SettingsSection title="Messaging">
        <SettingsCard>
          <BotHeader connected={telegramConnected} />

          {/* 仅当 Telegram 已连接时才展示直接会话和超级群组区域。 */}
          {telegramConnected && (
            <>
              {directs.length > 0 ? (
                <>
                  <Separator />
                  <DirectSessionsSection sessions={directs} />
                </>
              ) : null}

              <Separator />
              {supergroupPaired ? (
                <PairedSupergroupSection topics={topics} />
              ) : (
                <UnpairedSupergroupRow />
              )}
            </>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// 局部子组件
// ---------------------------------------------------------------------------

function Separator() {
  return <div className="mx-4 h-px bg-border/50" />
}

function BotHeader({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <MessagingPlatformIcon platform="telegram" size={ROW_ICON_SIZE} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Telegram</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          Bot API · {connected ? 'Valid bot: @CraftAgentsBot' : 'Not connected'}
        </div>
      </div>
      {/* 根据连接状态展示“更多”按钮或“连接”按钮。 */}
      {connected ? (
        <button
          type="button"
          className="rounded-md p-1.5 transition-colors hover:bg-foreground/[0.05]"
          aria-label="More"
        >
          <MoreHorizontal className="h-4 w-4 text-foreground/50" />
        </button>
      ) : (
        <Button variant="outline" size="sm">
          <Plus className="h-3.5 w-3.5" />
          Connect
        </Button>
      )}
    </div>
  )
}

/**
 * Shared row shape: 16px left/right padding + 22px icon column + 12px gap.
 * Children that should sit in the "title" column pass the title and an
 * optional subtitle; children that should sit in the "icon-aligned" column
 * (e.g. topic rows under the supergroup) use `<IconSpacer />` instead of an
 * icon to inherit the same column geometry without rendering anything.
 * IconSpacer：占位的 22px 空白，让子行和上方图标列保持严格对齐。
 */
function IconSpacer() {
  return <div className="shrink-0" style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }} />
}

/**
 * Wraps a small Lucide icon inside the row's 22px icon slot so it stays
 * centred in the same column as the Telegram logo above. The icon itself
 * defaults to 16px @ stroke-width 1.5 (light secondary look). Caller can
 * override `size` and `strokeWidth` for individual rows without breaking
 * column alignment — the slot stays 22px regardless.
 * SubRowIcon：把 16px 小图标放进统一的 22px 槽位中，保证列对齐；调用者可覆盖 size/strokeWidth。
 */
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

function DirectSessionsSection({ sessions }: { sessions: DirectSession[] }) {
  return (
    <div className="divide-y divide-border/50">
      {sessions.map((s) => (
        <DirectSessionRow key={s.id} title={s.sessionTitle} />
      ))}
    </div>
  )
}

function DirectSessionRow({ title }: { title: string }) {
  // Layout convention matches the production MessagingSettingsPage: type
  // becomes the primary line, the session name drops to the subtitle so
  // Direct and Supergroup rows read in parallel.
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <SubRowIcon icon={MessageSquare} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">Direct message session</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">{title}</div>
      </div>
      <RowActions />
    </div>
  )
}

function RowActions() {
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm">
        <ArrowUpRight className="h-3.5 w-3.5" />
        Open
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
      >
        Disconnect
      </Button>
    </div>
  )
}

function UnpairedSupergroupRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <SubRowIcon icon={MessagesSquare} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">Supergroup</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          Not configured — pair to route automation topics into Telegram.
        </div>
      </div>
      <Button variant="outline" size="sm">
        <Plus className="h-3.5 w-3.5" />
        Pair Supergroup
      </Button>
    </div>
  )
}

function PairedSupergroupSection({ topics }: { topics: TopicBinding[] }) {
  // Default open when there are topics to draw attention to them; default
  // closed when the supergroup is paired but unused.
  // 有主题时默认展开，没有时折叠。
  const [isExpanded, setIsExpanded] = React.useState(topics.length > 0)

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
            <div className="truncate text-sm font-medium">Craft Agents</div>
            <div className="truncate text-xs text-foreground/50">(-1003783993623)</div>
          </div>
          <div className="mt-0.5 truncate text-xs text-foreground/50">
            {topics.length === 0
              ? 'No topics bound yet — automations with `telegramTopic` will create them.'
              : `${topics.length} ${topics.length === 1 ? 'topic' : 'topics'} bound`}
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground/50" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" />
        )}
      </button>

      {/* 可折叠区域，带高度/透明度过渡动画。 */}
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
              {topics.length === 0 ? (
                /* Empty-state copy uses the same icon column as topic rows
                   so the wording sits exactly under the supergroup name. */
                <div className="flex items-start gap-3 px-4 py-3 text-xs text-foreground/50">
                  <IconSpacer />
                  <span>
                    No bound topics. Set{' '}
                    <code className="rounded bg-foreground/[0.06] px-1 py-0.5">telegramTopic</code>{' '}
                    on an automation matcher to create one.
                  </span>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {topics.map((t) => (
                    <TopicRow key={t.id} binding={t} />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 px-4 py-2">
                <IconSpacer />
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  Unpair Supergroup
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TopicRow({ binding }: { binding: TopicBinding }) {
  // Topic title sits in the same column as the supergroup name above,
  // achieved by occupying the icon slot with an `<IconSpacer />` rather
  // than guessing at a `pl-[N]` value.
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <IconSpacer />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{binding.sessionTitle}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground/50">
          <Hash className="h-3 w-3" />
          <span className="truncate">
            {binding.topicName} <span className="text-foreground/30">·</span> Topic #{binding.threadId}
          </span>
        </div>
      </div>
      <RowActions />
    </div>
  )
}

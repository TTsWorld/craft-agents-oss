/**
 * UserMessageBubble - 共用的用户消息组件
 *
 * 以右对齐样式展示用户消息：
 * - 淡背景（5% 前景色）
 * - 胶囊形圆角
 * - 最大宽度 80%
 * - 链接和代码以 markdown 渲染
 * - 可选的文件附件（带缩略图）
 * - 用于 @提及（sources、skills）的内容徽章
 * - pending/queued 状态（仅 Electron）
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import type { StoredAttachment, ContentBadge } from '@craft-agent/core'
import { normalizePath } from '@craft-agent/core/utils'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'
import { FileTypeIcon, getFileTypeLabel } from './attachment-helpers'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../tooltip'
import { useTranslation } from 'react-i18next'

// 无 iconDataUrl 的徽章使用的兜底文本图标
// 使用简单字符，因为 SVG 渲染在所有上下文中不一定都可用
const SKILL_ICON_TEXT = '✦'
const SOURCE_ICON_TEXT = '⊕'
const CONTEXT_ICON_TEXT = '⚙'
const COMMAND_ICON_TEXT = '/'

/**
 * 判断徽章是否为 edit_request 徽章（通过 rawText 中的 XML 标签识别）
 */
function isEditRequestBadge(badge: ContentBadge): boolean {
  return badge.type === 'context' && !!badge.rawText?.includes('<edit_request>')
}

/**
 * EditRequestBadge - 渲染在用户消息气泡上方的独立徽章
 * 比内联徽章更高、圆角更大，以便视觉上区分
 */
function EditRequestBadge({ badge }: { badge: ContentBadge }) {
  const displayLabel = badge.collapsedLabel || badge.label
  return (
    <span className="inline-flex items-center h-[28px] px-2.5 rounded-[8px] bg-background shadow-minimal text-[13px] text-muted-foreground">
      {displayLabel}
    </span>
  )
}

/**
 * InlineBadge - 与文本内联渲染单个内容徽章
 * 样式与输入框徽章保持一致（bg-background + shadow）
 */
function InlineBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      {badge.iconDataUrl ? (
        <img
          src={badge.iconDataUrl}
          alt=""
          className="h-[12px] w-[12px] rounded-[2px] shrink-0"
        />
      ) : (
        <span className="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[8px]">
          {badge.type === 'skill' ? SKILL_ICON_TEXT : badge.type === 'context' ? CONTEXT_ICON_TEXT : SOURCE_ICON_TEXT}
        </span>
      )}
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * CommandBadge - 与文本内联渲染斜杠命令徽章
 * 样式与 InlineBadge 类似，但表示一个 SDK 命令（例如 /compact）
 */
function CommandBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <span className="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[10px] font-medium">
        {COMMAND_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * ContextBadge - 渲染折叠隐藏内容的 context 徽章
 * 展示折叠后的 label，隐藏原始内容不显示
 * 注：edit_request 徽章由 EditRequestBadge 单独处理
 */
function ContextBadge({ badge }: { badge: ContentBadge }) {
  const { t } = useTranslation()
  const displayLabel = badge.collapsedLabel || badge.label

  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mr-1 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
      title={t('chat.contextBadge')}
    >
      <span className="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[8px]">
        {CONTEXT_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px] text-muted-foreground">{displayLabel}</span>
    </span>
  )
}

/** 已知的代码文件扩展名，用于选择代码文件图标 */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** 根据徽章类型和文件扩展名返回对应的文件/文件夹 SVG 图标 */
function FileBadgeIcon({ badge }: { badge: ContentBadge }) {
  if (badge.type === 'folder') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
        <path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/>
      </svg>
    )
  }

  // 判断是否为代码文件
  const ext = badge.label.split('.').pop()?.toLowerCase()
  const isCode = ext ? CODE_EXTENSIONS.has(ext) : false

  if (isCode) {
    // 代码文件图标（带 < > 尖括号的文档）
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
        <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
      </svg>
    )
  }

  // 通用文件图标（带折角的文档）
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground">
      <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
    </svg>
  )
}

/**
 * InlineFileBadge - 在文本中内联展示的文件/文件夹徽章。
 * 显示对应图标（文件夹、代码文件或通用文件），并用 Tooltip 展示完整路径。
 * 当提供 onFileClick 时可点击。
 */
function InlineFileBadge({
  badge,
  onFileClick
}: {
  badge: ContentBadge
  onFileClick?: (path: string) => void
}) {
  // 剥离 .craft-agent 工作区/会话路径前缀，使 tooltip 展示更干净
  // 例如 "/Users/.../workspaces/{id}/sessions/{id}/plans/foo.md" → "plans/foo.md"
  const rawPath = badge.filePath || badge.label
  const tooltipPath = normalizePath(rawPath).replace(/^.*\.craft-agent\/workspaces\/[^/]+\/(sessions\/[^/]+\/)?/, '')
  const isClickable = !!badge.filePath && !!onFileClick

  const badgeContent = (
    <span
      role={isClickable ? 'button' : undefined}
      onClick={() => isClickable && onFileClick!(badge.filePath!)}
      className={cn(
        "inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle",
        isClickable && "hover:bg-foreground/5 transition-colors cursor-pointer"
      )}
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <FileBadgeIcon badge={badge} />
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )

  // 用 Tooltip 包裹，悬停时展示完整路径
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badgeContent}
        </TooltipTrigger>
        <TooltipContent side="top">
          {tooltipPath}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * 渲染内容并在对应位置插入徽章。
 * 徽章之间的文本片段以 Markdown 渲染。
 *
 * context 徽章（type='context'）较特殊：
 * - 完全隐藏被标记的内容范围
 * - 展示带 collapsedLabel 的折叠徽章
 * - 用于不应向用户展示的 EditPopover 元数据
 *
 * file 徽章（type='file'）以内联可点击徽章渲染：
 * - 用于文件路径与文本内联出现的 plan 执行消息
 */
function renderContentWithBadges(
  content: string,
  badges: ContentBadge[],
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void
): ReactNode {
  if (badges.length === 0) {
    return (
      <Markdown
        mode="minimal"
        onUrlClick={onUrlClick}
        onFileClick={onFileClick}
        className="text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap"
      >
        {content}
      </Markdown>
    )
  }

  // 按起始位置排序徽章
  const sortedBadges = [...badges].sort((a, b) => a.start - b.start)

  const elements: ReactNode[] = []
  let lastEnd = 0

  sortedBadges.forEach((badge, i) => {
    // 添加该徽章之前的文本
    if (badge.start > lastEnd) {
      const textBefore = content.slice(lastEnd, badge.start)
      if (textBefore.trim()) {
        elements.push(
          <Markdown
            key={`text-${i}`}
            mode="minimal"
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
            className="inline text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&_p]:inline"
          >
            {textBefore}
          </Markdown>
        )
      }
    }

    // context 徽章隐藏内容并展示折叠标签
    // command 徽章展示 SDK 命令，例如 /compact
    // file 徽章内联展示可点击的文件引用
    // source/skill 徽章与原始文本一起内联展示
    // 注意：edit_request 徽章被过滤出来，单独渲染在气泡上方
    if (badge.type === 'context') {
      elements.push(<ContextBadge key={`badge-${i}`} badge={badge} />)
    } else if (badge.type === 'command') {
      elements.push(<CommandBadge key={`badge-${i}`} badge={badge} />)
    } else if (badge.type === 'file' || badge.type === 'folder') {
      elements.push(<InlineFileBadge key={`badge-${i}`} badge={badge} onFileClick={onFileClick} />)
    } else {
      elements.push(<InlineBadge key={`badge-${i}`} badge={badge} />)
    }

    lastEnd = badge.end
  })

  // 添加最后一个徽章之后的剩余文本
  if (lastEnd < content.length) {
    const textAfter = content.slice(lastEnd)
    if (textAfter.trim()) {
      elements.push(
        <Markdown
          key="text-end"
          mode="minimal"
          onUrlClick={onUrlClick}
          onFileClick={onFileClick}
          className="inline text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&_p]:inline"
        >
          {textAfter}
        </Markdown>
      )
    }
  }

  // 使用 <p> 以匹配 Markdown 的块级行高行为
  return <p className="text-sm">{elements}</p>
}

export interface UserMessageBubbleProps {
  /** 消息内容（支持 markdown） */
  content: string
  /** 外层容器的额外 className */
  className?: string
  /** 点击 URL 时的回调 */
  onUrlClick?: (url: string) => void
  /** 点击文件路径时的回调 */
  onFileClick?: (path: string) => void
  /** 存储的附件（图片、文档） */
  attachments?: StoredAttachment[]
  /** 内联展示的内容徽章（sources、skills） */
  badges?: ContentBadge[]
  /** 消息是否正在等待后端确认。用户气泡保持视觉稳定。 */
  isPending?: boolean
  /** 消息是否已排队（展示徽章） */
  isQueued?: boolean
  /** compact 模式——减少内边距以适应 popover 内嵌 */
  compactMode?: boolean
}

/** "Queued" 徽章的最小可见时长。两个后端对中途流式发送的确认都在约 50–150ms 内，
 * 否则徽章会闪过得太快而无法感知。保持足够长以便用户实际读到它。 */
const QUEUED_MIN_VISIBLE_MS = 2500

export function UserMessageBubble({
  content,
  className,
  onUrlClick,
  onFileClick,
  attachments,
  badges,
  isQueued,
  compactMode,
}: UserMessageBubbleProps) {
  const { t } = useTranslation()
  const hasAttachments = attachments && attachments.length > 0

  // 在 `isQueued` 为 true 时展示排队徽章，且在其首次变为 true 后至少保持
  // QUEUED_MIN_VISIBLE_MS——即使后端在 <150ms 内确认。纯 UI 状态；
  // `isQueued` 仍是持久化的真相来源。
  const [showQueued, setShowQueued] = useState(isQueued ?? false)
  const queuedShownAtRef = useRef<number | null>(isQueued ? Date.now() : null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }

    if (isQueued) {
      setShowQueued(true)
      if (queuedShownAtRef.current === null) {
        queuedShownAtRef.current = Date.now()
      }
      return
    }

    // isQueued 翻转为 false。在最小可见窗口的剩余时间内保持徽章，然后清除。
    if (queuedShownAtRef.current === null) return

    const elapsed = Date.now() - queuedShownAtRef.current
    const remaining = Math.max(0, QUEUED_MIN_VISIBLE_MS - elapsed)

    if (remaining === 0) {
      setShowQueued(false)
      queuedShownAtRef.current = null
      return
    }

    clearTimerRef.current = setTimeout(() => {
      setShowQueued(false)
      queuedShownAtRef.current = null
      clearTimerRef.current = null
    }, remaining)
  }, [isQueued])

  // 将 edit_request 徽章（渲染在气泡上方）与其他徽章（内联渲染）分离
  const editRequestBadges = badges?.filter(isEditRequestBadge) ?? []
  const inlineBadges = badges?.filter(b => !isEditRequestBadge(b)) ?? []
  const hasEditRequestBadges = editRequestBadges.length > 0
  const hasInlineBadges = inlineBadges.length > 0

  // 从展示文本中剥离 edit_request 内容
  // 每个徽章有 start/end 位置标记要移除的内容范围
  let displayContent = content
  if (hasEditRequestBadges) {
    // 按起始位置降序排序，以便从后往前移除
    // （这样能保留较早移除操作的位置）
    const sortedBadges = [...editRequestBadges].sort((a, b) => b.start - a.start)
    for (const badge of sortedBadges) {
      displayContent = displayContent.slice(0, badge.start) + displayContent.slice(badge.end)
    }
    displayContent = displayContent.trim()
  }

  return (
    <div className={cn("flex flex-col items-end gap-3 w-full", className)}>
      {/* 附件预览行——带缩略图的已存储附件 */}
      {hasAttachments && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {attachments!.map((att, i) => {
            const isImage = att.type === 'image'
            const hasThumbnail = !!att.thumbnailBase64

            return (
              <div
                key={att.id || i}
                className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => att.storedPath && onFileClick?.(att.storedPath)}
                title={t('chat.clickToOpen', { name: att.name })}
              >
                {isImage ? (
                  /* 图片：仅方形缩略图 */
                  <div className="h-14 w-14 rounded-[8px] overflow-hidden bg-background shadow-minimal">
                    {hasThumbnail ? (
                      <img
                        src={`data:image/png;base64,${att.thumbnailBase64}`}
                        alt={att.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                ) : (
                  /* 文档：带缩略图/图标的气泡 + 两行文本 */
                  <div className="flex items-center gap-2.5 rounded-[8px] bg-user-message-bubble pl-1.5 pr-3 py-1.5">
                    <div className="h-11 w-8 rounded-[6px] overflow-hidden bg-background shadow-minimal flex items-center justify-center shrink-0">
                      {hasThumbnail ? (
                        <img
                          src={`data:image/png;base64,${att.thumbnailBase64}`}
                          alt={att.name}
                          className="h-full w-full object-cover object-top"
                        />
                      ) : (
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-[120px]">
                      <span className="text-xs font-medium line-clamp-2 break-all" title={att.name}>
                        {att.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {getFileTypeLabel(att.type, att.mimeType, att.name)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 徽章行——edit request 徽章位于文本气泡上方 */}
      {hasEditRequestBadges && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {editRequestBadges.map((badge, i) => (
            <EditRequestBadge key={`edit-badge-${i}`} badge={badge} />
          ))}
        </div>
      )}

      {/* 文本内容气泡。排队中的消息在气泡内部渲染一个内联头部徽章
          （Clock 图标 + 斜体 'Queued'），而非下方单独的药丸——保持每条消息
          一个气泡，同时徽章和脉冲图标让等待状态一目了然
          （#616 后续）。 */}
      <div
        className={cn(
          "max-w-[80%] bg-user-message-bubble rounded-[16px] break-words min-w-0 select-text [&_p]:m-0",
          compactMode ? "px-4 py-2" : "px-5 py-3.5"
        )}
      >
        {showQueued && (
          <div
            className="flex items-center gap-1.5 text-foreground/55 mb-1.5"
            role="status"
            aria-live="polite"
          >
            <Clock className="h-3 w-3 animate-pulse" aria-hidden="true" />
            <span className="text-[11px] italic">{t('chat.queuedBadge')}</span>
          </div>
        )}
        {hasInlineBadges
          ? renderContentWithBadges(displayContent, inlineBadges, onUrlClick, onFileClick)
          : (
            <Markdown
              mode="minimal"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
              className="text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap"
            >
              {displayContent}
            </Markdown>
          )
        }
      </div>
    </div>
  )
}

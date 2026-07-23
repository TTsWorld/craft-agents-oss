/**
 * SessionViewer - 只读会话记录查看器
 *
 * 平台无关的会话记录查看组件。
 * 由 web viewer 应用使用；交互式聊天由 Electron 的 ChatDisplay 承载。
 *
 * 将会话消息渲染为 turn card，顶部和底部带渐变遮罩。
 */

import type { ReactNode } from 'react'
import { useMemo, useState, useCallback } from 'react'
import type { StoredSession } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { CHAT_LAYOUT, CHAT_CLASSES } from '../../lib/layout'
import { PlatformProvider, type PlatformActions } from '../../context'
import { TurnCard } from './TurnCard'
import { UserMessageBubble } from './UserMessageBubble'
import { SystemMessage } from './SystemMessage'
import {
  groupMessagesByTurn,
  storedToMessage,
  getAssistantTurnUiKey,
  type ActivityItem,
} from './turn-utils'

export type SessionViewerMode = 'interactive' | 'readonly'

export interface SessionViewerProps {
  /** 待展示的会话数据 */
  session: StoredSession
  /** 查看模式 - 'readonly' 用于 web viewer，'interactive' 用于 Electron */
  mode?: SessionViewerMode
  /** 平台相关操作（打开文件、处理 URL 等） */
  platformActions?: PlatformActions
  /** 容器的额外 className */
  className?: string
  /** 点击 turn 时的回调 */
  onTurnClick?: (turnId: string) => void
  /** 点击活动时的回调 */
  onActivityClick?: (activity: ActivityItem) => void
  /** turn 的默认展开状态（readonly 为 true，interactive 为 false） */
  defaultExpanded?: boolean
  /** 自定义头部内容 */
  header?: ReactNode
  /** 自定义底部内容（交互模式下的输入区） */
  footer?: ReactNode
  /** 可选的会话文件夹路径，用于在工具展示中从文件路径里剔除该前缀 */
  sessionFolderPath?: string
}

/**
 * CraftAgentLogo - 用于品牌展示的 Craft Agent "C" logo
 */
function CraftAgentLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(3.4502, 3)" fill="currentColor">
        <path
          d="M3.17890888,3.6 L3.17890888,0 L16,0 L16,3.6 L3.17890888,3.6 Z M9.642,7.2 L9.64218223,10.8 L0,10.8 L0,3.6 L16,3.6 L16,7.2 L9.642,7.2 Z M3.17890888,18 L3.178,14.4 L0,14.4 L0,10.8 L16,10.8 L16,18 L3.17890888,18 Z"
          fillRule="nonzero"
        />
      </g>
    </svg>
  )
}

/**
 * SessionViewer - 只读会话记录查看组件
 */
export function SessionViewer({
  session,
  mode = 'readonly',
  platformActions = {},
  className,
  onTurnClick,
  onActivityClick,
  defaultExpanded = false,
  header,
  footer,
  sessionFolderPath,
}: SessionViewerProps) {
  // 将 StoredMessage[] 转换为 Message[] 并按 turn 分组。
  // 查看器始终是一个已完成会话的快照，因此标记为非 processing 状态，
  // 以强制将（可能存在的）开放 turn 以中间文本兜底方式刷出。
  const turns = useMemo(
    () => groupMessagesByTurn(session.messages.map(storedToMessage), { isSessionProcessing: false }),
    [session.messages]
  )

  // 跟踪展开的 turn（受控状态）
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    // 默认：所有 turn 折叠，可通过 defaultExpanded prop 覆盖
    if (defaultExpanded) {
      return new Set(
        turns
          .map((turn, index) => turn.type === 'assistant' ? getAssistantTurnUiKey(turn, index) : null)
          .filter((key): key is string => !!key)
      )
    }
    return new Set()
  })

  // 跟踪展开的活动分组
  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())

  const handleExpandedChange = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  const handleExpandedActivityGroupsChange = useCallback((groups: Set<string>) => {
    setExpandedActivityGroups(groups)
  }, [])

  const handleOpenActivityDetails = useCallback((activity: ActivityItem) => {
    if (onActivityClick) {
      onActivityClick(activity)
    } else if (platformActions.onOpenActivityDetails) {
      platformActions.onOpenActivityDetails(session.id, activity.id)
    }
  }, [onActivityClick, platformActions, session.id])

  const handleOpenTurnDetails = useCallback((turnId: string) => {
    if (onTurnClick) {
      onTurnClick(turnId)
    } else if (platformActions.onOpenTurnDetails) {
      platformActions.onOpenTurnDetails(session.id, turnId)
    }
  }, [onTurnClick, platformActions, session.id])

  return (
    <PlatformProvider actions={platformActions}>
      <div className={cn("flex flex-col h-full", className)}>
        {/* 头部 */}
        {header && (
          <div className="shrink-0 border-b">
            {header}
          </div>
        )}

        {/* 消息区域，顶部和底部带渐变遮罩 */}
        <div
          className="flex-1 min-h-0"
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
          }}
        >
          <div className="h-full overflow-y-auto">
            <div className={cn(CHAT_LAYOUT.maxWidth, "mx-auto", CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing)}>
            {turns.map((turn, index) => {
              if (turn.type === 'user') {
                return (
                  <div key={turn.message.id} className={CHAT_LAYOUT.userMessagePadding}>
                    <UserMessageBubble
                      content={turn.message.content}
                      attachments={turn.message.attachments}
                      badges={turn.message.badges}
                      onUrlClick={platformActions.onOpenUrl}
                      onFileClick={platformActions.onOpenFile}
                    />
                  </div>
                )
              }

              if (turn.type === 'system') {
                const msgType = turn.message.role === 'error' ? 'error' :
                               turn.message.role === 'warning' ? 'warning' :
                               turn.message.role === 'info' ? 'info' : 'system'
                return (
                  <SystemMessage
                    key={turn.message.id}
                    content={turn.message.content}
                    type={msgType}
                  />
                )
              }

              if (turn.type === 'assistant') {
                const assistantUiKey = getAssistantTurnUiKey(turn, index)
                return (
                  <TurnCard
                    key={assistantUiKey}
                    turnId={turn.turnId}
                    activities={turn.activities}
                    response={turn.response}
                    intent={turn.intent}
                    isStreaming={turn.isStreaming}
                    isComplete={turn.isComplete}
                    isExpanded={expandedTurns.has(assistantUiKey)}
                    onExpandedChange={(expanded) => handleExpandedChange(assistantUiKey, expanded)}
                    onOpenFile={platformActions.onOpenFile}
                    onOpenUrl={platformActions.onOpenUrl}
                    onPopOut={platformActions.onOpenMarkdownPreview}
                    onOpenDetails={() => handleOpenTurnDetails(turn.turnId)}
                    onOpenActivityDetails={handleOpenActivityDetails}
                    todos={turn.todos}
                    expandedActivityGroups={expandedActivityGroups}
                    onExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
                    hasEditOrWriteActivities={turn.activities.some(a =>
                      a.toolName === 'Edit' || a.toolName === 'Write'
                    )}
                    onOpenMultiFileDiff={platformActions.onOpenMultiFileDiff
                      ? () => platformActions.onOpenMultiFileDiff!(session.id, turn.turnId)
                      : undefined
                    }
                    sessionFolderPath={sessionFolderPath}
                    annotationInteractionMode={mode === 'readonly' ? 'tooltip-only' : 'interactive'}
                  />
                )
              }

              return null
            })}

            {/* 底部品牌标识 */}
            <div className={CHAT_CLASSES.brandingContainer}>
              <CraftAgentLogo className="w-8 h-8 text-[#9570BE]/40" />
            </div>
            </div>
          </div>
        </div>

        {/* 底部（输入区） */}
        {footer && (
          <div className="shrink-0 border-t">
            {footer}
          </div>
        )}
      </div>
    </PlatformProvider>
  )
}

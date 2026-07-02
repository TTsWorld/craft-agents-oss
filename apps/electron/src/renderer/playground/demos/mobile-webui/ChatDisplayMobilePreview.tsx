/**
 * ChatDisplayMobilePreview — React 组件
 * ChatDisplayMobilePreview：在手机框架内预览聊天界面（ChatDisplay）的 playground 组件。
 * 
 * 所属目录：mobile-webui
 */
import * as React from 'react'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import type { Message } from '@craft-agent/core/types'
// permission mode 是 Agent 执行工具前的权限策略：auto/ask/confirm 等。
import type { PermissionMode } from '../../../../shared/types'
import { MobileWebUIFrame, type MobileDevice } from './MobileWebUIFrame'
import { MobilePlaygroundProviders } from './MobilePlaygroundProviders'
import {
  MOCK_MESSAGES,
  MOCK_LABELS,
  MOCK_LLM_CONNECTIONS,
  MOCK_SESSION_STATUSES,
  MOCK_SOURCES,
  MOCK_SKILLS,
  MOBILE_WORKSPACE_ID,
  buildMockSession,
} from './mock-mobile-data'

// 工厂函数，返回一个用于 playground 占位回调的 logger；unknown[] 表示接受任意参数。
const log = (label: string) => (...args: unknown[]) => {
  console.log(`[Mobile ChatDisplay] ${label}`, args)
}

// 字面量联合类型，限制 messageCount 只能是 1/5/20 三种场景。
type MessageCount = '1' | '5' | '20'

interface ChatDisplayMobilePreviewProps {
  device?: MobileDevice
  showBezel?: boolean
  /** Number of messages to show. '1' = single user msg, '5' = full thread, '20' = scroll test */
  messageCount?: MessageCount
  /** Show the last assistant turn as still streaming. */
  streaming?: boolean
  /** Initial permission mode for the inline badge. */
  permissionMode?: PermissionMode
}

const DEMO_SESSION_ID = 'mobile-chat-demo'

/**
 * Builds a message slice scaled by `messageCount` so the demo can exercise
 * single-message empty-feel, normal threads, and long scrollable threads.
 * 根据 messageCount 构建不同数量的消息数组，用于测试空态、普通会话和长列表滚动。
 */
function buildMessages(count: MessageCount, streaming: boolean): Message[] {
  if (count === '1') {
    return [MOCK_MESSAGES[0]]
  }
  if (count === '5') {
    const base = MOCK_MESSAGES.slice(0, 4)
    if (!streaming) return base
    return [
      ...base.slice(0, -1),
      {
        ...base[base.length - 1],
        id: 'm-streaming',
        content: 'Trying to reproduce on iOS 17.4… ',
        isStreaming: true,
      },
    ]
  }
  // '20': cycle the base messages with new ids and timestamps
  // 循环复用基础消息，生成 20 条带新 id 和递增时间戳的消息。
  const out: Message[] = []
  for (let i = 0; i < 20; i++) {
    const base = MOCK_MESSAGES[i % MOCK_MESSAGES.length]
    out.push({
      ...base,
      id: `${base.id}-loop-${i}`,
      timestamp: (base.timestamp ?? Date.now()) - (20 - i) * 60_000,
    })
  }
  if (streaming) {
    const last = out[out.length - 1]
    out[out.length - 1] = { ...last, isStreaming: true, content: last.content + ' …' }
  }
  return out
}

/** ChatDisplayMobilePreview：函数 */
export function ChatDisplayMobilePreview({
  device = 'iphone-15',
  showBezel = true,
  messageCount = '5',
  streaming = false,
  permissionMode = 'ask',
}: ChatDisplayMobilePreviewProps) {
  // 当前选中的模型、权限模式、输入框内容，都是局部受控状态。
  const [model, setModel] = React.useState('haiku')
  const [mode, setMode] = React.useState<PermissionMode>(permissionMode)
  const [input, setInput] = React.useState('')

  // 当外部 prop permissionMode 变化时同步到内部状态。
  React.useEffect(() => setMode(permissionMode), [permissionMode])

  // useMemo 缓存消息数组，避免每次渲染都重新生成 20 条消息。
  const messages = React.useMemo(
    () => buildMessages(messageCount, streaming),
    [messageCount, streaming],
  )

  // 用缓存的消息构建 mock session；session 是 Agent 一次对话的上下文容器。
  const session = React.useMemo(
    () =>
      buildMockSession(DEMO_SESSION_ID, {
        messages,
        isProcessing: streaming,
      }),
    [messages, streaming],
  )

  return (
    <MobilePlaygroundProviders session={session} llmConnections={MOCK_LLM_CONNECTIONS}>
      <MobileWebUIFrame device={device} showBezel={showBezel}>
        <div className="flex flex-col h-full bg-background">
          <ChatDisplay
            session={session}
            onSendMessage={log('onSendMessage')}
            onOpenFile={log('onOpenFile')}
            onOpenUrl={log('onOpenUrl')}
            currentModel={model}
            onModelChange={setModel}
            permissionMode={mode}
            onPermissionModeChange={setMode}
            inputValue={input}
            onInputChange={(v) => setInput(v)}
            sources={MOCK_SOURCES}
            onSourcesChange={log('onSourcesChange')}
            skills={MOCK_SKILLS}
            labels={MOCK_LABELS}
            onLabelsChange={log('onLabelsChange')}
            sessionStatuses={MOCK_SESSION_STATUSES}
            onSessionStatusChange={log('onSessionStatusChange')}
            workspaceId={MOBILE_WORKSPACE_ID}
            compactMode={true}
            enableCompactModelPicker={true}
          />
        </div>
      </MobileWebUIFrame>
    </MobilePlaygroundProviders>
  )
}

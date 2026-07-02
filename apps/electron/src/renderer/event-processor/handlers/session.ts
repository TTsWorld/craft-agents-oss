/**
 * Session 事件处理器
 *
 * 处理 complete、error、sources_changed、labels_changed、session_status_changed 等事件。
 * 都是纯函数：只读输入，返回新的 state，无副作用。
 *
 * 对 Go 同学：可以把它看作一个事件驱动的 reducer，每个 handler 处理一种事件类型，
 * 返回新的状态和一个副作用列表（Effect[]）。
 */

import type {
  SessionState,
  ProcessResult,
  CompleteEvent,
  ErrorEvent,
  TypedErrorEvent,
  SourcesChangedEvent,
  LabelsChangedEvent,
  ProjectIdChangedEvent,
  SessionStatusChangedEvent,
  SessionMetadataChangedEvent,
  SessionFlaggedEvent,
  SessionUnflaggedEvent,
  SessionArchivedEvent,
  SessionUnarchivedEvent,
  NameChangedEvent,
  PermissionRequestEvent,
  CredentialRequestEvent,
  PlanSubmittedEvent,
  StatusEvent,
  InfoEvent,
  InterruptedEvent,
  TitleGeneratedEvent,
  TitleRegeneratingEvent,
  AsyncOperationEvent,
  WorkingDirectoryChangedEvent,
  PermissionModeChangedEvent,
  SessionModelChangedEvent,
  LLMConnectionChangedEvent,
  UserMessageEvent,
  MessageAnnotationsUpdatedEvent,
  SessionSharedEvent,
  SessionUnsharedEvent,
  AuthRequestEvent,
  AuthCompletedEvent,
  UsageUpdateEvent,
  Effect,
} from '../types'
import type { Message } from '../../../shared/types'
import { generateMessageId, appendMessage } from '../helpers'

/**
 * 处理 complete 事件：Agent 一轮执行结束。
 *
 * - 设置 isProcessing: false
 * - 清空 streaming 状态
 * - 把仍在运行中的 tool 标记为完成（安全兜底）
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent
): ProcessResult {
  const { session } = state

  // 安全兜底：把所有非终止状态的 tool 消息标记为完成。
  // 这会捕获 'executing'（正常）和 'backgrounded'（伪后台，例如前台 Agent 结果里包含 agentId:）。
  // 真正的后台任务同时具备 isBackground=true 和 taskId，因此会被排除，由 task_completed 事件最终处理。
  const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error'])
  let updatedMessages = session.messages
  const hasRunningTools = session.messages.some(
    m => m.role === 'tool'
      && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
      && !(m.isBackground && m.taskId)  // 不要强制完成真正的后台任务
  )

  if (hasRunningTools) {
    updatedMessages = session.messages.map(m => {
      if (
        m.role === 'tool'
        && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
        && !(m.isBackground && m.taskId)
      ) {
        return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult ?? '' }
      }
      return m
    })
  }

  // 一轮执行完成后，清除所有用户消息的 isQueued 标记。
  // Pi 的 steer 路径不会发送 'processing' 状态来清除它（消息是中途注入并合并进当前回复的），
  // 所以在这里清除最自然。
  // Claude 的排队路径已经在这个事件触发前通过 'processing' 状态清除了；
  // 再次清除也是安全的空操作。
  const hasQueuedUserBubbles = updatedMessages.some(m => m.role === 'user' && m.isQueued)
  if (hasQueuedUserBubbles) {
    updatedMessages = updatedMessages.map(m =>
      m.role === 'user' && m.isQueued ? { ...m, isQueued: false } : m
    )
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined,  // 清除任何残留的状态提示
        // 用 complete 事件里的 tokenUsage 更新（用于实时上下文计数器）
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
        // 用主进程传来的 hasUnread 更新（NEW 角标的状态机）
        // 只有显式提供时才更新；undefined 表示“不要改动”
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * 处理 error 事件：简单的错误事件。
 *
 * 把运行中的 tool 标记为失败，并在消息列表末尾追加一条 error 消息。
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent
): ProcessResult {
  const { session } = state

  // 安全兜底：把运行中的 tool 标记为失败。
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // 清除任何残留的状态提示
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * 处理 typed_error 事件：带有结构化详情的错误事件。
 *
 * 与 handleError 类似，但保留 error code、title、details、可重试标记和错误动作。
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent
): ProcessResult {
  const { session } = state

  // 安全兜底：把运行中的 tool 标记为失败。
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.title
      ? `${event.error.title}: ${event.error.message}`
      : event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    errorActions: event.error.actions?.map(a => ({
      key: a.key,
      label: a.label,
      action: a.action,
      url: a.url,
      sourceSlug: a.sourceSlug,
    })),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // 清除任何残留的状态提示
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * 处理 status 事件：状态消息（例如 compacting）。
 *
 * 既把状态存到 session.currentStatus 供 ProcessingIndicator 使用，
 * 也作为消息追加到消息列表供 TurnCard 展示活动状态。
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent
): ProcessResult {
  const { session, streaming } = state

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType,
  }

  const updatedSession = appendMessage(session, statusMessage)

  return {
    state: {
      session: {
        ...updatedSession,
        // 同时存到 session 上，供 ProcessingIndicator 读取。
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
        },
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 info 事件：信息消息。
 *
 * 如果是 compaction_complete，则更新已有的 compacting 消息并清空 currentStatus；
 * 否则作为新的 info 消息追加。
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent
): ProcessResult {
  const { session, streaming } = state

  // compaction_complete 时更新已有的 compacting 消息，并清空 currentStatus。
  if (event.statusType === 'compaction_complete') {
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'compacting'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'compaction_complete' as const, infoLevel: event.level }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,  // 清除 ProcessingIndicator 上的状态
        },
        streaming,
      },
      effects: [],
    }
  }

  // 否则作为新的 info 消息追加
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  }

  return {
    state: {
      session: appendMessage(session, infoMessage),
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 interrupted 事件：Agent 被中断。
 *
 * 有两种形态：
 * - **用户主动停止**（`event.message` 存在）：用户点击了 Stop 按钮。
 *   渲染“Response interrupted”提示，移除排队的用户气泡，并把它们的文本恢复到输入框，
 *   方便用户编辑后重新发送。
 * - **静默重定向**（`event.message` 不存在）：Agent 内部中止以处理新消息。
 *   后端 `processNextQueuedMessage` 会自动重放排队消息；这里不能移除排队气泡，
 *   也不能恢复到输入框，否则用户会觉得消息被静默丢弃（#616）。
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent
): ProcessResult {
  const { session } = state
  const effects: Effect[] = []
  const isUserInitiated = !!event.message

  // 清空瞬时 streaming 状态（isPending、isStreaming），并把运行中的 tool 标记为中断。
  // 这些字段不会被持久化，因此这与刷新后的状态一致。
  // 同时过滤掉 status 消息：它们是瞬时 UI 状态，中断后不应保留。
  const updatedMessages = session.messages
    .filter(m => m.role !== 'status')  // 移除瞬时 status 消息
    // 只在用户主动停止时丢弃排队气泡；静默重定向会自动重放，必须保持可见（#616）。
    .filter(m => !(isUserInitiated && m.isQueued))
    .map(m => {
      // 把运行中的 tool 标记为中断
      if (m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error') {
        return { ...m, toolStatus: 'error' as const, toolResult: 'Interrupted', isError: true }
      }
      // 清除 assistant 消息的 pending 状态（瞬时 streaming 状态）
      if (m.role === 'assistant' && m.isPending) {
        return { ...m, isPending: false, isStreaming: false }
      }
      return m
    })

  // 只有非静默重定向时才追加“Response interrupted”消息。
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages

  // 仅在用户主动停止时把排队消息文本恢复到输入框。
  // 静默重定向保留气泡在聊天中，依赖后端自动重放（#616）。
  if (isUserInitiated && event.queuedMessages && event.queuedMessages.length > 0) {
    effects.push({
      type: 'restore_input',
      text: event.queuedMessages.join('\n\n'),
    })
  }

  return {
    state: {
      session: {
        ...session,
        isProcessing: false,
        messages,
        currentStatus: undefined,  // 清除任何残留的状态提示
      },
      streaming: null,
    },
    effects,
  }
}

/**
 * 处理 title_generated 事件：更新会话标题并清除标题生成中的状态
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        name: event.title,
        // 标题生成已完成，清除生成中状态
        isRegeneratingTitle: false,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 title_regenerating 事件：设置标题生成中状态，用于 shimmer 动画
 * @deprecated 请改用 handleAsyncOperation
 */
export function handleTitleRegenerating(
  state: SessionState,
  event: TitleRegeneratingEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isRegeneratingTitle: event.isRegenerating,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 async_operation 事件：设置通用异步操作状态，用于 shimmer 动画
 * 适用于分享、更新分享、撤销分享、标题重新生成等任意异步操作
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 working_directory_changed 事件：更新会话工作目录（用户通过 UI 主动切换）
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 permission_mode_changed 事件：把事件转换成副作用，交给父组件处理会话选项
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_mode_changed',
      sessionId: event.sessionId,
      permissionMode: event.permissionMode,
      previousPermissionMode: event.previousPermissionMode,
      transitionDisplay: event.transitionDisplay,
      modeVersion: event.modeVersion,
      changedAt: event.changedAt,
      changedBy: event.changedBy,
    }],
  }
}

/**
 * 处理 session_model_changed 事件：更新会话使用的模型
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, model: event.model ?? undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 connection_changed 事件：把服务端的 session.llmConnection 同步到 renderer 状态
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        ...(event.supportsBranching !== undefined && { supportsBranching: event.supportsBranching }),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 user_message 事件：后端对乐观用户消息的确认
 *
 * 三种状态：
 * - 'accepted'：消息正在处理中（确认乐观消息）
 * - 'queued'：消息在正在进行中的回复期间被排队（如果不存在则添加，并标记为 queued）
 * - 'processing'：排队的消息现在开始处理（更新状态）
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent
): ProcessResult {
  const { session, streaming } = state
  const { message, status } = event

  // 按 ID 匹配查找已有消息（后端 ID、乐观 ID，或 content+timestamp 兜底）
  const existingIndex = session.messages.findIndex(m =>
    m.role === 'user' && (
      m.id === message.id ||
      (event.optimisticMessageId && m.id === event.optimisticMessageId) ||
      (m.content === message.content && Math.abs(m.timestamp - message.timestamp) < 5000)
    )
  )

  let updatedMessages: Message[]

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex]

    // 事件顺序保护：不要从 'processing' 回退到 'queued'
    // 处理乱序事件（例如 'processing' 比 'queued' 先到）
    if (status === 'queued' && existingMessage.isQueued === false) {
      // 已经过了 queued 阶段，忽略这个迟到的 'queued' 事件
      return { state, effects: [] }
    }

    // 更新已有消息 —— 清除 isPending，根据 status 设置 isQueued。
    //
    // - 'queued'     → isQueued = true  （Claude 路径：后端排队等待重发）
    // - 'processing' → isQueued = false （排队的消息现在真正开始执行）
    // - 'accepted'   → isQueued = false （Pi steer 路径：Agent 已收到消息）
    //
    // 这里故意不把 `m.id` 换成后端权威 id。
    // ChatDisplay 的 `getTurnKey` 按 id 给用户消息气泡做 key，一旦替换 id 会导致
    // UserMessageBubble 卸载/重挂，从而丢失本地计时器状态，并在动画中途丢掉 queued 标签。
    // 后续事件都用 `event.optimisticMessageId` 路由（见上面的 findIndex），所以权威 id 并不关键。
    updatedMessages = session.messages.map((m, i) => {
      if (i === existingIndex) {
        return {
          ...m,
          isPending: false,
          isQueued: status === 'queued',
        }
      }
      return m
    })
  } else {
    // 消息不存在（例如来自后端的新排队消息）——直接添加
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: status === 'queued',
    }
    updatedMessages = [...session.messages, newMessage]
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user',  // 用户回复后清除 plan 角标
        // 当消息被 accepted/processing 时设置 isProcessing（支持多窗口同步）
        isProcessing: status === 'accepted' || status === 'processing',
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 message_annotations_updated 事件：更新指定消息的批注
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        messages: session.messages.map(m =>
          m.id === event.messageId
            ? { ...m, annotations: event.annotations }
            : m
        ),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 sources_changed 事件：更新会话启用的来源列表
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 labels_changed 事件：更新会话标签
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 project_id_changed 事件：更新会话的 projectId 绑定
 */
export function handleProjectIdChanged(
  state: SessionState,
  event: ProjectIdChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        projectId: event.projectId ?? undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_status_changed 事件：更新 sessionStatus（外部元数据变更或 Agent 工具触发）
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_metadata_changed 事件：合并程序化的元数据变更（taskNodeCount、
 * kanbanColumn，以及 orchestrator 接管时 taskDraft → taskSlug 的提升），
 * 这些变更不会通过 header 签名文件监听传播。
 */
export function handleSessionMetadataChanged(
  state: SessionState,
  event: SessionMetadataChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, ...event.changes },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_flagged 事件：标记会话为已标星
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_unflagged 事件：标记会话为未标星
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_archived 事件：标记会话为已归档
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_unarchived 事件：标记会话为未归档
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: false, archivedAt: undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 name_changed 事件：更新会话名称（外部元数据变更）
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, name: event.name },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 permission_request 事件：把权限请求转换成副作用，交给父组件处理
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request',
      request: event.request,
    }]
  }
}

/**
 * 处理 credential_request 事件：把凭据请求转换成副作用，交给父组件处理
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'credential_request',
      request: event.request,
    }]
  }
}

/**
 * 处理 plan_submitted 事件：把计划消息加入会话
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_shared 事件：会话已被分享到 viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 session_unshared 事件：会话分享已被撤销
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 auth_request 事件：把 auth-request 消息加入会话
 * 这是统一认证流程 —— 在认证完成前 Agent 执行会暂停
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent
): ProcessResult {
  const { session, streaming } = state

  // 把 auth-request 消息加入会话
  return {
    state: {
      session: {
        ...appendMessage(session, event.message),
        isProcessing: false,  // Agent 执行暂停
      },
      streaming: null,  // 清空任何流式状态
    },
    effects: [],
  }
}

/**
 * 处理 auth_completed 事件：更新 auth-request 消息状态
 * Agent 会通过一条新的用户消息恢复执行（由 session manager 发送）
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent
): ProcessResult {
  const { session, streaming } = state

  // 更新 auth-request 消息状态
  const updatedMessages = session.messages.map(m => {
    if (
      m.role === 'auth-request' &&
      m.authRequestId === event.requestId &&
      m.authStatus === 'pending'
    ) {
      return {
        ...m,
        authStatus: event.success
          ? ('completed' as const)
          : event.cancelled
            ? ('cancelled' as const)
            : ('failed' as const),
        authError: event.error,
      }
    }
    return m
  })

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * 处理 usage_update 事件：处理过程中实时更新上下文用量
 * 合并到现有 tokenUsage 中（保留 outputTokens、costUsd 等已有字段）
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent
): ProcessResult {
  const { session, streaming } = state

  // 合并用量更新到现有 tokenUsage，为必填字段提供默认值
  const updatedTokenUsage = {
    inputTokens: event.tokenUsage.inputTokens,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: session.tokenUsage?.contextTokens ?? 0,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && { cacheReadTokens: session.tokenUsage.cacheReadTokens }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && { cacheCreationTokens: session.tokenUsage.cacheCreationTokens }),
    ...(event.tokenUsage.contextWindow && { contextWindow: event.tokenUsage.contextWindow }),
  }

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
      },
      streaming,
    },
    effects: [],
  }
}

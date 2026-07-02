/**
 * 事件处理器
 *
 * 核心纯函数：统一处理所有 Agent 事件。
 * 保证状态转换的一致性，并且总是返回新的 state 引用。
 *
 * 设计收益：
 * - 单一事件处理来源，避免散落逻辑
 * - 纯函数：无副作用、便于单元测试（类似 Go 中只读输入输出）
 * - 单条更新路径，避免竞态条件
 * - 总是返回新的引用，保证 Jotai 等原子状态库能感知到变化
 * - 消息按 ID 查找，不按数组下标
 */

import type { SessionState, AgentEvent, ProcessResult } from './types'
import { handleTextDelta, handleTextComplete } from './handlers/text'
import { handleToolStart, handleToolResult, handleTaskBackgrounded, handleShellBackgrounded, handleTaskProgress, handleTaskCompleted } from './handlers/tool'
import {
  handleComplete,
  handleError,
  handleTypedError,
  handleSourcesChanged,
  handleLabelsChanged,
  handleProjectIdChanged,
  handleSessionStatusChanged,
  handleSessionMetadataChanged,
  handleSessionFlagged,
  handleSessionUnflagged,
  handleSessionArchived,
  handleSessionUnarchived,
  handleNameChanged,
  handlePermissionRequest,
  handleCredentialRequest,
  handlePlanSubmitted,
  handleStatus,
  handleInfo,
  handleInterrupted,
  handleTitleGenerated,
  handleTitleRegenerating,
  handleAsyncOperation,
  handleWorkingDirectoryChanged,
  handlePermissionModeChanged,
  handleSessionModelChanged,
  handleConnectionChanged,
  handleUserMessage,
  handleMessageAnnotationsUpdated,
  handleSessionShared,
  handleSessionUnshared,
  handleAuthRequest,
  handleAuthCompleted,
  handleUsageUpdate,
} from './handlers/session'

/**
 * 处理一个 Agent 事件，返回新的会话状态以及需要执行的副作用
 *
 * 这是一个纯函数：无副作用，总是返回新的 state。
 * 如果 switch 没有匹配到已知事件，也会浅拷贝 state 后返回，保证引用新鲜。
 *
 * @param state - 当前会话状态（session + streaming）
 * @param event - 要处理的 Agent 事件
 * @returns 新状态和待执行的副作用数组
 */
export function processEvent(
  state: SessionState,
  event: AgentEvent
): ProcessResult {
  switch (event.type) {
    case 'text_delta': {
      const newState = handleTextDelta(state, event)
      return { state: newState, effects: [] }
    }

    case 'text_complete': {
      const newState = handleTextComplete(state, event)
      return { state: newState, effects: [] }
    }

    case 'tool_start': {
      const newState = handleToolStart(state, event)
      return { state: newState, effects: [] }
    }

    case 'tool_result': {
      const newState = handleToolResult(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_backgrounded': {
      const newState = handleTaskBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'shell_backgrounded': {
      const newState = handleShellBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_progress': {
      const newState = handleTaskProgress(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_completed': {
      const newState = handleTaskCompleted(state, event)
      return { state: newState, effects: [] }
    }

    case 'workflow_agent_completed':
      // Live workflow fan-out progress — the chip counter is updated in App.tsx's
      // handleBackgroundTaskEvent; nothing to change in message/session state here.
      return { state, effects: [] }

    case 'complete':
      return handleComplete(state, event)

    case 'error':
      return handleError(state, event)

    case 'typed_error':
      return handleTypedError(state, event)

    case 'status':
      return handleStatus(state, event)

    case 'info':
      return handleInfo(state, event)

    case 'interrupted':
      return handleInterrupted(state, event)

    case 'title_generated':
      return handleTitleGenerated(state, event)

    case 'title_regenerating':
      return handleTitleRegenerating(state, event)

    case 'async_operation':
      return handleAsyncOperation(state, event)

    case 'working_directory_changed':
      return handleWorkingDirectoryChanged(state, event)

    case 'working_directory_error':
      // 仅作为副作用触发一条 toast 错误提示，不修改业务状态
      return {
        state: { ...state, session: { ...state.session } },
        effects: [{ type: 'toast_error', message: event.error }],
      }

    case 'permission_mode_changed':
      return handlePermissionModeChanged(state, event)

    case 'session_model_changed':
      return handleSessionModelChanged(state, event)

    case 'connection_changed':
      return handleConnectionChanged(state, event)

    case 'sources_changed':
      return handleSourcesChanged(state, event)

    case 'labels_changed':
      return handleLabelsChanged(state, event)

    case 'project_id_changed':
      return handleProjectIdChanged(state, event)

    case 'session_status_changed':
      return handleSessionStatusChanged(state, event)

    case 'session_metadata_changed':
      return handleSessionMetadataChanged(state, event)

    case 'session_flagged':
      return handleSessionFlagged(state, event)

    case 'session_unflagged':
      return handleSessionUnflagged(state, event)

    case 'session_archived':
      return handleSessionArchived(state, event)

    case 'session_unarchived':
      return handleSessionUnarchived(state, event)

    case 'name_changed':
      return handleNameChanged(state, event)

    case 'permission_request':
      return handlePermissionRequest(state, event)

    case 'credential_request':
      return handleCredentialRequest(state, event)

    case 'plan_submitted':
      return handlePlanSubmitted(state, event)

    case 'user_message':
      return handleUserMessage(state, event)

    case 'message_annotations_updated':
      return handleMessageAnnotationsUpdated(state, event)

    case 'session_shared':
      return handleSessionShared(state, event)

    case 'session_unshared':
      return handleSessionUnshared(state, event)

    case 'auth_request':
      return handleAuthRequest(state, event)

    case 'auth_completed':
      return handleAuthCompleted(state, event)

    case 'source_activated':
      // source_activated 的自动重试逻辑现在由服务端负责（craft-agents-oss#804），
      // renderer 端收到事件后仅用作 UI 反馈。详情见 SessionManager.processEvent。
      return { state, effects: [] }

    case 'usage_update':
      return handleUsageUpdate(state, event)

    default: {
      // 未知事件类型：原样返回新的 state 引用，确保 Jotai 原子状态能感知到“变化”
      // never 类型：表示这里理论上不会到达，类似 Go 的 exhaustiveness 检查
      const _exhaustiveCheck: never = event
      return {
        state: { ...state, session: { ...state.session } },
        effects: [],
      }
    }
  }
}

/**
 * 事件处理器 Hook
 *
 * 给 App.tsx 提供事件处理能力。
 * 管理每个会话的流式状态，并返回处理后的会话与副作用。
 */

import { useCallback, useRef } from 'react'
import * as Sentry from '@sentry/electron/renderer'
import type { Session } from '../../shared/types'
import { processEvent } from './processor'
import type { SessionState, AgentEvent, Effect, StreamingState, ErrorEvent, TypedErrorEvent } from './types'
import { createEmptySession } from './helpers'

/**
 * 把 agent 的 error/typed_error 事件上报到 Sentry，使用 captureException 而不是普通消息。
 * captureException 能获得更完整的堆栈和更好的错误聚合。
 * 该函数作为 processEvent 之后的副作用调用，保持事件处理器本身仍是纯函数。
 */
function captureAgentError(event: AgentEvent): void {
  if (event.type === 'error') {
    // as 是 TS 的类型断言：告诉编译器“把 event 当成 ErrorEvent 用”，类似 Go 的类型断言 x.(T)
    const errorEvent = event as ErrorEvent
    Sentry.captureException(new Error(errorEvent.error), {
      tags: { errorSource: 'agent' },
      extra: { sessionId: event.sessionId },
    })
  } else if (event.type === 'typed_error') {
    const typedEvent = event as TypedErrorEvent
    const title = typedEvent.error.title ?? 'Agent Error'
    Sentry.captureException(new Error(`${title}: ${typedEvent.error.message}`), {
      tags: {
        errorSource: 'agent',
        errorCode: typedEvent.error.code ?? 'unknown',
      },
      extra: {
        sessionId: event.sessionId,
        // 上报调试信息，但排除 details/originalError，避免泄露用户敏感内容或文件路径
        canRetry: typedEvent.error.canRetry,
      },
    })
  }
}

/**
 * useEventProcessor 的返回类型
 */
interface UseEventProcessorResult {
  /**
   * 处理一个 Agent 事件，返回更新后的会话和副作用
   *
   * @param event - 要处理的事件
   * @param currentSession - 当前会话状态（找不到时为 null）
   * @param workspaceId - 新建会话时用的工作区 ID
   * @returns 更新后的会话和副作用数组
   */
  processAgentEvent: (
    event: AgentEvent,
    currentSession: Session | null,
    workspaceId: string
  ) => { session: Session; effects: Effect[] }

  /**
   * 清空某个会话的流式状态（出错或完成时调用）
   */
  clearStreamingState: (sessionId: string) => void

  /**
   * 获取某个会话当前的流式状态（调试用）
   */
  getStreamingState: (sessionId: string) => StreamingState | null
}

/**
 * 提供事件处理器能力的 React Hook
 *
 * 用 useRef 管理每个会话的流式状态（替代旧的 streamingTextRef）。
 * 所有事件处理都走纯函数 processEvent。
 *
 * 关于 React Hook：
 * - useRef 返回一个可变的容器，.current 可以读写且不会触发重渲染
 * - useCallback 缓存函数引用，避免子组件不必要的重渲染
 */
export function useEventProcessor(): UseEventProcessorResult {
  // 按 sessionId 保存流式状态；不用 React state，因为这里只是累积数据，不需要触发 UI 重渲染
  const streamingStates = useRef<Map<string, StreamingState>>(new Map())

  const processAgentEvent = useCallback((
    event: AgentEvent,
    currentSession: Session | null,
    workspaceId: string
  ): { session: Session; effects: Effect[] } => {
    // ?? 是空值合并运算符：仅当左侧为 null/undefined 时取右侧，类似 Go 的 if x == nil { x = default }
    const session = currentSession ?? createEmptySession(event.sessionId, workspaceId)

    // 组装当前状态：Session = 持久化会话；streaming = 当前正在累积的流式内容
    const currentState: SessionState = {
      session,
      streaming: streamingStates.current.get(event.sessionId) ?? null,
    }

    // 调用纯函数处理事件
    const result = processEvent(currentState, event)

    // 副作用：如果是错误事件，上报到 Sentry（放在纯函数外部，不破坏 processEvent 的纯度）
    if (event.type === 'error' || event.type === 'typed_error') {
      captureAgentError(event)
    }

    // 根据处理结果更新流式状态 ref
    if (result.state.streaming) {
      streamingStates.current.set(event.sessionId, result.state.streaming)
    } else {
      streamingStates.current.delete(event.sessionId)
    }

    return {
      session: result.state.session,
      effects: result.effects,
    }
  }, [])

  const clearStreamingState = useCallback((sessionId: string) => {
    streamingStates.current.delete(sessionId)
  }, [])

  const getStreamingState = useCallback((sessionId: string): StreamingState | null => {
    return streamingStates.current.get(sessionId) ?? null
  }, [])

  return {
    processAgentEvent,
    clearStreamingState,
    getStreamingState,
  }
}

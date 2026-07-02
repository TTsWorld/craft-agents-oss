/**
 * useBackgroundTasks - 管理会话中的后台任务
 *
 * 跟踪每个会话的后台 Agent 与 Shell 任务。
 * 通过 task_backgrounded、shell_backgrounded、task_progress 等事件更新。
 */

import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'

export interface UseBackgroundTasksOptions {
  /** 要跟踪任务的会话 ID */
  sessionId: string
}

export interface UseBackgroundTasksResult {
  /** 当前会话的活跃后台任务 */
  tasks: BackgroundTask[]
  /** 添加新的后台任务 */
  addTask: (task: Omit<BackgroundTask, 'elapsedSeconds'>) => void
  /** 更新某个任务的已运行秒数 */
  updateTaskProgress: (toolUseId: string, elapsedSeconds: number) => void
  /** 移除任务（完成或被杀死时） */
  removeTask: (toolUseId: string) => void
  /** 杀死任务（通过 IPC 发送 kill 请求） */
  killTask: (taskId: string, type: 'agent' | 'shell') => Promise<void>
}

/**
 * 管理会话中的后台任务。
 */
export function useBackgroundTasks({ sessionId }: UseBackgroundTasksOptions): UseBackgroundTasksResult {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))

  const addTask = useCallback((task: Omit<BackgroundTask, 'elapsedSeconds'>) => {
    setTasks(prev => {
      // 防止重复添加同一任务
      if (prev.some(t => t.toolUseId === task.toolUseId)) {
        return prev
      }
      // 新增任务，初始已运行 0 秒
      return [...prev, { ...task, elapsedSeconds: 0 }]
    })
  }, [setTasks])

  const updateTaskProgress = useCallback((toolUseId: string, elapsedSeconds: number) => {
    setTasks(prev => prev.map(t =>
      t.toolUseId === toolUseId
        ? { ...t, elapsedSeconds }
        : t
    ))
  }, [setTasks])

  const removeTask = useCallback((toolUseId: string) => {
    setTasks(prev => prev.filter(t => t.toolUseId !== toolUseId))
  }, [setTasks])

  const killTask = useCallback(async (taskId: string, type: 'agent' | 'shell') => {
    // 先找到任务以获取其 toolUseId
    const task = tasks.find(t => t.id === taskId)

    if (type === 'shell') {
      // Shell 任务使用 KillShell IPC
      try {
        await window.electronAPI.killShell(sessionId, taskId)
      } catch {
        // Shell 可能已不存在，忽略错误，仍然从 UI 移除
      }
    } else {
      // Agent 任务目前没有直接 kill 机制，需要模型通过 TaskOutput 检查状态
      console.warn('Killing agent tasks not yet implemented')
    }

    // 无论 kill 是否成功，都从 UI 移除
    if (task) {
      setTasks(prev => prev.filter(t => t.id !== taskId))
    }
  }, [sessionId, tasks, setTasks])

  return {
    tasks,
    addTask,
    updateTaskProgress,
    removeTask,
    killTask,
  }
}

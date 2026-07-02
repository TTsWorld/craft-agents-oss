/**
 * ActiveTasksBar - 运行中后台任务的紧凑横向展示条
 *
 * 当存在后台任务时，显示在 ChatInput 附近。
 * 每个任务展示：类型图标、缩短后的 ID、已运行时间、操作菜单入口。
 */

import React from 'react'
import { useSetAtom } from 'jotai'
import { TaskActionMenu, type TerminalOverlayData } from './TaskActionMenu'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'

// 为现有的消费方（ActiveOptionBadges、ChatInputZone、TaskActionMenu）重新导出，
// 这样唯一定义集中在 atoms/sessions.ts 中。
export type { BackgroundTask } from '@/atoms/sessions'

/**
 * 终态/孤立的芯片在被自动清除前的停留时长。终态（completed/failed/stopped）
 * 芯片会快速清除，使任务条能反映实时工作；孤立芯片停留更久，
 * 让用户能注意到任务在轮次结束时已终止，而不是悄无声息地消失。
 */
const TERMINAL_LINGER_MS = 8_000
const ORPHANED_LINGER_MS = 20_000

/** ActiveTasksBarProps：组件 props 类型定义 */
export interface ActiveTasksBarProps {
  /** 活动中的后台任务列表 */
  tasks: BackgroundTask[]
  /** 当前会话 ID，用于打开预览窗口 */
  sessionId: string
  /** 点击停止按钮时的回调 */
  onKillTask?: (taskId: string) => void
  /** 向输入框插入文本的回调 */
  onInsertMessage?: (text: string) => void
  /** 显示终端输出浮层的回调 */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** 额外的 CSS 类名 */
  className?: string
}

/**
 * ActiveTasksBar - 以徽章形式展示运行中的后台任务
 * 样式与 ActiveOptionBadges 保持一致；没有任务时不渲染。
 */
export function ActiveTasksBar({ tasks, sessionId, onKillTask, onInsertMessage, onShowTerminalOverlay, className }: ActiveTasksBarProps) {
  const setTasks = useSetAtom(backgroundTasksAtomFamily(sessionId))

  // 自动过期定时器：在停留窗口过后清除终态/孤立芯片，
  // 使任务条反映实时工作，避免终态芯片堆积。运行中的芯片不会被清除——
  // 它们在 task_completed 时清除，或在轮次结束时被翻转为 'orphaned'
  // （App.tsx handleBackgroundTaskEvent）。这是任务条首次禁用时缺失的可靠性兜底。
  React.useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      setTasks((prev) => {
        const next = prev.filter((t) => {
          if (t.status === 'running') return true
          const age = now - (t.completedAt ?? now)
          const linger = t.status === 'orphaned' ? ORPHANED_LINGER_MS : TERMINAL_LINGER_MS
          return age < linger
        })
        return next.length === prev.length ? prev : next
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [sessionId, setTasks])

  // 没有任务时不渲染任何内容
  if (tasks.length === 0) return null

  return (
    <>
      {tasks.map((task) => (
        <TaskActionMenu
          key={task.id}
          task={task}
          sessionId={sessionId}
          onKillTask={onKillTask || (() => {})}
          onInsertMessage={onInsertMessage}
          onShowTerminalOverlay={onShowTerminalOverlay}
          className={className}
        />
      ))}
    </>
  )
}

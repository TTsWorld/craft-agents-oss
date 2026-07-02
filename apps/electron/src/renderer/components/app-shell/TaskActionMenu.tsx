/**
 * TaskActionMenu — React 组件
 * 
 * 所属目录：app-shell
 */
import * as React from 'react'
import { useTranslation } from "react-i18next"
import { ChevronDown, Square, ArrowUpRight, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { BackgroundTask } from './ActiveTasksBar'

/** 终端浮层需要的数据 */
export interface TerminalOverlayData {
  command: string
  output: string
  description?: string
  toolType: 'bash' | 'grep' | 'glob'
}

/** 把秒数格式化成紧凑的已运行时间 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

/** 缩短任务 ID 用于紧凑展示（只显示前 8 位） */
function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

/** TaskActionMenuProps：组件 props 类型定义 */
export interface TaskActionMenuProps {
  /** 后台任务数据 */
  task: BackgroundTask
  /** 当前会话 ID，用于打开预览窗口 */
  sessionId: string
  /** 点击停止按钮时的回调 */
  onKillTask: (taskId: string) => void
  /** 向输入框插入文本的回调 */
  onInsertMessage?: (text: string) => void
  /** 显示终端输出浮层的回调 */
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  /** 额外的 CSS 类名 */
  className?: string
}

/**
 * TaskActionMenu - 后台任务的操作下拉菜单
 *
 * 提供的操作：
 * - View Output：在终端浮层里查看任务输出
 * - Stop Task：终止 shell 任务
 */
export function TaskActionMenu({ task, sessionId, onKillTask, onInsertMessage, onShowTerminalOverlay, className }: TaskActionMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const isTerminal = task.status !== 'running'

  // 针对运行中（RUNNING）任务的实时计时器。异步的 agent 路径默认不发出
  // task_progress 事件，因此从 startTime 推算已用时间（而非依赖
  // elapsedSeconds）能让 chip 对所有任务类型持续计时。终态 chip 将已用时间
  // 冻结在 completedAt。
  const [localElapsed, setLocalElapsed] = React.useState(() => {
    // 用开始时间初始化
    return Math.floor((Date.now() - task.startTime) / 1000)
  })

  React.useEffect(() => {
    // 只对运行中的任务启用本地秒表
    if (isTerminal) return
    const interval = setInterval(() => {
      setLocalElapsed(Math.floor((Date.now() - task.startTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isTerminal, task.startTime])

  const displayElapsed = isTerminal
    ? Math.max(0, Math.floor(((task.completedAt ?? Date.now()) - task.startTime) / 1000))
    : Math.max(localElapsed, task.elapsedSeconds)

  // 优先使用人类可读的 intent 作为 chip 标签，而非晦涩的任务 ID。
  const taskLabel = task.intent?.trim() ?? ''

  const handleViewOutput = async () => {
    try {
      // 通过 IPC 拉取任务输出（读取 task_completed 时存储的文件）。
      const output = await window.electronAPI.getTaskOutput(task.id)

      if (onShowTerminalOverlay) {
        // 首选路径：在终端浮层中展示。
        onShowTerminalOverlay({
          command: task.intent || `${task.type} task`,
          output: output || t('chat.noOutputYet'),
          description: task.intent,
          toolType: 'bash', // shell 和 agent 任务都按 bash 类型展示
        })
      } else if (output) {
        // 当没有接入浮层处理程序时的回退方案：将完整输出复制到
        // 剪贴板，确保内容仍可获取。（运行中的任务尚无输出。）
        await navigator.clipboard?.writeText(output)
        toast.success(t('toast.taskOutputCopied', 'Task output copied to clipboard'))
      } else {
        toast.info(t('chat.noOutputYet'))
      }
      setOpen(false)
    } catch (err) {
      toast.error(t('toast.failedToLoadTaskOutput'))
    }
  }

  const handleStopTask = () => {
    onKillTask(task.id)
    setOpen(false)
  }

  // Status → icon + tint. Running shows the spinner; terminal/orphaned states
  // are visually distinct so a chip never falsely reads as "still running".
  const statusTint = cn(
    "bg-white dark:bg-white/10",
    "hover:bg-white/80 dark:hover:bg-white/15",
    "data-[state=open]:bg-white/80 dark:data-[state=open]:bg-white/15",
    task.status === 'failed' && "bg-destructive/10 hover:bg-destructive/15 dark:bg-destructive/15",
    task.status === 'orphaned' && "bg-amber-500/10 hover:bg-amber-500/15 dark:bg-amber-500/15",
  )

  const StatusIcon = () => {
    switch (task.status) {
      case 'completed':
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
      case 'failed':
        return <XCircle className="h-3.5 w-3.5 text-destructive" />
      case 'stopped':
        return <Square className="h-3 w-3 opacity-60" />
      case 'orphaned':
        return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
      default:
        return <Spinner className="text-xs" />
    }
  }

  const statusLabel: Record<string, string> = {
    completed: t('chat.taskStatusDone', 'done'),
    failed: t('chat.taskStatusFailed', 'failed'),
    stopped: t('chat.taskStatusStopped', 'stopped'),
    orphaned: t('chat.taskStatusOrphaned', 'orphaned'),
  }

  const chipTitle = task.status === 'orphaned'
    ? t('chat.taskOrphanedHint', 'This background task was terminated when its turn ended.')
    : t("chat.clickForTaskActions")

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-[30px] pl-2.5 pr-2 text-xs font-medium rounded-[8px]",
            "flex items-center gap-1.5 shrink-0 select-none",
            "transition-all shadow-minimal cursor-pointer",
            statusTint,
            className
          )}
          title={chipTitle}
        >
          {/* 状态图标 */}
          <div className="flex items-center justify-center shrink-0">
            <StatusIcon />
          </div>

          {/* 任务类型 */}
          <span className="opacity-60">
            {task.type === 'workflow'
              ? t('chat.taskTypeWorkflow')
              : task.type === 'agent'
                ? t('chat.taskTypeAgent')
                : t('chat.taskTypeShell')}
          </span>

          {/* Intent（实际的任务描述）—— 仅当没有捕获到 intent 时才回退到
              缩短的任务 ID。截断以防止过长的 intent 撑爆 chip；完整文本在 hover 时展示。 */}
          {taskLabel ? (
            <span className="opacity-80 truncate max-w-[220px]" title={taskLabel}>
              {taskLabel}
            </span>
          ) : (
            <span className="font-mono opacity-80">
              {shortenId(task.id)}
            </span>
          )}

          {/* 工作流扇出进度：已完成子代理的实时计数。 */}
          {task.type === 'workflow' && (task.agentsCompleted ?? 0) > 0 && (
            <span
              className="opacity-60 tabular-nums"
              title={t('chat.workflowAgentsDone', { count: task.agentsCompleted ?? 0 })}
            >
              {t('chat.workflowAgentsDone', { count: task.agentsCompleted ?? 0 })}
            </span>
          )}

          {/* 已用时间，或终态状态文字 */}
          {task.status === 'running' ? (
            <span className="opacity-60 tabular-nums">
              {formatElapsed(displayElapsed)}
            </span>
          ) : (
            <span className="opacity-70">
              {statusLabel[task.status] ?? task.status}
            </span>
          )}

          {/* 下拉箭头 */}
          <ChevronDown className="h-3.5 w-3.5 opacity-60 ml-auto" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start" sideOffset={4}>
        {/* 查看输出 - 主要操作 */}
        <StyledDropdownMenuItem onClick={handleViewOutput}>
          <ArrowUpRight />
          {t('chat.viewOutput')}
        </StyledDropdownMenuItem>

        {/* 停止任务 - 仅对 shell 任务显示 */}
        {task.type === 'shell' && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleStopTask}>
              <Square />
              {t('chat.stopTask')}
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

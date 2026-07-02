/**
 * SendToWorkspaceDialog - 把会话发送到远程工作区的对话框。
 *
 * 只显示远程工作区（同一机器上的本地工作区之间发送没有意义）。
 * 不可达的远程工作区显示为禁用，并带 CloudOff 图标。
 *
 * 跨服务器传输流程：
 * 1. 从当前服务器生成一个迷你摘要 handoff payload
 * 2. 通过临时连接把摘要导入目标服务器
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { useState, useCallback, useEffect, useRef } from 'react'
import { Cloud, CloudOff, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { cn } from '@/lib/utils'
import type { Workspace } from '../../../shared/types'

/** SendToWorkspaceDialogProps：组件 props 类型定义 */
export interface SendToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 要传输的会话 ID 列表 */
  sessionIds: string[]
  /** 所有工作区 */
  workspaces: Workspace[]
  /** 当前工作区 ID（选择器中排除） */
  activeWorkspaceId: string | null
  /** 传输成功后回调，返回目标工作区 ID 和新会话 ID 列表 */
  onTransferComplete?: (targetWorkspaceId: string, newSessionIds: string[]) => void
}

/** SendToWorkspaceDialog - 发送会话到远程工作区 */
export function SendToWorkspaceDialog({
  open,
  onOpenChange,
  sessionIds,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendToWorkspaceDialogProps) {
  const { t } = useTranslation()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isTransferring, setIsTransferring] = useState(false)
  // 整个批次传输的归一化进度（0–1）
  const [overallProgress, setOverallProgress] = useState(0)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // 监听主进程的 chunk 上传进度，并归一化到整个批次
  useEffect(() => {
    if (!isTransferring) {
      setOverallProgress(0)
      return
    }
    const cleanup = window.electronAPI.onTransferProgress((p) => {
      // 每个会话贡献 1/sessionCount 的总进度；会话内按 chunkSent/chunkTotal 填充该片段。
      const sessionSlice = 1 / p.sessionCount
      const withinSession = p.chunkTotal > 0 ? p.chunkSent / p.chunkTotal : 1
      setOverallProgress(p.sessionIndex * sessionSlice + withinSession * sessionSlice)
    })
    return cleanup
  }, [isTransferring])

  // 远程工作区健康检查结果（对话框打开时检测）
  const [remoteHealthMap, setRemoteHealthMap] = useState<Map<string, 'ok' | 'error' | 'checking'>>(new Map())
  const healthCheckAbort = useRef<AbortController | null>(null)

  // 只显示远程工作区（本地到本地无意义）
  const remoteWorkspaces = workspaces.filter(w => w.id !== activeWorkspaceId && w.remoteServer)

  // 对话框打开时检测所有远程工作区的连通性
  useEffect(() => {
    if (!open) {
      healthCheckAbort.current?.abort()
      return
    }

    // 取消进行中的检测
    healthCheckAbort.current?.abort()
    const abort = new AbortController()
    healthCheckAbort.current = abort

    if (remoteWorkspaces.length === 0) return

    setRemoteHealthMap(() => {
      const next = new Map<string, 'ok' | 'error' | 'checking'>()
      for (const ws of remoteWorkspaces) next.set(ws.id, 'checking')
      return next
    })

    // 并行检测
    for (const ws of remoteWorkspaces) {
      window.electronAPI.testRemoteConnection(ws.remoteServer!.url, ws.remoteServer!.token)
        .then(result => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(prev => new Map(prev).set(ws.id, result.ok ? 'ok' : 'error'))
        })
        .catch(() => {
          if (abort.signal.aborted) return
          setRemoteHealthMap(prev => new Map(prev).set(ws.id, 'error'))
        })
    }

    return () => abort.abort()
  }, [open, remoteWorkspaces.map(w => w.id).join(',')])

  const handleTransfer = useCallback(async () => {
    if (!selectedWorkspaceId || sessionIds.length === 0) return

    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!targetWorkspace?.remoteServer) return

    setIsTransferring(true)
    const targetName = targetWorkspace.name
    const count = sessionIds.length

    const toastId = toast.loading(t('sendToWorkspace.sending', { count, target: targetName }))

    try {
      const newSessionIds: string[] = []

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        // 主进程处理导出 + 摘要 + 传输（大数据包会分块）
        const result = await window.electronAPI.transferSessionToWorkspace(sessionId, selectedWorkspaceId, i, sessionIds.length)
        newSessionIds.push(result.sessionId)
      }

      toast.success(t('sendToWorkspace.sent', { count, target: targetName }), {
        id: toastId,
        action: onTransferComplete ? {
          label: t('sendToWorkspace.open'),
          onClick: () => onTransferComplete(selectedWorkspaceId, newSessionIds),
        } : undefined,
      })

      onOpenChange(false)
      setSelectedWorkspaceId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('sendToWorkspace.failedToSend', { count }), {
        id: toastId,
        description: message,
      })
    } finally {
      setIsTransferring(false)
    }
  }, [selectedWorkspaceId, sessionIds, workspaces, onOpenChange, onTransferComplete])

  const count = sessionIds.length

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isTransferring) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            {t("sendToWorkspace.title")}
          </DialogTitle>
          <DialogDescription>
            {t("sendToWorkspace.description", { count })}
          </DialogDescription>
        </DialogHeader>

        {/* 工作区列表——仅远程 */}
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
          {remoteWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground px-2 py-4 text-center">
              {t("sendToWorkspace.noRemoteWorkspaces")}
            </p>
          ) : (
            remoteWorkspaces.map(workspace => {
              const isSelected = selectedWorkspaceId === workspace.id
              const healthStatus = remoteHealthMap.get(workspace.id)
              const isDisconnected = healthStatus === 'error'
              const isChecking = healthStatus === 'checking'

              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={isTransferring || isDisconnected}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                  className={cn(
                    'flex items-center gap-2 w-full px-2 py-2 rounded-md text-left text-sm transition-colors',
                    'hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-foreground/10 ring-1 ring-foreground/15',
                    isDisconnected && 'opacity-50 cursor-not-allowed hover:bg-transparent',
                  )}
                >
                  <WorkspaceAvatar
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    src={workspaceIconMap.get(workspace.id)}
                    className="h-5 w-5 rounded-full ring-1 ring-border/50 shrink-0"
                    fallbackClassName="rounded-full"
                  />
                  <span className="flex-1 truncate">{workspace.name}</span>
                  {isDisconnected ? (
                    <CloudOff className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  ) : (
                    <Cloud className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      isChecking ? 'text-muted-foreground/30 animate-pulse' : 'text-muted-foreground',
                    )} />
                  )}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isTransferring}
          >
            Cancel
          </Button>
          <TransferButton
            onClick={handleTransfer}
            disabled={!selectedWorkspaceId || isTransferring}
            isTransferring={isTransferring}
            progress={overallProgress}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * TransferButton - 发送按钮，传输时显示紫色 LED 边框围绕按钮转动。
 */
function TransferButton({ onClick, disabled, isTransferring, progress }: {
  onClick: () => void
  disabled: boolean
  isTransferring: boolean
  progress: number
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<SVGRectElement>(null)
  const [perim, setPerim] = useState(0)

  useEffect(() => {
    if (rectRef.current && isTransferring) {
      setPerim(rectRef.current.getTotalLength())
    }
  }, [isTransferring])

  return (
    <div ref={wrapperRef} className="relative">
      <Button onClick={onClick} disabled={disabled}>
        {isTransferring ? 'Sending...' : 'Send'}
      </Button>
      {isTransferring && (
        <svg
          className="absolute pointer-events-none"
          style={{ inset: '-3px', width: 'calc(100% + 6px)', height: 'calc(100% + 6px)', overflow: 'visible' }}
        >
          <rect
            ref={rectRef}
            x="1.5" y="1.5"
            width="calc(100% - 3px)" height="calc(100% - 3px)"
            rx="10" ry="10"
            fill="none"
            stroke="#8B5CF6"
            strokeWidth="2"
            strokeDasharray={perim > 0 ? `${progress * perim} ${perim}` : '0 999'}
            style={{
              transition: 'stroke-dasharray 0.2s ease-out',
              filter: 'drop-shadow(0 0 3px #8B5CF6) drop-shadow(0 0 6px rgba(139,92,246,0.3))',
            }}
          />
        </svg>
      )}
    </div>
  )
}

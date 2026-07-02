/**
 * SendResourceToWorkspaceDialog - 把来源、技能或自动化复制到另一个工作区。
 *
 * 使用 resources:export → resources:import 的 RPC 流程。
 * 同时支持本地和远程目标工作区：
 * - 本地目标：两次 RPC 都发往同一服务器
 * - 远程目标：导出在本地执行，导入通过 invokeOnServer 在目标服务器执行
 *
 * 改编自 SendToWorkspaceDialog（会话传输）。
 */

import * as React from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Cloud, CloudOff, Monitor, Send } from 'lucide-react'
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
import type { Workspace, ExportResourcesOptions, ResourceImportMode } from '../../../shared/types'

/** SendResourceType：联合/字面量类型别名 */
export type SendResourceType = 'source' | 'skill' | 'automation'

/** SendResourceToWorkspaceDialogProps：组件 props 类型定义 */
export interface SendResourceToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 要发送的资源类型 */
  resourceType: SendResourceType
  /** 要发送的资源 slug 或 ID 列表 */
  resourceIds: string[]
  /** 对话框描述中显示的标签，例如 "Slack source" */
  resourceLabel: string
  /** 所有工作区 */
  workspaces: Workspace[]
  /** 当前工作区 ID（选择器中排除） */
  activeWorkspaceId: string | null
  /** 传输成功后的回调 */
  onTransferComplete?: () => void
}

// 资源类型的单复数英文标签（用于日志和提示，不翻译）
const RESOURCE_TYPE_LABELS: Record<SendResourceType, { singular: string; plural: string }> = {
  source: { singular: 'source', plural: 'sources' },
  skill: { singular: 'skill', plural: 'skills' },
  automation: { singular: 'automation', plural: 'automations' },
}

/** SendResourceToWorkspaceDialog - 发送资源到其它工作区 */
export function SendResourceToWorkspaceDialog({
  open,
  onOpenChange,
  resourceType,
  resourceIds,
  resourceLabel,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendResourceToWorkspaceDialogProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // 远程工作区健康检查结果
  const [remoteHealthMap, setRemoteHealthMap] = useState<Map<string, 'ok' | 'error' | 'checking'>>(new Map())
  const healthCheckAbort = useRef<AbortController | null>(null)

  // 除当前工作区外的所有工作区（本地和远程）
  const targetWorkspaces = workspaces.filter(w => w.id !== activeWorkspaceId)

  // 对话框打开时检测远程工作区
  useEffect(() => {
    if (!open) {
      healthCheckAbort.current?.abort()
      return
    }

    healthCheckAbort.current?.abort()
    const abort = new AbortController()
    healthCheckAbort.current = abort

    const remoteTargets = targetWorkspaces.filter(w => w.remoteServer)
    if (remoteTargets.length === 0) return

    // 先把所有远程目标标记为检测中
    setRemoteHealthMap(() => {
      const next = new Map<string, 'ok' | 'error' | 'checking'>()
      for (const ws of remoteTargets) next.set(ws.id, 'checking')
      return next
    })

    // 并行检测
    for (const ws of remoteTargets) {
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
  }, [open, targetWorkspaces.map(w => w.id).join(',')])

  const handleSend = useCallback(async () => {
    if (!selectedWorkspaceId || !activeWorkspaceId || resourceIds.length === 0) return

    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!targetWorkspace) return

    setIsSending(true)
    const targetName = targetWorkspace.name
    const { singular, plural } = RESOURCE_TYPE_LABELS[resourceType]
    const count = resourceIds.length
    const label = count === 1 ? singular : plural
    const mode: ResourceImportMode = 'skip'

    const toastId = toast.loading(`Sending ${resourceLabel} to ${targetName}...`)

    try {
      // 1. 从当前工作区导出选中的资源
      const exportOptions: ExportResourcesOptions = {}
      if (resourceType === 'source') exportOptions.sources = resourceIds
      else if (resourceType === 'skill') exportOptions.skills = resourceIds
      else if (resourceType === 'automation') exportOptions.automations = resourceIds

      const { bundle, warnings: exportWarnings } = await window.electronAPI.exportResources(
        activeWorkspaceId,
        exportOptions,
      )

      // 2. 导入到目标工作区
      let importResult
      if (targetWorkspace.remoteServer) {
        // 远程目标：通过 invokeOnServer 在目标服务器执行导入
        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer
        importResult = await window.electronAPI.invokeOnServer(
          url, token,
          'resources:import',
          remoteWorkspaceId, bundle, mode,
        )
      } else {
        // 本地目标：直接 RPC
        importResult = await window.electronAPI.importResources(
          selectedWorkspaceId,
          bundle,
          mode,
        )
      }

      // 3. 根据导入结果显示提示
      const bucket = importResult[`${resourceType}s`] ?? importResult[resourceType + 's']
      const imported = bucket?.imported?.length ?? 0
      const skipped = bucket?.skipped?.length ?? 0

      if (imported > 0 && skipped === 0) {
        toast.success(`Sent ${resourceLabel} to ${targetName}`, { id: toastId })
      } else if (imported > 0 && skipped > 0) {
        toast.success(`Sent ${imported} ${label}, ${skipped} already existed`, { id: toastId })
      } else if (skipped > 0) {
        toast.info(`${resourceLabel} already exists in ${targetName}`, { id: toastId })
      } else {
        toast.warning(`Nothing was sent to ${targetName}`, { id: toastId })
      }

      if (exportWarnings.length > 0) {
        console.warn('[SendResource] Export warnings:', exportWarnings)
      }

      onOpenChange(false)
      setSelectedWorkspaceId(null)
      onTransferComplete?.()
    } catch (error: any) {
      const isUnsupported = error?.code === 'CHANNEL_NOT_FOUND' ||
        (error?.message ?? '').includes('No handler for')
      const message = isUnsupported
        ? `${targetName} is running an older version that doesn't support resource import. Update the remote server and try again.`
        : error instanceof Error ? error.message : 'Unknown error'
      toast.error(`Failed to send ${label}`, { id: toastId, description: message })
    } finally {
      setIsSending(false)
    }
  }, [selectedWorkspaceId, activeWorkspaceId, resourceIds, resourceType, resourceLabel, workspaces, onOpenChange, onTransferComplete])

  const { singular, plural } = RESOURCE_TYPE_LABELS[resourceType]

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isSending) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Send to Workspace
          </DialogTitle>
          <DialogDescription>
            Send {resourceLabel} to another workspace.
          </DialogDescription>
        </DialogHeader>

        {/* 工作区列表 */}
        <div className="flex flex-col gap-1 max-h-64 overflow-y-auto py-1">
          {targetWorkspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground px-2 py-4 text-center">
              No other workspaces available.
            </p>
          ) : (
            targetWorkspaces.map(workspace => {
              const isSelected = selectedWorkspaceId === workspace.id
              const isRemote = !!workspace.remoteServer
              const healthStatus = remoteHealthMap.get(workspace.id)
              const isDisconnected = isRemote && healthStatus === 'error'
              const isChecking = isRemote && healthStatus === 'checking'

              return (
                <button
                  key={workspace.id}
                  type="button"
                  disabled={isSending || isDisconnected}
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
                  {isRemote ? (
                    isDisconnected ? (
                      <CloudOff className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                    ) : (
                      <Cloud className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        isChecking ? 'text-muted-foreground/30 animate-pulse' : 'text-muted-foreground',
                      )} />
                    )
                  ) : (
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  )}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={!selectedWorkspaceId || isSending}
          >
            {isSending ? 'Sending...' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

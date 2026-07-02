/**
 * WorkspacePicker - 当瘦客户端（thin client）未携带工作区 ID 时展示
 *
 * 作用：向远程 Craft Agent Server 拉取工作区列表，让用户选择已有工作区或新建一个。
 * 对应 Electron 架构中的 renderer 进程，通过 window.electronAPI 调用 preload 暴露的接口。
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface WorkspacePickerProps {
  /** 用户选择工作区后触发的回调，参数为工作区 ID */
  onSelectWorkspace: (workspaceId: string) => void
}

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()

  // workspaces：从远程服务器加载的工作区列表
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // creating / newName：底部“新建工作区”输入框的状态
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // 组件挂载时从服务器拉取工作区列表
  useEffect(() => {
    window.electronAPI.getServerWorkspaces()
      .then(ws => {
        setWorkspaces(ws)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load workspaces')
        setLoading(false)
      })
  }, [])

  // 在服务器上新建工作区，成功后通知上层选中该工作区
  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const ws = await window.electronAPI.createServerWorkspace(newName.trim())
      onSelectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }, [newName, onSelectWorkspace])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        <AddWorkspaceStepHeader
          title={t("workspace.selectWorkspace")}
          description={t("workspace.selectWorkspaceDesc")}
        />

        {error && (
          <p className="mt-3 w-full text-center text-sm text-destructive">{error}</p>
        )}

        {/* 工作区列表 */}
        {workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                  {ws.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* 分隔线 */}
        <div className="mt-5 mb-4 w-full border-t" />

        {/* 新建工作区区域 */}
        <div className="w-full space-y-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t("workspace.newWorkspaceName")}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <AddWorkspacePrimaryButton
            onClick={handleCreate}
            disabled={!newName.trim()}
            loading={creating}
            loadingText={t("workspace.creating")}
            className="bg-accent hover:bg-accent/90 text-white"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("workspace.createWorkspace")}
          </AddWorkspacePrimaryButton>
        </div>
      </AddWorkspaceContainer>
    </div>
  )
}

import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, CheckCircle, XCircle, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { slugify } from "@/lib/slugify"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { AddWorkspaceContainer, AddWorkspaceStepHeader, AddWorkspacePrimaryButton, AddWorkspaceSecondaryButton } from "./primitives"

/** 下拉框中表示“新建远程工作区”的特殊值 */
const CREATE_NEW_VALUE = '__create_new__'

interface AddWorkspaceStep_ConnectRemoteProps {
  /** 返回上一步 */
  onBack: () => void
  /** 创建本地工作区并关联远程服务器 */
  onCreate: (folderPath: string, name: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
  /** 是否正在处理中 */
  isCreating: boolean
  /** 重连流程中预填充服务器 URL */
  initialUrl?: string
  /** 重连流程中预填充 token */
  initialToken?: string
  /**
   * 若传入，则进入“重连模式”：
   * 不再创建新工作区，而是更新已有工作区的远程服务器配置。
   */
  reconnectWorkspace?: { id: string; name: string; remoteWorkspaceId: string }
  /** 重连时调用，用于更新已有工作区的远程配置 */
  onUpdate?: (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
}

/**
 * 为远程工作区生成唯一的本地 slug。
 * 尝试顺序：baseName → baseName-remote → baseName-2 → baseName-3 → ...
 * 若超过 20 次仍未找到唯一值，则追加时间戳作为安全兜底。
 */
async function resolveUniqueSlug(baseName: string): Promise<{ slug: string; path: string }> {
  const baseSlug = slugify(baseName)
  if (!baseSlug) return { slug: 'remote', path: '' }

  let slug = baseSlug
  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await window.electronAPI.checkWorkspaceSlug(slug)
    if (!result.exists) {
      return { slug, path: result.path }
    }
    attempt++
    slug = attempt === 1 ? `${baseSlug}-remote` : `${baseSlug}-${attempt}`
    if (attempt > 20) {
      // 安全兜底，实际几乎不会触发
      return { slug: `${baseSlug}-${Date.now()}`, path: result.path.replace(baseSlug, `${baseSlug}-${Date.now()}`) }
    }
  }
}

/**
 * AddWorkspaceStep_ConnectRemote - 连接远程 Craft Agent Server
 *
 * 两种主要路径：
 * 1. 连接已有远程工作区：从下拉框选择，无需输入名称，自动解析本地 slug
 * 2. 新建远程工作区：输入名称，先在远端创建，再关联到本地
 *
 * 另外支持 reconnectWorkspace 重连模式，用于更新已有工作区的远程服务器地址或 token。
 */
export function AddWorkspaceStep_ConnectRemote({
  onBack,
  onCreate,
  isCreating,
  initialUrl,
  initialToken,
  reconnectWorkspace,
  onUpdate,
}: AddWorkspaceStep_ConnectRemoteProps) {
  const { t } = useTranslation()

  const isReconnectMode = !!reconnectWorkspace
  const [serverUrl, setServerUrl] = useState(initialUrl ?? '')
  const [token, setToken] = useState(initialToken ?? '')
  const [homeDir, setHomeDir] = useState('')

  // 连接测试状态：idle / testing / ok / error
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState<string | null>(null)

  // 远程服务器上的工作区列表
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<Array<{ id: string; name: string }>>([])

  // 当前下拉框选中值：工作区 ID 或 CREATE_NEW_VALUE
  const [selectedValue, setSelectedValue] = useState<string | null>(null)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  // 用于 Select 下拉框的 portal 挂载点，确保在 Dialog 内能正常接收鼠标事件
  const selectPortalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.getHomeDir().then(setHomeDir)
  }, [])

  const isCreateNew = selectedValue === CREATE_NEW_VALUE
  const selectedWorkspace = !isCreateNew ? remoteWorkspaces.find(w => w.id === selectedValue) : null

  // 刚连上的服务器没有任何工作区时，直接进入创建模式
  const isFreshServer = testState === 'ok' && remoteWorkspaces.length === 0

  // URL 或 token 变化时重置测试状态，避免旧结果误导用户
  useEffect(() => {
    setTestState('idle')
    setTestError(null)
    setRemoteWorkspaces([])
    setSelectedValue(null)
    setNewWorkspaceName('')
  }, [serverUrl, token])

  // 测试与远程服务器的连接
  const handleTestConnection = useCallback(async () => {
    if (!serverUrl || !token) return
    setTestState('testing')
    setTestError(null)
    try {
      const result = await window.electronAPI.testRemoteConnection(serverUrl, token)
      console.log('[ConnectRemote] testRemoteConnection result:', JSON.stringify(result, null, 2))
      if (result.ok) {
        setTestState('ok')
        setServerVersion(result.serverVersion ?? null)
        if (result.needsWorkspace) {
          // 新服务器没有工作区，直接进入创建模式
          setRemoteWorkspaces([])
          setSelectedValue(null)
        } else {
          const workspaces = result.remoteWorkspaces ?? []
          setRemoteWorkspaces(workspaces)
          if (workspaces.length === 1) {
            setSelectedValue(workspaces[0]!.id)
          }
        }
      } else {
        setTestState('error')
        setTestError(result.error || 'Connection failed')
      }
    } catch (err) {
      setTestState('error')
      setTestError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [serverUrl, token])

  // 连接/创建/重连主逻辑
  const handleConnect = useCallback(async () => {
    if (!serverUrl || !token) return

    // 重连模式：更新现有工作区的远程配置
    if (isReconnectMode && onUpdate) {
      try {
        await onUpdate(reconnectWorkspace!.id, {
          url: serverUrl,
          token,
          remoteWorkspaceId: reconnectWorkspace!.remoteWorkspaceId,
        })
        return
      } catch (err) {
        setTestState('error')
        setTestError(err instanceof Error ? err.message : 'Failed to reconnect workspace')
        return
      }
    }

    if (!homeDir) return
    const defaultBasePath = `${homeDir}/.craft-agent/workspaces`

    if (isCreateNew || isFreshServer) {
      // 通过 RPC 在远端直接创建工作区，再在本地关联
      const name = newWorkspaceName.trim()
      if (!name) return

      try {
        const created = await window.electronAPI.invokeOnServer(
          serverUrl, token, 'server:createWorkspace', name
        ) as { id: string; name: string }

        const { slug, path } = await resolveUniqueSlug(name)
        const finalPath = path || `${defaultBasePath}/${slug}`
        await onCreate(finalPath, name, { url: serverUrl, token, remoteWorkspaceId: created.id })
      } catch (err) {
        setTestState('error')
        setTestError(err instanceof Error ? err.message : 'Failed to create workspace on remote server')
        return
      }
    } else if (selectedWorkspace) {
      // 连接已有远程工作区，自动解析本地唯一 slug
      const { slug, path } = await resolveUniqueSlug(selectedWorkspace.name)
      const finalPath = path || `${defaultBasePath}/${slug}`
      await onCreate(finalPath, selectedWorkspace.name, { url: serverUrl, token, remoteWorkspaceId: selectedWorkspace.id })
    }
  }, [serverUrl, token, homeDir, isCreateNew, isFreshServer, newWorkspaceName, selectedWorkspace, onCreate, isReconnectMode, onUpdate, reconnectWorkspace])

  const canConnect = testState === 'ok' && !isCreating && (
    isReconnectMode ? true :
    (isFreshServer || isCreateNew) ? !!newWorkspaceName.trim() : !!selectedWorkspace
  )

  const showCreateMode = !isReconnectMode && (isCreateNew || isFreshServer)
  const buttonLabel = isReconnectMode ? 'Reconnect' : showCreateMode ? 'Create and Connect' : 'Connect'
  const buttonLoadingLabel = isReconnectMode ? 'Reconnecting...' : showCreateMode ? 'Creating...' : 'Connecting...'

  return (
    <AddWorkspaceContainer>
      {/* 返回按钮 */}
      <button
        onClick={onBack}
        disabled={isCreating}
        className={cn(
          "self-start flex items-center gap-1 text-sm text-muted-foreground",
          "hover:text-foreground transition-colors mb-4",
          isCreating && "opacity-50 cursor-not-allowed"
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <AddWorkspaceStepHeader
        title={isReconnectMode ? t("workspace.reconnect", { name: reconnectWorkspace!.name }) : "Connect to remote server"}
        description={isReconnectMode
          ? "Update the server URL or token to restore the connection."
          : "Connect to a remote Craft Agent Server for this workspace."}
      />

      <div className="mt-6 w-full space-y-5">
        {/* 服务器 URL */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Server URL
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://192.168.1.100:9100"
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent shadow-none font-mono text-sm"
            />
          </div>
        </div>

        {/* Token */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Token
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("workspace.serverAuthToken")}
              disabled={isCreating}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        {/* 测试连接 */}
        <div className="flex items-center gap-3">
          <AddWorkspaceSecondaryButton
            onClick={handleTestConnection}
            disabled={!serverUrl || !token || testState === 'testing' || isCreating}
          >
            {testState === 'testing' ? 'Testing...' : 'Test Connection'}
          </AddWorkspaceSecondaryButton>
          {testState === 'ok' && !isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''}
            </span>
          )}
          {testState === 'ok' && isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''} — no workspaces yet
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {testError || 'Failed'}
            </span>
          )}
        </div>

        {/* 旧服务器警告 */}
        {testState === 'ok' && !serverVersion && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-700 dark:text-yellow-400">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{t("workspace.olderServerWarning")}</span>
          </div>
        )}

        {/* Select 下拉框的 portal 挂载点，必须位于 Dialog 内才能接收指针事件 */}
        <div ref={selectPortalRef} />

        {/* 工作区选择器：选择已有或新建（重连模式下隐藏） */}
        {!isReconnectMode && testState === 'ok' && remoteWorkspaces.length > 0 && !isCreateNew && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Select
                value={selectedValue ?? ''}
                onValueChange={setSelectedValue}
                disabled={isCreating}
              >
                <SelectTrigger className="border-0 bg-transparent shadow-none">
                  <SelectValue placeholder={t("workspace.selectWorkspacePlaceholder")} />
                </SelectTrigger>
                <SelectContent container={selectPortalRef.current}>
                  {remoteWorkspaces.map(ws => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              onClick={() => setSelectedValue(CREATE_NEW_VALUE)}
              disabled={isCreating}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              Create new workspace on server
            </button>
          </div>
        )}

        {/* 新建工作区名称输入：适用于全新服务器或选择“新建”时（重连模式下隐藏） */}
        {!isReconnectMode && testState === 'ok' && showCreateMode && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace name
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Input
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder={t("workspace.myRemoteWorkspace")}
                disabled={isCreating}
                className="border-0 bg-transparent shadow-none"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A workspace will be created on the remote server with this name.
            </p>
            {isCreateNew && remoteWorkspaces.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedValue(remoteWorkspaces.length === 1 ? remoteWorkspaces[0]!.id : null)
                  setNewWorkspaceName('')
                }}
                disabled={isCreating}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                Use existing workspace
              </button>
            )}
          </div>
        )}

        {/* 连接 / 创建并连接 */}
        <AddWorkspacePrimaryButton
          onClick={handleConnect}
          disabled={!canConnect}
          loading={isCreating}
          loadingText={buttonLoadingLabel}
        >
          {buttonLabel}
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}

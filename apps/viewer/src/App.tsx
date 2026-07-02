/**
 * Craft Agent Session Viewer
 *
 * 一个用于查看 Craft Agent 会话记录的轻量 Web 应用。
 * 用户可以上传本地会话 JSON 文件，或者通过 /s/{id} 链接查看共享会话。
 *
 * 路由：
 * - / - 上传界面
 * - /s/{id} - 查看共享会话
 *
 * 这里的“会话（Session）”可以理解为 Agent 一次完整运行所产生的消息链，
 * 类似一次聊天/任务执行的完整上下文。
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import type { StoredSession } from '@craft-agent/core'
import {
  SessionViewer,
  GenericOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  TooltipProvider,
  extractOverlayData,
  detectLanguage,
  openExternalUrl,
  type PlatformActions,
  type ActivityItem,
  type OverlayData,
  type FileChange,
} from '@craft-agent/ui'
import { SessionUpload } from './components/SessionUpload'
import { Header } from './components/Header'

/** 开发环境默认使用的共享会话 ID，方便本地直接预览 */
const DEV_SESSION_ID = 'tz5-13I84pwK_he'

/**
 * 从当前 URL 路径中提取会话 ID。
 *
 * 匹配规则：/s/{id}，其中 id 只能包含字母、数字、下划线和连字符。
 * 开发环境下访问根路径 / 会自动重定向到默认会话，方便调试。
 */
function getSessionIdFromUrl(): string | null {
  const path = window.location.pathname
  const match = path.match(/^\/s\/([a-zA-Z0-9_-]+)$/)
  if (match) return match[1]

  // 开发模式下把根路径替换为默认会话链接
  if (import.meta.env.DEV && path === '/') {
    window.history.replaceState({}, '', `/s/${DEV_SESSION_ID}`)
    return DEV_SESSION_ID
  }

  return null
}

export function App() {
  const { t } = useTranslation()

  // 当前已加载的会话数据
  const [session, setSession] = useState<StoredSession | null>(null)
  // 是否正在从服务端拉取共享会话
  const [isLoading, setIsLoading] = useState(false)
  // 加载或解析过程中的错误信息
  const [error, setError] = useState<string | null>(null)
  // 当前 URL 对应的会话 ID，初始值从 URL 解析得到
  const [sessionId, setSessionId] = useState<string | null>(() => getSessionIdFromUrl())
  // 深色模式开关：首次加载时跟随系统偏好
  const [isDark, setIsDark] = useState(() => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  /**
   * 当存在 sessionId 时，从后端 API 拉取共享会话数据。
   *
   * useEffect 会在依赖项变化时执行，这里依赖 sessionId，
   * 类似在组件生命周期中监听某个状态变化后触发副作用。
   */
  useEffect(() => {
    if (!sessionId) return

    const fetchSession = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const response = await fetch(`/s/api/${sessionId}`)
        if (!response.ok) {
          if (response.status === 404) {
            setError(t('errors.sessionNotFound'))
          } else {
            setError(t('errors.failedToLoadSession'))
          }
          return
        }

        const data = await response.json()
        setSession(data)
      } catch (err) {
        console.error('Failed to fetch session:', err)
        setError(t('errors.failedToLoadSession'))
      } finally {
        setIsLoading(false)
      }
    }

    fetchSession()
  }, [sessionId])

  /**
   * 监听浏览器前进/后退事件。
   *
   * 当用户点击浏览器返回或前进按钮导致 URL 变化时，
   * 重新解析 sessionId 并清空旧会话状态。
   */
  useEffect(() => {
    const handlePopState = () => {
      const newId = getSessionIdFromUrl()
      setSessionId(newId)
      if (!newId) {
        setSession(null)
        setError(null)
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // 根据当前主题状态给 <html> 元素添加或移除 dark 类
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  /**
   * 监听系统主题变化。
   *
   * 当用户切换系统深色/浅色模式时自动同步，
   * 组件卸载时移除监听器，避免内存泄漏。
   */
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  // 本地上传成功后加载会话
  const handleSessionLoad = useCallback((loadedSession: StoredSession) => {
    setSession(loadedSession)
  }, [])

  // 清除当前会话并回到上传界面
  const handleClear = useCallback(() => {
    setSession(null)
    setSessionId(null)
    setError(null)
    // 把浏览器 URL 推回到根路径
    window.history.pushState({}, '', '/')
  }, [])

  // 切换深色/浅色主题
  const toggleTheme = useCallback(() => {
    setIsDark(prev => !prev)
  }, [])

  // 当前需要展示在浮层中的 Activity（非 Edit/Write 工具）
  const [overlayActivity, setOverlayActivity] = useState<ActivityItem | null>(null)
  // Edit/Write 工具对应的文件变更数据，用于多文件 diff 浮层
  const [multiDiffState, setMultiDiffState] = useState<{ changes: FileChange[] } | null>(null)

  /**
   * 处理用户点击某条 Activity（工具调用记录）。
   *
   * - Edit/Write 工具：提取文件路径、修改前/后内容，打开多文件 diff 浮层。
   *   这里同时兼容 Claude 风格字段（file_path / old_string / new_string / content）
   *   和 PI 风格字段（path / oldText / newText），优先使用 Claude 字段。
   * - 其他工具：把 Activity 交给 extractOverlayData 解析，打开对应类型的浮层。
   */
  const handleActivityClick = useCallback((activity: ActivityItem) => {
    if (activity.toolName === 'Edit' || activity.toolName === 'Write') {
      const input = activity.toolInput as Record<string, unknown> | undefined
      // Claude 字段优先；PI 字段作为兜底回退
      const filePath = (input?.file_path as string) || (input?.path as string) || 'unknown'
      const change: FileChange = {
        id: activity.id,
        filePath,
        toolType: activity.toolName,
        original: activity.toolName === 'Edit'
          ? ((input?.old_string as string) || (input?.oldText as string) || '')
          : '',
        modified: activity.toolName === 'Edit'
          ? ((input?.new_string as string) || (input?.newText as string) || '')
          : ((input?.content as string) || ''),
        error: activity.error || undefined,
      }
      setMultiDiffState({ changes: [change] })
    } else {
      setOverlayActivity(activity)
    }
  }, [])

  // 关闭所有浮层
  const handleCloseOverlay = useCallback(() => {
    setOverlayActivity(null)
    setMultiDiffState(null)
  }, [])

  /**
   * 用共享解析器把 Activity 转成浮层需要的数据。
   *
   * useMemo 会在 overlayActivity 变化时重新计算，避免每次渲染都重复解析。
   */
  const overlayData: OverlayData | null = useMemo(() => {
    if (!overlayActivity) return null
    return extractOverlayData(overlayActivity)
  }, [overlayActivity])

  /**
   * 提供给 SessionViewer 的平台能力对象。
   *
   * 在 Viewer 中只实现了打开 URL 和复制到剪贴板的最小能力集，
   * 类似 Go 接口的实现，只暴露 Viewer 能支持的方法。
   */
  const platformActions: PlatformActions = {
    onOpenUrl: (url) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        const detail = result.reason === 'dangerous' ? result.detail : result.reason
        console.warn('[viewer:onOpenUrl] blocked URL:', detail, url)
      }
    },
    onCopyToClipboard: async (text) => {
      await navigator.clipboard.writeText(text)
    },
  }

  const theme = isDark ? 'dark' : 'light'

  return (
    <TooltipProvider>
    <div className="h-full flex flex-col bg-foreground-2 text-foreground">
      <Header
        hasSession={!!session}
        sessionTitle={session?.name}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onClear={handleClear}
      />

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center text-muted-foreground">
            <div className="animate-pulse">Loading session...</div>
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="text-destructive mb-4">{error}</div>
            <button
              onClick={handleClear}
              className="px-4 py-2 rounded-md bg-background text-foreground shadow-sm border border-border hover:bg-foreground/5 transition-colors"
            >
              Go back
            </button>
          </div>
        </div>
      ) : session ? (
        <SessionViewer
          session={session}
          mode="readonly"
          platformActions={platformActions}
          defaultExpanded={false}
          className="flex-1 min-h-0"
          onActivityClick={handleActivityClick}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center p-8">
          <SessionUpload onSessionLoad={handleSessionLoad} />
        </div>
      )}

      {/* 代码预览浮层：Read/Write 等返回代码内容的工具 */}
      {overlayData?.type === 'code' && (
        <CodePreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          content={overlayData.content}
          filePath={overlayData.filePath}
          mode={overlayData.mode}
          startLine={overlayData.startLine}
          totalLines={overlayData.totalLines}
          numLines={overlayData.numLines}
          theme={theme}
          error={overlayData.error}
          command={overlayData.command}
        />
      )}

      {/* 多文件 diff 浮层：Edit/Write 工具的变更对比 */}
      {multiDiffState && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={multiDiffState.changes}
          consolidated={false}
          theme={theme}
        />
      )}

      {/* 终端输出浮层：Bash/Grep/Glob 等命令行类工具 */}
      {overlayData?.type === 'terminal' && (
        <TerminalPreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          command={overlayData.command}
          output={overlayData.output}
          exitCode={overlayData.exitCode}
          toolType={overlayData.toolType}
          description={overlayData.description}
          theme={theme}
        />
      )}

      {/* JSON 预览浮层：返回结构化 JSON 数据的工具 */}
      {overlayData?.type === 'json' && (
        <JSONPreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          data={overlayData.data}
          title={overlayData.title}
          theme={theme}
          error={overlayData.error}
        />
      )}

      {/* 文档浮层：格式化 Markdown 内容（如 Write .md/.txt、WebSearch 结果） */}
      {overlayData?.type === 'document' && (
        <DocumentFormattedMarkdownOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          content={overlayData.content}
          filePath={overlayData.filePath}
          typeBadge={{ icon: FileText, label: overlayData.toolName, variant: 'default' }}
          onOpenUrl={platformActions.onOpenUrl}
          error={overlayData.error}
        />
      )}

      {/* 通用浮层：未知类型工具，若内容是 Markdown 则走文档视图，否则走通用视图 */}
      {overlayData?.type === 'generic' && (
        detectLanguage(overlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            onOpenUrl={platformActions.onOpenUrl}
            error={overlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            title={overlayData.title}
            theme={theme}
          />
        )
      )}
    </div>
    </TooltipProvider>
  )
}

/**
 * SessionFilesSection - 以树形结构展示当前 session 工作目录中的文件
 *
 * 主要功能：
 * - 递归树形视图，文件夹可展开/收起（样式与左侧边栏保持一致）
 * - 文件变化时通过文件监听器自动刷新
 * - 单击在应用内预览，双击打开
 * - 右键上下文菜单，支持“打开”/“在文件管理器中显示”
 * - 每个 session 的展开状态会持久化到本地存储
 *
 * 样式与 LeftSidebar 对齐：
 * - Chevron 默认隐藏，悬停时显示
 * - 嵌套项使用竖向连接线
 * - 图标 14x14px，间距 8px，圆角 6px
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import { File, Folder, FolderOpen, FileText, Image, FileCode, ChevronRight, ExternalLink } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import type { SessionFile } from '../../../shared/types'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { useAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { restoreSessionFileWatch } from './session-files-watch'

/**
 * 子项的交错动画变体（variants），与 LeftSidebar 保持一致
 * 展开文件夹时产生“级联”出现的效果
 */
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.01,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
}

export interface SessionFilesSectionProps {
  sessionId?: string
  className?: string
  /** session 文件夹的绝对路径，用于顶部“在文件管理器中查看”等操作 */
  sessionFolderPath?: string
  /** 在紧凑容器（例如 popover）中嵌入时，隐藏区块标题 */
  hideHeader?: boolean
}

/**
 * 将字节数格式化为人类可读的大小
 */
function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 递归收集所有目录路径，用于默认“全部展开”的树形状态。 */
function collectDirectoryPaths(entries: SessionFile[]): string[] {
  const directories: string[] = []
  const visit = (items: SessionFile[]) => {
    for (const item of items) {
      if (item.type === 'directory') {
        directories.push(item.path)
        if (item.children && item.children.length > 0) {
          visit(item.children)
        }
      }
    }
  }
  visit(entries)
  return directories
}

/**
 * 根据文件名/类型返回对应的图标（14x14px，与左侧边栏保持一致）
 */
function getFileIcon(file: SessionFile, isExpanded?: boolean) {
  const iconClass = "h-3.5 w-3.5 text-muted-foreground"

  if (file.type === 'directory') {
    return isExpanded
      ? <FolderOpen className={iconClass} />
      : <Folder className={iconClass} />
  }

  const ext = file.name.split('.').pop()?.toLowerCase()

  if (ext === 'md' || ext === 'markdown') {
    return <FileText className={iconClass} />
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext || '')) {
    return <Image className={iconClass} />
  }

  if (['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'py', 'rb', 'go', 'rs'].includes(ext || '')) {
    return <FileCode className={iconClass} />
  }

  return <File className={iconClass} />
}

/**
 * 可通过自定义 thumbnail:// 协议生成缩略图预览的文件扩展名集合。
 * 与 thumbnail-protocol.ts 中的 ALL_PREVIEWABLE 保持一致。
 */
const PREVIEWABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif',
  'pdf', 'svg', 'psd', 'ai',
])

/**
 * 在 Web 模式下以 <img> 形式轻量预览的图片扩展名集合。
 * 不包含 pdf/psd/ai/svg，这些文件不会在此渲染为 img 缩略图。
 */
const WEB_PREVIEWABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
])

/** 当前是否运行在 Web UI（浏览器）而非 Electron 环境。 */
const isWebMode = window.electronAPI.getRuntimeEnvironment() === 'web'

/**
 * 为指定文件路径构建 thumbnail:// 协议 URL。
 * 路径会经过 URI 编码，确保安全嵌入 URL；跨平台兼容（macOS 以 / 开头，Windows 以 C:\ 开头）。
 */
function getThumbnailUrl(filePath: string): string {
  return `thumbnail://thumb/${encodeURIComponent(filePath)}`
}

/**
 * FileThumbnail - 渲染文件缩略图，并从默认图标交叉淡入。
 *
 * 在 Electron 中：通过自定义 thumbnail:// 协议加载（主进程会缩放为 64x64）。
 * 在 Web 模式下：通过 readFilePreviewDataUrl RPC 获取服务端缩放后的 base64 预览图。
 *
 * 先显示 Lucide 图标，缩略图加载成功后交叉淡入；加载失败则保持图标可见，避免布局跳动。
 */
const FileThumbnail = memo(function FileThumbnail({ file }: { file: SessionFile }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  // 当文件变化时（例如文件监听器触发重新渲染）重置缩略图状态
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
    setDataUrl(null)
  }, [file.path])

  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const previewableSet = isWebMode ? WEB_PREVIEWABLE_EXTENSIONS : PREVIEWABLE_EXTENSIONS
  const canPreview = previewableSet.has(ext)

  // Web 模式：通过 RPC 加载一个小尺寸的 base64 预览图
  useEffect(() => {
    if (!isWebMode || !canPreview || failed) return
    let cancelled = false
    window.electronAPI.readFilePreviewDataUrl(file.path, 64).then((url) => {
      if (!cancelled) setDataUrl(url)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [file.path, canPreview, failed])

  // 如果文件不可预览或缩略图加载失败，就回到普通图标
  if (!canPreview || failed) {
    return getFileIcon(file)
  }

  const imgSrc = isWebMode ? dataUrl : getThumbnailUrl(file.path)

  return (
    <>
      {/* 兜底图标：初始可见，缩略图加载完成后淡出 */}
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center transition-opacity duration-200',
          loaded ? 'opacity-0' : 'opacity-100'
        )}
      >
        {getFileIcon(file)}
      </span>
      {/* 缩略图：加载成功后淡入 */}
      {imgSrc && (
        <img
          src={imgSrc}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'absolute inset-0 h-full w-full rounded-[2px] object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}
    </>
  )
})

interface FileTreeItemProps {
  file: SessionFile
  depth: number
  expandedPaths: Set<string>
  onToggleExpand: (path: string) => void
  onFileClick: (file: SessionFile) => void
  onFileDoubleClick: (file: SessionFile) => void
  onRevealInFileManager: (path: string) => void
  /** 当前项是否位于已展开文件夹内部（用于交错动画） */
  isNested?: boolean
}

/**
 * 递归文件树项组件
 * 样式与 LeftSidebar 严格保持一致：
 * - 容器级竖向连接线（非每项一条）
 * - 使用 framer-motion 实现展开/收起的交错动画
 * - Chevron 悬停显示，默认图标隐藏
 */
function FileTreeItem({
  file,
  depth,
  expandedPaths,
  onToggleExpand,
  onFileClick,
  onFileDoubleClick,
  onRevealInFileManager,
  isNested,
}: FileTreeItemProps) {
  const { t } = useTranslation()
  const isDirectory = file.type === 'directory'
  const isExpanded = expandedPaths.has(file.path)
  const hasChildren = isDirectory && file.children && file.children.length > 0

  const handleClick = () => {
    if (isDirectory && hasChildren) {
      onToggleExpand(file.path)
    } else {
      onFileClick(file)
    }
  }

  const handleDoubleClick = () => {
    onFileDoubleClick(file)
  }

  // 单独处理 Chevron 点击，避免触发整个项的单击/双击
  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (hasChildren) {
      onToggleExpand(file.path)
    }
  }

  // 单个文件/文件夹的按钮元素
  const buttonElement = (
    <button
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      className={cn(
        // 基础样式，与 LeftSidebar 完全一致
        // min-w-0 和 overflow-hidden 是在 grid 布局中实现文本截断所必需的
        "group flex w-full min-w-0 overflow-hidden items-center gap-2 rounded-[6px] py-[5px] text-[13px] select-none outline-none text-left",
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        "hover:bg-sidebar-hover transition-colors",
        // 所有项使用相同内边距，嵌套缩进由外层容器处理
        "px-2"
      )}
      title={`${file.path}\n${file.type === 'file' ? formatFileSize(file.size) : 'Directory'}\n\nClick to ${hasChildren ? 'expand' : 'reveal'}, double-click to open`}
    >
      {/* 图标容器：可展开项在悬停时显示 Chevron */}
      <span className="relative h-3.5 w-3.5 shrink-0 flex items-center justify-center">
        {hasChildren ? (
          <>
            {/* 主图标：悬停时隐藏 */}
            <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity duration-150">
              {getFileIcon(file, isExpanded)}
            </span>
            {/* 切换 Chevron：悬停时显示 */}
            <span
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer"
              onClick={handleChevronClick}
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                  isExpanded && "rotate-90"
                )}
              />
            </span>
          </>
        ) : (
          /* 非目录文件：对可预览类型显示缩略图，并从图标交叉淡入；不支持预览的类型回退到图标。 */
          <FileThumbnail file={file} />
        )}
      </span>

      {/* 文件/文件夹名称：min-w-0 是在 flex 容器中实现 truncate 的关键 */}
      <span className="flex-1 min-w-0 truncate">{file.name}</span>
    </button>
  )

  const fileManagerName = getFileManagerName()

  // 内部内容：按钮 + 可展开的子项（外层结构与 LeftSidebar 的 group/section 类似）
  const innerContent = (
    <div className="group/section min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {buttonElement}
        </ContextMenuTrigger>
        <StyledContextMenuContent>
          {/* 打开：仅对文件显示（文件夹只显示“在文件管理器中显示”） */}
          {file.type !== 'directory' && (
            <StyledContextMenuItem onSelect={() => onFileClick(file)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t("chat.openFile")}
            </StyledContextMenuItem>
          )}
          {/* 在文件管理器中显示 */}
          <StyledContextMenuItem
            onSelect={() => onRevealInFileManager(file.path)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("chat.showInFileManager", { fileManager: fileManagerName })}
          </StyledContextMenuItem>
        </StyledContextMenuContent>
      </ContextMenu>
      {/* 可展开子项：使用 framer-motion 动画，与 LeftSidebar 完全一致 */}
      {hasChildren && (
        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              animate={{ height: 'auto', opacity: 1, marginTop: 2, marginBottom: 8 }}
              exit={{ height: 0, opacity: 0, marginTop: 0, marginBottom: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              {/* 包装 div 与 LeftSidebar 的递归结构一致；min-w-0 允许子树在窄空间中收缩 */}
              <div className="flex flex-col select-none min-w-0">
                <motion.nav
                  className="grid gap-0.5 pl-5 pr-0 relative"
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {/* 容器级竖向连接线，与 LeftSidebar 样式一致 */}
                  <div
                    className="absolute left-[13px] top-1 bottom-1 w-px bg-foreground/10"
                    aria-hidden="true"
                  />
                  {file.children!.map((child) => (
                    <motion.div key={child.path} variants={itemVariants} className="min-w-0">
                      <FileTreeItem
                        file={child}
                        depth={depth + 1}
                        expandedPaths={expandedPaths}
                        onToggleExpand={onToggleExpand}
                        onFileClick={onFileClick}
                        onFileDoubleClick={onFileDoubleClick}
                        onRevealInFileManager={onRevealInFileManager}
                        isNested={true}
                      />
                    </motion.div>
                  ))}
                </motion.nav>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )

  // 嵌套项已由父级的 motion.div 包裹以参与交错动画；
  // 根级项使用 Fragment，避免额外包装层（与 LeftSidebar 完全一致）。
  return <>{innerContent}</>
}

/**
 * 以树形结构展示 session 文件的区块组件
 */
export function SessionFilesSection({ sessionId, className, sessionFolderPath, hideHeader = false }: SessionFilesSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<SessionFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [hasSavedExpandedState, setHasSavedExpandedState] = useState(false)
  const mountedRef = useRef(true)

  // session 切换时从本地存储读取已保存的展开路径。
  // 如果没有保存过，则默认在文件加载后“全部展开”。
  useEffect(() => {
    if (sessionId) {
      const raw = storage.getRaw(storage.KEYS.sessionFilesExpandedFolders, sessionId)
      if (raw !== null) {
        const saved = storage.get<string[]>(storage.KEYS.sessionFilesExpandedFolders, [], sessionId)
        setExpandedPaths(new Set(saved))
        setHasSavedExpandedState(true)
      } else {
        setExpandedPaths(new Set())
        setHasSavedExpandedState(false)
      }
    } else {
      setExpandedPaths(new Set())
      setHasSavedExpandedState(false)
    }
  }, [sessionId])

  // 展开路径变化时持久化到本地存储
  const saveExpandedPaths = useCallback((paths: Set<string>) => {
    if (sessionId) {
      storage.set(storage.KEYS.sessionFilesExpandedFolders, Array.from(paths), sessionId)
    }
  }, [sessionId])

  // 加载文件列表
  const loadFiles = useCallback(async () => {
    if (!sessionId) {
      setFiles([])
      return
    }

    setIsLoading(true)
    try {
      const sessionFiles = await window.electronAPI.getSessionFiles(sessionId)
      if (mountedRef.current) {
        setFiles(sessionFiles)

        // 默认行为：当没有已保存状态时，自动展开整个文件夹树。
        if (!hasSavedExpandedState) {
          const allDirectoryPaths = new Set(collectDirectoryPaths(sessionFiles))
          if (allDirectoryPaths.size > 0) {
            setExpandedPaths(allDirectoryPaths)
            saveExpandedPaths(allDirectoryPaths)
            setHasSavedExpandedState(true)
          }
        }
      }
    } catch (error) {
      console.error('Failed to load session files:', error)
      if (mountedRef.current) {
        setFiles([])
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [sessionId, hasSavedExpandedState, saveExpandedPaths])

  // 初始加载并设置文件监听器
  useEffect(() => {
    mountedRef.current = true
    loadFiles()

    if (sessionId) {
      // 开始监听该 session 目录的文件变化
      void window.electronAPI.watchSessionFiles(sessionId)

      // 监听文件变化事件
      const unsubscribe = window.electronAPI.onSessionFilesChanged((changedSessionId) => {
        if (changedSessionId === sessionId && mountedRef.current) {
          void loadFiles()
        }
      })

      const unsubscribeReconnect = window.electronAPI.onReconnected(() => {
        if (!mountedRef.current) return
        void restoreSessionFileWatch(sessionId, loadFiles)
      })

      return () => {
        mountedRef.current = false
        unsubscribe()
        unsubscribeReconnect()
        void window.electronAPI.unwatchSessionFiles()
      }
    }

    return () => {
      mountedRef.current = false
    }
  }, [sessionId, loadFiles])

  // 通过 AppShellContext 提供的链接拦截器，让文件单击优先在应用内预览，
  // 而不是直接打开系统文件管理器/默认应用。
  const { onOpenFile } = useAppShellContext()
  const fileManagerName = getFileManagerName()

  // 在系统文件管理器中定位文件/文件夹
  const handleRevealInFileManager = useCallback((path: string) => {
    window.electronAPI.showInFolder(path)
  }, [])

  // 处理文件单击：优先在应用内预览；目录则直接打开
  const handleFileClick = useCallback((file: SessionFile) => {
    if (file.type === 'directory') {
      // eslint-disable-next-line craft-links/no-direct-file-open -- 目录无法在应用内预览，只能直接打开
      window.electronAPI.openFile(file.path)
    } else {
      onOpenFile(file.path)
    }
  }, [onOpenFile])

  // 处理文件双击：行为与单击一致（由拦截器决定是预览还是外部打开）
  const handleFileDoubleClick = useCallback((file: SessionFile) => {
    if (file.type === 'directory') {
      // eslint-disable-next-line craft-links/no-direct-file-open -- 目录无法在应用内预览，只能直接打开
      window.electronAPI.openFile(file.path)
    } else {
      onOpenFile(file.path)
    }
  }, [onOpenFile])

  // 切换文件夹展开状态
  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      saveExpandedPaths(next)
      return next
    })
  }, [saveExpandedPaths])

  if (!sessionId) {
    return null
  }

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* 标题栏：与侧边栏样式一致，顶部额外内边距用于视觉平衡 */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0 select-none">
          <span className="text-xs font-medium text-muted-foreground">{t("chat.sessionFiles")}</span>
          {sessionFolderPath && (
            <button
              type="button"
              onClick={() => window.electronAPI.showInFolder(sessionFolderPath)}
              className="text-xs text-foreground/50 hover:text-foreground/80 hover:underline underline-offset-2 transition-colors"
            >
              {t("chat.viewInFileManager", { fileManager: fileManagerName })}
            </button>
          )}
        </div>
      )}

      {/* 文件树：nav 使用 px-2 与 LeftSidebar 一致（限制 grid 宽度）；overflow-x-hidden 防止横向滚动，强制文本截断 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden pb-2 min-h-0">
        {files.length === 0 ? (
          <div className="px-4 text-muted-foreground select-none">
            <p className="text-xs">
              {isLoading ? t('chat.sessionFilesLoading') : t('chat.sessionFilesEmpty')}
            </p>
          </div>
        ) : (
          /* 根级 nav 使用 px-2 与 LeftSidebar 一致——这会限制 grid 宽度 */
          <nav className="grid gap-0.5 px-2">
            {files.map((file) => (
              <FileTreeItem
                key={file.path}
                file={file}
                depth={0}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onFileClick={handleFileClick}
                onFileDoubleClick={handleFileDoubleClick}
                onRevealInFileManager={handleRevealInFileManager}
              />
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}

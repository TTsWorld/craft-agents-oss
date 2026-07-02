import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { motion } from "motion/react"
import { Dithering } from "@paper-design/shaders-react"
import { FullscreenOverlayBase } from "@craft-agent/ui"
import { cn } from "@/lib/utils"
import { overlayTransitionIn } from "@/lib/animations"
import { AddWorkspaceStep_Choice } from "./AddWorkspaceStep_Choice"
import { AddWorkspaceStep_CreateNew } from "./AddWorkspaceStep_CreateNew"
import { AddWorkspaceStep_OpenFolder } from "./AddWorkspaceStep_OpenFolder"
import { AddWorkspaceStep_ConnectRemote } from "./AddWorkspaceStep_ConnectRemote"
import type { Workspace } from "../../../shared/types"
import { toast } from "sonner"

/** 创建流程中的当前步骤 */
type CreationStep = 'choice' | 'create' | 'open' | 'remote'

interface WorkspaceCreationScreenProps {
  /** 工作区创建成功后回调，参数为刚创建的 Workspace 对象 */
  onWorkspaceCreated: (workspace: Workspace) => void
  /** 关闭当前全屏覆盖层时回调 */
  onClose: () => void
  className?: string
  /**
   * 若传入该字段，则跳过选择步骤，直接进入“连接远程”重连模式。
   * 用于已存在工作区但远程服务器配置需要重新连接的场景。
   */
  reconnectWorkspace?: Workspace
  /**
   * 重连已有远程工作区，只有真正成功时才 resolve。
   * 这里用 Promise<void> 让调用方可以等待并捕获异常。
   */
  onReconnectWorkspace?: (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
}

/**
 * WorkspaceCreationScreen - 创建工作区的全屏覆盖层
 *
 * 流程类似 Obsidian：
 * 1. choice：选择“新建工作区”或“打开已有文件夹”或“连接远程服务器”
 * 2. create：输入名称 + 选择本地位置
 * 3. open：浏览本地文件夹
 * 4. remote：连接远程服务器并选择/创建工作区
 */
export function WorkspaceCreationScreen({
  onWorkspaceCreated,
  onClose,
  className,
  reconnectWorkspace,
  onReconnectWorkspace,
}: WorkspaceCreationScreenProps) {
  const { t } = useTranslation()

  // 如果是重连，则直接进入 remote 步骤
  const [step, setStep] = useState<CreationStep>(reconnectWorkspace ? 'remote' : 'choice')
  const [isCreating, setIsCreating] = useState(false)

  // 窗口尺寸，用于下方 Dithering shader 背景
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 })

  // 监听窗口大小变化，为 shader 提供实时宽高
  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight })
    }
    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // 包装 onClose：创建过程中禁止关闭
  // FullscreenOverlayBase 已经处理 ESC 键，这里再包一层用于屏蔽忙时关闭
  const handleClose = useCallback(() => {
    if (!isCreating) {
      onClose()
    }
  }, [isCreating, onClose])

  // 创建本地或远程工作区
  const handleCreateWorkspace = useCallback(async (folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }) => {
    setIsCreating(true)
    try {
      const workspace = await window.electronAPI.createWorkspace(folderPath, name, remoteServer)
      onWorkspaceCreated(workspace)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToCreateWorkspace'), {
        description: message,
      })
    } finally {
      setIsCreating(false)
    }
  }, [onWorkspaceCreated])

  // 重连已有远程工作区
  const handleReconnectWorkspace = useCallback(async (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => {
    if (!onReconnectWorkspace) {
      throw new Error('Reconnect handler not configured')
    }

    setIsCreating(true)
    try {
      await onReconnectWorkspace(workspaceId, remoteServer)
    } finally {
      setIsCreating(false)
    }
  }, [onReconnectWorkspace])

  // 根据当前步骤渲染对应的子组件
  const renderStep = () => {
    switch (step) {
      case 'choice':
        return (
          <AddWorkspaceStep_Choice
            onCreateNew={() => setStep('create')}
            onOpenFolder={() => setStep('open')}
            onConnectRemote={() => setStep('remote')}
          />
        )

      case 'create':
        return (
          <AddWorkspaceStep_CreateNew
            onBack={() => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
          />
        )

      case 'open':
        return (
          <AddWorkspaceStep_OpenFolder
            onBack={() => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
          />
        )

      case 'remote':
        return (
          <AddWorkspaceStep_ConnectRemote
            onBack={reconnectWorkspace ? onClose : () => setStep('choice')}
            onCreate={handleCreateWorkspace}
            isCreating={isCreating}
            initialUrl={reconnectWorkspace?.remoteServer?.url}
            initialToken={reconnectWorkspace?.remoteServer?.token}
            reconnectWorkspace={reconnectWorkspace?.remoteServer ? {
              id: reconnectWorkspace.id,
              name: reconnectWorkspace.name,
              remoteWorkspaceId: reconnectWorkspace.remoteServer.remoteWorkspaceId,
            } : undefined}
            onUpdate={handleReconnectWorkspace}
          />
        )

      default:
        return null
    }
  }

  // 从 CSS 变量读取主题色，用于 Dithering shader
  const shaderColors = useMemo(() => {
    if (typeof window === 'undefined') return { back: '#00000000', front: '#684e85' }
    const root = document.documentElement
    const isDark = root.classList.contains('dark')
    // 背景透明，前景使用主题 accent 色
    return isDark
      ? { back: '#00000000', front: '#9b7bb8' }  // 深色模式使用更亮的 accent
      : { back: '#00000000', front: '#684e85' }  // 浅色模式使用 accent 色
  }, [])

  // FullscreenOverlayBase 负责 portal、traffic lights 和 ESC 键处理
  return (
    <FullscreenOverlayBase
      isOpen={true}
      onClose={handleClose}
      className={cn("z-splash flex flex-col bg-background", className)}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={overlayTransitionIn}
        className="flex flex-col flex-1"
      >
        {/* Dithering shader 背景 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={overlayTransitionIn}
          className="absolute inset-0 pointer-events-none"
        >
          <Dithering
            colorBack={shaderColors.back}
            colorFront={shaderColors.front}
            shape="swirl"
            type="8x8"
            size={2}
            speed={1}
            scale={1}
            width={dimensions.width}
            height={dimensions.height}
          />
        </motion.div>

        {/* 顶部标题栏拖拽区域与关闭按钮 */}
        <header className="titlebar-drag-region relative h-[50px] shrink-0 flex items-center justify-end px-6">
          {/* 关闭按钮显式声明不可拖拽 */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={overlayTransitionIn}
            onClick={(e) => {
              e.stopPropagation()
              handleClose()
            }}
            disabled={isCreating}
            className={cn(
              "titlebar-no-drag flex items-center justify-center p-2 rounded-[6px]",
              "bg-background shadow-minimal hover:bg-foreground-5",
              "text-muted-foreground hover:text-foreground",
              "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "mr-[-8px] mt-2",
              isCreating && "opacity-50 cursor-not-allowed"
            )}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </motion.button>
        </header>

        {/* 主内容区 */}
        <motion.main
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={overlayTransitionIn}
          className="relative flex flex-1 items-center justify-center p-8"
        >
          {renderStep()}
        </motion.main>
      </motion.div>
    </FullscreenOverlayBase>
  )
}

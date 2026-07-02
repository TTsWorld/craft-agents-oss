/**
 * PlaygroundAppShellProvider
 *
 * 真实 AppShellProvider 的最小替代品，让依赖 `useActiveWorkspace()` /
 * `useAppShellContext()` 的组件（例如 MessagingSettingsPage）可以在 Playground
 * 中独立渲染，而无需接入完整的 AppShell 主线。
 *
 * Electron 架构补充：
 * - main 进程负责原生能力（文件、窗口、IPC）
 * - preload 脚本在 renderer 暴露安全的 electronAPI
 * - renderer（本文件所在层）只调用 window.electronAPI，不直接访问 Node/Electron
 *
 * 所有回调都是仅打印日志的空操作 —— 交互结果只输出到控制台。
 */

import * as React from 'react'
import { AppShellProvider, type AppShellContextType } from '../context/AppShellContext'
import type { Workspace } from '../../shared/types'

/** Playground 使用的 mock workspace（对应 AppShellContext 中的当前工作区） */
const PLAYGROUND_WORKSPACE: Workspace = {
  id: 'playground-workspace',
  name: 'Playground',
  slug: 'playground',
  rootPath: '/mock/workspaces/playground-workspace',
  createdAt: Date.now(),
}

/** 生成一个只打印日志的空操作回调工厂 */
function logCall(method: string) {
  return (...args: unknown[]) => {
    console.log(`[Playground AppShell] ${method} called`, args)
  }
}

// 构造一个满足 AppShellContextType 形状的最小值。
// 大部分回调为空操作；只有 workspaces / activeWorkspaceId 使用真实数据，
// 这样 `useActiveWorkspace()` 会解析到 playground workspace。
const playgroundValue: AppShellContextType = {
  workspaces: [PLAYGROUND_WORKSPACE],
  activeWorkspaceId: PLAYGROUND_WORKSPACE.id,
  activeWorkspaceSlug: PLAYGROUND_WORKSPACE.slug,
  llmConnections: [],
  refreshLlmConnections: async () => {},
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  sessionOptions: new Map(),
  onCreateSession: (async () => {
    throw new Error('[Playground] onCreateSession is not available')
  }) as AppShellContextType['onCreateSession'],
  onSendMessage: logCall('onSendMessage'),
  onRenameSession: logCall('onRenameSession'),
  onFlagSession: logCall('onFlagSession'),
  onUnflagSession: logCall('onUnflagSession'),
  onArchiveSession: logCall('onArchiveSession'),
  onUnarchiveSession: logCall('onUnarchiveSession'),
  onMarkSessionRead: logCall('onMarkSessionRead'),
  onMarkSessionUnread: logCall('onMarkSessionUnread'),
  onSetActiveViewingSession: logCall('onSetActiveViewingSession'),
  onSessionStatusChange: logCall('onSessionStatusChange'),
  onDeleteSession: async () => {
    console.log('[Playground AppShell] onDeleteSession called')
    return false
  },
  onOpenFile: logCall('onOpenFile'),
  onOpenUrl: logCall('onOpenUrl'),
  onSelectWorkspace: logCall('onSelectWorkspace'),
  onOpenSettings: logCall('onOpenSettings'),
  onOpenKeyboardShortcuts: logCall('onOpenKeyboardShortcuts'),
  onOpenStoredUserPreferences: logCall('onOpenStoredUserPreferences'),
  onReset: logCall('onReset'),
  onSessionOptionsChange: logCall('onSessionOptionsChange'),
  onInputChange: logCall('onInputChange'),
  onAttachmentsChange: logCall('onAttachmentsChange'),
  // mobile-webui 相关 demo 依赖该标志把 AppMenu 切换为紧凑布局；
  // 其他不读取该字段的 demo 不受影响。
  isCompactMode: true,
}

/** Playground 专用的 AppShellProvider：用 mock 数据包裹子组件 */
export function PlaygroundAppShellProvider({ children }: { children: React.ReactNode }) {
  return <AppShellProvider value={playgroundValue}>{children}</AppShellProvider>
}

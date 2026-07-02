/**
 * deep-link.ts —— 深链处理器。
 *
 * 解析 craftagents:// URL 并路由到对应动作。
 *
 * URL 格式（workspace 可选，省略时使用当前活动窗口）：
 *
 * 复合路由（层级导航）：
 *   craftagents://allSessions[/session/{sessionId}]            - 全部会话列表
 *   craftagents://flagged[/session/{sessionId}]                - 已标记会话
 *   craftagents://state/{stateId}[/session/{sessionId}]        - 按状态过滤
 *   craftagents://sources[/source/{sourceSlug}]                - 来源列表
 *   craftagents://settings[/{subpage}]                         - 设置页
 *
 * 动作路由：
 *   craftagents://action/{actionName}[/{id}][?params]
 *   craftagents://workspace/{workspaceId}/action/{actionName}[?params]
 *
 * 动作：
 *   new-chat                  - 新建聊天，可带 ?input=text&name=name&send=true
 *   resume-sdk-session/{id}   - 按 SDK session ID 恢复 Claude Code 会话
 *   delete-session/{id}       - 删除会话
 *   flag-session/{id}         - 标记会话
 *   unflag-session/{id}       - 取消标记
 */

import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { RPC_CHANNELS } from '../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'

// 解析后的深链目标
export interface DeepLinkTarget {
  /** 工作区 ID；undefined 表示使用当前活动窗口 */
  workspaceId?: string
  /** 复合路由格式，例如 'allSessions/session/abc123'、'settings/shortcuts' */
  view?: string
  /** 动作路由，例如 'new-chat'、'delete-session' */
  action?: string
  actionParams?: Record<string, string>
  /** 窗口模式；若设置则打开新窗口，而非在现有窗口内导航 */
  windowMode?: 'focused' | 'full'
  /** 右侧边栏参数，例如 'files/path/to/file'、'history' */
  rightSidebar?: string
}

export interface DeepLinkResult {
  success: boolean
  error?: string
  windowId?: number
}

/**
 * 通过 IPC 发送给渲染进程的导航载荷
 */
export interface DeepLinkNavigation {
  /** 复合路由格式，例如 'allSessions/session/abc123'、'settings/shortcuts' */
  view?: string
  /** 动作路由，例如 'new-chat'、'delete-session' */
  action?: string
  actionParams?: Record<string, string>
}

/**
 * 从 URL 查询参数解析窗口模式（focused / full）
 */
function parseWindowMode(parsed: URL): 'focused' | 'full' | undefined {
  const windowParam = parsed.searchParams.get('window')
  if (windowParam === 'focused' || windowParam === 'full') {
    return windowParam
  }
  return undefined
}

/**
 * 从 URL 查询参数解析右侧边栏参数
 */
function parseRightSidebar(parsed: URL): string | undefined {
  return parsed.searchParams.get('sidebar') || undefined
}

/**
 * 把深链 URL 解析成结构化的 DeepLinkTarget
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'craftagents:') {
      return null
    }

    // 自定义协议里，hostname 就是第一个路径段
    // 例：craftagents://workspace/ws123 → hostname='workspace', pathname='/ws123'
    // 例：craftagents://allSessions/chat/abc → hostname='allSessions', pathname='/chat/abc'
    const host = parsed.hostname
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const windowMode = parseWindowMode(parsed)
    const rightSidebar = parseRightSidebar(parsed)

    // craftagents://auth-callback?... OAuth 回调，返回 null 让已有处理器处理
    if (host === 'auth-callback') {
      return null
    }

    // 复合路由前缀
    const COMPOUND_ROUTE_PREFIXES = [
      'allSessions', 'flagged', 'state', 'sources', 'settings', 'skills'
    ]

    // craftagents://allSessions/...、craftagents://settings/... 等复合路由
    if (COMPOUND_ROUTE_PREFIXES.includes(host)) {
      // 用 hostname + pathname 拼出完整复合路由
      const viewRoute = pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
      return {
        workspaceId: undefined,
        view: viewRoute,
        windowMode,
        rightSidebar,
      }
    }

    // craftagents://workspace/{workspaceId}/...（指定 workspace）
    if (host === 'workspace') {
      const workspaceId = pathParts[0]
      if (!workspaceId) return null

      const result: DeepLinkTarget = { workspaceId, windowMode, rightSidebar }

      // 看 workspace ID 后面是什么类型的路由
      const routeType = pathParts[1]

      // 解析复合路由：/workspace/{id}/{compoundRoute}
      // 例：/workspace/ws123/allSessions/session/abc123
      if (routeType && COMPOUND_ROUTE_PREFIXES.includes(routeType)) {
        const viewRoute = pathParts.slice(1).join('/')
        result.view = viewRoute
        return result
      }

      // 解析 /action/{actionName}/...
      if (routeType === 'action') {
        result.action = pathParts[2]
        result.actionParams = {}
        // 处理路径里的 ID，例如 /action/delete-session/{sessionId}
        if (pathParts[3]) {
          result.actionParams.id = pathParts[3]
        }
        parsed.searchParams.forEach((value, key) => {
          // window 和 sidebar 参数单独处理，不要放进 actionParams
          if (key !== 'window' && key !== 'sidebar') {
            result.actionParams![key] = value
          }
        })
        return result
      }

      return result
    }

    // craftagents://action/...（没有 workspace，使用当前活动窗口）
    if (host === 'action') {
      const result: DeepLinkTarget = {
        workspaceId: undefined,
        action: pathParts[0],
        actionParams: {},
        windowMode,
        rightSidebar,
      }

      if (pathParts[1]) {
        result.actionParams!.id = pathParts[1]
      }

      parsed.searchParams.forEach((value, key) => {
        // window 和 sidebar 参数单独处理
        if (key !== 'window' && key !== 'sidebar') {
          result.actionParams![key] = value
        }
      })

      return result
    }

    return null
  } catch (error) {
    mainLog.error('[DeepLink] Failed to parse URL:', url, error)
    return null
  }
}

/**
 * 等待窗口的渲染进程加载完成（HTML 加载 + 短暂延时让 React 挂载）
 */
function waitForWindowReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        // 时序说明：did-finish-load 只表示 HTML 加载完成，React 的 useEffect 还没跑。
        // 延迟 100ms 让 React 挂载并注册 IPC 监听器，再发送深链。
        // 更严谨的做法是让渲染进程显式发「ready」握手，但复杂度更高，100ms 足够覆盖实际场景。
        setTimeout(resolve, 100)
      })
    } else {
      resolve()
    }
  })
}

/**
 * 去掉 window 查询参数后的深链 URL，用于在新窗口内部导航
 */
function buildDeepLinkWithoutWindowParam(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete('window')
  return parsed.toString()
}

/**
 * 处理深链：解析目标并导航到对应窗口。
 */
export async function handleDeepLink(
  url: string,
  windowManager: WindowManager,
  sink?: EventSink,
  resolveClientId?: (webContentsId: number) => string | undefined,
  preferredClientId?: string,
): Promise<DeepLinkResult> {
  const target = parseDeepLink(url)

  if (!target) {
    // auth-callback 这类返回 null 的目标由其他处理器负责，这里直接算成功
    if (url.includes('auth-callback')) {
      return { success: true }
    }
    return { success: false, error: 'Invalid deep link URL' }
  }

  mainLog.info('[DeepLink] Handling:', target)

  // 如果指定了 windowMode，就开新窗口而不是在现有窗口里导航
  if (target.windowMode) {
    mainLog.info('[DeepLink] windowMode detected:', target.windowMode)
    // 从目标或当前窗口获取 workspaceId
    let wsId = target.workspaceId
    if (!wsId) {
      const focusedWindow = windowManager.getFocusedWindow()
      mainLog.info('[DeepLink] focusedWindow:', focusedWindow?.id)
      if (focusedWindow) {
        wsId = windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
        mainLog.info('[DeepLink] wsId from focused window:', wsId)
      }
      if (!wsId) {
        const allWindows = windowManager.getAllWindows()
        mainLog.info('[DeepLink] allWindows count:', allWindows.length)
        if (allWindows.length > 0) {
          wsId = allWindows[0].workspaceId
          mainLog.info('[DeepLink] wsId from first window:', wsId)
        }
      }
    }

    if (!wsId) {
      mainLog.error('[DeepLink] No workspace available for new window')
      return { success: false, error: 'No workspace available for new window' }
    }

    // 去掉 window 参数后的 URL，用于在新窗口内部导航
    const navUrl = buildDeepLinkWithoutWindowParam(url)
    mainLog.info('[DeepLink] Creating new window with navUrl:', navUrl)

    const window = windowManager.createWindow({
      workspaceId: wsId,
      focused: target.windowMode === 'focused',
      initialDeepLink: navUrl,
    })
    mainLog.info('[DeepLink] Window created:', window.webContents.id)

    return { success: true, windowId: window.webContents.id }
  }

  // 1. 获取目标窗口（非 windowMode 的默认行为）
  let window: BrowserWindow | null = null

  if (target.workspaceId) {
    // 指定了 workspace，聚焦或创建对应窗口
    window = windowManager.focusOrCreateWindow(target.workspaceId)
  } else {
    // 没指定 workspace，使用聚焦窗口或最近活动窗口
    window = windowManager.getFocusedWindow() ?? windowManager.getLastActiveWindow()

    if (!window) {
      // 没有任何窗口，无法导航
      return { success: false, error: 'No active window to navigate' }
    }

    // 聚焦窗口
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()
  }

  // 2. 等窗口渲染进程准备好（HTML 加载 + React 挂载）
  await waitForWindowReady(window)

  // 3. 把导航命令发给渲染进程
  if (target.view || target.action) {
    const navigation: DeepLinkNavigation = {
      view: target.view,
      action: target.action,
      actionParams: target.actionParams,
    }
    const wsId = target.workspaceId ?? windowManager.getWorkspaceForWindow(window.webContents.id)
    const resolvedClientId = resolveClientId?.(window.webContents.id)

    // 优先使用解析出的目标窗口 client；只有没提供 resolver 的遗留调用点才用 preferredClientId
    const clientId = resolvedClientId ?? (!resolveClientId ? preferredClientId : undefined)

    if (sink && clientId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'client', clientId }, navigation)
    } else if (sink && wsId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'workspace', workspaceId: wsId }, navigation)
    }
  }

  return { success: true, windowId: window.isDestroyed() ? -1 : window.webContents.id }
}

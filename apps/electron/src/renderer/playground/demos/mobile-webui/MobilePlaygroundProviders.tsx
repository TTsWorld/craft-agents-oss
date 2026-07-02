/**
 * MobilePlaygroundProviders — React 组件
 * MobilePlaygroundProviders：为 mobile-webui demo 提供最小上下文栈的 Provider 组合。
 * 
 * 所属目录：mobile-webui
 */
import * as React from 'react'
// jotai 的 Provider 与 createStore 用于创建独立的 atom 存储；useSetAtom 用来写入 atom。
import { Provider as JotaiProvider, createStore, useSetAtom } from 'jotai'
import { useOptionalAppShellContext, AppShellProvider } from '@/context/AppShellContext'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { sessionMetaMapAtom, sessionAtomFamily, type SessionMeta } from '@/atoms/sessions'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { Session } from '../../../../shared/types'
import { MOBILE_WORKSPACE_ID, MOBILE_WORKSPACE_SLUG, buildMockSession } from './mock-mobile-data'

interface HydrateProps {
  sessions?: SessionMeta[]
  session?: Session
}

/**
 * Hydrates the isolated jotai store with mock data so atom-driven components
 * (SessionList, ChatDisplay) render against deterministic state.
 * 把 mock 数据灌入独立的 jotai store，让依赖 atom 的生产组件看到确定性的状态。
 */
function HydrateAtoms({ sessions, session, children }: HydrateProps & { children: React.ReactNode }) {
  const setMetaMap = useSetAtom(sessionMetaMapAtom)
  // sessionAtomFamily 是参数化 atom：传入 session.id 拿到该会话的 atom 实例。
  const setSession = useSetAtom(session ? sessionAtomFamily(session.id) : sessionAtomFamily('__noop__'))

  React.useEffect(() => {
    if (sessions && sessions.length > 0) {
      const map = new Map<string, SessionMeta>()
      for (const meta of sessions) map.set(meta.id, meta)
      setMetaMap(map)
    }
  }, [sessions, setMetaMap])

  React.useEffect(() => {
    if (session) setSession(session)
  }, [session, setSession])

  return <>{children}</>
}

interface MobileAppShellOverrideProps {
  llmConnections?: LlmConnectionWithStatus[]
  children: React.ReactNode
}

/**
 * Overrides `isCompactMode: true` on the existing AppShell context inherited
 * from PlaygroundAppShellProvider, without rebuilding the full mock value.
 * Optionally injects mock `llmConnections` so demos that exercise the model
 * picker can render real provider/connection rows.
 * 在已有的 AppShell context 基础上覆盖 isCompactMode、workspaceId 和 llmConnections。
 */
function MobileAppShellOverride({ llmConnections, children }: MobileAppShellOverrideProps) {
  const parent = useOptionalAppShellContext()
  if (!parent) {
    throw new Error('MobilePlaygroundProviders must be rendered inside PlaygroundAppShellProvider')
  }
  // useMemo 避免每次渲染都创建新的 context value，防止子树不必要的重渲染。
  const value = React.useMemo(
    () => ({
      ...parent,
      isCompactMode: true,
      activeWorkspaceId: MOBILE_WORKSPACE_ID,
      activeWorkspaceSlug: MOBILE_WORKSPACE_SLUG,
      llmConnections: llmConnections ?? parent.llmConnections,
    }),
    [parent, llmConnections],
  )
  return <AppShellProvider value={value}>{children}</AppShellProvider>
}

/** MobilePlaygroundProvidersProps：组件 props 类型定义 */
export interface MobilePlaygroundProvidersProps {
  /** Sessions to populate `sessionMetaMapAtom` with. */
  sessions?: SessionMeta[]
  /** Optional full session to hydrate into `sessionAtomFamily` for ChatDisplay. */
  session?: Session
  /** Mock LLM connections (overrides the empty default from PlaygroundAppShellProvider). */
  llmConnections?: LlmConnectionWithStatus[]
  children: React.ReactNode
}

/**
 * Wraps a mobile-webui demo with the minimum context stack the embedded
 * production components need:
 * - Fresh per-demo Jotai store (no atom bleed across demos)
 * - NavigationProvider (no-op route handlers)
 * - Focus / Modal / DismissibleLayer / EscapeInterrupt / ActionRegistry
 * - AppShell override forcing `isCompactMode: true`
 */
export function MobilePlaygroundProviders({
  sessions,
  session,
  llmConnections,
  children,
}: MobilePlaygroundProvidersProps) {
  // Fresh store per render — isolates demo state from the playground root.
  // 每次渲染都创建新的 jotai store，避免不同 demo 之间的 atom 状态互相泄漏。
  const store = React.useMemo(() => createStore(), [])

  // 创建新会话的回调；在 playground 里返回一个 mock stub。
  const onCreateSession = React.useCallback(async (): Promise<Session> => {
    const stub = buildMockSession('mobile-stub-' + Date.now(), { messages: [] })
    return stub
  }, [])

  return (
    <JotaiProvider store={store}>
      <HydrateAtoms sessions={sessions} session={session}>
        <ActionRegistryProvider>
          <DismissibleLayerProvider>
            <ModalProvider>
              <EscapeInterruptProvider>
                <FocusProvider>
                  <NavigationProvider
                    workspaceId={MOBILE_WORKSPACE_ID}
                    workspaceSlug={MOBILE_WORKSPACE_SLUG}
                    onCreateSession={onCreateSession}
                    isReady
                    isSessionsReady
                  >
                    <MobileAppShellOverride llmConnections={llmConnections}>
                      {children}
                    </MobileAppShellOverride>
                  </NavigationProvider>
                </FocusProvider>
              </EscapeInterruptProvider>
            </ModalProvider>
          </DismissibleLayerProvider>
        </ActionRegistryProvider>
      </HydrateAtoms>
    </JotaiProvider>
  )
}

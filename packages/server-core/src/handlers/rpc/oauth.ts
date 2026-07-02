import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadSource, loadWorkspaceSources, getSourceCredentialManager } from '@craft-agent/shared/sources'
import { createPendingFlow } from '@craft-agent/shared/auth'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

// 本文件属于 OAuth RPC 模块，负责：Source 的 OAuth 授权流程管理（start/complete/cancel/revoke）。
// Agent 概念：OAuth 用于让 Agent 安全地获得外部 source 的访问令牌，避免把用户密码直接交给 Agent。
// 核心函数 completeOAuthFlow 同时被 RPC handler 和 /api/oauth/callback HTTP 路由复用，
// 类似 Golang 里抽出一个 service 函数，被 grpc handler 和 http handler 同时调用。

// 本 handler 负责注册的 OAuth channel 列表
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.REVOKE,
] as const

/**
 * 完成 OAuth 流程：校验 state、用授权码换取 token、保存凭证。
 *
 * 同时被 `oauth:complete` RPC handler（Electron 调用）和 `/api/oauth/callback`
 * HTTP 路由（WebUI 的 relay 调用）复用。
 *
 * @param opts.clientId - RPC 客户端 ID（用于所有权校验）；HTTP callback 调用时省略。
 * @param opts.workspaceId - Workspace ID（用于所有权校验）；HTTP callback 调用时省略。
 */
// completeOAuthFlow：完成 OAuth 授权码换 token，并保存凭证。
// 参数用 options 对象组织，避免过长参数列表；TS 里这叫“命名参数模式”。
export async function completeOAuthFlow(opts: {
  code: string
  state: string
  flowStore: { getByState(state: string): any; remove(state: string): void }
  credManager: { exchangeAndStore(...args: any[]): Promise<any> }
  sessionManager: { completeAuthRequest(...args: any[]): Promise<void> }
  pushSourcesChanged: (workspaceId: string) => void
  logger: { info(msg: string): void; }
  clientId?: string
  workspaceId?: string | null
}): Promise<{ success: boolean; error?: string; email?: string }> {
  const { code, state, flowStore, credManager, sessionManager, pushSourcesChanged, logger } = opts

  const flow = flowStore.getByState(state)
  if (!flow) throw new Error('Unknown or expired OAuth flow')

  // 通过 RPC 调用时校验 flow 所有权；HTTP callback 只靠 state 本身做认证，跳过此校验
  if (opts.clientId !== undefined) {
    if (flow.ownerClientId !== opts.clientId) throw new Error('OAuth flow owned by different client')
  }
  if (opts.workspaceId != null) {
    if (flow.workspaceId !== opts.workspaceId) throw new Error('Workspace mismatch')
  }

  const result = await credManager.exchangeAndStore(flow.source, flow.provider, {
    code,
    codeVerifier: flow.codeVerifier,
    tokenEndpoint: flow.tokenEndpoint,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    redirectUri: flow.redirectUri,
  })

  flowStore.remove(state)

  // 如果 OAuth 是从 session 的 auth card 触发的，通知 session manager 完成认证请求
  if (flow.sessionId && flow.authRequestId) {
    await sessionManager.completeAuthRequest(flow.sessionId, {
      requestId: flow.authRequestId,
      sourceSlug: flow.sourceSlug,
      success: result.success,
      email: result.email,
      error: result.error,
    })
  }

  // 向该 workspace 的所有客户端推送 source 状态更新
  pushSourcesChanged(flow.workspaceId)

  logger.info(`[OAuth] Flow complete for ${flow.sourceSlug} (success=${result.success})`)
  return result
}

// registerOAuthHandlers：注册 OAuth 流程相关 RPC 路由。
export function registerOAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const flowStore = deps.oauthFlowStore
  const credManager = getSourceCredentialManager()

  // ── oauth:start ──────────────────────────────────────────────
  // 启动 source 的 OAuth 流程：准备 authUrl、state、PKCE codeVerifier，
  // 把 pending flow 存到 flowStore，等待浏览器回调或客户端 complete。
  server.handle(RPC_CHANNELS.oauth.START, async (ctx, args: {
    sourceSlug: string
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
  }) => {
    const { sourceSlug, callbackPort, callbackUrl, sessionId, authRequestId } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    const prepared = await credManager.prepareOAuth(source, { callbackPort, callbackUrl })

    const flowId = randomUUID()
    flowStore.store(createPendingFlow({
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      source,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      tokenEndpoint: prepared.tokenEndpoint,
      provider: prepared.provider,
      ownerClientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
      sourceSlug,
      sessionId,
      authRequestId,
    }))

    log.info(`[OAuth] Flow started for ${sourceSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // ── oauth:complete ───────────────────────────────────────────
  // 客户端在浏览器授权完成后调用；校验 flowId/state 后进入复用的 completeOAuthFlow。
  server.handle(RPC_CHANNELS.oauth.COMPLETE, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }) => {
    const { flowId, code, state } = args

    const flow = flowStore.getByState(state)
    if (!flow) throw new Error('Unknown or expired OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')

    return completeOAuthFlow({
      code,
      state,
      flowStore,
      credManager,
      sessionManager: deps.sessionManager,
      pushSourcesChanged: (workspaceId) => {
        const ws = getWorkspaceByNameOrId(workspaceId)
        const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
        pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
      },
      logger: log,
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
    })
  })

  // ── oauth:cancel ─────────────────────────────────────────────
  // 取消进行中的 OAuth flow，仅在 flow 属于当前 client 时删除。
  server.handle(RPC_CHANNELS.oauth.CANCEL, async (ctx, args: {
    flowId: string
    state: string
  }) => {
    const { flowId, state } = args
    const flow = flowStore.getByState(state)
    if (flow && flow.flowId === flowId && flow.ownerClientId === ctx.clientId) {
      flowStore.remove(state)
      log.info(`[OAuth] Flow cancelled for ${flow.sourceSlug}`)
    }
  })

  // ── oauth:revoke ─────────────────────────────────────────────
  // 吊销/登出某个 source 的 OAuth 凭证，并推送 source 状态变更。
  server.handle(RPC_CHANNELS.oauth.REVOKE, async (ctx, args: {
    sourceSlug: string
  }) => {
    const { sourceSlug } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    await credManager.delete(source)
    credManager.markSourceNeedsReauth(source, 'Signed out by user')

    // 推送 source 状态更新
    const revokeSources = loadWorkspaceSources(workspace.rootPath)
    pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId: ctx.workspaceId }, ctx.workspaceId, revokeSources)

    log.info(`[OAuth] Revoked credentials for ${sourceSlug}`)
    return { success: true }
  })
}

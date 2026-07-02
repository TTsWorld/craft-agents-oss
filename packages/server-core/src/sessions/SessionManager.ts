/**
 * SessionManager.ts
 *
 * Craft Agent 的核心会话管家。可以把本文件理解为：
 * - 一个 Go 后端里的 `SessionService` + `AgentService` + `EventBus` 的混合体；
 * - 同时兼任“浏览器工具调度员”和“文件变更监听器”。
 *
 * 主要职责：
 * 1. 会话生命周期：create / get / delete / archive / flag / rename。
 * 2. Agent 创建：根据 LLM connection 解析 provider（Claude / Pi），按需启动 SDK 子进程。
 * 3. 事件转发：把 Agent 子进程产出的事件（text_delta、tool_start、tool_result、complete 等）
 *    通过 `eventSink` 广播给前端/Electron/WebSocket 客户端。
 * 4. 文件监听：每个 workspace 有一个 ConfigWatcher，监听 sources、skills、labels、automations
 *    等配置变化，并热重载到已存在的会话中。
 * 5. 浏览器面板管理：决定使用本地 Electron BPM，还是通过 `client:browser:invoke` 转发到
 *    远程桌面客户端。
 * 6. 消息队列：当 Agent 正在处理时收到新消息，根据连接策略选择 steer（中途改向）或
 *    queue（FIFO 重放）。
 *
 * TypeScript 要点：
 * - `ManagedSession` 是运行时内存态，比持久化层 `StoredSession` 多了 `agent`、`messageQueue`、
 *   `backgroundShellCommands` 等临时字段。类似 Go 里的内存对象 vs 数据库模型。
 * - `private readonly xxx: Map<string, ...>` 是 TS 的类字段语法；`readonly` 只保证引用不可变，
 *   Map 内部仍可增删。类似 Go 里 `map` 作为 struct 字段。
 * - `async/await` 与 Go 的 goroutine + channel 不同：TS 里是单线程事件循环 + 微任务队列，
 *   适合 I/O 密集型，不适合 CPU 密集型阻塞。
 *
 * Agent 开发关键点：
 * - Agent 是懒加载（lazy）的：第一次 `sendMessage` 时才 `getOrCreateAgent`；
 * - 每个会话的 LLM connection 在第一条消息后会被锁定（`connectionLocked`），保证后续对话
 *   始终使用同一 provider；
 * - `processEvent` 是事件总线入口，所有 Agent 事件都在这里被翻译为 UI 事件并持久化；
 * - `onProcessingStopped` 是处理停止后的单一 truth source，负责清理状态、处理队列、
 *   更新未读标记。
 */

import type { EventSink, RpcServer } from '@craft-agent/server-core/transport'
import { CLIENT_BROWSER_INVOKE } from '@craft-agent/server-core/transport'
import type { ISessionManager, IBrowserPaneManager, ExecutePromptAutomationInput } from '@craft-agent/server-core/handlers'
import { RemoteBrowserPaneManager } from './RemoteBrowserPaneManager'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@craft-agent/server-core/runtime'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { type AgentEvent, setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics, type PermissionMode, unregisterSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, AbortReason, type AuthRequest, type AuthResult, type CredentialAuthRequest, type BrowserPaneFns, generateConversationSummary, resolveKeepBackgroundTasksAlive } from '@craft-agent/shared/agent'
import {
  resolveSessionConnection,
  createBackendFromConnection,
  resolveBackendContext,
  createBackendFromResolvedContext,
  cleanupSourceRuntimeArtifacts,
  providerTypeToAgentProvider,
  type AgentBackend,
  type BackendHostRuntimeContext,
  type PostInitResult,
} from '@craft-agent/shared/agent/backend'
import { getLlmConnection, getLlmConnections, getDefaultLlmConnection, getDefaultThinkingLevel, resetManagedAnthropicAuthEnvVars, resolveMidStreamBehavior, getPersistedUiLanguage, resolveTitleLanguageName } from '@craft-agent/shared/config'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { InitGate } from '@craft-agent/server-core/domain'
import { i18n } from '@craft-agent/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,
  loadPreferences,
  migrateLegacyCredentials,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type { ActiveSessionInfo, SessionProcessingStatus } from '@craft-agent/core/types'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  // 会话持久化函数
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  canUpdateSdkCwd,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionAttachmentsPath,
  getSessionPath as getSessionStoragePath,
  ensureSessionDir,
  getSessionFilePath,
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  writeSessionJsonl,
  serializeSession,
  validateBundle,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionMetadata,
  type SessionStatus,
  type SessionHeader,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources, loadAllSources, getSourcesBySlugs, isSourceUsable, type LoadedSource, type McpServerConfig, getSourcesNeedingAuth, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, hasRenewEndpoint, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter } from '@craft-agent/shared/sources'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@craft-agent/shared/config'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import { resolveAuthEnvVars } from '@craft-agent/shared/config'
import { toolMetadataStore, getLastApiError } from '@craft-agent/shared/interceptor'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftMcpClient, McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp'
import { type Session, type SessionEvent, type FileAttachment, type SendMessageOptions, type UnreadSummary, type RemoteSessionTransferPayload, type ImportRemoteSessionTransferResult, RPC_CHANNELS, generateMessageId } from '@craft-agent/shared/protocol'
import { messageToStored, storedToMessage, type Message, type StoredAttachment, type ToolDisplayMeta, type TokenUsage } from '@craft-agent/core/types'
import { formatPathsToRelative, formatToolInputPaths, perf, encodeIconToDataUrlAsync, getEmojiIcon, resetSummarizationClient, resolveToolIcon, readFileAttachment, selectSpreadMessages, normalizePath } from '@craft-agent/shared/utils'
import { loadAllSkills, loadSkillBySlug, invalidateSkillsCache, type LoadedSkill } from '@craft-agent/shared/skills'
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system'
import { getToolIconsDir, getMiniModel } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import { listLabels, loadLabelConfig } from '@craft-agent/shared/labels/storage'
import { extractLabelId, resolveSessionLabels, findTaskItemLabelId } from '@craft-agent/shared/labels'
import { ensureLabelsExist, ensureTaskItemLabel } from '@craft-agent/shared/labels/crud'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import { AutomationSystem, createPromptHistoryEntry, appendAutomationHistoryEntry, type AutomationSystemMetadataSnapshot } from '@craft-agent/shared/automations'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput } from './runtime-config'

// 从 server-core 领域工具导入
import { sanitizeForTitle, shouldActivateBrowserOverlay, normalizeBrowserToolName, rollbackFailedBranchCreation, releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'
import { resizeImageForAPI, resizeIconBuffer } from '@craft-agent/server-core/services'
export { sanitizeForTitle }

// 模块级平台引用——在初始化时通过 setSessionPlatform() 设置一次
let _platform: PlatformServices | null = null

// 作用域日志器——调用 setSessionPlatform() 时从 console 回退升级而来
// 命名为 `sessionLog`，以便所有约30个现有调用点保持不变
let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

/**
 * 注入当前进程的平台服务（文件系统、日志、错误上报等）。
 * 必须在创建任何会话之前调用一次；后续所有会话操作都依赖 `_platform`。
 */
export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

/**
 * 覆盖会话运行时的生命周期钩子（徽章计数、异常捕获、启停回调）。
 * 用于 Electron 主进程或 CLI 在启动时注入 UI 相关回调。
 */
export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}

function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform) throw new Error('setSessionPlatform() must be called before session creation')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}

/**
 * 代理行为的特性标志
 */
export const AGENT_FLAGS = {
  /** 新会话启用的默认模式 */
  defaultModesEnabled: true,
} as const

const MAX_ADMIN_REMEMBER_MINUTES = 60
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// 窗口期，在此期间忽略来自我们自身原子写入的 fs.watch 元数据回滚事件
// 以便监视器不会回滚我们刚刚持久化的内存变更
// 参见 onSessionMetadataChange
const METADATA_WRITE_GUARD_MS = 5000

/**
 * 当计划从桌面 UI 外部（如 Telegram 按钮）批准时发送给会话的文本。
 * 镜像桌面流程中 `plan-approval-message.ts` 使用的英文 `plan.approved` i18n 键。
 * 不进行本地化——此文本由代理读取，而非最终用户。
 */
const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath 已移除——改用 @craft-agent/server-core/handlers 中的共享 validateFilePath

const PI_TURN_ANCHORS_VERSION = 1
const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

interface PiTurnAnchorsIndex {
  version: number
  anchors: Record<string, string>
}

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

/**
 * 从会话存储中加载 Pi SDK 的轮次锚点索引。
 * 用于 Pi provider 在分支或续话时精确定位历史消息。
 */
export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  const filePath = getPiTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PiTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(anchors)) {
      if (typeof messageId === 'string' && typeof anchor === 'string' && messageId && anchor) {
        normalized[messageId] = anchor
      }
    }
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getPiTurnAnchor(sessionPath: string, messageId: string): Promise<string | undefined> {
  if (!messageId) return undefined
  const index = await loadPiTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

/**
 * 保存一条 Pi SDK 轮次锚点映射（Craft messageId -> Pi anchorId）。
 * 文件不存在时会自动创建 meta 目录。
 */
export async function savePiTurnAnchor(sessionPath: string, messageId: string, anchorId: string): Promise<void> {
  if (!messageId || !anchorId) return

  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return

  index.anchors[messageId] = anchorId

  const filePath = getPiTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * 将源会话中的 Pi 轮次锚点复制到分支会话中，
 * 仅过滤实际带入分支的消息。
 *
 * 没有此操作，分支的分支会静默丢失数据：源分支的 sidecar
 * 不包含从其自身父级复制的消息的锚点，因此下游分支
 * 回退到“全历史分支”——丢弃分支截断点并生成一个
 * 可见历史与 LLM 所见不匹配的会话。参见 craft-agents-oss#782。
 */
export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const index = await loadPiTurnAnchors(sourceSessionPath)
  if (Object.keys(index.anchors).length === 0) return
  const idSet = new Set(branchedMessageIds)
  const filtered: Record<string, string> = {}
  for (const [messageId, anchor] of Object.entries(index.anchors)) {
    if (idSet.has(messageId)) {
      filtered[messageId] = anchor
    }
  }
  if (Object.keys(filtered).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(
    getPiTurnAnchorsPath(branchSessionPath),
    JSON.stringify({ version: PI_TURN_ANCHORS_VERSION, anchors: filtered }),
    'utf-8',
  )
}

const CLAUDE_TURN_ANCHORS_VERSION = 1
const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(sessionPath: string): Promise<ClaudeTurnAnchorsIndex> {
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      const sdkSessionId = (value as { sdkSessionId?: unknown }).sdkSessionId
      const sdkMessageUuid = (value as { sdkMessageUuid?: unknown }).sdkMessageUuid
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getClaudeTurnAnchor(sessionPath: string, messageId: string): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * 使用新的统一模块从源码构建 MCP 和 API 服务器。
 * 一步处理凭据加载和服务器构建。
 * 当发生认证错误时，更新源配置以反映实际状态。
 *
 * @param sources - 要构建服务器的源
 * @param sessionPath - 可选的会话文件夹路径，用于保存大型 API 响应
 * @param tokenRefreshManager - 可选的 TokenRefreshManager，用于 OAuth 令牌刷新
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // 加载所有源的凭据
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  // 为可刷新的源（OAuth + renew-endpoint）构建令牌获取器
  // 使用 TokenRefreshManager 实现统一刷新逻辑（DRY 原则）
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // 特定提供商的 OAuth（Google、Slack、Microsoft）或通用 OAuth（authType: 'oauth'）
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    // API renew 端点——非 OAuth 令牌刷新
    if (hasRenewEndpoint(source)) {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // 非 OAuth / 非 renew API 源的每次请求凭据获取器
  // （bearer / header / query / basic 认证）。
  //
  // 没有此机制，进程内 API 工具会在构建时捕获凭据作为静态字符串
  // 并永久使用它——这意味着通过 source_credential_prompt 输入的新 JWT
  // 会被忽略，直到会话重启。
  //
  // 使用此获取器，每次 API 调用都会从保管库读取最新凭据，
  // 因此凭据更新会在下一次调用时生效。OAuth 和
  // renew-endpoint 源通过 TokenRefreshManager 拥有自己的刷新逻辑
  // 并在此处跳过。
  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    return async () => credManager.getApiCredential(source)
  }

  // 传递 sessionPath 以启用将大型 API 响应保存到会话文件夹
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
    getCredentialForSource,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // 更新认证错误的源配置，以便 UI 反映实际状态。
  // 当凭据仅过期但可刷新时，将 AUTH_REQUIRED 重新分类为 TOKEN_EXPIRED；
  // 在这种情况下，刷新周期处理恢复
  // 我们绝不能过早地将源标记为需要重新认证（#710）。
  for (const error of result.errors) {
    if (error.error !== SERVER_BUILD_ERRORS.AUTH_REQUIRED) continue
    const source = sources.find(s => s.config.slug === error.sourceSlug)
    if (!source) continue

    const cred = await credManager.load(source)
    const isExpiredRefreshable =
      cred &&
      (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
      (cred.refreshToken || hasRenewEndpoint(source))

    if (isExpiredRefreshable) {
      error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
      sessionLog.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
      continue
    }

    credManager.markSourceNeedsReauth(source, 'Token missing or expired')
    sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
  }

  span.end()
  return result
}

/**
 * 过期凭据刷新的结果。
 */
interface RefreshExpiredCredentialsResult {
  /** 成功刷新令牌的源数量 */
  refreshedCount: number
  /** 刷新失败的源（用于警告显示） */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * 刷新给定源的过期 OAuth / renew-endpoint 令牌。
 *
 * 副作用（由 `TokenRefreshManager.ensureFreshToken` 承载）：
 * - 成功：source.config.isAuthenticated = true（内存 + 磁盘）。
 * - 失败：source.config.isAuthenticated = false + connectionStatus = 'needs_auth'
 *   （内存 + 磁盘），因此 isSourceUsable() 返回 false，且该源被
 *   调用者从 intendedSlugs 中排除。
 *
 * 调用者负责在此返回后构建服务器——这样
 * 一次新的构建就能看到正确的凭据和正确的可用集。
 * 问题 #710。
 */
async function refreshExpiredCredentials(
  sources: LoadedSource[],
  tokenRefreshManager: TokenRefreshManager
): Promise<RefreshExpiredCredentialsResult> {
  sessionLog.debug('[OAuth] Checking if any tokens need refresh')

  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)
  if (needRefresh.length === 0) {
    return { refreshedCount: 0, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Refreshing ${needRefresh.length} source(s): ${needRefresh.map(s => s.config.slug).join(', ')}`)

  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  return { refreshedCount: refreshed.length, failedSources }
}

/**
 * 为使用它的后端应用 bridge-mcp-server 更新。
 * 委托给后端自己的 applyBridgeUpdates() 方法。
 * 每个后端通过 applyBridgeUpdates() 处理自己的策略。
 */
async function applyBridgeUpdates(
  agent: AgentInstance,
  sessionPath: string,
  enabledSources: LoadedSource[],
  mcpServers: Record<string, import('@craft-agent/shared/agent/backend').SdkMcpServerConfig>,
  sessionId: string,
  workspaceRootPath: string,
  context: string,
  poolServerUrl?: string
): Promise<void> {
  await agent.applyBridgeUpdates({
    sessionPath,
    enabledSources,
    mcpServers,
    sessionId,
    workspaceRootPath,
    context,
    poolServerUrl,
  })
}

/**
 * 解析工具调用的工具显示元数据。
 * 返回包含 base64 编码图标的元数据，以兼容查看器。
 *
 * @param toolName - 事件中的工具名称（例如 "Skill"、"mcp__linear__list_issues"）
 * @param toolInput - 工具输入（用于 Skill 工具以获取技能标识符）
 * @param workspaceRootPath - 工作区路径，用于加载技能/源
 * @param sources - 工作区已加载的源
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'
let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // 缓存未命中哨兵：undefined 表示“尚未计算”
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // 开发回退（同步到 ~/.craft-agent/tool-icons 之前）
      join(process.cwd(), 'apps', 'electron', 'resources', 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
      // 打包回退（应用资源）
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, { resize: resizeIconBuffer })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): Promise<ToolDisplayMeta | undefined> {
  // 检查是否为 MCP 工具（格式：mcp__<serverSlug>__<toolName>）
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // 内部 MCP 服务器工具（session、docs）
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'SubmitPlan': 'Submit Plan',
          'call_llm': 'LLM Query',
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
          'transform_data': 'Transform Data',
          'render_template': 'Render Template',
          'update_user_preferences': 'Update Preferences',
          'send_developer_feedback': 'Send Feedback',
          'browser_tool': 'Browser',
        },
        'craft-agents-docs': {
          'SearchCraftAgents': 'Search Docs',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return {
            displayName,
            iconDataUrl: normalizedBrowserTool ? await getBrowserToolIconDataUrl() : undefined,
            category: 'native' as const,
          }
        }
      }

      // 外部源工具
      let sourceSlug = serverSlug

      // 特殊情况：api-bridge 服务器在工具名称中嵌入源 slug，格式为 "api_{slug}"
      // 例如，mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // 首先尝试基于文件的图标，回退到配置中的表情符号图标
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, { resize: resizeIconBuffer })
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        }
      }
    }
    return undefined
  }

  // 检查是否为 Skill 工具
  if (toolName === 'Skill' && toolInput) {
    // Skill 输入具有 'skill' 参数，格式为 "skillSlug" 或 "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // 提取技能 slug（如果存在则移除工作区前缀）
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // 加载技能并找到正在调用的那个
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // 首先尝试基于文件的图标，回退到元数据中的表情符号图标
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, { resize: resizeIconBuffer })
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // 技能加载失败，跳过
        }
      }
    }
    return undefined
  }

  // CLI 工具图标解析（用于 Bash 命令）
  // 解析命令字符串以检测已知工具（git、npm、docker 等）
  // 并从 ~/.craft-agent/tool-icons/ 解析其品牌图标
  if (toolName === 'Bash' && toolInput?.command) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // 图标解析是尽力而为——绝不因此使会话崩溃
    }
  }

  // 原生浏览器工具名称（带 Chrome 图标）
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return {
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    }
  }

  // 原生工具显示名称（无图标——UI 使用内置图标处理这些）
  // 这确保 toolDisplayMeta 始终填充，以实现一致的显示
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'Agent': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // 未知工具——无显示元数据（将在 UI 中回退到工具名称）
  return undefined
}

/** 代理类型——所有提供商的统一后端接口 */
type AgentInstance = AgentBackend

/**
 * 主进程注册表中后台任务的状态。
 * - `running`   —— 已转入后台，尚未看到终止通知。
 * - `completed`/`failed`/`stopped` —— 收到了真实的 SDK task_notification。
 * - `orphaned`  —— 拥有该任务的 turn 在终止通知到达前就结束了。在（默认的）每 turn 子进程
 *   模型下，该任务几乎肯定随子进程一起消亡，因此把它报告为仍"running"就是在撒谎。
 *   一旦启用 WS2 keep-alive，就不再产生此类状态，因为查询的生命周期超过了 turn。
 */
type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

/** 从启动开始跟踪的后台任务，用于跨子进程的状态查询。 */
interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  /** 任务转入后台时的毫秒时间戳 */
  startTime: number
  /** 最近一次 task_progress 通知的毫秒时间戳（如果有） */
  lastProgressAt?: number
  /** 最近一次进度通知经过的秒数（如果有） */
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  /** 任务达到终止/孤儿状态时的毫秒时间戳 */
  completedAt?: number
  /** 发起该任务的 turn（用于在该 turn 完成时将其标记为孤儿） */
  turnId?: string
  /** Workflow 运行 id（wf_...）—— 当该任务是 Workflow 启动时设置。 */
  workflowId?: string
  /** 目前已完成的 workflow 子 agent 数量（仅 Workflow 任务）。 */
  agentsCompleted?: number
}

/**
 * 单个会话的运行时内存表示。
 *
 * 与 Go 的类比：
 * - 如果 Go 里有一个 `type Session struct`，那么 `ManagedSession` 就是它在内存里的扩展版，
 *   附加了运行时字段（如 `agent`、`messageQueue`），这些字段不会序列化到磁盘。
 *
 * 关键字段解释：
 * - `agent: AgentInstance | null`：懒加载，第一条消息前为 null；
 * - `isProcessing`：当前是否正在流式处理中；
 * - `processingGeneration`：单调递增，用于检测当前处理是否已被新消息取代；
 * - `messageQueue`：Agent 忙碌时收到的新消息队列，FIFO 重放；
 * - `backgroundShellCommands / backgroundTaskOutputs`：记录后台 shell / task，
 *   支持 `KillShell` 和 `getTaskOutput`；
 * - `tokenRefreshManager`：OAuth / renew-endpoint token 的刷新器，每个会话独立，
 *   避免跨会话刷新竞争。
 */
interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null  // 延迟加载——在第一条消息之前为 null
  messages: Message[]
  isProcessing: boolean
  /** 用户请求停止时设置——允许事件循环在清除 isProcessing 之前排空 */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  // 每次新消息开始处理时递增。
  // 用于检测后续消息是否已取代当前消息（过期请求防护）。
  processingGeneration: number
  // 注意：父子跟踪状态（pendingTools、parentToolStack、toolToParentMap、
  // pendingTextParent）已移除。CraftAgent 现在使用 SDK 权威的 parent_tool_use_id 字段
  // 直接在所有事件上提供 parentToolUseId。
  // 参见：packages/shared/src/agent/tool-matching.ts
  // 会话名称（用户定义或 AI 生成）
  name?: string
  isFlagged: boolean
  /** 此会话是否已归档 */
  isArchived?: boolean
  /** 会话归档的时间戳（用于保留策略） */
  archivedAt?: number
  /** 此会话的权限模式（'safe'、'ask'、'allow-all'） */
  permissionMode?: PermissionMode
  /** 先前的权限模式（在重启之间保留，用于 session_state modeTransition 上下文） */
  previousPermissionMode?: PermissionMode
  /** 此会话源连接的集中式 MCP 客户端池 */
  mcpPool?: McpClientPool
  /** 将池工具暴露给外部 SDK 子进程的 HTTP MCP 服务器 */
  poolServer?: McpPoolServer
  // SDK 会话 ID，用于对话连续性
  sdkSessionId?: string
  // 用于显示的令牌使用情况
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** 模型的上下文窗口大小（以令牌为单位，来自 SDK modelUsage） */
    contextWindow?: number
  }
  // 会话状态（用户控制）——决定打开还是关闭
  // 引用工作区状态配置的动态状态 ID
  sessionStatus?: string
  // 已读/未读跟踪——用户已读的最后一条消息的 ID
  lastReadMessageId?: string
  /**
   * 显式未读标志——NEW 徽章的唯一真实来源。
   * 当助手消息完成且用户未查看时设置为 true。
   * 当用户查看会话（且未处理中）时设置为 false。
   */
  hasUnread?: boolean
  // 每个会话的源选择（已启用源的 slug）
  enabledSourceSlugs?: string[]
  // 应用于此会话的标签（累加标签，每个会话多个）
  labels?: string[]
  // workspace 级项目绑定（undefined = 未绑定）
  projectId?: string
  // 父 session id —— 设置后表示该 session 是父任务的子任务（undefined = 顶级任务）
  parentSessionId?: string
  // 看板列 id（'todo' | 'in-progress' | 'done'）；与 sessionStatus 独立
  kanbanColumn?: string
  // Tasks Conductor：该 session 所属的任务 spec slug（编排器 + 子节点）
  taskSlug?: string
  // Tasks Conductor：派生该子 session 的运行的 id（仅子节点）
  taskRunId?: string
  // Tasks Conductor：该子 session 执行的 DAG 节点 id（仅子节点）
  taskNodeId?: string
  // Tasks Conductor：DAG 节点总数（仅编排器）—— 稳定的看板进度分母
  taskNodeCount?: number
  // Tasks Conductor：隐藏的生成时编排器，等待验证后采纳（不在看板上）
  taskDraft?: boolean
  // 此会话的工作目录（代理用于 bash 命令）
  workingDirectory?: string
  // SDK 会话存储的 cwd——创建时设置一次，永不更改。
  // 确保 SDK 无论 workingDirectory 如何更改都能找到会话记录。
  sdkCwd?: string
  // 共享查看器 URL（如果通过查看器共享）
  sharedUrl?: string
  // 查看器中的共享会话 ID（用于撤销）
  sharedId?: string
  // 此会话使用的模型（如果设置则覆盖全局配置）
  model?: string
  // 此会话的 LLM 连接 slug（第一条消息后锁定）
  llmConnection?: string
  // 连接是否已锁定（首次创建代理后无法更改）
  connectionLocked?: boolean
  // 此会话的思考级别（'off'、'think'、'max'）
  thinkingLevel?: ThinkingLevel
  // 迷你代理的系统提示预设（'default' | 'mini'）
  systemPromptPreset?: 'default' | 'mini' | string
  // 最后一条消息的角色/类型（用于徽章显示，无需加载消息）
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // 最后一条最终（非中间）助手消息的 ID——预计算用于未读检测
  lastFinalMessageId?: string
  // 轮次基线：轮次开始时最后一条最终助手消息的 ID（仅运行时，不持久化）
  turnStartFinalMessageId?: string
  // 处理过程中看到的外部会话元数据更新（轮次停止后应用）
  pendingExternalMetadata?: SessionHeader
  // 防护：在程序化写入（setSessionStatus/setSessionLabels）后抑制外部元数据回滚。
  // fs.watch 在原子写入期间触发（unlink+rename）并可能读取过期数据，回滚内存状态。
  _metadataWriteGuardUntil?: number
  // 异步操作是否正在进行（共享、更新共享、撤销、标题重新生成）
  // 用于会话标题的闪烁效果
  isAsyncOperationOngoing?: boolean
  // 第一条用户消息的预览（用于侧边栏显示回退）
  preview?: string
  // 会话首次创建的时间（JSONL 头部的毫秒时间戳）
  createdAt?: number
  // 总消息数（在 JSONL 头部预计算，用于快速列表加载）
  messageCount?: number
  // 处理过程中处理新消息的消息队列
  // 当消息在处理过程中到达时，我们中断并排队
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string  // 预生成的 ID，用于与 UI 匹配
    optimisticMessageId?: string  // 前端的 ID，用于可靠的事件匹配
  }>
  // shellId -> 命令的映射，用于终止后台 shell
  backgroundShellCommands: Map<string, string>
  // taskId -> 输出信息的映射，用于后台任务结果
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // 该 session 的后台任务注册表（运行中 + 最近终止的）。
  // 与 backgroundTaskOutputs（只存储已完成任务用于获取输出）不同，这里从任务转入后台的那一刻起
  // 就开始跟踪，这样跨子进程的"状态如何？"查询就能枚举出真正还在运行的任务。SDK 的进程内
  // 任务工具无法回答这个问题：它们的状态在 turn 结束时随子进程消亡，因此这个主进程注册表才是
  // 后台任务状态的真正事实来源。见 RunningBackgroundTask。
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  // 消息是否已从磁盘加载（用于延迟加载）
  messagesLoaded: boolean
  // 待处理的认证请求跟踪（用于统一认证流程）
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  // 认证重试跟踪（用于会话中令牌过期）
  // 存储最后发送的消息/附件，以便在令牌刷新后启用重试
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // 防止无限重试循环的标志（每次 sendMessage 开始时重置）
  authRetryAttempted?: boolean
  // 表示认证重试正在进行的标志（防止 complete 处理程序干扰）
  authRetryInProgress?: boolean
  // 此会话是否在会话列表中隐藏（例如，迷你编辑会话）
  hidden?: boolean
  branchFromMessageId?: string
  // 分支上下文策略：
  // - sdk-fork：从父级 SDK 会话进行提供者级别的分支
  // - seeded-fresh-session：使用分支截止点之前的记录作为种子的全新后端会话
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  // 父级会话的 SDK 会话 ID（仅在 branchContextStrategy === 'sdk-fork' 时使用）
  branchFromSdkSessionId?: string
  // 父级会话的存储路径（仅在 branchContextStrategy === 'sdk-fork' 时使用）
  branchFromSessionPath?: string
  // 父级会话的 sdkCwd — 分支子进程需要它来使用正确的
  // ~/.claude/projects/{cwd-hash}/ 目录以找到父级的会话文件。
  branchFromSdkCwd?: string
  // 分支点处的 SDK 助手消息 UUID — 用作 resumeSessionAt
  // 以在分支点截断分支后的对话。
  branchFromSdkTurnId?: string
  // 种子分支模式的一次性标志 — 在第一次轮次种子注入后设置为 true。
  branchSeedApplied?: boolean
  // 远程转移后，在第一个轮次注入的一次性隐藏摘要。
  transferredSessionSummary?: string
  // 转移会话的摘要是否已被注入。
  transferredSessionSummaryApplied?: boolean
  // 用于 OAuth 令牌刷新的令牌刷新管理器，带速率限制
  tokenRefreshManager: TokenRefreshManager
  // 由自动化创建的会话的元数据
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number }
  // 当代理实例就绪时解决的 Promise（供标题生成等待）
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
  // 每个会话的 SDK 子进程环境变量覆盖（例如，ANTHROPIC_BASE_URL）。
  // 存储在托管会话上，以便在代理重新创建时持久化（认证重试等）
  envOverrides?: Record<string, string>
  // 创建/刷新实时代理时捕获的影响运行时的后端配置签名。
  backendRuntimeSignature?: string
  /**
   * 无法通过 `update_runtime_config` 传播的字段的签名
   * （参见 `runtime-config.ts:buildRestartRequiredSignature`）。当此签名发生变化时，
   * 必须销毁并重新创建代理，而不是原地刷新。
   */
  backendRestartSignature?: string
  // 上一轮次是否被中断（用于在下一消息中注入上下文）。
  // 临时 — 不持久化到磁盘。一次性注入后清除。
  wasInterrupted?: boolean
  /**
   * 仅运行时：Pi SDK 消息 ID → Craft 助手消息 ID。
   * 当携带 `sdkMessageId` 的 `text_complete` 到达时填充，
   * 并在后续的 `pi_turn_anchor` 事件到达时读取（延迟一个微任务，
   * 以便 SDK 的会话管理器已更新其叶子节点 — 参见 craft-agents-oss#782）。
   * 上限为 PI_SDK_MESSAGE_ID_CACHE_LIMIT 以限制长会话中的内存。
   */
  piSdkMessageToCraftMessage?: Map<string, string>
  // 源激活自动重试（craft-agents-oss#804）。当源在轮次中激活时
  // 我们会在短暂延迟后，用 "[<slug> activated]" 后缀重新发送原始消息。
  // pending 槽位允许 `sendMessage` 去重来自旧版渲染器的重复
  // RPC，该渲染器仍然发送客户端的 auto_retry。
  autoRetryTimer?: ReturnType<typeof setTimeout>
  autoRetryPending?: {
    content: string
    deadlineMs: number
    /** 第一个匹配的 sendMessage 消费该槽位后设为 true；后续匹配丢弃。 */
    committed: boolean
  }
}

const PI_SDK_MESSAGE_ID_CACHE_LIMIT = 256

/**
 * 承载“源激活后自动重试”的 pending 状态。
 * 被 `sendMessage` 和自动重试逻辑共享，用于去重并设置重试截止时间。
 */
export interface AutoRetryPendingHost {
  autoRetryPending?: {
    content: string
    deadlineMs: number
    committed: boolean
  }
}

/**
 * 认领一次自动重试槽位。
 * - 若 message 与 pending 内容匹配且在截止时间前未提交，则标记为已提交并返回 'send'；
 * - 已提交或超时的重复调用返回 'drop'；
 * - 普通消息返回 'send'。
 */
export function claimAutoRetryPending(
  host: AutoRetryPendingHost,
  message: string,
  nowMs = Date.now(),
): 'send' | 'drop' {
  const pending = host.autoRetryPending
  if (pending && message === pending.content) {
    if (nowMs < pending.deadlineMs) {
      if (pending.committed) return 'drop'
      pending.committed = true
      return 'send'
    }
    host.autoRetryPending = undefined
    return 'send'
  }

  if (pending && nowMs >= pending.deadlineMs) {
    host.autoRetryPending = undefined
  }

  return 'send'
}

/**
 * 从任何类似会话的源（SessionMetadata, SessionConfig, StoredSession）创建 ManagedSession。
 * 从源中展开所有匹配的字段，以便新的持久化字段自动传播。
 * 仅运行时的字段获得合理的默认值。
 */
export function createManagedSession(
  source: { id: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: 在旧的持久化会话头在升级过程中
    // 实际过期后，移除遗留的 'think' 规范化。
    const normalizedThinkingLevel = normalizeThinkingLevel(sourceFields.thinkingLevel)
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  const managed = {
    // 从源展开所有类似会话的字段（id, name, permissionMode, labels, model 等）
    // 这确保新的持久化字段自动流转，无需手动复制。
    ...sourceFields,
    // 仅运行时的默认值（不持久化）
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    backgroundTaskRegistry: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // 调用者覆盖（permissionMode 默认值, thinkingLevel, messagesLoaded 等）
    ...overrides,
  } as ManagedSession

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // 如果 SDK 会话 ID 已存在，则第一轮次已经发生。
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  return managed
}

/**
 * 解析托管会话的 supportsBranching。
 * 优先使用实时代理实例；否则对所有后端返回 true。
 */
function resolveSupportsBranching(managed: ManagedSession): boolean {
  // 如果代理是实时的，使用其实例属性（权威来源）
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // 默认值：对所有后端启用分支
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

/**
 * 将 ManagedSession 转换为渲染器端的 Session 对象。
 * 使用 pickSessionFields() 获取持久化字段，以便新字段自动传播。
 */
function managedToSession(m: ManagedSession, overrides?: Partial<Session>): Session {
  return {
    ...pickSessionFields(m),
    // 从头信息预计算的字段（不在 SESSION_PERSISTENT_FIELDS 中）
    preview: m.preview,
    lastMessageRole: m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: m.messageCount,
    lastFinalMessageId: m.lastFinalMessageId,
    // 仅运行时字段
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    isProcessing: m.isProcessing,
    sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}

// 性能：批量处理 IPC delta 事件以减少渲染器负载
const DELTA_BATCH_INTERVAL_MS = 50  // 每 50ms 刷新一次批处理的 delta

interface PendingDelta {
  delta: string
  turnId?: string
}

/**
 * 进程内的会话完成信号，供 Tasks Conductor 使用。
 *
 * 每次 turn 在 `onProcessingStopped` 中、当 session 的消息队列为空时（即真正的完成，
 * 而非排队 turn 之间的交接）触发一次，携带停止 `reason`。这是一个内部的、无副作用的接缝
 * —— 它不是渲染器事件，也不对 agent 暴露。Conductor 把 reason 映射到节点运行状态：
 * complete→done、error/timeout→failed、interrupted→cancelled。
 */
export interface SessionCompletionEvent {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  /** 该 turn 的最终（非 intermediate）assistant 消息 id（如果有）。 */
  finalMessageId?: string
  /** 最终 assistant 消息文本的便捷副本（同 getSessionFinalText）。 */
  finalText?: string
  /** 该 session 的累计 token 使用量，让 Conductor 无需重新获取即可计量 token_budget。 */
  tokenUsage?: TokenUsage
}

/**
 * 会话管理器主类。
 *
 * 内部维护若干 Map，可按 sessionId / workspaceRootPath 快速索引：
 * - `sessions`：所有已加载会话的运行时态；
 * - `pendingDeltas / deltaFlushTimers`：文本流式增量批处理，减少 IPC 频率；
 * - `configWatchers`：每个 workspace 一个文件监听器；
 * - `automationSystems`：每个 workspace 的自动化系统（含定时器、事件匹配、执行器）；
 * - `pendingCredentialResolvers / pendingPermissionRequests`：等待用户输入的认证/权限请求；
 * - `adminRememberApprovals`：管理员"允许 N 分钟"的特权命令记忆窗口；
 * - `messageLoadingPromises`：懒加载消息时的去重 Promise；
 * - `activeViewingSession`：记录用户当前正在查看哪个会话，用于未读判定；
 * - `agentRefreshLocks`：保证同一会话的 runtime config 刷新串行化，避免并发刷新导致子进程竞态。
 */
export class SessionManager implements ISessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  // 为性能进行 Delta 批处理 - 将 IPC 事件从 50+/秒 减少到约 20/秒
  private pendingDeltas: Map<string, PendingDelta> = new Map()
  private deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // 用于实时更新的配置监视器（源等）- 每个工作区一个
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // 用于工作区事件自动化的自动化系统 - 每个工作区一个（包括调度器、差异比较和处理程序）
  private automationSystems: Map<string, AutomationSystem> = new Map()
  // 待处理的凭据请求解析器（以 requestId 为键）
  private pendingCredentialResolvers: Map<string, (response: import('@craft-agent/shared/protocol').CredentialResponse) => void> = new Map()
  // 权限请求元数据跟踪（以 requestId 为键）
  private pendingPermissionRequests: Map<string, {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }> = new Map()
  // 特权审批绑定 + 审计日志记录器
  private privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // 会话本地管理员记住窗口（精确命令哈希绑定）
  private adminRememberApprovals: Map<string, {
    createdAt: number
    expiresAt: number
    sourceRequestId: string
  }> = new Map()
  // 用于延迟加载消息的 Promise 去重（防止竞态条件）
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  /**
   * 跟踪用户当前正在查看的会话（每个工作区）。
   * 映射 workspaceId -> sessionId。用于确定助手完成时是否应将会话标记为未读 -
   * 如果用户正在查看它，则不标记为未读。
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** 协调来自 IPC 处理程序的启动初始化等待者。 */
  private initGate = new InitGate()
  // O(1) 索引：taskId → sessionId，用于后台任务输出查找（避免 O(n) 会话扫描）
  private taskOutputIndex: Map<string, string> = new Map()
  /**
   * WS2 keep-alive 标志（默认开启，可通过 `CRAFT_KEEP_BG_AGENTS_ALIVE=0` 关闭）。
   * 为 true 时，一个持久的流式查询让子进程跨 turn 存活，使后台子 agent 得以保留，并抑制孤儿化。
   * 为 false（kill-switch）时，子 agent 绑定到单个 turn 的子进程，在 turn 结束时消亡，
   * 因此 markOrphanedBackgroundTasks() 会在 turn 完成时把仍处于 running 的注册表条目翻转为 `orphaned`。
   * 通过共享的 `resolveKeepBackgroundTasksAlive` 解析，确保主进程和 Claude 后端对 keep-alive
   * 是否开启永远不会产生分歧。
   */
  private readonly keepBackgroundTasksAlive: boolean = resolveKeepBackgroundTasksAlive()
  /**
   * 每个会话正在进行的运行时刷新 Promise。确保 `updateRuntimeConfig`
   * （或 dispose）不能与另一个刷新重叠，也不能与同一会话上的发送路径
   * `getOrCreateAgent` 重叠。没有此序列化，
   * `SAVE` 触发的刷新和 `sendMessage` 触发的刷新都可能
   * 看到 `agent.isProcessing()=false`，两者都触发 `updateRuntimeConfig`，并且
   * 子进程可能使生成的 `chat` 与仍在等待的更新发生竞态。
   */
  private agentRefreshLocks: Map<string, Promise<void>> = new Map()
  /** 单调时钟以确保严格递增的消息时间戳 */
  private lastTimestamp = 0

  /**
   * 由消息网关引导程序安装的可选绑定器。设置后，
   * `executePromptAutomation` 在创建其匹配器声明了 `telegramTopic` 的会话后调用它，
   * 以便新会话绑定到工作区配对超级组中的 Telegram 论坛主题。
   * 尽力而为 — 失败不得阻塞会话。
   */
  private automationBinder?: (input: {
    workspaceId: string
    sessionId: string
    topicName: string
  }) => Promise<void>

  /**
   * 会话处理状态的集中设置器。
   * 在状态转换时自动通知电源管理器（true→false, false→true），
   * 因此调用者无需记住调用 onSessionStarted/onSessionStopped。
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      sessionRuntimeHooks.onSessionStopped()
    }
  }

  /** 等待 initialize() 完成（从磁盘加载会话）。
   *  如果已初始化则立即解决。 */
  waitForInit(): Promise<void> {
    return this.initGate.wait()
  }

  /**
   * 安装自动化→主题绑定器。由消息网关引导程序连接，
   * 以便 SessionManager 无需导入消息包（避免包级循环依赖）。
   */
  setAutomationBinder(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void {
    this.automationBinder = fn
  }

  private browserPaneManager: IBrowserPaneManager | null = null
  private rpcServer: RpcServer | null = null
  private remoteBpms = new Map<string, RemoteBrowserPaneManager>()
  /** 每个会话固定的桌面客户端，用于 `client:browser:invoke` 路由。 */
  private browserHostByCanvas = new Map<string, string>()
  private eventSink: EventSink | null = null

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  /**
   * 注入本地浏览器面板管理器（Electron 同进程模式）。
   *
   * 当 Agent 与 Electron 客户端运行在同一进程时，直接调用本地 BPM；
   * 否则通过 `setRpcServer` 启用远程桥接（`RemoteBrowserPaneManager`）。
   */
  setBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.browserPaneManager = bpm
    bpm.setSessionPathResolver((sessionId) => this.getSessionPath(sessionId))
  }

  /**
   * 提供 WS RPC 服务器，以便远程客户端可以托管浏览器工具。
   *
   * 调用时，SM 激活远程桥接代码路径：每个会话的
   * `RemoteBrowserPaneManager` 实例由 {@link getBrowserPaneManagerForSession} 延迟创建，
   * 浏览器主机客户端通过 {@link getBrowserHostClient} 解析，并具有能力感知的回退。
   *
   * 本地 Electron 调用者无需调用此方法 — 它们已经
   * 使用进程内 BPM 调用 `setBrowserPaneManager(bpm)`，
   * 在 {@link getBrowserPaneManagerForSession} 中优先于远程桥接。
   */
  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
    sessionLog.info('[browser-pane] setRpcServer called — remote browser bridge is now available')
  }

  /**
   * 解析拥有用户本地浏览器的 {@link IBrowserPaneManager}，用于给定会话。返回：
   *
   * 1. 当存在本地注入的 `browserPaneManager` 时（与代理共置的 Electron 客户端），
   *    无论会话如何，都返回它。
   * 2. 当设置了 `rpcServer` 时，返回会话绑定的 {@link RemoteBrowserPaneManager}。
   *    缓存在 `remoteBpms` 中，以便重复查找不分配新对象。
   * 3. 当既没有本地 BPM 也没有 RPC 服务器时，返回 `null`。
   */
  getBrowserPaneManagerForSession(sid: string): IBrowserPaneManager | null {
    if (this.browserPaneManager) return this.browserPaneManager
    if (!this.rpcServer) return null

    const cached = this.remoteBpms.get(sid)
    if (cached) return cached

    const session = this.sessions.get(sid)
    if (!session) return null

    const bridge = new RemoteBrowserPaneManager({
      sessionId: sid,
      workspaceId: session.workspace.id,
      rpcServer: this.rpcServer,
      getHostClient: () => this.getBrowserHostClient(sid),
    })
    this.remoteBpms.set(sid, bridge)
    return bridge
  }

  /**
   * 记录哪个桌面客户端应托管此会话的浏览器。从 `sessions.sendMessage` RPC 处理程序
   * 使用 `ctx.clientId` 调用，以便代理的 browser_* 工具路由回发布消息的客户端。
   *
   * 当 `callerClientId` 为 undefined 时无操作 — 保留现有的固定客户端
   * （让重新连接的客户端继续持有主机角色）。
   */
  private setLastMessageClientId(sid: string, callerClientId: string | undefined): void {
    if (!callerClientId) return
    this.browserHostByCanvas.set(sid, callerClientId)
  }

  /**
   * 由传输引导程序在 `onClientDisconnected` 时调用。删除由 `clientId` 持有的任何固定客户端，
   * 以便下一次浏览器工具调用通过 {@link findClientsWithCapability} 重新解析，
   * 而不是尝试发送到已断开的客户端。
   */
  onClientDisconnected(clientId: string): void {
    for (const [sid, pinned] of this.browserHostByCanvas) {
      if (pinned === clientId) this.browserHostByCanvas.delete(sid)
    }
  }

  /**
   * 优先使用固定的客户端，回退到工作区中任何已连接且声明了 `client:browser:invoke` 的客户端。
   * 回退处理使用新 clientId 重新连接的情况，
   * 这样代理就不会卡住等待另一个用户消息。
   */
  private getBrowserHostClient(sid: string): string | null {
    if (!this.rpcServer) return null
    const pinned = this.browserHostByCanvas.get(sid)
    if (pinned && this.rpcServer.hasClientCapability(pinned, CLIENT_BROWSER_INVOKE)) {
      return pinned
    }
    const session = this.sessions.get(sid)
    if (!session) return null
    const candidates = this.rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId: session.workspace.id },
    )
    const fallback = candidates[0]
    if (!fallback) return null
    this.browserHostByCanvas.set(sid, fallback)
    return fallback
  }

  /** 返回严格递增的时间戳（毫秒）。当 Date.now() 与
   *  前一个值冲突时，递增 1 以保持事件顺序。 */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  private hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
        sessionId,
        commandHash,
        sourceRequestId: entry.sourceRequestId,
        expiresAt: entry.expiresAt,
      })
      return false
    }

    return true
  }

  private storeAdminRememberApproval(sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES)
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(this.getAdminRememberKey(sessionId, commandHash), {
      createdAt: now,
      expiresAt,
      sourceRequestId,
    })

    this.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
      sessionId,
      commandHash,
      sourceRequestId,
      rememberForMinutes: boundedMinutes,
      createdAt: now,
      expiresAt,
    })
  }

  private clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  private clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, metadata] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  /**
   * 将外部会话头元数据应用于内存状态并发出 UI 事件。
   * 如果任何内存元数据字段发生更改，则返回 true。
   */
  private applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): boolean {
    const sessionId = managed.id
    let changed = false

    // 标签
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(header.labels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = header.labels
      this.sendEvent({ type: 'labels_changed', sessionId, labels: header.labels ?? [] }, managed.workspace.id)
      changed = true
    }

    // 已标记
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent(
        { type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId },
        managed.workspace.id
      )
      changed = true
    }

    // 会话状态
    if (managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' }, managed.workspace.id)
      changed = true
    }

    // 名称
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id)
      changed = true
    }

    // Project binding (no dedicated event today — handled via metaChanged broadcast)
    if (managed.projectId !== header.projectId) {
      managed.projectId = header.projectId
      changed = true
    }

    // Kanban column (mutable via drag; reconcile external/multi-window changes)
    if (managed.kanbanColumn !== header.kanbanColumn) {
      managed.kanbanColumn = header.kanbanColumn
      changed = true
    }

    if (changed) {
      sessionLog.info(`External metadata change detected for session ${sessionId}`)

      // 防止过时的待处理写入还原外部更新的元数据。
      sessionPersistenceQueue.cancel(sessionId)
      this.persistSession(managed)
    }

    return changed
  }

  /**
   * 为 workspace 配置文件监听器（ConfigWatcher）。
   *
   * 这是 Agent 系统的“热重载”中枢：
   * - sources.json / 单个 source 目录变化 → 重载 sources 并广播给该 workspace 所有会话；
   * - labels.json / statuses.json / automations.json 变化 → 广播给 UI；
   * - session.jsonl 头变化 → 检测外部编辑（多设备同步 / 手动修改）并同步内存态。
   *
   * 注意：每个 workspace 只创建一个 watcher；幂等，重复调用直接返回。
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // 检查是否已在监视此工作区
    if (this.configWatchers.has(workspaceRootPath)) {
      return // 已在监视此工作区
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // 广播更新后的源列表，以便侧边栏获取指南更改
        // 注意：指南更改不需要重新加载会话源（无服务器更改）
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // 通过 AutomationSystem 发出 LabelConfigChange 事件
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(`[Automations] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onAutomationsConfigChange: () => {
        sessionLog.info(`Automations config changed in ${workspaceId}`)
        // 通过 AutomationSystem 重新加载自动化配置
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`)
          } else {
            sessionLog.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors)
          }
        }
        // 通知渲染器重新读取 automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onLlmConnectionsChange: () => {
        sessionLog.info(`LLM connections changed in ${workspaceId}`)
        this.broadcastLlmConnectionsChanged()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // 向 UI 广播更新后的列表
        const { loadAllSkills } = await import('@craft-agent/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // 会话元数据更改（对 session.jsonl 头的编辑）。
      // 检测来自内部写入（自身）和外部源的更改
      // （其他实例、脚本、手动编辑）。
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // 检查这是否是我们自己的写入通过 fs.watch() 回显。
        // 自身写入不需要内存同步（已经是最新的），但
        // 仍然需要通知自动化系统进行事件匹配。
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature = sessionPersistenceQueue.getLastWrittenSignature(sessionId)
        const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature)

        // 对于外部写入：同步内存状态 + 发出 UI 事件。
        // 跳过自身写入以避免反馈循环（尤其是在 Windows 上
        // fs.watch 触发频繁：unlink + rename = 2+ 个事件）。
        if (!isSelfWrite) {
          // 在以下情况下延迟外部元数据应用：
          // 1. 会话正在积极处理中（代理正在运行），或者
          // 2. 会话刚刚通过编程方式写入（set_session_status/labels 工具）
          //    — fs.watch 在原子写入（unlink+rename）期间触发，可能读到过期数据
          const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`)
            } else {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (processing active)`)
            }
          } else {
            this.applyExternalSessionMetadata(managed, header)
          }
        }

        // 始终通知自动化系统——它自己会做差异比较，并且需要
        // 同时看到自身写入和外部变更，以便进行事件匹配。
        const automationSystem = this.automationSystems.get(managed.workspace.rootPath)
        if (automationSystem) {
          automationSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: header.labels,
            isFlagged: header.isFlagged,
            sessionStatus: header.sessionStatus,
            sessionName: header.name,
          }).catch((error) => {
            sessionLog.error(`[Automations] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // 为此工作空间初始化 AutomationSystem（包含调度器、处理器和事件日志）
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: async (prompts) => {
          // 通过创建新会话来执行提示词自动化
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptAutomation({
                workspaceId,
                workspaceRootPath,
                prompt: pending.prompt,
                labels: pending.labels,
                permissionMode: pending.permissionMode,
                mentions: pending.mentions,
                llmConnection: pending.llmConnection,
                model: pending.model,
                thinkingLevel: pending.thinkingLevel,
                automationName: pending.automationName,
                telegramTopic: pending.telegramTopic,
              })
            )
          )

          // 写入增强后的历史记录条目（包含会话 ID 和提示词摘要）
          for (const [idx, result] of settled.entries()) {
            const pending = prompts[idx]
            if (!pending.matcherId) continue

            const entry = createPromptHistoryEntry({
              matcherId: pending.matcherId,
              ok: result.status === 'fulfilled',
              sessionId: result.status === 'fulfilled' ? result.value.sessionId : undefined,
              prompt: pending.prompt,
              error: result.status === 'rejected' ? String(result.reason) : undefined,
            })

            appendAutomationHistoryEntry(workspaceRootPath, entry).catch(e => sessionLog.warn('[Automations] Failed to write history:', e))

            if (result.status === 'rejected') {
              sessionLog.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, result.reason)
            } else {
              sessionLog.info(`[Automations] Created session ${result.value.sessionId} from prompt action`)
            }
          }
        },
        onError: (event, error) => {
          sessionLog.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      sessionLog.info(`Initialized AutomationSystem for workspace ${workspaceId}`)
    }
  }

  /**
   * 手动通知 ConfigWatcher 文件已变更。
   * 解决 Bun 的 fs.watch 在 Linux 上无法检测原子重命名的问题。
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  /**
   * 重新加载工作空间中所有会话的源，跳过正在处理的会话。
   */
  private async reloadSourcesForWorkspace(workspaceRootPath: string): Promise<void> {
    for (const [_, managed] of this.sessions) {
      if (managed.workspace.rootPath === workspaceRootPath) {
        if (managed.isProcessing) {
          sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
          continue
        }
        await this.reloadSessionSources(managed)
      }
    }
  }

  private broadcastSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    if (!this.eventSink) return
    this.eventSink(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
  }

  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAutomationsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAppThemeChanged(theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastLlmConnectionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting LLM connections changed')
    this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
  }

  private broadcastSkillsChanged(workspaceId: string, skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  private broadcastDefaultPermissionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting default permissions changed')
    this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
  }

  /**
   * 为拥有活跃 agent 的会话重新加载源。
   * 由 ConfigWatcher 在源文件磁盘变更时调用。
   * 如果 agent 为 null（会话尚未发送任何消息），则跳过——下次消息发送时会进行全新构建。
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return  // 没有 agent = 无需更新（下次消息发送时全新构建）

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // 从磁盘重新加载所有源（craft-agents-docs 始终作为 MCP 服务器可用）
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // 为会话启用的源重新构建 MCP 和 API 服务器
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // 传入会话路径，以便大型 API 响应可以保存到会话文件夹中
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    // 更新 bridge-mcp-server 的配置/凭据，供需要它们的后端使用
    await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source reload', managed.poolServer?.url)

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * 重新初始化认证环境变量。
   * 在完成引导或设置变更后调用，以获取新的凭据。
   *
   * 安全说明：这些环境变量通过 options.ts 传播到 SDK 子进程。
   * 子进程中禁用了 Bun 的自动 .env 加载（--env-file=/dev/null），
   * 以防止用户项目的 .env 注入 ANTHROPIC_API_KEY 并覆盖 OAuth 认证——
   * 当两者都设置时，Claude Code 优先使用 API key 而非 OAuth token。
   * 参见：https://github.com/lukilabs/craft-agents-oss/issues/39
   */
  /**
   * 重新初始化认证环境变量。
   *
   * 使用默认的 LLM 连接来决定设置哪些凭据。
   *
   * @param connectionSlug - 可选的连接标识（覆盖默认连接）
   */
  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    try {
      const manager = getCredentialManager()

      // 获取要使用的连接（显式参数或默认连接）
      const slug = connectionSlug || getDefaultLlmConnection()
      if (!slug) {
        sessionLog.warn('No LLM connection slug available for reinitializeAuth')
      }
      const connection = slug ? getLlmConnection(slug) : null

      // 在应用此连接之前，将受管理的认证环境变量恢复为基线值。
      resetManagedAnthropicAuthEnvVars()

      if (!connection) {
        sessionLog.error(`No LLM connection found for slug: ${slug}`)
        resetSummarizationClient()
        return
      }

      sessionLog.info(`Reinitializing auth for connection: ${slug} (${connection.authType})`)

      // 通过共享工具解析认证环境变量（与提供商无关）
      const result = await resolveAuthEnvVars(connection, slug!, manager, getValidClaudeOAuthToken)

      if (!result.success) {
        sessionLog.error(`Auth resolution failed for ${slug}: ${result.warning}`)
      } else {
        // 将解析后的环境变量应用到 process.env
        for (const [key, value] of Object.entries(result.envVars)) {
          process.env[key] = value
        }
        sessionLog.info(`Auth env vars set for connection: ${slug}`)
      }

      // 重置缓存的摘要客户端，使其获取新的凭据/基础 URL
      resetSummarizationClient()
    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async initialize(): Promise<void> {
    try {
      // 回填现有 LLM 连接上缺失的 `models` 数组
      migrateLegacyLlmConnectionsConfig()

      // 修复指向不存在连接的 defaultLlmConnection
      migrateOrphanedDefaultConnections()

      // 将旧版凭据迁移为 LLM 连接格式（一次性迁移）
      // 确保在 LLM 连接之前保存的凭据可以通过新系统使用
      await migrateLegacyCredentials()

      // 设置认证环境变量（对 SDK 正常工作至关重要）
      await this.reinitializeAuth()

      // 主动为每个工作空间激活 ConfigWatcher + AutomationSystem，以便
      // 调度器和事件处理器在启动时就开始运行——而不是等到首次
      // 客户端连接时才惰性启动。这对于无头服务器至关重要，因为可能永远没有 UI
      // 连接，但定时/事件驱动的自动化仍需触发。
      const workspaces = getWorkspaces()
      for (const workspace of workspaces) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
      }

      // 从磁盘加载现有会话
      this.loadSessionsFromDisk()

      // 发出初始化完成的信号——等待 initGate 的 IPC 处理器将开始执行
      this.initGate.markReady()
    } catch (error) {
      this.initGate.markFailed(error)
      throw error
    }
  }

  // 从磁盘将所有现有会话加载到内存中（仅元数据——消息是惰性加载的）
  private loadSessionsFromDisk(): void {
    try {
      const workspaces = getWorkspaces()
      let totalSessions = 0

      // 遍历每个工作空间并加载其会话
      for (const workspace of workspaces) {
        const workspaceRootPath = workspace.rootPath
        const sessionMetadata = listStoredSessions(workspaceRootPath)
        // 每个工作空间加载一次工作空间配置，以获取默认工作目录
        const wsConfig = loadWorkspaceConfig(workspaceRootPath)
        const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory

        for (const meta of sessionMetadata) {
          // 仅从元数据创建受管会话（消息按需惰性加载）
          // 这大大减少了启动时的内存使用——消息仅在
          // 调用 getSession() 获取特定会话时才会加载
          const managed = createManagedSession(meta, workspace, {
            // header 携带了 session 的显式 source 选择（在创建时 / setSessionSources 时持久化）。
            // 现在就注入，让渲染器的第一个 session 列表就显示正确的 chip ——
            // 没有 source 选择的 session 会在加载消息时注入任何 legacy body 值（见 hydrateMessagesForColdPersist）。
            enabledSourceSlugs: meta.enabledSourceSlugs,
            workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
          })

          // 迁移：清除孤立的 llmConnection 引用（例如，在连接被删除后）
          if (managed.llmConnection) {
            const conn = resolveSessionConnection(managed.llmConnection, undefined)
            if (!conn) {
              sessionLog.warn(`Session ${meta.id} has orphaned llmConnection "${managed.llmConnection}", clearing`)
              managed.llmConnection = undefined
              managed.connectionLocked = false
            }
          }

          // 即使在创建 agent 之前，也为恢复的会话初始化 mode-manager 状态。
          // 这确保诊断/有效模式与持久化的会话元数据保持一致。
          setPermissionMode(meta.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
          if (managed.previousPermissionMode) {
            hydratePreviousPermissionMode(meta.id, managed.previousPermissionMode)
          }

          this.sessions.set(meta.id, managed)

          // 在 AutomationSystem 中初始化会话元数据，用于差异比较
          const automationSystem = this.automationSystems.get(workspaceRootPath)
          if (automationSystem) {
            automationSystem.setInitialSessionMetadata(meta.id, {
              permissionMode: meta.permissionMode,
              labels: meta.labels,
              isFlagged: meta.isFlagged,
              sessionStatus: meta.sessionStatus,
              sessionName: managed.name,
            })
          }

          totalSessions++
        }
      }

      sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`)
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  // 在我们自己的原子写入完成的时间窗口内，抑制 fs.watch 的元数据恢复事件。
  // 参见 onSessionMetadataChange。
  private setMetadataWriteGuard(managed: ManagedSession): void {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS
  }

  /**
   * 将会话持久化到磁盘（异步，在持久化队列中带有去抖）。
   *
   * 冷会话路径：如果消息尚未惰性加载，则先从 JSONL 同步加载它们——
   * 否则我们入队的快照会用 `messages: []` 覆盖磁盘上的真实消息。
   * 加载故意不触及持久化元数据字段（name, labels, sessionStatus, llmConnection, ...），
   * 因为调用者可能刚刚修改了它们；内存中的变更必须优先于磁盘上的数据。
   * `loadStoredSession` 是同步的（同步 fs 读取），因此整个路径保持同步——
   * 在加载和入队之间没有微任务竞态窗口。
   */
  private persistSession(managed: ManagedSession): void {
    if (!managed.messagesLoaded) {
      this.hydrateMessagesForColdPersist(managed)
    }
    this.enqueuePersist(managed)
  }

  // 冷持久化加载。镜像了 loadMessagesFromDisk 的消息/队列恢复部分，
  // 但跳过了元数据字段同步。设置
  // messagesLoaded=true，以便后续的 persistSession 调用走快速路径。
  // 后续的 ensureMessagesLoaded 调用也会短路，这没问题——
  // 队列恢复已经在这里执行过了。
  private hydrateMessagesForColdPersist(managed: ManagedSession): void {
    sessionLog.debug(`Cold-load triggered for persistSession on ${managed.id}`)
    const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (stored) {
      managed.messages = (stored.messages || []).map(storedToMessage)
      managed.tokenUsage = stored.tokenUsage
      // 延迟加载的字段（启动后有意为 undefined，参见
      // loadSessionsFromDisk）。仅当内存中尚未设置时，才从磁盘填充——
      // 调用者可能已通过 setSessionSources 等方法修改了它们。
      if (managed.enabledSourceSlugs === undefined) managed.enabledSourceSlugs = stored.enabledSourceSlugs
      if (managed.lastReadMessageId === undefined) managed.lastReadMessageId = stored.lastReadMessageId
      if (managed.hasUnread === undefined) managed.hasUnread = stored.hasUnread
      if (managed.sharedUrl === undefined) managed.sharedUrl = stored.sharedUrl
      if (managed.sharedId === undefined) managed.sharedId = stored.sharedId
      if (managed.transferredSessionSummary === undefined) managed.transferredSessionSummary = stored.transferredSessionSummary
      if (managed.transferredSessionSummaryApplied === undefined) managed.transferredSessionSummaryApplied = stored.transferredSessionSummaryApplied

      // 队列恢复：查找因崩溃/重启而遗留的孤立排队消息，并重新入队。
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,
            storedAttachments: msg.attachments,
            options: undefined,
          })
        }
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
      sessionLog.debug(`Cold-hydrated ${managed.messages.length} messages for session ${managed.id}`)
    }
    managed.messagesLoaded = true
  }

  // 构建 StoredSession 快照并将其交给持久化队列。
  // 调用者必须确保 `managed.messagesLoaded` 为 true。
  private enqueuePersist(managed: ManagedSession): void {
    try {
      // 过滤掉瞬态状态消息（进度指示器，如“压缩中...”）
      // 错误消息现在使用丰富的字段进行持久化，以便诊断
      const persistableMessages = managed.messages.filter(m =>
        m.role !== 'status'
      )

      const storedSession: StoredSession = {
        ...pickSessionFields(managed),
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession

      // 加入异步持久化队列（带去抖）
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
  }

  // 立即刷新特定会话（在会话关闭/切换时调用）。
  // 冷持久化加载是同步的，因此当我们到达这里时，
  // 只要刚刚调用了 persistSession，队列中就已经有一个条目。
  async flushSession(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  // 刷新所有待处理的会话（在应用退出时调用）。
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  // ============================================
  // 统一认证请求辅助函数
  // ============================================

  /**
   * 获取认证请求的人类可读描述
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * 格式化要发送回 agent 的认证结果消息
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }


  /**
   * 完成认证请求并将结果发送回 agent
   * 这会更新认证消息状态并发送一条伪造的用户消息
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    // 查找并更新待处理的认证请求消息
    const authMessage = managed.messages.find(m =>
      m.role === 'auth-request' &&
      m.authRequestId === result.requestId &&
      m.authStatus === 'pending'
    )

    if (authMessage) {
      authMessage.authStatus = result.success ? 'completed' :
                               result.cancelled ? 'cancelled' : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // 触发 auth_completed 事件以更新 UI
    this.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    }, managed.workspace.id)

    // 创建包含结果的伪造用户消息
    const resultContent = this.formatAuthResultMessage(result)

    // 清除待处理的认证状态
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // 认证成功后，在会话中自动启用该源
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        sessionLog.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`)
      }

      // 清除任何刷新冷却时间，以便该源立即可用
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // 使用更新后的认证消息和已启用的源持久化会话
    this.persistSession(managed)

    // 更新 bridge-mcp-server 的配置/凭据，供需要它们的后端使用
    if (result.success && result.sourceSlug && managed.agent) {
      const workspaceRootPath = managed.workspace.rootPath
      const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(workspaceRootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )
      const { mcpServers } = await buildServersFromSources(
        enabledSources, sessionPath, managed.tokenRefreshManager
      )
      await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source auth', managed.poolServer?.url)
    }

    // 将结果作为新消息发送，以恢复对话
    // 由于这是系统生成的消息，附件使用空数组
    await this.sendMessage(sessionId, resultContent, [], [], {})

    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * 处理来自 UI 的凭据输入（用于非 OAuth 认证）
   * 当用户通过内联表单提交凭据时调用
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // 使用现有的工作空间 ID 提取模式存储凭据
      const credManager = getCredentialManager()
      // 从根路径提取工作空间 ID（路径的最后一段）
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // 将值存储为 JSON 字符串 {username, password}——credential-manager.ts 会解析它以进行基本认证
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        // 将多标头凭据存储为 JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify(response.headers) }
        )
      } else {
        // header 或 query——两者都使用 API key 存储
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // 更新源配置以标记为已认证
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // 将源标记为未读，以便在下一条消息时注入新的指南
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath, createdAt, ...info }) => info)
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem) return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // 如果系统是使用 enableScheduler 创建的，则 SchedulerService 正在运行
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  /**
   * 从磁盘重新加载所有会话。
   * 在导入会话后使用，以刷新内存中的会话列表。
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // 仅返回会话元数据——不包含消息以节省内存
    // 使用 getSession(id) 加载特定会话的消息
    let sessions = Array.from(this.sessions.values())

    // 如果指定了工作空间，则按工作空间过滤（在切换工作空间时使用）
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => managedToSession(m))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  /**
   * 聚合所有工作空间的未读状态。
   * 从计数/指示器中排除隐藏和归档的会话。
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
    }
  }

  /**
   * 根据当前未读状态刷新徽章计数。
   * 由渲染器在挂载时调用——确保即使在初始的
   * emitUnreadSummaryChanged() 在渲染器就绪之前触发，徽章也能被设置。
   */
  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)
  }

  /**
   * 向所有工作空间窗口广播全局未读摘要。
   */
  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()

    // 通过运行时钩子更新徽章——宿主决定是否以及如何渲染徽章
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)

    if (!this.eventSink) return

    // 广播给渲染器以更新 UI（会话列表圆点等）
    this.eventSink(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED, { to: 'all' }, summary)
  }

  /**
   * 通过 ID 获取单个会话，并加载所有消息。
   * 用于在选中会话时惰性加载会话消息。
   * 消息在首次访问时从磁盘加载，以减少内存使用。
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // 如果尚未加载，则从磁盘惰性加载消息
    await this.ensureMessagesLoaded(m)

    return managedToSession(m, { messages: m.messages })
  }

  /**
   * 确保受管会话的消息已加载。
   * 使用 Promise 去重来防止当多个并发调用（例如，快速切换会话 + 发送消息）
   * 同时尝试加载消息时出现竞态条件。
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    // 去重并发加载——如果正在加载中，则返回现有的 promise
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * 内部：从磁盘存储加载消息到受管会话。
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // 用于 NEW 徽章状态机的显式未读标志
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      // 从磁盘同步名称——确保在惰性加载后标题持久化
      managed.name = storedSession.name
      // 恢复 LLM 连接状态——确保在恢复时使用正确的提供商
      if (storedSession.llmConnection) {
        managed.llmConnection = storedSession.llmConnection
      }
      if (storedSession.connectionLocked) {
        managed.connectionLocked = storedSession.connectionLocked
      }
      // 从磁盘同步已转移的会话摘要状态
      managed.transferredSessionSummary = storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied
      sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)

      // 队列恢复：查找因崩溃/重启而遗留的孤立排队消息，并重新入队
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,  // 附件已存储在磁盘上
            storedAttachments: msg.attachments,
            options: undefined,
          })
        }
        // 当会话变为活跃时处理队列（将在第一条消息或交互时触发）
        // 使用 setImmediate 以避免阻塞加载，并让会话状态稳定下来
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
    }
    managed.messagesLoaded = true
  }

  /**
   * 获取会话文件夹的文件系统路径
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  async createSession(
    workspaceId: string,
    options?: import('@craft-agent/shared/protocol').CreateSessionOptions,
    // Transport concern, deliberately NOT on the wire DTO: by default every created session is
    // announced to the renderer (see notifySessionCreated). Callers that register the session
    // themselves — the `sessions:create` RPC adds it from the return value — pass
    // `{ emitCreatedEvent: false }` to avoid a redundant hydrate.
    internal?: { emitCreatedEvent?: boolean },
  ): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // 从工作空间配置获取新会话默认值（带有全局回退）
    // Options.permissionMode 覆盖工作空间默认值（由 EditPopover 用于自动执行）
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const globalDefaults = loadConfigDefaults()

    // 从工作空间配置读取权限模式，回退到全局默认值
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    // 以调用者优先的顺序解析思考级别，与上面的 permissionMode 一致：
    //   调用者覆盖 → 工作区默认 → 全局默认。
    // normalizeThinkingLevel() 能容忍 undefined/unknown 输入。
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel)
      ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
      ?? getDefaultThinkingLevel()
    // 从工作区配置获取默认模型（当未设置会话特定模型时使用）
    const defaultModel = wsConfig?.defaults?.model
    // 从工作区配置获取默认启用的数据源
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // 将模型层级提示（'fast' / 'default'）解析为实际的模型 ID。
    // EditPopover 使用层级提示而非硬编码的 Anthropic 模型名称
    // 以便无论当前使用哪个 LLM 提供商，都能选择正确的模型。
    let resolvedModelOption = options?.model || defaultModel
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierConnection = resolveSessionConnection(
        options?.llmConnection,
        wsConfig?.defaults?.defaultLlmConnection,
      )
      if (tierConnection) {
        resolvedModelOption = resolvedModelOption === 'fast'
          ? (getMiniModel(tierConnection) ?? tierConnection.defaultModel ?? defaultModel)
          : (tierConnection.defaultModel ?? defaultModel)
      } else {
        resolvedModelOption = defaultModel
      }
    }

    // 提前解析后端目标，用于分支策略检查。
    const targetBackendContext = resolveBackendContext({
      sessionConnectionSlug: options?.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: resolvedModelOption,
    })
    const targetProviderType = targetBackendContext.connection?.providerType
      ?? (targetBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
    const targetPiAuthProvider = targetBackendContext.connection?.piAuthProvider

    // 从选项中解析工作目录：
    // - 'user_default' 或 undefined：使用工作区配置的默认值
    // - 'none'：无工作目录（空字符串表示仅会话文件夹）
    // - 绝对路径：按原样使用
    let resolvedWorkingDir: string | undefined
    if (options?.workingDirectory === 'none') {
      resolvedWorkingDir = undefined  // 无工作目录
    } else if (options?.workingDirectory === 'user_default' || options?.workingDirectory === undefined) {
      resolvedWorkingDir = userDefaultWorkingDir
    } else {
      resolvedWorkingDir = options.workingDirectory
    }

    // 解析项目绑定。当提供了 projectId 且该项目配置了 workingDirectory 时，
    // 继承它（仅当调用方没有传入显式覆盖时）。这样"+ 在 {project} 中新建 session"
    // 就能复用项目绑定的目录，而无需在渲染器侧重复逻辑。
    // 子任务在调用方没有显式绑定时继承父任务的项目 —— 项目绑定的任务的子任务属于该项目
    //（看板快速添加不传 projectId），因此项目级过滤能看到整个任务家族。
    const inheritedProjectId = options?.parentSessionId
      ? this.sessions.get(options.parentSessionId)?.projectId
      : undefined
    const requestedProjectId = options?.projectId ?? inheritedProjectId
    let resolvedProjectId: string | undefined
    if (requestedProjectId) {
      const { loadProjectById } = await import('@craft-agent/shared/projects')
      const project = loadProjectById(workspaceRootPath, requestedProjectId)
      if (!project) {
        // 显式绑定到一个不存在的项目是调用方的 bug；继承的绑定
        //（父任务的项目后来被删除）则直接跳过，而不是让子任务失败。
        if (options?.projectId) {
          throw new Error(`Project ${options.projectId} not found in workspace ${workspaceId}`)
        }
      } else {
        resolvedProjectId = project.config.id
        if (
          (options?.workingDirectory === undefined || options?.workingDirectory === 'user_default') &&
          project.config.workingDirectory
        ) {
          resolvedWorkingDir = project.config.workingDirectory
        }
      }
    }

    // 预先验证分支请求，确保分支元数据仅设置在有效的分支上。
    // 这防止创建声称已分支但没有复制历史记录的会话。
    let validatedBranch: {
      sourceSessionId: string
      sourceMessageId: string
      sourceSession: StoredSession
      branchIdx: number
      branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session'
      branchFromSdkSessionId?: string
      branchFromSessionPath?: string
      branchFromSdkCwd?: string
      branchFromSdkTurnId?: string
      sourceProvider?: 'anthropic' | 'pi'
    } | undefined

    if (options?.branchFromSessionId || options?.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        sessionLog.warn('Branch validation failed: missing branchFromSessionId or branchFromMessageId', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged) {
        if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
          sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
            workspaceId,
            targetWorkspaceRootPath: workspaceRootPath,
            sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
            branchFromSessionId: options.branchFromSessionId,
          })
          throw new Error('Invalid branch request: source session belongs to a different workspace')
        }

        // 将源会话刷新到磁盘，确保分支复制时可获取最新的消息列表。
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(workspaceRootPath, options.branchFromSessionId)
      if (!sourceSession) {
        sessionLog.warn('Branch validation failed: source session not found on disk', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
        })
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }

      const sourceBackendContext = resolveBackendContext({
        sessionConnectionSlug: sourceManaged?.llmConnection || sourceSession.llmConnection,
        workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType = sourceBackendContext.connection?.providerType
        ?? (sourceBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
      const sourcePiAuthProvider = sourceBackendContext.connection?.piAuthProvider

      const providerMismatch = sourceBackendContext.provider !== targetBackendContext.provider
      const providerTypeMismatch = sourceProviderType !== targetProviderType
      const piAuthProviderMismatch =
        sourceBackendContext.provider === 'pi' && sourcePiAuthProvider !== targetPiAuthProvider

      if (providerMismatch || providerTypeMismatch || piAuthProviderMismatch) {
        sessionLog.warn('Branch validation failed: source and target providers are incompatible', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          sourceProviderType,
          sourcePiAuthProvider,
          targetProvider: targetBackendContext.provider,
          targetProviderType,
          targetPiAuthProvider,
        })
        throw new Error('Branching is only supported within the same provider/backend. Switch this panel connection and try again.')
      }

      const branchIdx = sourceSession.messages.findIndex(m => m.id === options.branchFromMessageId)
      if (branchIdx === -1) {
        sessionLog.warn('Branch validation failed: message not found in source session', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }

      // 新分支始终使用严格的提供商级 SDK fork 语义。
      // Seeded 模式仅保留给在强制严格 fork 之前创建的旧会话。
      const branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session' = 'sdk-fork'

      const branchFromSdkSessionId = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkSessionId || sourceSession.sdkSessionId)
        : undefined
      const branchFromSessionPath = branchContextStrategy === 'sdk-fork'
        ? getSessionStoragePath(workspaceRootPath, options.branchFromSessionId)
        : undefined
      // 捕获父进程的 sdkCwd，以便子 SDK 子进程能找到父进程的
      // 会话文件（存储在 ~/.claude/projects/{cwd-hash}/ 下）。
      const branchFromSdkCwd = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkCwd || sourceSession.sdkCwd)
        : undefined

      // 分支点处的提供商原生分支锚点。
      // - Claude：assistant 消息 UUID（resumeSessionAt），但仅当锚点谱系
      //   与正在恢复的父 SDK 会话匹配时。
      // - Pi：从 sidecar（pi-turn-anchors.json）加载的会话条目 ID
      const branchMessage = sourceSession.messages[branchIdx]
      let branchFromSdkTurnId: string | undefined
      if (branchContextStrategy === 'sdk-fork') {
        if (sourceBackendContext.provider === 'pi') {
          if (branchFromSessionPath) {
            branchFromSdkTurnId = await getPiTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!branchFromSdkTurnId) {
              sessionLog.warn('Pi branch anchor missing: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            }
          }
        } else if (sourceBackendContext.provider === 'anthropic') {
          if (branchFromSessionPath && branchFromSdkSessionId) {
            const anchor = await getClaudeTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!anchor) {
              sessionLog.warn('Claude branch anchor missing: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            } else if (!anchor.sdkMessageUuid || !isClaudeMessageUuid(anchor.sdkMessageUuid)) {
              sessionLog.warn('Claude branch anchor malformed: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
              })
            } else if (anchor.sdkSessionId !== branchFromSdkSessionId) {
              sessionLog.warn('Claude branch anchor lineage mismatch: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
                parentSdkSessionId: branchFromSdkSessionId,
              })
            } else {
              branchFromSdkTurnId = anchor.sdkMessageUuid
            }
          }
        } else {
          branchFromSdkTurnId = branchMessage?.turnId
        }
      }

      if (branchContextStrategy === 'sdk-fork' && !branchFromSdkSessionId) {
        sessionLog.warn('Branch validation failed: sdk-fork requires parent SDK session ID', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          targetProvider: targetBackendContext.provider,
        })
        throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.')
      }

      validatedBranch = {
        sourceSessionId: options.branchFromSessionId,
        sourceMessageId: options.branchFromMessageId,
        sourceSession,
        branchIdx,
        branchContextStrategy,
        branchFromSdkSessionId,
        branchFromSessionPath,
        branchFromSdkCwd,
        branchFromSdkTurnId,
        sourceProvider: sourceBackendContext.provider,
      }

      sessionLog.info('Branch validation succeeded', {
        workspaceId,
        branchFromSessionId: validatedBranch.sourceSessionId,
        branchFromMessageId: validatedBranch.sourceMessageId,
        branchContextStrategy: validatedBranch.branchContextStrategy,
        branchFromSdkSessionId: !!validatedBranch.branchFromSdkSessionId,
        copiedMessageCount: validatedBranch.branchIdx + 1,
      })
    }

    // 使用存储层创建并持久化会话
    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      hidden: options?.hidden,
      sessionStatus: options?.sessionStatus,
      labels: options?.labels,
      isFlagged: options?.isFlagged,
      projectId: resolvedProjectId,
      parentSessionId: options?.parentSessionId,
      taskSlug: options?.taskSlug,
      taskRunId: options?.taskRunId,
      taskNodeId: options?.taskNodeId,
      taskDraft: options?.taskDraft,
      // Persist only an EXPLICIT selection (e.g. a task's spec.sources on its subtasks).
      // The workspace-default fallback stays dynamic — freezing it into the header would
      // pin every ordinary session to the defaults as of its creation time.
      enabledSourceSlugs: options?.enabledSourceSlugs,
    })

    // 分支：从源会话复制消息，直到并包括分支点
    if (validatedBranch) {
      const branchedStored = loadStoredSession(workspaceRootPath, storedSession.id)
      if (!branchedStored) {
        throw new Error(`Failed to load newly created session ${storedSession.id} for branch copy`)
      }

      const sourceMessages = validatedBranch.sourceSession.messages.slice(0, validatedBranch.branchIdx + 1)

      // 重新映射嵌入的路径：源消息是使用 expandSessionPath(sourceDir) 加载的，
      // 因此它们包含指向*源*会话目录的绝对路径。当保存到
      // 分支会话时，makeSessionPathPortable 使用*分支*目录——这会导致不匹配。
      // 修复：将源目录路径替换为分支目录路径，以便保存时 tokenization 正常工作。
      const sourceDir = normalizePath(getSessionStoragePath(workspaceRootPath, validatedBranch.sourceSessionId))
      const branchDir = normalizePath(getSessionStoragePath(workspaceRootPath, storedSession.id))
      if (sourceDir !== branchDir) {
        branchedStored.messages = sourceMessages.map(m => {
          const json = JSON.stringify(m)
          if (!json.includes(sourceDir)) return m
          return JSON.parse(json.replaceAll(sourceDir, branchDir)) as StoredMessage
        })
      } else {
        branchedStored.messages = sourceMessages
      }

      branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
      if (validatedBranch.branchContextStrategy === 'sdk-fork') {
        branchedStored.branchFromSdkSessionId = validatedBranch.branchFromSdkSessionId
        branchedStored.branchFromSessionPath = validatedBranch.branchFromSessionPath
        branchedStored.branchFromSdkCwd = validatedBranch.branchFromSdkCwd
        branchedStored.branchFromSdkTurnId = validatedBranch.branchFromSdkTurnId
      } else {
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
      }
      await saveStoredSession(branchedStored)

      // 将 Pi 的 turn-anchor sidecar 传播到分支中，以便下游
      // 分支仍然可以解析从此处复制的消息的锚点。
      // 没有这一步，分支的分支会静默回退到
      // 全历史 fork——参见 craft-agents-oss#782。
      if (
        validatedBranch.branchContextStrategy === 'sdk-fork' &&
        validatedBranch.sourceProvider === 'pi'
      ) {
        try {
          await copyPiTurnAnchorsForBranch(
            sourceDir,
            branchDir,
            branchedStored.messages.map((m) => m.id),
          )
        } catch (err) {
          sessionLog.warn('Failed to copy Pi turn-anchors sidecar to branch', {
            err,
            sourceSessionId: validatedBranch.sourceSessionId,
            branchSessionId: storedSession.id,
          })
        }
      }
    }

    // 使用与提供商无关的后端解析器解析连接/提供商/认证/模型。
    // 重用预先计算的目标上下文，使分支验证和会话构建共享相同的目标标识。
    const resolvedContext = targetBackendContext
    const resolvedModel = resolvedContext.resolvedModel

    // 记录迷你 agent 会话创建
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`)
    }

    const isBranch = !!validatedBranch

    const managed = createManagedSession(storedSession, workspace, {
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      model: resolvedModel,
      llmConnection: options?.llmConnection,
      thinkingLevel: defaultThinkingLevel,
      systemPromptPreset: options?.systemPromptPreset,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchFromSdkSessionId: validatedBranch?.branchFromSdkSessionId,
      branchFromSessionPath: validatedBranch?.branchFromSessionPath,
      branchFromSdkCwd: validatedBranch?.branchFromSdkCwd,
      branchFromSdkTurnId: validatedBranch?.branchFromSdkTurnId,
      branchSeedApplied: validatedBranch ? validatedBranch.branchContextStrategy === 'sdk-fork' : undefined,
      messagesLoaded: !isBranch,  // 分支会话：从 JSONL 惰性加载消息
    })

    // 为分支会话急切加载消息，以便渲染器能立即获取完整的
    // 对话内容（面板打开时滚动到底部所需）
    if (isBranch) {
      await this.ensureMessagesLoaded(managed)

      const requiresBranchPreflight = managed.branchContextStrategy === 'sdk-fork'
      if (requiresBranchPreflight) {
        // 在创建时强制执行分支正确性。
        // 分支仅在当前能建立后端上下文时才有效，
        // 而不是推迟到第一条用户消息。
        try {
          await this.getOrCreateAgent(managed)
          await managed.agent!.ensureBranchReady()
        } catch (error) {
          sessionLog.warn('Branch creation failed during backend preflight handshake', {
            workspaceId,
            sessionId: storedSession.id,
            branchFromSessionId: validatedBranch?.sourceSessionId,
            branchFromMessageId: validatedBranch?.sourceMessageId,
            branchContextStrategy: managed.branchContextStrategy,
            error: error instanceof Error ? error.message : String(error),
          })

          await rollbackFailedBranchCreation({
            managed,
            workspaceRootPath,
            sessionId: storedSession.id,
            deleteFromRuntimeSessions: (id) => {
              const m = this.sessions.get(id)
              if (m?.autoRetryTimer) {
                clearTimeout(m.autoRetryTimer)
                m.autoRetryTimer = undefined
              }
              if (m) m.autoRetryPending = undefined
              this.sessions.delete(id)
            },
            deleteStoredSession,
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    // 立即初始化 mode-manager 状态，以避免在 agent 实例
    // 被惰性创建之前出现 UI/执行竞争。
    setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(storedSession.id, managed.previousPermissionMode)
    }

    this.sessions.set(storedSession.id, managed)

    // 在 AutomationSystem 中初始化会话元数据以进行差异比较
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(storedSession.id, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Reserved "Task" label: task flows opt in so the tile (and its subtasks, which inherit the
    // parent's number) are filterable as tasks from the moment they exist. Applied before the
    // created-event so the renderer hydrates the label with the rest of the metadata. Fail-soft:
    // a label problem must never abort session creation.
    if (options?.applyTaskLabel) {
      try {
        await this.applyTaskLabel(storedSession.id, { parentSessionId: options?.parentSessionId })
      } catch (error) {
        sessionLog.warn('Failed to apply Task label to new session', {
          sessionId: storedSession.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Announce by default so the renderer hydrates full metadata (name, parentSessionId, …)
    // instead of fabricating a titleless "New Chat" from the first streamed event. Emitted at
    // the very end so a thrown branch-preflight failure above never announces an orphan.
    if (internal?.emitCreatedEvent !== false) {
      this.notifySessionCreated(workspaceId, storedSession.id)
    }

    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined)
  }

  /**
   * Announce a session to the renderer so it hydrates full metadata (name, parentSessionId, …)
   * instead of fabricating a "New Chat" placeholder from the first streamed event.
   *
   * `createSession` calls this by default, so server-side creators get it for free. Use it
   * directly only for sessions built outside `createSession` (e.g. the SessionBundle import
   * path, which assembles a ManagedSession by hand). The renderer handler is idempotent.
   */
  notifySessionCreated(workspaceId: string, sessionId: string): void {
    this.sendEvent({ type: 'session_created', sessionId }, workspaceId)
  }

  /** Resolved working directory of a live session (used by the Tasks Conductor so child
   *  sessions inherit the orchestrator's cwd). Undefined if the session has none or is unknown. */
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workingDirectory
  }

  private async disposeManagedAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    const sessionId = managed.id

    if (managed.agent) {
      try {
        if (managed.agent.disposeForRestart) {
          await managed.agent.disposeForRestart()
        } else {
          managed.agent.dispose()
        }
      } catch (error) {
        sessionLog.warn(`Failed to dispose agent for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.poolServer) {
      try {
        await managed.poolServer.stop()
      } catch (error) {
        sessionLog.warn(`Failed to stop pool server for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.mcpPool) {
      try {
        await managed.mcpPool.disconnectAll()
      } catch (error) {
        sessionLog.warn(`Failed to disconnect MCP pool for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    managed.agent = null
    managed.poolServer = undefined
    managed.mcpPool = undefined
    managed.envOverrides = undefined
    managed.agentReady = undefined
    managed.agentReadyResolve = undefined
    managed.backendRuntimeSignature = undefined
    managed.backendRestartSignature = undefined
    unregisterSessionScopedToolCallbacks(sessionId)
  }

  /**
   * 当会话的已解析连接签名与创建 agent 时的签名不一致时，就地刷新现有 agent 的运行时配置。
   * 如果 agent 不存在、签名仍然匹配或 agent 正在处理中（门控条件是 `agent.isProcessing()`——
   * 不使用 `managed.isProcessing`，因为 `sendMessage` 在调用 `getOrCreateAgent` 之前会翻转它，
   * 这会使每个发送路径的刷新成为死代码），则不执行任何操作。
   *
   * 并发控制：通过 `agentRefreshLocks` 实现每个会话的序列化。第二个调用者
   *（例如在 `SAVE` 刷新期间到达的 `sendMessage`）等待正在进行的刷新完成，
   * 然后从刷新后的状态重新评估——因此后续的 `agent.chat()` 仅在子进程应用了
   * 运行时更新（或 agent 已被销毁以重新创建）之后才发送。
   *
   * 该辅助函数区分两种漂移：
   *   - 需要重启（provider/auth/slug/piAuthProvider）：直接销毁并重新创建，
   *     因为 `update_runtime_config` 无法在运行的子进程中完全重新路由凭据/提供商状态。
   *   - 可原地安全更新（model/baseUrl/customEndpoint/customModels）：尝试
   *     `agent.updateRuntimeConfig`，如果后端无法应用更新，则回退到销毁。
   */
  private async tryRefreshAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    // 针对此会话上任何正在进行的刷新进行序列化。等待者
    // 不会传播先前调用的错误——这些错误会在
    // 原始调用点记录。
    const inflight = this.agentRefreshLocks.get(managed.id)
    if (inflight) {
      await inflight.catch(() => undefined)
    }

    if (!managed.agent) return

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      return
    }

    const restartRequired = managed.backendRestartSignature !== restartSignature
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature

    if (!restartRequired && !runtimeChanged) return

    if (managed.agent.isProcessing()) {
      sessionLog.info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`)
      return
    }

    const work = this.runAgentRuntimeRefresh(
      managed,
      backendContext,
      runtimeSignature,
      restartSignature,
      restartRequired,
      reason,
    )
    // 跟踪工作，以便并发调用者序列化。吞掉跟踪的 promise 上的错误——
    // 等待者不应得到其他人的异常；
    // 错误在 `runAgentRuntimeRefresh` 内部记录。
    const tracked = work.then(() => undefined, () => undefined)
    this.agentRefreshLocks.set(managed.id, tracked)
    try {
      await work
    } finally {
      // 并发调用者在到达此点之前已经等待了 `tracked`，
      // 并且每个都串行注册了自己的工作，因此当我们的工作解析时，
      // 该槽位始终由我们清除。
      if (this.agentRefreshLocks.get(managed.id) === tracked) {
        this.agentRefreshLocks.delete(managed.id)
      }
    }
  }

  private async runAgentRuntimeRefresh(
    managed: ManagedSession,
    backendContext: ReturnType<typeof resolveBackendContext>,
    runtimeSignature: string,
    restartSignature: string,
    restartRequired: boolean,
    reason: string,
  ): Promise<void> {
    if (restartRequired) {
      sessionLog.info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'restart-required runtime change')
      return
    }

    const connection = backendContext.connection
    let refreshed = false
    if (managed.agent?.updateRuntimeConfig) {
      try {
        refreshed = await managed.agent.updateRuntimeConfig({
          model: backendContext.resolvedModel,
          providerType: connection?.providerType,
          authType: backendContext.authType,
          runtime: connection ? {
            baseUrl: connection.baseUrl,
            piAuthProvider: connection.piAuthProvider,
            customEndpoint: connection.customEndpoint,
            customModels: connection.models?.map(model => {
              if (typeof model === 'string') return model
              const supportsImages = typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined
              if (model.contextWindow || supportsImages !== undefined) {
                return {
                  id: model.id,
                  ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                  ...(supportsImages !== undefined ? { supportsImages } : {}),
                }
              }
              return model.id
            }),
          } : undefined,
        })
      } catch (error) {
        sessionLog.warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (refreshed) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      sessionLog.info(`Refreshed runtime config for session ${managed.id} (${reason})`)
    } else {
      sessionLog.info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'runtime config refresh')
    }
  }

  /**
   * 将连接的运行时更新（例如 `supportsImages` 切换）推送到所有使用它的活动会话。
   * 从 `llmConnections.SAVE` 处理程序调用，以便能力变更能立即到达正在运行的 Pi 子进程，
   * 而不是等待下一次发送时惰性地发现签名漂移。
   */
  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    for (const managed of this.sessions.values()) {
      if (managed.llmConnection !== connectionSlug) continue
      try {
        await this.tryRefreshAgentRuntime(managed, 'connection update')
      } catch (error) {
        sessionLog.warn(`refreshConnectionRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * 懒加载/创建会话对应的 Agent 后端实例。
   *
   * 这是 Agent 子进程的“工厂方法”：
   * 1. 先根据签名判断当前 runtime config 是否漂移，需要热更新或重建；
   * 2. 解析 LLM connection（会话级 → workspace 默认 → 全局默认）；
   * 3. 第一次创建时锁定 connection（`connectionLocked = true`），并持久化；
   * 4. 构建 enabled sources 的 MCP / API server 配置；
   * 5. 创建 `McpClientPool` 和可选的 HTTP pool server（供外部 SDK 子进程连接）；
   * 6. 通过 `createBackendFromResolvedContext` 创建 provider-specific 后端（Claude / Pi）；
   * 7. 注册各类回调：调试日志、认证、权限、计划提交、子会话生成、source 激活等。
   *
   * 与 Go 的类比：
   * - 类似于 Go 里根据配置 new 一个 `Agent` 接口实现，并把事件回调注册进去；
   * - `await` 相当于等待初始化完成，Go 里可能是 `agent.Initialize(ctx)`。
   *
   * Provider 解析顺序：
   * 1. session.llmConnection（第一条消息后锁定）
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
   * 4. fallback：未配置 connection
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    // 当连接自 agent 创建以来发生漂移时，就地刷新运行时配置。
    // 如果就地刷新失败，可能会将 `managed.agent` 置为 null，
    // 在这种情况下，下面的创建分支会重建它。
    await this.tryRefreshAgentRuntime(managed, 'send-path refresh')

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })

      // 首次解析后锁定连接
      // 这确保会话始终使用相同的提供商
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        sessionLog.info(`Locked session ${managed.id} to connection "${connection.slug}"`)
        this.persistSession(managed)

        // 自动锁定连接时，保持渲染器会话能力同步。
        this.sendEvent({
          type: 'connection_changed',
          sessionId: managed.id,
          connectionSlug: connection.slug,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }

      const provider = backendContext.provider
      if (connection) {
        sessionLog.info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`)
      } else {
        sessionLog.warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`)
      }

      // 设置会话目录，用于工具元数据的跨进程共享。
      // SDK 子进程读取 CRAFT_SESSION_DIR 以写入 tool-metadata.json；
      // 主进程通过 toolMetadataStore.setSessionDir() 读取它。
      const sessionDirForMetadata = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      process.env.CRAFT_SESSION_DIR = sessionDirForMetadata
      toolMetadataStore.setSessionDir(sessionDirForMetadata)

      // 设置 agentReady promise，以便标题生成可以等待 agent 创建
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // 通用设置：数据源、MCP 池、会话配置
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(managed.workspace.rootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )

      // 为启用的数据源构建服务器配置
      const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)

      // 创建集中式 MCP 客户端池（所有后端都使用它）
      managed.mcpPool = new McpClientPool({ debug: (msg) => sessionLog.debug(msg), workspaceRootPath: managed.workspace.rootPath, sessionPath })

      // 作为外部子进程运行的后端需要一个 HTTP 池服务器
      let poolServerUrl: string | undefined
      if (backendContext.capabilities.needsHttpPoolServer) {
        managed.poolServer = new McpPoolServer(managed.mcpPool, { debug: (msg) => sessionLog.debug(msg) })
        managed.mcpPool.onToolsChanged = () => managed.poolServer?.notifyToolsChanged()
        poolServerUrl = await managed.poolServer.start()
        await managed.mcpPool.sync(mcpServers) // 确保在 SDK 连接之前池中已有工具
      }

      // 每个会话的环境变量覆盖
      const miniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
        // 将 mini 模型传递给 SDK 子进程，以便 WebFetch 等内置工具
        // 使用正确的模型进行摘要（而不是硬编码的 Haiku）
        ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // 通用会话 + 回调配置（所有后端相同）
      // ============================================================

      const sessionConfig = {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchFromMessageId,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmConnection: managed.llmConnection,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
        projectId: managed.projectId,
      }

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        // 子会话已建立，现在移除仅用于分支的 fork 元数据
        if (managed.branchFromSdkSessionId) {
          sessionLog.info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`)
          managed.branchFromSdkSessionId = undefined
          managed.branchFromSdkCwd = undefined
          managed.branchFromSdkTurnId = undefined
        } else {
          sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
        }
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onBranchForkInvalidated = () => {
        managed.sdkSessionId = undefined
        managed.branchFromSdkSessionId = undefined
        managed.branchFromSdkCwd = undefined
        managed.branchFromSdkTurnId = undefined
        sessionLog.info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const getRecoveryMessages = () => {
        const relevantMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .slice(-6)
        return relevantMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)
          .map(m => ({
            type: m.role as 'user' | 'assistant',
            content: m.content,
          }))
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        const seedMessages = managed.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => !m.isIntermediate)

        return seedMessages.map(m => ({
          type: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      }

      const markBranchSeedApplied = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        sessionLog.info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null)
        sessionLog.info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`)
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary) return
        managed.transferredSessionSummaryApplied = true
        this.persistSession(managed)
        sessionLog.info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      // ============================================================
      // 通过工厂构造后端
      // ============================================================

      managed.agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
        workspace: managed.workspace,
        miniModel,
        thinkingLevel: managed.thinkingLevel,
        session: sessionConfig,
        onSdkSessionIdUpdate,
        onSdkSessionIdCleared,
        onBranchForkInvalidated,
        getRecoveryMessages,
        getBranchFallbackMessages,
        getBranchSeedMessages,
        markBranchSeedApplied,
        getTransferredSessionSummary,
        markTransferredSessionSummaryApplied,
        mcpPool: managed.mcpPool,
        poolServerUrl,
        envOverrides,
        // Claude 特有
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true, // 服务器拥有工作区级别的 ConfigWatcher——不要在 agent 中重复创建
        automationSystem: this.automationSystems.get(managed.workspace.rootPath),
        systemPromptPreset: managed.systemPromptPreset,
        debugMode: _platform?.isDebugMode ? { enabled: true, logFilePath: _platform.getLogFilePath?.() } : undefined,
        enable1MContext: await (async () => { const { getEnable1MContext } = await import('@craft-agent/shared/config/storage'); return getEnable1MContext(); })(),
        // 图片大小调整回调——防止过大的图片进入对话历史
        onImageResize: async (filePath: string, maxSizeBytes: number): Promise<string | null> => {
          try {
            const buffer = await readFile(filePath)
            const result = await resizeImageForAPI(buffer, { maxSizeBytes })
            if (!result) return null

            // 写入会话临时目录（随会话一起清理）
            const sessionTmpDir = join(sessionPath, 'tmp')
            await mkdir(sessionTmpDir, { recursive: true })
            const ext = result.format === 'jpeg' ? 'jpg' : 'png'
            const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`)
            await writeFile(outPath, result.buffer)

            sessionLog.info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`)
            return outPath
          } catch (err) {
            sessionLog.error('Image resize failed:', err)
            return null
          }
        },
        // postInit() 的源配置——后端设置自己的桥接/配置
        initialSources: {
          enabledSources,
          mcpServers,
          apiServers,
          enabledSlugs,
        },
        },
      }) as AgentInstance

      sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // 构造后：调试回调、认证回调、postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            sessionLog.info('Tool blocked by permission mode', payload)
            return
          } catch {
            // 当有效载荷解析失败时，回退到普通日志记录
          }
        }

        sessionLog.info(msg)
      }

      // 统一认证回调——替换每个后端的 onChatGptAuthRequired/onGithubAuthRequired
      managed.agent.onBackendAuthRequired = (reason: string) => {
        sessionLog.warn(`Backend auth required for session ${managed.id}: ${reason}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: `Authentication required: ${reason}`,
          level: 'error',
        }, managed.workspace.id)
      }

      // 运行后初始化（认证注入）——每个后端处理自己的
      const postInitResult = await managed.agent.postInit()
      if (postInitResult.authWarning) {
        sessionLog.warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: postInitResult.authWarning,
          level: postInitResult.authWarningLevel || 'error',
        }, managed.workspace.id)
      }

      // 在 MCP 池中连接大响应处理（所有后端）
      if (managed.mcpPool && managed.agent) {
        managed.mcpPool.setSummarizeCallback(managed.agent.getSummarizeCallback())
      }

      // 连接浏览器面板工具——将 BrowserPaneFns 合并到会话回调中
      // 以便 browser_* 工具可以委托给 BrowserPaneManager。
      //
      // 当本地 BPM 已设置或 RPC 服务器可用时始终注册
      //（这允许 `getBrowserPaneManagerForSession` 惰性构建
      // RemoteBrowserPaneManager）。如果未连接桌面客户端，每个方法的调用会失败并返回
      // BROWSER_NO_CAPABLE_CLIENT，而不是
      // 返回“工具不可用”。
      sessionLog.info('[browser-pane] BPF gate check', {
        sessionId: managed.id,
        hasLocalBpm: !!this.browserPaneManager,
        hasRpcServer: !!this.rpcServer,
      })
      if (this.browserPaneManager || this.rpcServer) {
        const sid = managed.id
        const bpm = this.getBrowserPaneManagerForSession(sid)
        if (!bpm) {
          throw new Error('Browser pane manager unavailable despite passing the gate — this is a bug.')
        }
        sessionLog.info('[browser-pane] BPF block resolved BPM', {
          sessionId: sid,
          bpmKind: this.browserPaneManager === bpm ? 'local' : 'remote',
        })

        const workspaceId = managed.workspace.id
        const resolveSessionBrowserInstance = async (toolName: string, options?: { show?: boolean }): Promise<string> => {
          const instanceId = await bpm.createForSessionAsync(sid, {
            show: options?.show ?? false,
            workspaceId,
          })
          const info = await bpm.getInstanceAsync(instanceId)
          sessionLog.info(`[browser-pane] tool target resolved: ${toolName} session=${sid} instance=${instanceId} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
          return instanceId
        }

        const resolveLifecycleWindowTarget = async (command: 'release' | 'close' | 'hide', requestedInstanceId?: string) => {
          const windows = await bpm.listInstancesAsync()

          if (windows.length === 0) {
            return { windows, reason: 'No browser windows are available. Use "open" first.' }
          }

          const validateTarget = (target: (typeof windows)[number] | undefined) => {
            if (!target) {
              return { ok: false as const, reason: `Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.` }
            }

            if (target.boundSessionId && target.boundSessionId !== sid) {
              return { ok: false as const, reason: `Browser window "${target.id}" is locked to session ${target.boundSessionId}.` }
            }

            if (!target.boundSessionId && target.ownerSessionId && target.ownerSessionId !== sid) {
              return { ok: false as const, reason: `Browser window "${target.id}" is currently owned by session ${target.ownerSessionId}.` }
            }

            return { ok: true as const, target }
          }

          if (requestedInstanceId) {
            const validated = validateTarget(windows.find((w) => w.id === requestedInstanceId))
            if (!validated.ok) {
              return { windows, reason: validated.reason }
            }
            return { windows, target: validated.target }
          }

          const fallbackTarget = windows.find((w) => w.boundSessionId === sid)
            ?? windows.find((w) => w.ownerSessionId === sid)

          if (!fallbackTarget) {
            return { windows, reason: `No ${command} target is currently associated with this session. Use "windows", then "${command} <id>".` }
          }

          const validated = validateTarget(fallbackTarget)
          if (!validated.ok) {
            return { windows, reason: validated.reason }
          }

          return { windows, target: validated.target }
        }

        sessionLog.info('[browser-pane] BPF registering browserPaneFns', { sessionId: sid })
        mergeSessionScopedToolCallbacks(sid, {
          browserPaneFns: {
            openPanel: async (options) => {
              const instanceId = options?.background
                ? await bpm.createForSessionAsync(sid, { show: false, workspaceId })
                : await bpm.focusBoundForSessionAsync(sid, { workspaceId })
              const info = await bpm.getInstanceAsync(instanceId)
              sessionLog.info(`[browser-pane] route decision: browser_open session=${sid} instance=${instanceId} background=${options?.background ?? false} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
              return { instanceId }
            },
            navigate: async (url) => {
              const instanceId = await resolveSessionBrowserInstance('browser_navigate')
              return bpm.navigate(instanceId, url)
            },
            snapshot: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_snapshot')
              return bpm.getAccessibilitySnapshot(instanceId)
            },
            click: async (ref, options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click')
              return bpm.clickElement(instanceId, ref, options)
            },
            clickAt: async (x, y) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click_at')
              return bpm.clickAtCoordinates(instanceId, x, y)
            },
            drag: async (x1, y1, x2, y2) => {
              const instanceId = await resolveSessionBrowserInstance('browser_drag')
              return bpm.drag(instanceId, x1, y1, x2, y2)
            },
            fill: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_fill')
              return bpm.fillElement(instanceId, ref, value)
            },
            type: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_type')
              return bpm.typeText(instanceId, text)
            },
            select: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_select')
              return bpm.selectOption(instanceId, ref, value)
            },
            setClipboard: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_set_clipboard')
              return bpm.setClipboard(instanceId, text)
            },
            getClipboard: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_get_clipboard')
              return bpm.getClipboard(instanceId)
            },
            screenshot: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot')
              return bpm.screenshot(instanceId, options)
            },
            screenshotRegion: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot_region')
              return bpm.screenshotRegion(instanceId, options)
            },
            getConsoleLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_console')
              return bpm.getConsoleLogs(instanceId, options)
            },
            windowResize: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_window_resize')
              return bpm.windowResize(instanceId, options.width, options.height)
            },
            getNetworkLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_network')
              return bpm.getNetworkLogs(instanceId, options)
            },
            waitFor: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_wait')
              return bpm.waitFor(instanceId, options)
            },
            sendKey: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_key')
              return bpm.sendKey(instanceId, options)
            },
            getDownloads: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_downloads')
              return bpm.getDownloads(instanceId, options)
            },
            upload: async (ref, filePaths) => {
              const instanceId = await resolveSessionBrowserInstance('browser_upload')
              return bpm.uploadFile(instanceId, ref, filePaths).then(() => {})
            },
            scroll: async (direction, amount) => {
              const instanceId = await resolveSessionBrowserInstance('browser_scroll')
              return bpm.scroll(instanceId, direction, amount)
            },
            goBack: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_back')
              return bpm.goBack(instanceId)
            },
            goForward: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_forward')
              return bpm.goForward(instanceId)
            },
            evaluate: async (expression) => {
              const instanceId = await resolveSessionBrowserInstance('browser_evaluate')
              return bpm.evaluate(instanceId, expression)
            },
            focusWindow: async (targetInstanceId) => {
              const windows = await bpm.listInstancesAsync()
              if (windows.length === 0) {
                throw new Error('No browser windows available to focus. Use "open" first.')
              }

              const target = targetInstanceId
                ? windows.find(w => w.id === targetInstanceId)
                : windows.find(w => w.boundSessionId === sid || w.ownerSessionId === sid)

              if (!target) {
                if (targetInstanceId) {
                  throw new Error(`Browser window "${targetInstanceId}" not found. Use "windows" to list available windows.`)
                }
                throw new Error('No browser window is currently bound to this session. Use "open --foreground" to create or reuse one.')
              }

              const availableToSession = !target.boundSessionId || target.boundSessionId === sid
              if (!availableToSession) {
                throw new Error(`Browser window "${target.id}" is locked to session ${target.boundSessionId}.`)
              }

              if (!target.boundSessionId) {
                bpm.bindSession(target.id, sid, { workspaceId })
              }

              bpm.focus(target.id)
              const focused = await bpm.getInstanceAsync(target.id)
              return {
                instanceId: target.id,
                title: focused?.title ?? target.title,
                url: focused?.currentUrl ?? target.url,
              }
            },
            releaseControl: async (requestedInstanceId) => {
              if (requestedInstanceId === 'all') {
                const before = await bpm.listInstancesAsync()
                const beforeActive = before.filter((w) => !!w.agentControlActive).length
                bpm.clearAgentControl(sid)
                const after = await bpm.listInstancesAsync()
                const afterActive = after.filter((w) => !!w.agentControlActive).length
                const released = afterActive < beforeActive

                sessionLog.info(`[browser-pane] lifecycle release-all session=${sid} overlays=${beforeActive}->${afterActive}`)

                return {
                  action: released ? 'released' : 'noop',
                  requestedInstanceId,
                  affectedIds: released ? before.filter((w) => !!w.agentControlActive).map((w) => w.id) : [],
                  reason: released ? undefined : 'No active overlay was found for this session.',
                }
              }

              const resolution = await resolveLifecycleWindowTarget('release', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              const result = bpm.clearAgentControlForInstance(resolution.target.id, sid)
              const action = result.released ? 'released' : 'noop'
              sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=${action} reason=${result.reason ?? 'none'}`)

              return {
                action,
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: result.released ? [resolution.target.id] : [],
                reason: result.reason,
              }
            },
            closeWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('close', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.destroyInstance(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=closed`)

              return {
                action: 'closed',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            hideWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('hide', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.hide(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=hidden`)

              return {
                action: 'hidden',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            listWindows: async () => {
              return bpm.listInstancesAsync()
            },
            detectChallenge: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_detect_challenge')
              return bpm.detectSecurityChallenge(instanceId)
            },
          } satisfies BrowserPaneFns,
        })
      }

      // 发出信号表示 agent 实例已就绪（解除标题生成的阻塞）
      managed.agentReadyResolve?.()

      // 设置权限处理程序，将请求转发给渲染器
      managed.agent.onPermissionRequest = (request: {
        requestId: string;
        toolName: string;
        command?: string;
        description: string;
        type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
        appName?: string;
        reason?: string;
        impact?: string;
        requiresSystemPrompt?: boolean;
        rememberForMinutes?: number;
        commandHash?: string;
        approvalTtlSeconds?: number;
      }) => {
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command)
        let brokerMetadata: {
          commandHash?: string
          approvalTtlSeconds?: number
        } = {}

        if (request.type === 'admin_approval' && request.command) {
          const brokerRequest = this.privilegedExecutionBroker.createRequest({
            requestId: request.requestId,
            sessionId: managed.id,
            command: request.command,
            reason: request.reason,
            impact: request.impact,
            approvalTtlSeconds: request.approvalTtlSeconds,
          })

          brokerMetadata = {
            commandHash: brokerRequest.commandHash,
            approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
          }
        }

        const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash

        this.pendingPermissionRequests.set(request.requestId, {
          sessionId: managed.id,
          type: request.type,
          commandHash: effectiveCommandHash,
        })

        if (request.type === 'admin_approval' && effectiveCommandHash && this.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)) {
          const brokerResult = this.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
            expectedCommandHash: effectiveCommandHash,
          })

          this.pendingPermissionRequests.delete(request.requestId)

          if (brokerResult.ok) {
            this.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
              sessionId: managed.id,
              requestId: request.requestId,
              commandHash: effectiveCommandHash,
            })
            const liveAgent = managed.agent
            if (liveAgent) {
              liveAgent.respondToPermission(request.requestId, true, false)
              return
            }
          }

          sessionLog.warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`)
        }

        this.sendEvent({
          type: 'permission_request',
          sessionId: managed.id,
          request: {
            ...request,
            ...brokerMetadata,
            sessionId: managed.id,
          }
        }, managed.workspace.id)
      }

      // 注意：凭据请求现在通过 onAuthRequest（统一认证流程）
      // 旧的 onCredentialRequest 回调已从 CraftAgent 中移除
      // 会话中令牌过期的认证刷新由 sendMessage 中的错误处理程序处理
      // 它会销毁/重新创建 agent 以获取新凭据

      // 设置模式变更处理程序
      managed.agent.onPermissionModeChange = (mode) => {
        if (managed.permissionMode === mode) {
          return
        }

        managed.permissionMode = mode
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        managed.previousPermissionMode = diagnostics.previousPermissionMode
        sessionLog.info('Permission mode changed (agent callback)', {
          sessionId: managed.id,
          permissionMode: mode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
        this.sendEvent({
          type: 'permission_mode_changed',
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          previousPermissionMode: diagnostics.previousPermissionMode,
          transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id)
      }

      // 连接 onPlanSubmitted，将计划消息添加到对话中
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        try {
          // 读取计划文件内容
          const planContent = await readFile(planPath, 'utf-8')

          // 将 SubmitPlan 工具消息标记为已完成（由于 forceAbort，它不会收到 tool_result）
          const submitPlanMsg = managed.messages.find(
            m => m.toolName?.includes('SubmitPlan') && m.toolStatus === 'executing'
          )
          if (submitPlanMsg) {
            submitPlanMsg.toolStatus = 'completed'
            submitPlanMsg.content = 'Plan submitted for review'
            submitPlanMsg.toolResult = 'Plan submitted for review'
          }

          // 创建计划消息
          const planMessage = {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'plan' as const,
            content: planContent,
            timestamp: this.monotonic(),
            planPath,
          }

          // 添加到会话消息中
          managed.messages.push(planMessage)

          // 更新 lastMessageRole 用于徽章显示
          managed.lastMessageRole = 'plan'

          // 向渲染器发送事件
          this.sendEvent({
            type: 'plan_submitted',
            sessionId: managed.id,
            message: planMessage,
          }, managed.workspace.id)

          // 中断执行——计划展示是一个停止点
          // 用户需要审查并回复后才能继续
          if (managed.isProcessing && managed.agent) {
            sessionLog.info(`Interrupting for plan submission in session ${managed.id}`)
            managed.agent.interruptForHandoff(AbortReason.PlanSubmitted)
            this.setProcessing(managed, false)

            // 释放浏览器覆盖层和会话绑定，因为 agent 不再运行。
            // 计划提交会暂停执行直到用户审查，因此浏览器所有权不应保持锁定。
            await releaseBrowserOwnershipOnForcedStop(
              (sid) => this.getBrowserPaneManagerForSession(sid),
              managed.id,
            )

            // 发送完成事件，让渲染器知道处理已停止（包含 tokenUsage 用于实时更新）
            this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)

            // 持久化会话状态
            this.persistSession(managed)
          }
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }
      }

      // 连接 onAuthRequest，将认证消息添加到对话中并暂停执行
      managed.agent.onAuthRequest = (request) => {
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

        // 创建认证请求消息
        const authMessage: Message = {
          id: generateMessageId(),
          role: 'auth-request',
          content: this.getAuthRequestDescription(request),
          timestamp: this.monotonic(),
          authRequestId: request.requestId,
          authRequestType: request.type,
          authSourceSlug: request.sourceSlug,
          authSourceName: request.sourceName,
          authStatus: 'pending',
          // 复制凭据的类型特定字段
          ...(request.type === 'credential' && {
            authCredentialMode: request.mode,
            authLabels: request.labels,
            authDescription: request.description,
            authHint: request.hint,
            authHeaderName: request.headerName,
            authHeaderNames: request.headerNames,
            authSourceUrl: request.sourceUrl,
            authPasswordRequired: request.passwordRequired,
          }),
        }

        // 添加到会话消息中
        managed.messages.push(authMessage)

        // 存储待处理的认证请求，以便后续解析
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request

        // 中断执行（类似 SubmitPlan）
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(`Interrupting for auth request in session ${managed.id}`)
          managed.agent.interruptForHandoff(AbortReason.AuthRequest)
          this.setProcessing(managed, false)

          // 释放浏览器覆盖层和会话绑定，因为 agent 已暂停等待用户认证。
          void releaseBrowserOwnershipOnForcedStop(
            (sid) => this.getBrowserPaneManagerForSession(sid),
            managed.id,
          )

          // 发送完成事件，让渲染器知道处理已停止（包含 tokenUsage 用于实时更新）
          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)
        }

        // 向渲染器发出 auth_request 事件
        this.sendEvent({
          type: 'auth_request',
          sessionId: managed.id,
          message: authMessage,
          request: request,
        }, managed.workspace.id)

        // 持久化会话状态
        this.persistSession(managed)

        // OAuth 流程由客户端通过 performOAuth()（preload）驱动。
        // 当用户点击“登录”时，UI 调用 window.electronAPI.performOAuth()。
      }

      // 连接 onSpawnSession，从 agent 工具调用创建独立会话
      managed.agent.onSpawnSession = async (request) => {
        sessionLog.info(`Spawn session request from session ${managed.id}:`, request.name || '(unnamed)')

        const session = await this.createSession(managed.workspace.id, {
          name: request.name,
          llmConnection: request.llmConnection ?? managed.llmConnection,
          model: request.model ?? managed.model,
          enabledSourceSlugs: request.enabledSourceSlugs ?? managed.enabledSourceSlugs,
          permissionMode: request.permissionMode ?? managed.permissionMode,
          thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
          labels: request.labels ?? managed.labels,
          workingDirectory: request.workingDirectory,
          projectId: request.projectId ?? managed.projectId,
          // Spawned sessions become subtasks of the spawning session.
          parentSessionId: managed.id,
        })

        // 从路径构建 FileAttachment[]（如果有）
        let fileAttachments: FileAttachment[] | undefined
        if (request.attachments?.length) {
          const attachments: FileAttachment[] = []
          for (const a of request.attachments) {
            try {
              const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
              if (request.workingDirectory) extraDirs.push(request.workingDirectory)
              const safePath = await validateFilePath(a.path, extraDirs)
              const attachment = readFileAttachment(safePath)
              if (attachment) {
                if (a.name) attachment.name = a.name
                attachments.push(attachment)
              } else {
                sessionLog.warn(`Spawn session: attachment not found: ${a.path}`)
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              sessionLog.warn(`Spawn session: blocked attachment path ${a.path}: ${message}`)
            }
          }
          if (attachments.length > 0) fileAttachments = attachments
        }

        // （session_created 事件由上方的 createSession 发出。）

        // 触发后即忘——发送消息但不等待完成
        this.sendMessage(session.id, request.prompt, fileAttachments).catch(err => {
          sessionLog.error(`Failed to send message to spawned session ${session.id}:`, err)
        })

        return {
          sessionId: session.id,
          name: session.name || request.name || session.id,
          status: 'started' as const,
          connection: session.llmConnection,
          model: session.model,
        }
      }

      // 接入会话自我管理工具（set_session_labels、set_session_status 等）
      mergeSessionScopedToolCallbacks(managed.id, {
        setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
          await this.setSessionLabels(sessionId ?? managed.id, labels)
        },
        setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
          await this.setSessionStatus(sessionId ?? managed.id, status as SessionStatus)
        },
        getSessionInfoFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const session = this.sessions.get(targetId)
          if (!session) return null
          return {
            id: session.id,
            name: session.name ?? session.id,
            labels: session.labels ?? [],
            status: session.sessionStatus ?? 'todo',
            permissionMode: session.permissionMode ?? 'ask',
            createdAt: session.createdAt ?? 0,
            workingDirectory: session.workingDirectory,
            projectId: session.projectId,
            llmConnection: session.llmConnection,
            model: session.model,
            isActive: session.agent != null,
          }
        },
        listSessionsFn: (options) => {
          const DEFAULT_LIMIT = 20
          const MAX_LIMIT = 100
          const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const offset = options?.offset ?? 0

          let sessions = this.getSessions(managed.workspace.id)

          // 过滤
          if (options?.status) {
            sessions = sessions.filter(s => s.sessionStatus === options.status)
          }
          if (options?.label) {
            sessions = sessions.filter(s => s.labels?.includes(options.label!))
          }
          if (options?.search) {
            const needle = options.search.toLowerCase()
            sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle))
          }

          // 排序
          const sortBy = options?.sortBy ?? 'recent'
          if (sortBy === 'recent') {
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          } else if (sortBy === 'name') {
            sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          } else if (sortBy === 'status') {
            sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''))
          }

          const total = sessions.length

          // 分页
          const page = sessions.slice(offset, offset + limit)

          return {
            total,
            returned: page.length,
            sessions: page.map(s => ({
              id: s.id,
              name: s.name ?? s.id,
              labels: s.labels ?? [],
              status: s.sessionStatus ?? 'todo',
              createdAt: s.createdAt ?? 0,
              projectId: s.projectId,
            })),
          }
        },
        listBackgroundTasksFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const now = Date.now()
          return this.listBackgroundTasks(targetId).map((t) => {
            // Prefer wall-clock elapsed; running tasks tick off startTime, terminal
            // tasks freeze at completion. Fall back to the last progress value.
            const anchorEnd = t.status === 'running' ? now : (t.completedAt ?? now)
            const wallElapsed = Math.max(0, Math.round((anchorEnd - t.startTime) / 1000))
            return {
              taskId: t.taskId,
              intent: t.intent,
              status: t.status,
              startTime: t.startTime,
              elapsedSeconds: t.elapsedSeconds ?? wallElapsed,
              completedAt: t.completedAt,
            }
          })
        },
        resolveLabelsFn: (labels: string[]) => {
          const labelConfig = loadLabelConfig(managed.workspace.rootPath)
          return resolveSessionLabels(labels, labelConfig.labels)
        },
        resolveStatusFn: (status: string) => {
          const statusConfig = loadStatusConfig(managed.workspace.rootPath)
          const allStatuses = statusConfig.statuses
          const available = allStatuses.map(s => s.id)

          // 精确 ID 匹配
          const byId = allStatuses.find(s => s.id === status)
          if (byId) return { resolved: byId.id, available, category: byId.category }
          // 不区分大小写的标签 → ID
          const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase())
          if (byLabel) return { resolved: byLabel.id, available, category: byLabel.category }

          return { resolved: null, available }
        },
        sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => {
          // 从路径构建 FileAttachment[]（与 spawn_session 相同的模式）
          let fileAttachments: FileAttachment[] | undefined
          if (attachments?.length) {
            const builtAttachments: FileAttachment[] = []
            for (const a of attachments) {
              try {
                const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
                const safePath = await validateFilePath(a.path, extraDirs)
                const attachment = readFileAttachment(safePath)
                if (attachment) {
                  if (a.name) attachment.name = a.name
                  builtAttachments.push(attachment)
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                sessionLog.warn(`send_agent_message: blocked attachment path ${a.path}: ${msg}`)
              }
            }
            if (builtAttachments.length > 0) fileAttachments = builtAttachments
          }

          // Capture the target's busy state BEFORE delivery so the sender gets a
          // truthful ack. A busy (mid-turn) target queues the message and replays
          // it after the current turn (anthropic defaults to 'queue'); an idle
          // target starts processing immediately. sendMessage throws for an
          // unknown session — that rejection propagates to the handler's catch.
          const targetBusy = this.sessions.get(sessionId)?.isProcessing === true
          await this.sendMessage(sessionId, message, fileAttachments)
          return {
            delivery: targetBusy ? ('queued' as const) : ('delivered' as const),
            targetBusy,
          }
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
          const cb = managed.agent?.onSourceActivationRequest
          if (!cb) {
            return { ok: false, reason: 'Agent has no activation callback wired' }
          }
          const ok = await cb(sourceSlug)
          if (!ok) {
            return {
              ok: false,
              reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
            }
          }
          // 两个后端都需要当前轮次结束后新工具才可见：
          // Claude SDK 在 query() 启动时冻结 mcpServers；Pi 仅拾取新的代理
          // 在下一个 handlePrompt 上的工具定义（pi-agent-server 中的 `toolsChanged` 标志）。
          // 在代理上标记待处理的重启 — ClaudeAgent/PiAgent 在
          // 下一个 tool_result 后消费它，生成 source_activated 并 forceAbort。
          // 此类中的 `source_activated` 处理程序随后安排服务器端
          // 重新发送原始用户消息，并附加 "[{slug} activated]" 后缀 —
          // 最终进入一个工具已生效的新轮次（craft-agents-oss#804）。
          const userMessage = managed.agent?.getCurrentTurnUserMessage?.() ?? ''
          if (userMessage) {
            managed.agent?.setPendingSourceActivationRestart({ sourceSlug, userMessage })
          }
          return { ok: true, availability: 'next-turn' as const }
        },
      })

      // WS2 keep-alive：把 turn 之间到达（空闲 —— 没有 chat() 生成器在消费）的后台任务事件
      // 转发到正常的事件管道中，使运行中任务注册表 + 渲染器 chip 即使在 session 空闲时也能
      // 反映出完成。在 turn 进行期间这些事件照常通过 chat() 生成器流动；这里只覆盖空闲的间隙。
      // 仅在后端支持持久跨 turn 查询（Claude keep-alive）时生效，否则为 no-op。
      managed.agent.setBackgroundEventSink?.((event: AgentEvent) => {
        void this.processEvent(managed, event)
      })

      // 接入 onSourceActivationRequest，以便在代理尝试使用源时自动启用它们
      managed.agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug)

        const workspaceRootPath = managed.workspace.rootPath

        // 检查源是否已启用
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
          // 源在列表中，但服务器可能未激活（例如，之前构建失败）
        }

        // 加载源以检查其是否存在且就绪
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // 检查源是否可用（已启用且如果需要认证则已通过认证）
        if (!isSourceUsable(source)) {
          sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
          return false
        }

        // 跟踪我们是否添加了此 slug（用于失败时回滚）
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // 如果尚未添加，则添加到已启用的源中
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(`Added source ${sourceSlug} to session enabled sources`)
        }

        // 为所有已启用的源构建服务器配置
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs || [])
        // 传递会话路径，以便大型 API 响应可以保存到会话文件夹
        const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // 检查我们的目标源是否构建成功
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // 仅在我们添加时才移除（如果原本就在那里则不操作）
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        // 将源服务器应用到代理
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map(s => s.config.slug)

        // 为需要它的后端更新 bridge-mcp-server 配置/凭据
        await applyBridgeUpdates(managed.agent!, sessionPath, allEnabledSources, mcpServers, managed.id, workspaceRootPath, 'source enable', managed.poolServer?.url)

        await managed.agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

        // 使用更新后的已启用源持久化会话
        this.persistSession(managed)

        // 通知渲染器源已更改
        this.sendEvent({
          type: 'sources_changed',
          sessionId: managed.id,
          enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id)

        return true
      }

      // 注意：源重新加载现在由 ConfigWatcher 回调处理
      // 它检测文件系统更改并更新所有受影响的会话。
      // 完整的重新加载逻辑请参见 setupConfigWatcher()。

      // 将会话范围的权限模式应用于新创建的代理
      // 这确保 UI 切换状态在第一条消息之前反映在代理中
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode)
        }
        managed.agent!.setPermissionMode(managed.permissionMode)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        sessionLog.info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      end()
    }
    return managed.agent
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // 直接持久化内存状态，以避免与待处理队列写入的竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
      // 解决方法：Bun 的 fs.watch({ recursive: true }) 在 Linux 上不跟踪
      // 监视器启动后创建的目录。
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // 直接持久化内存状态，以避免与待处理队列写入的竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
      // 解决方法：Bun 的 fs.watch({ recursive: true }) 在 Linux 上不跟踪
      // 监视器启动后创建的目录。
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // 直接持久化内存状态，以避免与待处理队列写入的竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // 直接持久化内存状态，以避免与待处理队列写入的竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      this.setMetadataWriteGuard(managed)
      // 直接持久化内存状态，以避免与待处理队列写入的竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id)
      // 解决方法：Bun 的 fs.watch({ recursive: true }) 在 Linux 上不跟踪
      // 监视器启动后创建的目录。
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 设置会话的 LLM 连接。
   * 只能在发送第一条消息之前更改（之后连接将被锁定）。
   * 这决定了此会话将使用哪个 LLM 提供商/后端。
   */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // 仅允许在第一条消息之前更改连接（会话尚未开始）
    if (managed.messages && managed.messages.length > 0) {
      sessionLog.warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    // 验证连接是否存在
    const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      sessionLog.warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    // 直接持久化内存状态，以避免与待处理队列写入的竞争
    this.persistSession(managed)
    await this.flushSession(managed.id)
    sessionLog.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    // 通知 UI 连接已更改（触发能力刷新）
    this.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
  }

  // ============================================
  // 待处理的计划执行（接受并压缩）
  // ============================================

  /**
   * 设置待处理的计划执行状态。
   * 当用户点击“接受并压缩”时调用，以持久化计划路径，
   * 以便执行可以在压缩后恢复（即使页面重新加载）。
   */
  async setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, planPath, draftInputSnapshot)
      sessionLog.info(`Session ${sessionId}: set pending plan execution for ${planPath}`)
    }
  }

  /**
   * 标记待处理计划执行的压缩已完成。
   * 当 compression_complete 事件触发时调用 - 允许重新加载恢复
   * 知道压缩已完成，计划可以执行。
   */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  /**
   * 标记待处理的计划执行已从 UI 分派。
   * 这防止重新加载恢复在发送成功但因重新连接/断开连接而清理失败时
   * 重复提交相同的计划。
   */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: marked pending plan execution as dispatched`)
    }
  }

  /**
   * 清除待处理的计划执行状态。
   * 在计划执行触发后、收到新用户消息时，
   * 或待处理执行不再相关时调用。
   */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /**
   * 获取会话的待处理计划执行状态。
   * 在重新加载/初始化时使用，以检查是否需要恢复计划执行。
   */
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  /**
   * 为会话分派计划批准，等同于桌面端的
   * “接受计划”按钮。如果需要，将会话从探索模式（安全）
   * 切换到允许所有模式，以便计划无需每个工具的提示即可执行，
   * 然后通过正常的 sendMessage 路径发送批准消息。
   */
  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`acceptPlan: session ${sessionId} not found`)
      return
    }

    if (managed.permissionMode === 'safe') {
      this.setSessionPermissionMode(sessionId, 'allow-all')
    }

    await this.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE)
  }

  // ============================================
  // 会话共享
  // ============================================

  /**
   * 将会话共享到 Web 查看器
   * 上传会话数据并返回可共享的 URL
   */
  async shareToViewer(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    // 信号异步操作开始（用于闪烁效果）
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // 直接从磁盘加载会话（已经是正确的格式）
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = await response.json() as { id: string; url: string }

      // 将会话中的共享信息存储
      managed.sharedUrl = data.url
      managed.sharedId = data.id
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      sessionLog.info(`Session ${sessionId} shared at ${data.url}`)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_shared', sessionId, sharedUrl: data.url }, managed.workspace.id)
      return { success: true, url: data.url }
    } catch (error) {
      sessionLog.error('Share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // 信号异步操作结束
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * 更新现有的共享会话
   * 将会话数据重新上传到相同的 URL
   */
  async updateShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // 信号异步操作开始（用于闪烁效果）
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // 直接从磁盘加载会话（已经是正确的格式）
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      sessionLog.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`)
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      sessionLog.error('Update share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // 信号异步操作结束
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * 撤销共享会话
   * 从查看器中删除并清除本地共享状态
   */
  async revokeShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // 信号异步操作开始（用于闪烁效果）
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(
        `${VIEWER_URL}/s/api/${managed.sharedId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        sessionLog.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      // 清除共享信息
      delete managed.sharedUrl
      delete managed.sharedId
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      sessionLog.info(`Session ${sessionId} share revoked`)
      // 通知此工作区的所有窗口
      this.sendEvent({ type: 'session_unshared', sessionId }, managed.workspace.id)
      return { success: true }
    } catch (error) {
      sessionLog.error('Revoke error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // 信号异步操作结束
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  // ============================================
  // 会话源
  // ============================================

  /**
   * 更新会话的已启用源
   * 如果代理存在，则立即构建并应用服务器。
   * 否则，服务器将在下一条消息时全新构建。
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // 清除正在禁用的源的凭据缓存（安全）
    // 当源不再活跃时，这会从磁盘中移除解密的令牌
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug))
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs)
      } catch (err) {
        sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // 存储选择
    managed.enabledSourceSlugs = sourceSlugs

    // 如果代理存在，则立即构建并应用服务器
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // 传递会话路径，以便大型 API 响应可以保存到会话文件夹
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // 设置所有源以供上下文使用（代理看到包含描述和内置源的完整列表）
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // 设置活跃的源服务器（工具仅来自这些源）
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      // 为需要它的后端更新 bridge-mcp-server 配置/凭据
      const usableSources = sources.filter(isSourceUsable)
      await applyBridgeUpdates(managed.agent, sessionPath, usableSources, mcpServers, managed.id, workspaceRootPath, 'source config change', managed.poolServer?.url)

      await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // 使用更新后的源持久化会话
    this.persistSession(managed)

    // 通知渲染器源已更改
    this.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * 获取会话的已启用源 slug
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * 从消息列表中获取最后一条最终的助手消息 ID
   * “最终”消息是指：
   * - role === 'assistant' 且
   * - isIntermediate !== true（不是工具调用之间的评论）
   * 如果不存在最终的助手消息，则返回 undefined
   */
  private getLastFinalAssistantMessageId(messages: Message[]): string | undefined {
    // 向后迭代以查找最近的最终助手消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }

  /**
   * 读取 session 最终的 assistant 消息文本（Tasks Conductor 的进程内输出读取器）。
   * `getLastFinalAssistantMessageId` 是私有的并返回一个 id；这里包装它来返回消息内容。
   * 不对 agent 暴露 —— 子节点输出在这里读取，而非通过任何工具/RPC。
   */
  getSessionFinalText(sessionId: string): string | undefined {
    const managed = this.sessions.get(sessionId)
    if (!managed) return undefined
    const id = this.getLastFinalAssistantMessageId(managed.messages)
    if (!id) return undefined
    return managed.messages.find(m => m.id === id)?.content
  }

  /**
   * 设置用户正在主动查看的会话。
   * 当用户导航到会话时调用。用于确定是否将新消息标记为未读 -
   * 如果用户正在查看，则不标记为未读。
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // 当用户开始查看未在处理中的会话时，清除未读
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * 清除工作区的活动查看会话。
   * 当所有窗口离开工作区时调用，以确保读/未读状态正确。
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * 检查用户当前是否正在查看会话
   */
  private isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * 通过设置 lastReadMessageId 并清除 hasUnread 将会话标记为已读。
   * 当用户导航到会话（且未在处理中）时调用。
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // 仅当当前未在处理中时才标记为已读
    // （用户正在查看，但我们希望等待处理完成）
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // 更新 lastReadMessageId 以实现旧版/手动未读功能
    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // 清除 hasUnread 标志（NEW 徽章的主要真实来源）
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // 持久化更改
    if (needsPersist) {
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * 通过设置 hasUnread 标志将会话标记为未读。
   * 当用户通过上下文菜单手动将会话标记为未读时调用。
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // 持久化到磁盘
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * 将工作区中所有非隐藏、非归档的会话标记为已读。
   * 从“所有会话”上的“全部标记为已读”上下文菜单调用。
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.rootPath, managed.id, { hasUnread: false })
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.name = name
      this.persistSession(managed)
      // 通知渲染器名称已更改
      this.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
      // 解决方法：Bun 的 fs.watch({ recursive: true }) 在 Linux 上不跟踪
      // 监视器启动后创建的目录。
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 根据最近的消息重新生成会话标题。
   * 使用最后几条用户消息来捕捉会话的演变内容。
   * 自动使用与会话相同的提供商（Claude 或 OpenAI）。
   */
  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    // 确保消息已从磁盘加载（支持延迟加载）
    await this.ensureMessagesLoaded(managed)

    // 选择一组分布的用户消息（第一条、中间、最后一条）以捕捉会话的目的
    const allUserContents = managed.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    const userMessages = selectSpreadMessages(allUserContents)

    sessionLog.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`)

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    // 获取最近的助手响应
    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    // 从显式持久化的 UI 语言解析标题语言（磁盘支持，
    // 无竞争 vs. 主进程 i18n 异步水合）；undefined => 自动检测（#885）。
    const titleLanguage = resolveTitleLanguageName()
    const titleOptions = { language: titleLanguage }
    sessionLog.info(`[refreshTitle] language at call time`, {
      sessionId,
      persistedUiLanguage: getPersistedUiLanguage() ?? null,
      resolvedLanguage: i18n.resolvedLanguage ?? null,
      titleLanguage: titleLanguage ?? null,
    })

    // 使用现有代理或创建临时代理
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        const resolvedMiniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: resolvedMiniModel,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`)
      } catch (error) {
        sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error)
        return { success: false, error: 'Failed to create agent for title generation' }
      }
    }

    if (!agent) {
      sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)


    // 通知渲染器标题重新生成已开始（用于闪烁效果）
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)
    // 保留旧版事件以实现向后兼容
    this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: true }, managed.workspace.id)

    try {
      const title = await agent.regenerateTitle(userMessages, assistantResponse, titleOptions)
      sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // title_generated 也会通过事件处理程序清除 isRegeneratingTitle
        this.sendEvent({ type: 'title_generated', sessionId, title }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      // 生成失败 - 清除正在重新生成的状态
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      // 发生错误 - 清除正在重新生成的状态
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error)
      return { success: false, error: message }
    } finally {
      // 清理临时代理
      if (isTemporary && agent) {
        agent.destroy()
      }
      // 信号异步操作结束
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * 更新会话的工作目录。
   *
   * 如果尚未发送任何消息（无 SDK 交互），则同时更新 sdkCwd，
   * 以便 SDK 使用新路径进行转录存储。这可以防止用户在
   * 发送第一条消息之前更改工作目录时出现令人困惑的
   * “bash shell 从不同目录运行”警告。
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const validation = isValidWorkingDirectory(path)
      if (!validation.valid) {
        sessionLog.warn(`Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`)
        this.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: validation.reason!,
        }, managed.workspace.id)
        return
      }

      managed.workingDirectory = path

      // 使依赖于工作目录的文件系统缓存失效
      invalidateContextFileCache(path)
      invalidateSkillsCache()

      // 检查是否也可以更新 sdkCwd（如果尚无 SDK 交互则安全）
      // 条件：未发送消息且尚未创建代理（无 SDK 会话）
      const shouldUpdateSdkCwd =
        managed.messages.length === 0 &&
        !managed.sdkSessionId &&
        !managed.agent

      if (shouldUpdateSdkCwd) {
        managed.sdkCwd = path
        sessionLog.info(`Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`)
      }

      // 如果代理存在，也更新代理的会话配置
      if (managed.agent) {
        managed.agent.updateWorkingDirectory(path)
        // 如果代理存在但条件仍允许 sdkCwd 更新（边缘情况），
        // 同时更新 agent 的 sdkCwd
        if (shouldUpdateSdkCwd) {
          managed.agent.updateSdkCwd(path)
        }
      }

      this.persistSession(managed)
      // 通知渲染器工作目录已变更
      this.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory: path }, managed.workspace.id)
    }
  }

  /**
   * 更新会话的模型
   * 传入 null 可清除会话专属模型（将使用全局配置）
   * @param connection - 可选的 LLM 连接标识（仅在未锁定时生效）
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    sessionLog.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`)
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.model = model ?? undefined
      // 如果提供了连接且尚未锁定，也一并更新
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection
      }
      // 持久化到磁盘（如果连接已更新则包含连接信息）
      const updates: { model?: string; llmConnection?: string } = { model: model ?? undefined }
      if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      // 如果 agent 模型已存在则更新（下次查询时生效）
      if (managed.agent) {
        // 回退链：会话模型 > 工作区默认值 > 连接默认值
        const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const sessionConn = resolveSessionConnection(managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!
        sessionLog.info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`)
        managed.agent.setModel(effectiveModel)
      } else {
        sessionLog.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`)
      }
      // 通知渲染器模型已变更
      this.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * 更新会话中指定消息的内容
   * 预览窗口使用此方法将编辑后的内容保存回原始消息
   */
  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update message: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update message: message ${messageId} not found in session ${sessionId}`)
      return
    }

    // 更新消息内容
    message.content = content
    // 持久化更新后的会话
    this.persistSession(managed)
    sessionLog.info(`Updated message ${messageId} content in session ${sessionId}`)
  }

  /**
   * 为消息添加注解并持久化会话。
   */
  addMessageAnnotation(sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      sessionLog.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(a => a.id === safeAnnotation.id)) {
      sessionLog.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      sessionLog.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * 修补消息上的现有注解。
   */
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex(a => a.id === annotationId)
    if (idx === -1) {
      sessionLog.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      sessionLog.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * 从消息中移除注解并持久化会话。
   */
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(a => a.id === annotationId)) {
      sessionLog.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(a => a.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // 删除前获取工作区标识
    const workspaceRootPath = managed.workspace.rootPath

    // 如果正在处理中，通过 Query.close() 强制中止并等待清理完成
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // 短暂等待查询完成拆卸，然后再删除会话文件
      // 防止快速删除操作期间因重叠写入导致文件损坏
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // 如果会话已共享则撤销共享（防止产生孤立的查看者副本）
    if (managed.sharedId) {
      try {
        const { VIEWER_URL } = await import('@craft-agent/shared/branding')
        const response = await fetch(
          `${VIEWER_URL}/s/api/${managed.sharedId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(5000) }
        )
        if (!response.ok) {
          sessionLog.warn(`Failed to revoke share for ${sessionId}: HTTP ${response.status}`)
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }

    // 清理增量刷新定时器，防止产生孤立定时器
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }
    this.pendingDeltas.delete(sessionId)
    this.clearAdminRememberApprovalsForSession(sessionId)
    this.clearPendingPermissionRequestsForSession(sessionId)

    // 取消任何待处理的持久化写入（会话正在删除，无需保存）
    sessionPersistenceQueue.cancel(sessionId)

    // 清理会话范围内的工具回调，防止内存累积
    unregisterSessionScopedToolCallbacks(sessionId)

    // 销毁绑定到此会话的浏览器实例
    const sessionBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (sessionBpm) {
      sessionBpm.destroyForSession(sessionId)
    }
    // 销毁时删除会话级别的远程桥接和主机客户端固定引用
    this.remoteBpms.delete(sessionId)
    this.browserHostByCanvas.delete(sessionId)

    // 释放 agent 以清理 ConfigWatchers、事件监听器、MCP 连接
    if (managed.agent) {
      managed.agent.dispose()
    }

    // 停止池服务器（用于外部 SDK 子进程的 HTTP MCP 服务器）
    if (managed.poolServer) {
      managed.poolServer.stop().catch(err => {
        sessionLog.warn(`Failed to stop pool server for ${sessionId}: ${err instanceof Error ? err.message : err}`)
      })
    }

    // 取消任何待处理的源激活自动重试定时器 (craft-agents-oss#804)
    if (managed.autoRetryTimer) {
      clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
    }
    managed.autoRetryPending = undefined

    this.sessions.delete(sessionId)

    // 清理 AutomationSystem 中的会话元数据（防止内存泄漏）
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.removeSessionMetadata(sessionId)
    }

    // 同时从磁盘删除
    deleteStoredSession(workspaceRootPath, sessionId)

    // 通知该工作区的所有窗口会话已被删除
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)
    this.emitUnreadSummaryChanged()

    // 清理附件目录（由工作区范围存储的 deleteStoredSession 处理）
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  /**
   * 发送消息：会话生命周期的核心入口。
   *
   * 处理流程：
   * 1. 确保消息已懒加载（`ensureMessagesLoaded`）；
   * 2. 如果当前正在处理（`isProcessing === true`）：
   *    - 根据 connection 的 `midStreamBehavior` 决定 steer（中途改向）或 queue（排队）；
   *    - steer 成功则直接把消息插入当前 turn；
   *    - steer 失败或 queue 策略则把消息加入 `messageQueue`，设置 `wasInterrupted`，
   *      等当前 turn 结束后再重放。
   * 3. 如果空闲：
   *    - 创建用户消息并持久化到磁盘（#616：在通知 UI "accepted" 前必须先落盘）；
   *    - 首次用户消息时生成临时标题并异步生成 AI 标题；
   *    - 预启用 skill 所需的 sources；
   *    - 刷新过期 OAuth token；
   *    - `getOrCreateAgent` 获取/创建 Agent；
   *    - 调用 `agent.chat()` 进入事件循环；
   *    - 对每个事件调用 `processEvent`；
   *    - 收到 `complete` 事件或异常时进入 `onProcessingStopped`。
   *
   * 与 Go 的类比：
   * - 这就像一个 `SendMessage(ctx, req) error` 的 RPC handler；
   * - `for await (const event of chatIterator)` 类似 Go 里 `for event := range agent.Stream()`。
   *
   * Agent 开发关键点：
   * - 用户消息必须先写磁盘再 ack，防止服务器崩溃导致消息丢失；
   * - `processingGeneration` 用于防止旧 turn 的 finally 块覆盖新 turn 的状态；
   * - 认证过期时会走 `attemptAuthRetry`：销毁 Agent、刷新 token、重发上一条消息。
   */
  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    /**
     * 内部钩子，在用户消息已推送到 `managed.messages` 并持久化到磁盘后、
     * 模型流式处理开始前触发。RPC 处理器使用此钩子向客户端发送同步的“已接受”
     * 确认，以便流处理中途崩溃不会丢失用户消息 (#616)。
     * 预持久化错误仍会像之前一样拒绝外部 promise。
     */
    onAck?: (messageId: string) => void,
    /**
     * 可选的传输上下文。`sessions.sendMessage` RPC 处理器传递
     * `{ callerClientId: ctx.clientId }`，以便 SM 可以固定应托管此会话浏览器工具的桌面客户端。
     * 直接调用时（测试、服务器内部流程）传入 undefined 以保持现有固定不变。
     */
    rpcContext?: { callerClientId?: string },
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }
    this.setLastMessageClientId(sessionId, rpcContext?.callerClientId)

    // 源激活自动重试去重 (craft-agents-oss#804)。当服务器
    // 刚刚调度或提交了“[<slug> activated]”重试时，丢弃来自仍在运行客户端端
    // auto_retry 的旧版渲染器的匹配
    // 重复项。第一个匹配的调用者获胜（服务器定时器或旧版 RPC，
    // 以先到者为准），截止时间内后续匹配的调用将被丢弃。
    if (claimAutoRetryPending(managed, message) === 'drop') {
      sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`)
      return
    }

    // 发送新用户消息时清除任何待处理的计划执行状态。
    // 这充当安全阀——如果用户继续前进，我们不希望
    // 稍后自动执行旧计划。
    await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)

    // 确保在尝试添加新消息之前已加载消息
    await this.ensureMessagesLoaded(managed)

    // 如果当前正在处理，行为取决于连接的
    // `midStreamBehavior`（通过 {@link resolveMidStreamBehavior} 解析，
    // 默认为适合提供商的值）：
    //
    // - 'steer': 尝试传递到正在进行的轮次中。Pi 原生支持转向；
    //   Claude 通过 PreToolUse 钩子模拟。如果 `redirect()` 返回 false
    //   （Claude 没有实时查询，或后端无法转向），后端已
    //   调用 forceAbort(Redirect) 并且我们将其排队等待重放。
    // - 'queue': 保持消息不变；当前轮次继续运行
    //   直到自然完成；然后作为新轮次重放。不调用
    //   `agent.redirect()`，不 forceAbort，不中断。
    if (managed.isProcessing) {
      const connection = resolveSessionConnection(managed.llmConnection, undefined)
      // 当无法解析连接时回退到 'steer'——保留
      // 当前的确切行为（调用 redirect，接受其返回的任何值）。
      const behavior = connection ? resolveMidStreamBehavior(connection) : 'steer'

      const agent = managed.agent
      let steered = false
      if (behavior === 'steer') {
        steered = agent?.redirect(message) ?? false
      }
      // 对于 'queue'：完全跳过 redirect。当前轮次不受干扰。

      sessionLog.info('mid-stream send', {
        sessionId,
        behavior,
        steered,
        queueLengthBefore: managed.messageQueue.length,
        backend: agent ? agent.constructor.name : 'none',
        connectionSlug: connection?.slug,
      })

      // 为 UI 创建用户消息
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments,
        badges: options?.badges,
        // Hidden system-generated messages reach the model but never render as a
        // transcript bubble (e.g. background-task-completion nudge).
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)

      // 发送到 UI——如果转向成功则为 'accepted'；否则为 'queued'
      // （涵盖 queue-direct 和 queue-after-abort 两种路径）。
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: steered ? 'accepted' : 'queued',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      if (!steered) {
        // 推入 FIFO 队列，等待下次 onProcessingStopped 触发时重放。形状
        // 对于 queue-direct（当前轮次仍在运行）和
        // queue-after-abort（后端已中止）相同——processNextQueuedMessage 中的
        // 重放路径完全相同。
        managed.messageQueue.push({ message, attachments, storedAttachments, options, messageId: userMessage.id, optimisticMessageId: options?.optimisticMessageId })
        managed.wasInterrupted = true
      }

      this.persistSession(managed)
      // 强制同步刷新，以便用户消息真正写入磁盘
      // 然后才告诉渲染器“已接受”——`persistSession` 仅
      // 以 500ms 防抖入队。(#616 可靠性修复。)
      await this.flushSession(managed.id)
      onAck?.(userMessage.id)
      return
    }

    // 添加带有已存储附件的用户消息以进行持久化
    // 如果提供了 existingMessageId 则跳过（消息在排队时已创建）
    let userMessage: Message
    if (existingMessageId) {
      // 查找现有消息（排队时已添加）
      userMessage = managed.messages.find(m => m.id === existingMessageId)!
      if (!userMessage) {
        throw new Error(`Existing message ${existingMessageId} not found`)
      }
    } else {
      // 创建新消息
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments, // 包含用于持久化的内容（有 thumbnailBase64）
        badges: options?.badges,  // 包含内容徽章（来源、带有嵌入图标的技能）
        // hidden 系统生成消息会到达模型，但绝不渲染为消息气泡（例如后台任务完成的提醒）。
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)

      // 更新 lastMessageRole 以显示徽章。hidden 消息跳过此项，
      // 以免会话列表预览被一条不可见的系统提醒短暂驱动。
      if (!options?.hidden) {
        managed.lastMessageRole = 'user'
      }

      // 在宣布之前持久化并刷新——用户消息必须
      // 真正写入磁盘，然后才能告诉渲染器“已接受”，并且
      // `persistSession` 是防抖的（500ms）。#616。
      this.persistSession(managed)
      await this.flushSession(managed.id)
      onAck?.(userMessage.id)

      // 发送 user_message 事件，以便 UI 可以确认乐观消息
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      // 如果这是第一条用户消息且没有标题，则立即设置一个
      // AI 生成稍后会优化它，但我们始终从一开始就有标题
      // 自动化会话（设置了 triggeredBy）已有标题，完全跳过 AI 生成
      const isFirstUserMessage = managed.messages.filter(m => m.role === 'user').length === 1
      if (isFirstUserMessage && !managed.name && !managed.triggeredBy) {
        // 将括号提及替换为其显示标签（例如 [skill:ws:commit] -> "Commit"）
        // 以便标题显示人类可读的名称而不是原始 ID
        let titleSource = message
        if (options?.badges) {
          for (const badge of options.badges) {
            if (badge.rawText && badge.label) {
              titleSource = titleSource.replace(badge.rawText, badge.label)
            }
          }
        }
        // 清理：去除任何剩余的括号提及、XML 块、标签
        const sanitized = sanitizeForTitle(titleSource)
        const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '')
        managed.name = initialTitle
        this.persistSession(managed)
        // 立即刷新，以便在通知渲染器之前磁盘数据是权威的
        await this.flushSession(managed.id)
        this.sendEvent({
          type: 'title_generated',
          sessionId,
          title: initialTitle,
        }, managed.workspace.id)

        // 使用 agent 的 SDK 异步生成 AI 标题
        // （如果需要，短暂等待 agent 创建）
        this.generateTitle(managed, message)
      }
    }

    // 针对用户消息评估自动标签规则（新鲜消息和排队消息的
    // 通用路径）。扫描标签上配置的正则表达式模式，
    // 然后将任何新匹配项合并到会话的标签数组中。
    try {
      const labelTree = listLabels(managed.workspace.rootPath)
      const autoMatches = evaluateAutoLabels(message, labelTree)

      if (autoMatches.length > 0) {
        const existingLabels = managed.labels ?? []
        const newEntries = autoMatches
          .map(m => `${m.labelId}::${m.value}`)
          .filter(entry => !existingLabels.includes(entry))

        if (newEntries.length > 0) {
          managed.labels = [...existingLabels, ...newEntries]
          this.persistSession(managed)
          this.sendEvent({
            type: 'labels_changed',
            sessionId,
            labels: managed.labels,
          }, managed.workspace.id)
        }
      }
    } catch (e) {
      sessionLog.warn(`Auto-label evaluation failed for session ${sessionId}:`, e)
    }

    managed.lastMessageAt = Date.now()
    this.setProcessing(managed, true)
    managed.streamingText = ''
    managed.processingGeneration++
    managed.turnStartFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)

    // 为此新消息重置身份验证重试标志（每条消息允许一次重试）
    // 重要：如果这是身份验证重试调用，则跳过重置——该标志已为 true
    // 重置它会导致无限重试循环
    // 注意：authRetryInProgress 此处不重置——它由重试逻辑管理
    if (!_isAuthRetry) {
      managed.authRetryAttempted = false
    }

    // 存储消息/附件，以便在身份验证刷新后可能重试
    // （SDK 子进程在启动时缓存令牌，因此如果它在会话期间过期，
    // 我们需要重新创建 agent 并重试消息）
    managed.lastSentMessage = message
    managed.lastSentAttachments = attachments
    managed.lastSentStoredAttachments = storedAttachments
    managed.lastSentOptions = options

    // 捕获生成标识，以检测新请求是否取代了此请求。
    // 这可以防止当后续消息到达时，finally 块破坏状态。
    const myGeneration = managed.processingGeneration

    // 预启用被调用技能所需的来源（Issue #249）
    // 这消除了 agent 在运行时发现缺少来源的两轮惩罚。
    // 使用有针对性的 loadSkillBySlug() 而不是 loadAllSkills() 以避免 O(N) 文件系统扫描。
    if (options?.skillSlugs?.length) {
      try {
        const workspaceRoot = managed.workspace.rootPath

        const requiredSources = new Set<string>()
        for (const slug of options.skillSlugs) {
          const skill = loadSkillBySlug(workspaceRoot, slug, managed.workingDirectory)
          if (skill?.metadata.requiredSources) {
            for (const src of skill.metadata.requiredSources) {
              requiredSources.add(src)
            }
          }
        }

        if (requiredSources.size > 0) {
          const currentSlugs = new Set(managed.enabledSourceSlugs || [])
          const toEnable: string[] = []
          const skipped: string[] = []
          const candidateSlugs = Array.from(requiredSources)
          const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs)
          const usableSources = new Set(
            loadedSources
              .filter(isSourceUsable)
              .map(source => source.config.slug)
          )

          for (const srcSlug of candidateSlugs) {
            if (currentSlugs.has(srcSlug)) continue
            if (usableSources.has(srcSlug)) {
              toEnable.push(srcSlug)
            } else {
              skipped.push(srcSlug)
            }
          }

          if (skipped.length > 0) {
            sessionLog.warn(`Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`)
          }

          if (toEnable.length > 0) {
            managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable]
            sessionLog.info(`Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`)
            this.persistSession(managed)
            this.sendEvent({
              type: 'sources_changed',
              sessionId,
              enabledSourceSlugs: managed.enabledSourceSlugs,
            }, managed.workspace.id)
          }
        }
      } catch (e) {
        sessionLog.warn(`Failed to pre-enable skill sources for session ${sessionId}:`, e)
      }
    }

    // 为整个 sendMessage 流程启动性能跨度
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    const workspaceRootPath = managed.workspace.rootPath
    const enabledSlugs = managed.enabledSourceSlugs ?? []
    const hasSources = enabledSlugs.length > 0

    // 预先加载已启用的来源，以便在 getOrCreateAgent
    // 运行其内部冷会话构建之前刷新令牌。否则该构建会看到过时的令牌
    // 并发出 AUTH_REQUIRED，导致在
    // 构建后刷新恢复状态之前出现短暂的“needs_auth”UI 闪烁 (#710)。
    const sources: LoadedSource[] = hasSources
      ? getSourcesBySlugs(workspaceRootPath, enabledSlugs)
      : []

    if (hasSources && managed.tokenRefreshManager) {
      const refreshResult = await refreshExpiredCredentials(sources, managed.tokenRefreshManager)
      if (refreshResult.failedSources.length > 0) {
        sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug))
      }
      if (refreshResult.refreshedCount > 0) {
        sendSpan.mark('oauth.refreshed')
      }
    }

    // 获取或创建 agent（延迟加载）。其内部冷会话构建在
    // ~L2956 处现在看到的是新令牌（或正确需要身份验证的失败来源，因为
    // ensureFreshToken 将磁盘写入镜像到内存中的 source.config）。
    const agent = await this.getOrCreateAgent(managed)
    sendSpan.mark('agent.ready')

    // 始终设置所有来源以提供上下文（即使没有启用），包括内置来源
    const allSources = loadAllSources(workspaceRootPath)
    agent.setAllSources(allSources)
    sendSpan.mark('sources.loaded')

    // 如果启用了任何来源服务器，则应用它们
    if (hasSources) {
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      // 单次全新构建——令牌已在上方刷新。
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      const mcpCount = Object.keys(mcpServers).length
      const apiCount = Object.keys(apiServers).length
      if (mcpCount > 0 || apiCount > 0 || enabledSlugs.length > 0) {
        const usableSources = sources.filter(isSourceUsable)
        const intendedSlugs = usableSources.map(s => s.config.slug)
        await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
        await applyBridgeUpdates(agent, sessionPath, usableSources, mcpServers, sessionId, workspaceRootPath, 'send message', managed.poolServer?.url)
        sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`)
      }
      sendSpan.mark('servers.applied')
    }

    try {
      sessionLog.info('Starting chat for session:', sessionId)
      sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
      sessionLog.info('Message:', message)
      sessionLog.info('Agent model:', agent.getModel())
      sessionLog.info('process.cwd():', process.cwd())

      // 通过 agent 处理消息
      sessionLog.info('Calling agent.chat()...')
      if (attachments?.length) {
        sessionLog.info('Attachments:', attachments.length)
      }

      // 通过 @提及 提到的技能由 SDK 的 Skill 工具处理。
      // UI 层（mentions.ts 中的 extractBadges）在 rawText 中注入完全限定名称，
      // 而 craft-agent.ts 中的 canUseTool 提供回退
      // 以限定短名称。此处无需转换。

      // 确保主进程从正确的会话目录读取工具元数据。
      // 必须在每次 chat() 调用之前设置，因为多个会话共享该进程。
      const chatSessionDir = getSessionStoragePath(workspaceRootPath, sessionId)
      toolMetadataStore.setSessionDir(chatSessionDir)

      // 注入中断上下文，以便 LLM 知道上一轮被截断。
      // 使用 <system-reminder> 标签，以便 LLM 将其视为临时系统指导，
      // 而不是用户消息内容的一部分。原始消息存储在
      // 会话 JSONL 中（第 ~3952 行）；这仅影响 SDK 的进程内上下文。
      let effectiveMessage = message
      if (managed.wasInterrupted) {
        effectiveMessage = `${message}\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>`
        managed.wasInterrupted = false
      }

      const messageBackendContext = resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug: loadWorkspaceConfig(workspaceRootPath)?.defaults?.defaultLlmConnection,
        managedModel: managed.model,
      })
      const modelInputAttachments = filterAttachmentsForModelInput(
        attachments,
        messageBackendContext.connection,
        messageBackendContext.resolvedModel,
      )
      if (modelInputAttachments.omittedImages.length > 0) {
        const omittedNames = modelInputAttachments.omittedImages.map(a => a.name).join(', ')
        sessionLog.info(`Omitting ${modelInputAttachments.omittedImages.length} image attachment(s) from model input for ${messageBackendContext.resolvedModel}: ${omittedNames}`)
        this.sendEvent({
          type: 'info',
          sessionId,
          message: `Image attachment${modelInputAttachments.omittedImages.length === 1 ? '' : 's'} not sent because image input is disabled for ${messageBackendContext.resolvedModel}.`,
          level: 'warning',
        }, managed.workspace.id)
      }

      sendSpan.mark('chat.starting')
      const chatIterator = agent.chat(effectiveMessage, modelInputAttachments.attachments)
      sessionLog.info('Got chat iterator, starting iteration...')

      for await (const event of chatIterator) {
        // 记录事件（跳过嘈杂的 text_delta）
        if (event.type !== 'text_delta') {
          if (event.type === 'tool_start') {
            sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`)
          } else if (event.type === 'tool_result') {
            sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`)
          } else {
            sessionLog.info('Got event:', event.type)
          }
        }

        // 首先处理事件
        await this.processEvent(managed, event)

        // 回退：如果 onSdkSessionIdUpdate 回调未触发，则捕获 SDK 会话 ID。
        // 主要捕获发生在 getOrCreateAgent() 中，通过 onSdkSessionIdUpdate 回调，
        // 该回调会立即刷新到磁盘。此回退处理回调可能
        // 不触发的边缘情况（例如，SDK 版本不匹配，不支持回调）。
        if (!managed.sdkSessionId) {
          const sdkId = agent.getSessionId()
          if (sdkId) {
            managed.sdkSessionId = sdkId
            sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
            // 由于处于回退模式，也在此处刷新
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          }
        }

        // 处理 complete 事件——SDK 始终发送此事件（即使在中断后）
        // 这是处理结束的中心位置
        if (event.type === 'complete') {
          // 如果身份验证重试正在进行，则跳过正常的完成处理
          // 重试将处理其自身的完成
          if (managed.authRetryInProgress) {
            sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling')
            sendSpan.mark('chat.complete.auth_retry_pending')
            sendSpan.end()
            return  // 退出函数——重试将处理完成
          }

          // 身份验证/计划交接路径已停止处理并向渲染器发出 complete
          // 事件。忽略后端的尾部 complete 以避免
          // 双重清理和重复的 UI 完成事件。
          if (!managed.isProcessing) {
            sessionLog.info('Chat completed after explicit handoff/stop; skipping normal completion handling')
            sendSpan.mark('chat.complete.already_stopped')
            sendSpan.end()
            return
          }

          sessionLog.info('Chat completed via complete event')

          // 检查本轮是否收到了助手响应
          // 如果没有，SDK 可能遇到了上下文限制或其他问题
          const lastAssistantMsg = [...managed.messages].reverse().find(m =>
            m.role === 'assistant' && !m.isIntermediate
          )
          const lastUserMsg = [...managed.messages].reverse().find(m => m.role === 'user')

          // 如果最后一条用户消息比任何助手响应都新，则说明没有收到回复
          // 可能由上下文溢出或 API 问题导致
          if (lastUserMsg && (!lastAssistantMsg || lastUserMsg.timestamp > lastAssistantMsg.timestamp)) {
            sessionLog.warn(`Session ${sessionId} completed without assistant response - possible context overflow or API issue`)

            // 检查是否有捕获到的 API 错误可以解释静默失败
            // 传入显式会话路径，避免读取错误的会话
            // （_sessionDir 单例可能被并发会话覆盖）
            const sessionErrorPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
            const apiError = getLastApiError(sessionErrorPath)

            if (apiError && apiError.status === 400) {
              const isImageError = apiError.message?.includes('image exceeds')

              const errorMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: isImageError
                  ? `Image Too Large: ${apiError.message}`
                  : `Request Error: ${apiError.message}`,
                timestamp: this.monotonic(),
                errorCode: isImageError ? 'image_too_large' : 'invalid_request',
                errorTitle: isImageError ? 'Image Too Large' : 'Invalid Request',
                errorDetails: isImageError
                  ? ['An image in the conversation exceeds the 5 MB API limit.',
                     'This session cannot recover — the image is embedded in the history.',
                     'Please start a new session to continue.']
                  : [apiError.message],
                errorCanRetry: false,
              }
              managed.messages.push(errorMessage)
              this.sendEvent({
                type: 'typed_error',
                sessionId,
                error: {
                  code: isImageError ? 'image_too_large' as const : 'invalid_request' as const,
                  title: errorMessage.errorTitle!,
                  message: apiError.message,
                  actions: [],
                  canRetry: false,
                  details: errorMessage.errorDetails,
                },
              }, managed.workspace.id)
            }
          }

          sendSpan.mark('chat.complete')
          sendSpan.end()
          this.onProcessingStopped(sessionId, 'complete')
          return  // 退出函数，跳过 finally 块（onProcessingStopped 处理清理）
        }

        // 注意：我们不再因 !isProcessing 或 stopRequested 而提前中断
        // 软中断（forceAbort）后，后端设置 turnComplete=true，导致
        // 生成器产出剩余排队事件，然后自然完成
        // 这确保我们不会丢失正在传输的消息
      }

      // 循环退出——要么通过 complete 事件（正常），要么生成器在软中断后结束
      if (!managed.isProcessing) {
        sessionLog.info('Chat loop exited after explicit handoff/stop')
        sendSpan.mark('chat.exit.already_stopped')
        sendSpan.end()
      } else if (managed.stopRequested) {
        sessionLog.info('Chat loop completed after stop request - events drained successfully')
        this.onProcessingStopped(sessionId, 'interrupted')
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
      // 检查是否为中止错误（中断时预期出现）
      const isAbortError = error instanceof Error && (
        error.name === 'AbortError' ||
        error.message === 'Request was aborted.' ||
        error.message.includes('aborted')
      )

      if (isAbortError) {
        // 提取中止原因（如有）（防止意外中止传播的安全网）
        const reason = (error as DOMException).cause as AbortReason | undefined

        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
        sendSpan.mark('chat.aborted')
        sendSpan.setMetadata('abort_reason', reason || 'unknown')
        sendSpan.end()

        // UI 交接路径（计划提交、认证请求）自行处理清理
        // 通过直接设置 isProcessing = false。所有其他中止原因
        // 都通过 onProcessingStopped 进行队列排空
        if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
          this.onProcessingStopped(sessionId, 'interrupted')
        }
      } else {
        sessionLog.error('Error in chat:', error)
        sessionLog.error('Error message:', error instanceof Error ? error.message : String(error))
        sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack')

        // 通过运行时钩子报告聊天/SDK 错误（Electron 可转发到 Sentry）
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat', sessionId })

        sendSpan.mark('chat.error')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        this.sendEvent({
          type: 'error',
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error'
        }, managed.workspace.id)
        // 通过集中式处理器处理错误
        this.onProcessingStopped(sessionId, 'error')
      }
    } finally {
      // 仅处理意外退出的清理（循环中断但没有 complete 事件）
      // 正常完成在调用 onProcessingStopped 后提前返回
      // 错误在 catch 块中处理
      if (managed.isProcessing && managed.processingGeneration === myGeneration) {
        sessionLog.info('Finally block cleanup - unexpected exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
        this.onProcessingStopped(sessionId, 'interrupted')
      }
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.isProcessing) {
      return // 未在处理中，无需取消
    }

    sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '')

    // 收集排队消息文本，以便在清除前恢复输入
    const queuedTexts = managed.messageQueue.map(q => q.message)

    // 收集排队消息 ID，以便从消息数组中移除它们
    // （它们在处理期间调用 sendMessage 时被添加）
    const queuedMessageIds = new Set(
      managed.messageQueue.map(q => q.messageId).filter((id): id is string => !!id)
    )

    // 清除队列——用户显式停止，不处理排队消息
    managed.messageQueue = []

    // 从持久化消息数组中移除排队的用户消息
    if (queuedMessageIds.size > 0) {
      managed.messages = managed.messages.filter(m => !queuedMessageIds.has(m.id))
    }

    // 发出停止意图——让事件循环在清除 isProcessing 前排空剩余事件
    // 这防止软中断后丢失正在传输的消息
    managed.stopRequested = true

    // 跟踪中断，以便下一条用户消息获得上下文提示
    // 告知 LLM 之前的响应被截断
    managed.wasInterrupted = true

    // 通过 Query.close() 强制中止——向后端发送软中断
    if (managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
    }

    // 仅在用户显式点击停止时显示“响应已中断”消息
    // 静默模式用于重定向（在处理中发送新消息）
    if (!silent) {
      const interruptedMessage: Message = {
        id: generateMessageId(),
        role: 'info',
        content: 'Response interrupted',
        timestamp: this.monotonic(),
      }
      managed.messages.push(interruptedMessage)
      this.sendEvent({
        type: 'interrupted',
        sessionId,
        message: interruptedMessage,
        // 包含排队文本，以便 UI 可以将其恢复到输入字段
        ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
      }, managed.workspace.id)
    } else {
      // 仍然发送中断事件，但不带消息（用于 UI 状态更新）
      this.sendEvent({
        type: 'interrupted',
        sessionId,
        // 包含排队文本，以便 UI 可以将其恢复到输入字段
        ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
      }, managed.workspace.id)
    }

    // 安全超时：如果事件循环在 5 秒内未完成，则强制清理
    // 这处理生成器卡住的情况
    setTimeout(() => {
      if (managed.stopRequested && managed.isProcessing) {
        sessionLog.warn('Generator did not complete after stop request, forcing cleanup')
        this.onProcessingStopped(sessionId, 'timeout')
      }
    }, 5000)

    // 注意：我们不再在此处清除 isProcessing 或发送 complete 事件
    // 事件循环将排空剩余事件，并在完成时调用 onProcessingStopped
  }

  /**
   * 尝试认证重试：刷新令牌、销毁代理、重新发送最后一条消息
   * 由 typed_error 和普通错误认证重试路径共享
   * 如果重试已启动则返回 true，如果条件不满足则返回 false
   */
  private attemptAuthRetry(
    sessionId: string,
    managed: ManagedSession,
    workspaceId: string,
    failureErrorCode?: string,
  ): boolean {
    if (managed.authRetryAttempted || !managed.lastSentMessage) return false

    sessionLog.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`)
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true

    // 发出轻量级信息，让用户看到进度而不是可怕的红色错误
    this.sendEvent({
      type: 'info',
      sessionId,
      message: 'Token expired, refreshing session…',
      timestamp: this.monotonic(),
    }, workspaceId)

    setImmediate(async () => {
      try {
        // 1. 重置摘要客户端，使其获取新凭据
        sessionLog.info(`[auth-retry] Resetting summarization client for session ${sessionId}`)
        resetSummarizationClient()

        // 2. 销毁代理——新代理的 postInit() 将刷新认证
        sessionLog.info(`[auth-retry] Destroying agent for session ${sessionId}`)
        managed.agent = null

        // 3. 重试消息
        const retryMessage = managed.lastSentMessage
        const retryAttachments = managed.lastSentAttachments
        const retryStoredAttachments = managed.lastSentStoredAttachments
        const retryOptions = managed.lastSentOptions

        if (retryMessage) {
          sessionLog.info(`[auth-retry] Retrying message for session ${sessionId}`)
          this.setProcessing(managed, false)

          // 移除为此失败尝试添加的用户消息
          // 以便重试时不会出现重复消息
          const lastUserMsgIndex = managed.messages.findLastIndex(m => m.role === 'user')
          if (lastUserMsgIndex !== -1) {
            managed.messages.splice(lastUserMsgIndex, 1)
          }

          managed.authRetryInProgress = false

          await this.sendMessage(
            sessionId,
            retryMessage,
            retryAttachments,
            retryStoredAttachments,
            retryOptions,
            undefined,  // existingMessageId
            true        // _isAuthRetry - 防止无限重试循环
          )
          sessionLog.info(`[auth-retry] Retry completed for session ${sessionId}`)
        } else {
          managed.authRetryInProgress = false
        }
      } catch (retryError) {
        managed.authRetryInProgress = false
        sessionLog.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError)
        sessionRuntimeHooks.captureException(retryError, { errorSource: 'auth-retry', sessionId })
        const failedMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: 'Authentication failed. Please check your credentials.',
          timestamp: this.monotonic(),
          errorCode: failureErrorCode,
        }
        managed.messages.push(failedMessage)
        this.sendEvent({
          type: 'error',
          sessionId,
          error: 'Authentication failed. Please check your credentials.',
          timestamp: failedMessage.timestamp,
        }, workspaceId)
        this.onProcessingStopped(sessionId, 'error')
      }
    })

    return true
  }

  /**
   * 进程内会话完成接缝的监听器（见 SessionCompletionEvent）。
   * 供 Tasks Conductor 使用；在有人订阅之前为空，因此零开销。
   */
  private sessionCompletionListeners = new Set<(evt: SessionCompletionEvent) => void>()

  /**
   * 订阅进程内的会话完成（Tasks Conductor 接缝）。
   * 返回一个取消订阅函数。不是渲染器事件；不对 agent 暴露。
   */
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.sessionCompletionListeners.add(listener)
    return () => {
      this.sessionCompletionListeners.delete(listener)
    }
  }

  private emitSessionComplete(evt: SessionCompletionEvent): void {
    if (this.sessionCompletionListeners.size === 0) return
    for (const listener of this.sessionCompletionListeners) {
      try {
        listener(evt)
      } catch (err) {
        sessionLog.error(`onSessionComplete listener threw for session ${evt.sessionId}:`, err)
      }
    }
  }

  /**
   * 处理停止后的统一清理与队列调度入口。
   * 单一事实来源。
   *
   * 这是会话生命周期的“收尾函数”，任何原因导致 Agent 停止后都会进入这里：
   * 1. 重置 `isProcessing`、`stopRequested`；
   * 2. 清理浏览器面板 overlay（但保留窗口所有权，除非队列已空）；
   * 3. 根据用户是否正在查看本会话，更新未读状态；
   * 4. mini agent 自动标记为 done；
   * 5. 应用处理期间被延迟的外部元数据更新；
   * 6. 如果 `messageQueue` 非空，调用 `processNextQueuedMessage` 重放下一条；
   * 7. 如果队列为空，释放浏览器窗口绑定并向前端发送 `complete` 事件；
   * 8. 持久化会话。
   *
   * 与 Go 的类比：
   * - 类似 Go 里一个 `defer cleanup()` 或 `finally` 块，负责状态机收尾；
   * - 这里的“队列”类似 Go 的 channel，但用数组 + setImmediate 模拟异步消费。
   */
  private async onProcessingStopped(
    sessionId: string,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    // 1. 清理状态
    this.setProcessing(managed, false)
    managed.stopRequested = false  // 为下一轮重置

    // 1b. Orphan backstop: with the default per-turn subprocess model, any
    // background sub-agent still marked `running` dies when this turn's
    // subprocess is torn down. Flip those registry entries to `orphaned` so a
    // later "status?" query never reports a dead task as running. Suppressed
    // when WS2 keep-alive keeps the query alive across turns.
    this.markOrphanedBackgroundTasks(sessionId)

    const turnStartFinalMessageId = managed.turnStartFinalMessageId
    managed.turnStartFinalMessageId = undefined

    // 在轮次之间清除代理控制覆盖层。会话保留浏览器
    // 所有权（boundSessionId）——仅移除视觉覆盖层
    // 当队列为空时（会话真正结束），在下方进行完全解绑
    const turnBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (turnBpm) {
      // Same guard as the queue-empty teardown below: a remote BPM throw on a
      // headless server must not abort processing-stop handling.
      try {
        await turnBpm.clearVisualsForSession(sessionId)
      } catch (err) {
        sessionLog.warn(`Browser-pane visual clear failed for ${sessionId} (continuing):`, err)
      }
    }

    // 2. 根据用户是否正在查看此会话处理未读状态
    //    这是 NEW 徽章的显式状态机：
    //    - 如果用户正在查看：标记为已读（他们看到它完成）
    //    - 如果用户未查看：标记为未读（他们有新内容）
    //    重要：仅当该轮产生了新的最终助手消息时应用此逻辑
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const currentFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        // 用户正在观看——立即标记为已读
        await this.markSessionRead(sessionId)
      } else {
        // 用户未观看——标记为未读以显示 NEW 徽章
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. 自动完成迷你代理会话，避免会话列表杂乱
    //    迷你代理从 EditPopovers 生成，用于快速配置编辑
    //    完成后应自动移至“完成”状态
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.sessionStatus !== 'done') {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setSessionStatus(sessionId, 'done')
    }

    // 4. 应用处理期间捕获的延迟外部元数据更新
    if (managed.pendingExternalMetadata) {
      const pendingHeader = managed.pendingExternalMetadata
      managed.pendingExternalMetadata = undefined
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`)
      this.applyExternalSessionMetadata(managed, pendingHeader)
    }

    // 5. 检查队列并处理或完成
    if (managed.messageQueue.length > 0) {
      // 有排队消息——处理下一条
      this.processNextQueuedMessage(sessionId)
    } else {
      // 会话真正结束——释放浏览器所有权
      // 窗口保持存活（隐藏）并可被未来会话重用
      // 在下一轮，getOrCreateForSession() 将重新绑定它
      const doneBpm = this.getBrowserPaneManagerForSession(sessionId)
      if (doneBpm) {
        // Teardown must never block completion. On a headless/WebUI server the BPM is
        // remote and these calls throw (BROWSER_NO_CAPABLE_CLIENT) when no desktop
        // browser client is connected — which previously aborted onProcessingStopped
        // before emitSessionComplete, hanging the Tasks Conductor completion seam.
        try {
          await doneBpm.clearVisualsForSession(sessionId)
          doneBpm.unbindAllForSession(sessionId)
        } catch (err) {
          sessionLog.warn(`Browser-pane teardown failed for ${sessionId} (continuing to completion):`, err)
        }
      }

      // 无队列——向 UI 发出 complete 事件（包含 tokenUsage 和 hasUnread 用于状态更新）
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,  // 将未读状态传播到渲染器
        // WS2：当 keep-alive 使持久查询跨 turn 保持开启时，turn 结束不会杀死后台子 agent。
        // 告诉渲染器这一点，使其 chip 的孤儿兜底机制不会错误地把活跃任务翻转为 `orphaned`；
        // 真正的 `task_completed` 会在 agent 实际完成时到达。
        backgroundTasksAlive: this.keepBackgroundTasksAlive,
      }, managed.workspace.id)

      // Tasks Conductor seam: signal true completion (queue empty) with the stop
      // reason + this turn's final assistant message, so the Conductor can advance
      // the corresponding node. In-process only; never sent to the renderer/agents.
      this.emitSessionComplete({
        sessionId,
        workspaceId: managed.workspace.id,
        reason,
        finalMessageId: currentFinalMessageId,
        finalText: currentFinalMessageId
          ? managed.messages.find(m => m.id === currentFinalMessageId)?.content
          : undefined,
        tokenUsage: managed.tokenUsage,
      })
    }

    // 6. 始终持久化
    this.persistSession(managed)
  }

  /**
   * 消费消息队列中的下一条消息。
   *
   * 当前 turn 结束后，如果队列里还有消息，就弹出第一条，更新其状态为 processing，
   * 然后通过 `setImmediate` 异步调用 `sendMessage` 进行重放。
   *
   * 与 Go 的类比：
   * - 类似 Go 里一个 `for msg := range queue` 的消费者；
   * - `setImmediate` 把递归调用推迟到下一个事件循环 tick，避免调用栈过深。
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0) return

    const next = managed.messageQueue.shift()!
    sessionLog.info('replay queued', {
      sessionId,
      messageId: next.messageId,
      queueLengthAfterShift: managed.messageQueue.length,
    })

    // 更新 UI：queued → processing
    if (next.messageId) {
      const existingMessage = managed.messages.find(m => m.id === next.messageId)
      if (existingMessage) {
        // 清除 isQueued 标志并持久化——防止处理期间崩溃导致重新排队
        existingMessage.isQueued = false
        this.persistSession(managed)

        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: existingMessage,
          status: 'processing',
          optimisticMessageId: next.optimisticMessageId
        }, managed.workspace.id)
      }
    }

    // 处理消息（使用 setImmediate 允许当前堆栈清空）
    setImmediate(() => {
      this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId
      ).catch(err => {
        sessionLog.error('replay failed', {
          sessionId,
          messageId: next.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        // 通过运行时钩子报告排队消息失败
        sessionRuntimeHooks.captureException(err, { errorSource: 'chat-queue', sessionId })
        // 暴露一个类型化错误，以便 UI 可以显示清晰、可操作的横幅
        // 而不是通用的“未知错误”（#616）
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: 'queued_message_replay_failed',
            title: 'Queued message could not be sent',
            message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
            originalError: err instanceof Error ? err.message : String(err),
          },
        }, managed.workspace.id)
        // 调用 onProcessingStopped 处理清理并检查更多排队消息
        this.onProcessingStopped(sessionId, 'error')
      })
    })
  }

  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`)

    // 尝试使用存储的命令杀死实际进程
    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        // 使用 pkill 查找并杀死匹配命令的进程
        // -f 标志匹配完整命令行
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        // 转义命令以用于 pkill 模式
        // 我们在进程参数中搜索唯一的命令字符串
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        sessionLog.info(`Attempting to kill process with command: ${command.slice(0, 100)}...`)

        // 先使用 pgrep 查找 PID，然后杀死它
        // 这比 pkill -f 更安全，后者可能匹配范围过广
        try {
          const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`)
          const pids = stdout.trim().split('\n').filter(Boolean)

          if (pids.length > 0) {
            sessionLog.info(`Found ${pids.length} process(es) to kill: ${pids.join(', ')}`)
            // 杀死每个进程
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid}`)
                sessionLog.info(`Sent SIGTERM to process ${pid}`)
              } catch (killErr) {
                // 进程可能已退出
                sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`)
              }
            }
          } else {
            sessionLog.info(`No processes found matching command`)
          }
        } catch (pgrepErr) {
          // pgrep 在未找到进程时返回退出码 1，这没问题
          sessionLog.info(`No matching processes found (pgrep returned no results)`)
        }

        // 清理存储的命令
        managed.backgroundShellCommands.delete(shellId)
      } catch (err) {
        sessionLog.error(`Error killing shell process: ${err}`)
      }
    } else {
      sessionLog.warn(`No command stored for shell ${shellId}, cannot kill process`)
    }

    // 无论进程杀死是否成功，始终发出 shell_killed 以从 UI 中移除
    this.sendEvent({
      type: 'shell_killed',
      sessionId,
      shellId,
    }, managed.workspace.id)

    return { success: true }
  }

  /**
   * 从两个后台任务 map 中驱逐过期条目以限制内存。
   * - backgroundTaskOutputs：超过 1 小时的已完成输出（既有行为）。
   * - backgroundTaskRegistry：超过 1 小时的终止/孤儿条目。running 条目
   *   从不在这里驱逐（它们在完成时或 turn 结束标记为孤儿时被处理）。
   */
  private evictStaleBackgroundTasks(managed: ManagedSession): void {
    const ONE_HOUR = 3_600_000
    const now = Date.now()
    for (const [tid, info] of managed.backgroundTaskOutputs) {
      if (now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskOutputs.delete(tid)
        this.taskOutputIndex.delete(tid)
      }
    }
    for (const [tid, info] of managed.backgroundTaskRegistry) {
      if (info.status !== 'running' && info.completedAt && now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskRegistry.delete(tid)
      }
    }
  }

  /**
   * 把 session 中仍在运行的后台任务标记为 `orphaned`。
   *
   * 在一个 turn 结束时（onProcessingStopped）调用。在默认的每 turn 子进程模型下，
   * 后台子 agent 在 turn 结束时随查询/子进程被销毁而死亡，但它们的终止通知可能永远不会到达
   *（或只在一个后续 turn 的子进程上到达）。在这里把它们标记为 `orphaned` 保持了"状态如何？"查询的
   * 诚实性 —— 它绝不能把一个已死的任务报告为"running"。
   *
   * 一旦启用 WS2 keep-alive 就变为 no-op：有了持久查询，任务确实能活过 turn，
   * 因此 `keepBackgroundTasksAlive` 会短路此方法。
   */
  private markOrphanedBackgroundTasks(sessionId: string): void {
    if (this.keepBackgroundTasksAlive) return
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    const now = Date.now()
    let orphaned = 0
    for (const info of managed.backgroundTaskRegistry.values()) {
      if (info.status === 'running') {
        info.status = 'orphaned'
        info.completedAt = now
        orphaned++
      }
    }
    if (orphaned > 0) {
      sessionLog.info(`[bg-lifecycle] turn ended — orphaned ${orphaned} still-running background task(s)`, {
        sessionId,
      })
    }
  }

  /**
   * 为"状态如何？"查询枚举 session 的后台任务。
   * 返回主进程注册表快照 —— 跨子进程边界的真正事实来源
   *（SDK 的进程内任务工具看不到来自已销毁的先前子进程的任务）。
   */
  listBackgroundTasks(sessionId: string): RunningBackgroundTask[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) return []
    return Array.from(managed.backgroundTaskRegistry.values())
      .map((t) => ({ ...t }))
      .sort((a, b) => b.startTime - a.startTime)
  }

  /**
   * 获取后台任务的输出
   *
   * 查找收到 task_completed 事件时存储的输出文件，
   * 读取其内容并返回。如果文件无法读取，
   * 则回退到 SDK 提供的摘要
   *
   * @param taskId - 任务或 shell ID
   * @returns 任务输出内容，如果未找到任务则返回 null
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    // 通过 taskOutputIndex 进行 O(1) 查找
    const sessionId = this.taskOutputIndex.get(taskId)
    if (!sessionId) {
      sessionLog.info(`No output found for task: ${taskId} (task may still be running)`)
      return null
    }

    const managed = this.sessions.get(sessionId)
    const info = managed?.backgroundTaskOutputs.get(taskId)
    if (!info) {
      // 索引不同步——清理过期条目
      this.taskOutputIndex.delete(taskId)
      return null
    }

    sessionLog.info(`Found output for task ${taskId}: file=${info.outputFile}, status=${info.status}`)
    try {
      const content = await readFile(info.outputFile, 'utf-8')
      // 成功读取后删除，防止内存泄漏
      managed!.backgroundTaskOutputs.delete(taskId)
      this.taskOutputIndex.delete(taskId)
      return content
    } catch (err) {
      sessionLog.error(`Failed to read task output file: ${info.outputFile}`, err)
      // 回退到 SDK 提供的摘要
      return info.summary || null
    }
  }

  /**
   * 响应待处理的权限请求
   * 如果响应已送达则返回 true，如果代理/会话已消失则返回 false
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
          expectedCommandHash: requestMeta.commandHash,
        })
        if (!brokerResult.ok) {
          sessionLog.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`)
          // 代理拒绝应默认失败关闭
          managed.agent.respondToPermission(requestId, false, false)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes)
        }
      }

      sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      return true
    } else {
      sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * 响应待处理的凭据请求
   * 如果响应已送达则返回 true，如果未找到待处理请求则返回 false
   *
   * 支持：
   * - 新的统一认证流程（通过 handleCredentialInput）
   * - 旧的回调流程（通过 pendingCredentialResolvers）
   */
  async respondToCredential(sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse): Promise<boolean> {
    // 首先，检查这是否是新的统一认证流程请求
    const managed = this.sessions.get(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // 回退到旧的回调流程
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  /**
   * 设置会话的权限模式（'safe'、'ask'、'allow-all'）
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // 仅当托管状态和模式管理器状态都已匹配时才无操作
      // 如果托管状态匹配但诊断信息漂移，修复权威模式状态
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        sessionLog.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // 首先更新内存中的托管模式
      managed.permissionMode = mode

      // 为此特定会话协调模式管理器状态
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      sessionLog.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // 转发到代理实例，以便后端可以将模式更改向下游传播
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      }, managed.workspace.id)
      // 持久化到磁盘
      this.persistSession(managed)
    }
  }

  /**
   * 获取会话的权威权限模式诊断信息
   * 由渲染器用于协调乐观/过时的模式状态
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // 当模式管理器已重置时（例如应用重启），水合持久化的转换上下文
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // 修复恢复竞争条件，其中模式管理器仍具有默认状态，而
    // 会话元数据已具有持久化的非默认模式
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      sessionLog.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * 为会话设置标签（附加标签，每个会话多个）
   * 标签是引用工作区标签/config.json 的 ID
   */
  async setSessionLabels(sessionId: string, labels: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = labels
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // 直接持久化内存状态，避免与待处理队列写入竞争
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 解决方法：Bun 在 Linux 上的 fs.watch({ recursive: true }) 不跟踪
      // 监视器启动后创建的目录
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 对 session 应用保留的 Task 标签。每个任务都有自己的 ITEM 标签 ——
   * 一个名为 `TASK-<slug>-<N>` 的根 "Task" 标签的子标签（普通布尔标签，无值）——
   * 并且任务的整个家族都携带同一个 item 标签，因此一个标签就能过滤一个任务。
   * 顶级 session 根据自己的名称铸造新的 item 标签；带 `parentSessionId` 的 session
   * 继承父任务的 item 标签 —— 而一个没有 item 标签的父任务（一个刚获得第一个子任务的
   * 普通对话）会在同一轮中被标记，因此"成为一个任务"在构造上就成立。幂等：已携带
   * item 标签的 session 保持不变。返回解析出的 ITEM 标签 id —— slug 可能因碰撞而偏移，
   * 因此调用方必须使用它，而不是自己推导 id。
   */
  async applyTaskLabel(
    sessionId: string,
    opts?: { parentSessionId?: string },
  ): Promise<{ labelId: string } | undefined> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return undefined
    const rootPath = managed.workspace.rootPath

    const itemOf = (labels: string[] | undefined): string | undefined =>
      findTaskItemLabelId(labels, loadLabelConfig(rootPath).labels)
    const withItemEntry = (labels: string[] | undefined, itemId: string): string[] => [
      ...(labels ?? []).filter(entry => extractLabelId(entry) !== itemId),
      itemId,
    ]

    const existing = itemOf(managed.labels)
    if (existing) return { labelId: existing }

    let itemId: string
    const parent = opts?.parentSessionId ? this.sessions.get(opts.parentSessionId) : undefined
    if (parent) {
      const parentItem = itemOf(parent.labels)
      if (parentItem) {
        itemId = parentItem
      } else {
        itemId = ensureTaskItemLabel(rootPath, parent.name || 'task').itemId
        await this.setSessionLabels(parent.id, withItemEntry(parent.labels, itemId))
      }
    } else {
      itemId = ensureTaskItemLabel(rootPath, managed.name || 'task').itemId
    }

    await this.setSessionLabels(sessionId, withItemEntry(managed.labels, itemId))
    return { labelId: itemId }
  }

  /**
   * 绑定或解绑 session 到/从一个 workspace 项目。
   * 传入 `null` 即可解绑。session 的工作目录不会被追溯更改 ——
   * 项目绑定仅用作新建 session 的默认值。
   */
  async setSessionProjectId(sessionId: string, projectId: string | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.projectId = projectId ?? undefined
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'project_id_changed',
        sessionId: managed.id,
        projectId: managed.projectId ?? null,
      }, managed.workspace.id)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 设置 session 的看板列（'todo' | 'in-progress' | 'done'）。
   * 传入 `null` 清除（看板回退到默认列）。与 sessionStatus 独立。
   */
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.kanbanColumn = column ?? undefined
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 自行写入不会通过文件监视器重新发出（kanbanColumn 不在 header 签名中），
      // 因此推送一个实时元数据事件供看板消费。
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { kanbanColumn: column ?? undefined } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 在 Conductor 编排器 session 上记录 DAG 节点总数。看板用它作为稳定的进度分母，
   * 这样在子 session 于调度时惰性派生时它就不会增长。
   */
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.taskNodeCount = count
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // 自行写入不会通过文件监视器重新发出（taskNodeCount 不在 header 签名中），
      // 因此推送一个实时元数据事件，使进度分母立即更新。
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { taskNodeCount: count } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * 将隐藏的生成时编排器（`taskDraft`）提升为 `taskSlug` 对应的真正、看板可见的编排器。
   * 这是让"生成 → 创建并运行"复用草稿 session 而非另起一个顶级卡片的唯一狭窄路径（#bug1）。
   *
   * 成功时返回 `true`（包括对同一 slug 的幂等重新采纳）。当 session 不存在、不是草稿、或
   * 已经绑定到*不同的* slug 时返回 `false` —— session 保持不变。调用方在 `false` 时回退到 `createSession`。
   *
   * 故意不触碰 tools/sources/capabilities：编排器保留创建时的一切，以便它仍能编写/验证运行。
   */
  async adoptGeneratedTaskOrchestrator(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn('adoptGeneratedTaskOrchestrator: session not found', { sessionId, taskSlug })
      return false
    }
    // 幂等性：已绑定到该 slug → no-op 成功。绑定到不同 slug → 拒绝，
    // 这样一个过时的草稿引用就不能劫持一个无关的编排器。
    if (managed.taskSlug) {
      if (managed.taskSlug === taskSlug) return true
      sessionLog.warn('adoptGeneratedTaskOrchestrator: slug mismatch, refusing to rebind', {
        sessionId, existing: managed.taskSlug, requested: taskSlug,
      })
      return false
    }
    // 只有隐藏的生成时草稿才符合条件。一个没有 slug 的非草稿 session 不是
    // 生成编排器，绝不能被静默捕获。
    if (!managed.taskDraft) {
      sessionLog.warn('adoptGeneratedTaskOrchestrator: session is not a task draft', { sessionId, taskSlug })
      return false
    }

    // 实际变更的内容 —— 这样我们只在需要时才触发规范的实时更新（agent + 缓存 + 逐字段事件）。
    // 由于 generate 现在会注入 model/connection/mode，这些通常都为 false。
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
    const connectionChanged = Boolean(
      reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection,
    )
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)

    // 提升 task 元数据（这些没有规范的修改器）。Connection 直接设置，因为
    // setSessionConnection() 会拒绝已发送过消息的 session（生成草稿已经发过）；
    // 下方的 connection_changed 事件保持渲染器同步。
    managed.taskSlug = taskSlug
    managed.taskDraft = false
    if (reconcile?.projectId !== undefined) managed.projectId = reconcile.projectId
    if (connectionChanged) managed.llmConnection = reconcile!.llmConnection
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
    if (renamed) managed.name = reconcile!.name!

    // 通过规范的修改器路由 model / cwd / 权限模式，使 LIVE agent、缓存和逐字段事件保持一致
    // —— 而不只是磁盘上的元数据（后续 review 标记的脑裂问题）。每个只针对变更的字段；
    // 下方的 persist 捕获了 mode。
    if (modelChanged) await this.updateSessionModel(sessionId, managed.workspace.id, reconcile!.model!)
    if (cwdChanged) this.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!)
    if (modeChanged) this.setSessionPermissionMode(sessionId, reconcile!.permissionMode!)

    this.setMetadataWriteGuard(managed)
    this.persistSession(managed)
    await this.flushSession(managed.id)

    // 一次性看板提升：清除 taskDraft（以 `false` 发送，绝不是 `undefined` ——
    // undefined 在 JSON 传输中被丢弃）让已宣布的卡片显现；taskSlug/projectId
    // 调和它的元数据。`false` 对看板的 `if (meta.taskDraft)` 跳过逻辑来说是 falsy 的。
    const changes: { taskDraft: boolean; taskSlug: string; projectId?: string } = { taskDraft: false, taskSlug }
    if (reconcile?.projectId !== undefined) changes.projectId = reconcile.projectId
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id)
    if (renamed) {
      this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
    }
    if (connectionChanged) {
      this.sendEvent({
        type: 'connection_changed',
        sessionId,
        connectionSlug: managed.llmConnection!,
        supportsBranching: resolveSupportsBranching(managed),
      }, managed.workspace.id)
    }
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    sessionLog.info('adoptGeneratedTaskOrchestrator: promoted draft', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
    return true
  }

  /**
   * 用户发起的把一个*已存在、可见*的 session（如快速添加的卡片）绑定到 task slug。
   *
   * 这与 {@link adoptGeneratedTaskOrchestrator} 不同，后者是仅限草稿的狭窄提升路径。
   * 快速添加卡片是一个没有 `taskSlug` 的普通非草稿 session；adopt 方法中的草稿守卫会正确地
   * 拒绝它，因此编辑器的"把 spec 保存到该卡片"流程需要自己的路径。adopt 方法中的守卫保持不变。
   *
   * 成功时返回 `true`（包括对同一 slug 的幂等重新绑定）。当 session 不存在或已绑定到*不同的*
   * slug 时返回 `false` —— session 保持不变。调用方必须把 `false` 当作硬错误，且绝不能回退到
   * 创建新编排器（那会产生重复卡片）。
   *
   * 与 adopt 不同，这里也会调和 `llmConnection`（全新 create 会设置它；adopt 跳过它），
   * 使绑定的卡片不会渲染出一个过时的后端。
   */
  async bindExistingSessionToTask(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn('bindExistingSessionToTask: session not found', { sessionId, taskSlug })
      return false
    }
    if (managed.taskSlug) {
      if (managed.taskSlug === taskSlug) return true
      sessionLog.warn('bindExistingSessionToTask: slug mismatch, refusing to rebind', {
        sessionId, existing: managed.taskSlug, requested: taskSlug,
      })
      return false
    }

    // 实际变更的内容 —— 这样我们只在需要时才触发规范的实时更新（agent + 缓存 + 逐字段事件）。
    // 快速添加卡片已经是活跃的，因此这些让它运行中的 agent 保持同步。
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
    const connectionChanged = Boolean(
      reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection,
    )
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)

    // 提升 task 元数据（这些没有规范的修改器）。Connection 直接设置，因为
    // setSessionConnection() 会拒绝已发送过消息的 session（快速添加卡片已经发过）；
    // 下方的 connection_changed 事件保持渲染器同步。
    managed.taskSlug = taskSlug
    managed.taskDraft = false
    if (reconcile?.projectId !== undefined) managed.projectId = reconcile.projectId
    if (connectionChanged) managed.llmConnection = reconcile!.llmConnection
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
    if (renamed) managed.name = reconcile!.name!

    // 通过规范的修改器路由 model / cwd / 权限模式，使 LIVE agent、缓存和逐字段事件保持一致
    // —— 而不只是磁盘上的元数据（后续 review 标记的脑裂问题）。updateSessionModel 自己发出 session_model_changed。
    if (modelChanged) await this.updateSessionModel(sessionId, managed.workspace.id, reconcile!.model!)
    if (cwdChanged) this.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!)
    if (modeChanged) this.setSessionPermissionMode(sessionId, reconcile!.permissionMode!)

    this.setMetadataWriteGuard(managed)
    this.persistSession(managed)
    await this.flushSession(managed.id)

    const changes: { taskDraft: boolean; taskSlug: string; projectId?: string } = { taskDraft: false, taskSlug }
    if (reconcile?.projectId !== undefined) changes.projectId = reconcile.projectId
    this.sendEvent({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id)
    if (renamed) {
      this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
    }
    if (connectionChanged) {
      this.sendEvent({
        type: 'connection_changed',
        sessionId,
        connectionSlug: managed.llmConnection!,
        supportsBranching: resolveSupportsBranching(managed),
      }, managed.workspace.id)
    }
    const watcher = this.configWatchers.get(managed.workspace.rootPath)
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    sessionLog.info('bindExistingSessionToTask: bound existing session', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
    return true
  }

  /**
   * 设置会话的思考级别。有效值请参见 {@link ThinkingLevel}。
   * 此设置是粘性的，并在消息之间持久化。
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // 更新托管会话中的思考级别
      managed.thinkingLevel = level

      // 更新代理的思考级别（如果存在）
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // 持久化到磁盘
      this.persistSession(managed)
    }
  }

  /**
   * 根据用户的第一条消息为会话生成 AI 标题
   * 使用代理的 generateTitle() 方法，该方法处理特定提供商的 SDK 调用
   * 如果不存在代理，则使用会话的连接创建一个临时代理
   */
  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // 使用现有代理或创建临时代理
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // 短暂等待代理创建（它是并发创建的）
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
      agent = managed.agent
    }

    // 如果仍然没有代理，使用会话的连接创建一个临时代理
    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`)
      } catch (error) {
        sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error)
        return
      }
    }

    if (!agent) {
      sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`)
      return
    }

    try {
      // 从持久化 UI 语言进行无竞争的语言解析；undefined 表示自动检测（#885）
      const titleLanguage = resolveTitleLanguageName()
      sessionLog.info(`[generateTitle] language at call time`, {
        sessionId: managed.id,
        persistedUiLanguage: getPersistedUiLanguage() ?? null,
        resolvedLanguage: i18n.resolvedLanguage ?? null,
        titleLanguage: titleLanguage ?? null,
      })
      const title = await agent.generateTitle(userMessage, { language: titleLanguage })
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // 立即刷新以确保在通知渲染器之前磁盘是最新的
        // 这防止了延迟加载读取过时磁盘数据的竞争条件
        // （持久化队列有 500ms 的去抖）
        await this.flushSession(managed.id)
        // 现在可以安全地通知渲染器——磁盘是权威的
        this.sendEvent({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id)
        sessionLog.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        sessionLog.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      sessionLog.error(`Failed to generate title for session ${managed.id}:`, error)

      // 向用户暴露配额/认证错误——这些表明主聊天调用也会失败
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
        this.sendEvent({
          type: 'typed_error',
          sessionId: managed.id,
          error: {
            code: 'provider_error',
            title: 'API Error',
            message: `API error: ${errorMsg.slice(0, 200)}`,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
          }
        }, managed.workspace.id)
      }
    } finally {
      // 清理临时代理
      if (isTemporary && agent) {
        agent.destroy()
      }
    }
  }

  /**
   * 事件总线：把 Agent 子进程的事件翻译为 UI 事件并持久化。
   *
   * 处理的主要事件类型：
   * - `text_delta`：流式文本增量，进入批处理队列（`queueDelta`）降低 IPC 频率；
   * - `text_complete`：Assistant 回复完成，写入 `messages`，更新未读相关字段；
   * - `tool_start` / `tool_result`：工具调用开始/结束，更新消息列表并发送给 UI；
   * - `status` / `info`：状态提示，如 Compaction 完成；
   * - `error` / `typed_error`：错误处理，认证错误会触发 `attemptAuthRetry`；
   * - `task_backgrounded` / `task_progress` / `task_completed`：后台任务事件透传；
   * - `shell_backgrounded`：记录后台 shell 命令，供 `killShell` 使用；
   * - `source_activated`：source  mid-turn 激活后自动重发原消息；
   * - `complete` / `usage_update`：token 使用统计更新。
   *
   * 与 Go 的类比：
   * - 类似 Go 里一个 `switch event.Type` 的事件分发器；
   * - `this.sendEvent(...)` 相当于向消息总线/前端推送事件。
   */
  private async processEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const sessionId = managed.id
    const workspaceId = managed.workspace.id

    switch (event.type) {
      case 'text_delta':
        managed.streamingText += event.text
        // 排队增量以进行批量发送（性能：从 50+/秒减少到约 20/秒）
        this.queueDelta(sessionId, workspaceId, event.text, event.turnId)
        break

      case 'text_complete': {
        // 在发送 complete 之前刷新所有待处理的增量（确保渲染器拥有所有内容）
        this.flushDelta(sessionId, workspaceId)

        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.monotonic(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        }
        managed.messages.push(assistantMessage)
        managed.streamingText = ''

        // 更新 lastMessageRole 和 lastFinalMessageId 用于徽章/未读显示（仅限最终消息）
        if (!event.isIntermediate) {
          managed.lastMessageRole = 'assistant'
          managed.lastFinalMessageId = assistantMessage.id

          const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)

          // Claude 分支截断支持：在 sidecar 中持久化消息 UUID + SDK 会话谱系
          // 用于保护 resumeSessionAt，确保我们只发送对父 SDK 会话有效的锚点
          if (event.turnId && managed.sdkSessionId && isClaudeMessageUuid(event.turnId)) {
            try {
              await saveClaudeTurnAnchor(sessionPath, assistantMessage.id, managed.sdkSessionId, event.turnId)
            } catch (error) {
              sessionLog.warn(`Failed to persist Claude turn anchor for session ${sessionId}:`, error)
            }
          }

          // Pi 分支截断支持：记住 SDK 消息 ID 到 Craft
          // 助手消息 ID 的映射。实际锚点在一个微任务后作为
          // 单独的 `pi_turn_anchor` 事件到达——SDK
          // 仅在触发 message_end 后更新其叶子（参见 #782）
          if (event.sdkMessageId) {
            let cache = managed.piSdkMessageToCraftMessage
            if (!cache) {
              cache = new Map()
              managed.piSdkMessageToCraftMessage = cache
            }
            cache.set(event.sdkMessageId, assistantMessage.id)
            // 当超过上限时修剪最旧的条目。Map 保留插入顺序
            // 排序，第一个键是最旧的。
            if (cache.size > PI_SDK_MESSAGE_ID_CACHE_LIMIT) {
              const oldest = cache.keys().next().value
              if (oldest !== undefined) cache.delete(oldest)
            }
          }
        }

        this.sendEvent({ type: 'text_complete', sessionId, text: event.text, isIntermediate: event.isIntermediate, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: assistantMessage.timestamp, messageId: assistantMessage.id }, workspaceId)

        // 在完整消息后持久化会话，防止退出时数据丢失
        this.persistSession(managed)
        break
      }

      case 'pi_turn_anchor': {
        // 对来自 Pi 后端的 `text_complete` 的后续处理，携带
        // 在 SDK 追加其助手条目后捕获的正确叶子 ID
        // （同步的 `message_end` 监听器无法看到它 — #782）。
        // 通过 SDK 消息 ID 查找 Craft 助手消息 ID，并
        // 将锚点持久化到 sidecar。
        const cache = managed.piSdkMessageToCraftMessage
        const craftMessageId = cache?.get(event.sdkMessageId)
        if (!craftMessageId) {
          sessionLog.debug(`pi_turn_anchor for unknown sdkMessageId=${event.sdkMessageId}; ignoring`)
          break
        }
        const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)
        try {
          await savePiTurnAnchor(sessionPath, craftMessageId, event.sdkTurnAnchor)
        } catch (error) {
          sessionLog.warn(`Failed to persist Pi turn anchor for session ${sessionId}:`, error)
        }
        break
      }

      case 'tool_start': {
        // 将工具输入路径格式化为相对路径，以提高可读性
        const formattedToolInput = formatToolInputPaths(event.input)

        // 解析 call_llm 模型，用于 TurnCard 徽章显示。
        // 将 call_llm 模型短名称解析为完整 ID 以进行显示。
        // 注意：Pi 会话会覆盖 PiEventAdapter 中的模型（call_llm 始终使用 miniModel）。
        if (event.toolName === 'mcp__session__call_llm' && formattedToolInput?.model) {
          const shortName = String(formattedToolInput.model)
          const modelDef = MODEL_REGISTRY.find(m => m.id === shortName)
            || MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === shortName.toLowerCase())
            || MODEL_REGISTRY.find(m => m.name.toLowerCase() === shortName.toLowerCase())
          if (modelDef) {
            formattedToolInput.model = modelDef.id
          }
        }

        // 解析工具显示元数据（图标、displayName），用于技能/来源
        // 仅在有输入时解析（SDK 双事件模式的第二个事件）
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources)
        }

        // 首先检查是否已存在具有此 toolUseId 的消息
        // SDK 为每个工具发送两个事件：第一个来自 stream_event（输入为空），
        // 第二个来自 assistant message（输入完整）
        const existingStartMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        const isDuplicateEvent = !!existingStartMsg

        // 直接从事件中使用 parentToolUseId — CraftAgent 解析此
        // 来自 SDK 的 parent_tool_use_id（权威来源，正确处理并行任务）。
        // 不需要栈或映射；事件从一开始就携带了正确的父级。
        const parentToolUseId = event.parentToolUseId

        // 跟踪是否需要向渲染器发送事件
        // 发送时机：首次出现 或 有新输入数据需要更新时
        let shouldSendEvent = !isDuplicateEvent

        if (existingStartMsg) {
          // 用完整输入更新现有消息（第二个事件包含完整输入）
          if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
            const hadInputBefore = existingStartMsg.toolInput && Object.keys(existingStartMsg.toolInput).length > 0
            existingStartMsg.toolInput = formattedToolInput
            // 如果添加了之前没有的输入，则发送更新事件
            if (!hadInputBefore) {
              shouldSendEvent = true
            }
          }
          // 如果尚未设置父级，也设置父级
          if (parentToolUseId && !existingStartMsg.parentToolUseId) {
            existingStartMsg.parentToolUseId = parentToolUseId
          }
          // 如果尚未设置 toolDisplayMeta（包含供查看器使用的 base64 图标）
          if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
            existingStartMsg.toolDisplayMeta = toolDisplayMeta
          }
          // 如果尚未设置 toolIntent，则更新（第二个事件包含来自完整输入的意图）
          if (event.intent && !existingStartMsg.toolIntent) {
            existingStartMsg.toolIntent = event.intent
          }
          // 如果尚未设置 toolDisplayName，则更新
          if (event.displayName && !existingStartMsg.toolDisplayName) {
            existingStartMsg.toolDisplayName = event.displayName
          }
        } else {
          // 立即添加工具消息（将在 tool_result 时更新）
          // 这确保工具调用即使未完成也会被持久化
          const toolStartMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${event.toolName}...`,
            timestamp: this.monotonic(),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput,
            toolStatus: 'executing',
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // 包含供查看器兼容性使用的 base64 图标
            turnId: event.turnId,
            parentToolUseId,
          }
          managed.messages.push(toolStartMessage)
        }

        // 在可操作的浏览器工具启动时激活浏览器代理控制覆盖层。
        // 跳过 browser_tool 帮助/释放命令，以避免无意义的覆盖层闪烁。
        const shouldActivateOverlay = shouldActivateBrowserOverlay(
          event.toolName,
          formattedToolInput,
        )

        const overlayBpm = this.getBrowserPaneManagerForSession(sessionId)
        if (overlayBpm && shouldActivateOverlay) {
          // 确保一轮中的第一个浏览器操作在覆盖层激活前获得一个实例。
          overlayBpm.getOrCreateForSession(sessionId, { workspaceId })

          const resolvedDisplayName = toolDisplayMeta?.displayName
            ?? event.displayName
            ?? event.toolName
          overlayBpm.setAgentControl(
            sessionId,
            { displayName: resolvedDisplayName, intent: event.intent },
            { workspaceId },
          )
        }

        // 在首次出现或输入数据更新时向渲染器发送事件
        if (shouldSendEvent) {
          const timestamp = existingStartMsg?.timestamp ?? this.monotonic()
          this.sendEvent({
            type: 'tool_start',
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput ?? {},
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // 包含供查看器兼容性使用的 base64 图标
            turnId: event.turnId,
            parentToolUseId,
            timestamp,
          }, workspaceId)
        }
        break
      }

      case 'tool_result': {
        // toolName 直接来自 CraftAgent（通过 ToolIndex 解析）
        const toolName = event.toolName || 'unknown'

        // 将绝对路径格式化为相对路径，以提高可读性
        const rawFormattedResult = event.result ? formatPathsToRelative(event.result) : ''

        // 安全网：防止大量工具结果使会话 JSONL 膨胀（保护所有后端）
        const MAX_PERSISTED_RESULT_CHARS = 200_000 // 约 50K 个 token
        const formattedResult = rawFormattedResult.length > MAX_PERSISTED_RESULT_CHARS
          ? rawFormattedResult.slice(0, MAX_PERSISTED_RESULT_CHARS) +
            `\n\n[Truncated for storage: ${rawFormattedResult.length.toLocaleString()} chars total]`
          : rawFormattedResult

        // 某些后端省略了显式的 isError，但仍以 [ERROR] 为前缀。
        const inferredError = event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(formattedResult)

        // 更新现有的工具消息（在 tool_start 时创建），而不是创建新消息
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        // 跟踪是否已完成，以避免发送重复事件
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed'

        sessionLog.info(`RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}`)

        // parentToolUseId 来自 CraftAgent（SDK 权威来源）或现有消息
        const parentToolUseId = existingToolMsg?.parentToolUseId || event.parentToolUseId

        if (existingToolMsg) {
          // 在 `content` 中保留轻量级状态文本，并将完整负载仅存储在 `toolResult` 中。
          existingToolMsg.toolResult = formattedResult
          existingToolMsg.toolStatus = inferredError ? 'error' : 'completed'
          existingToolMsg.isError = inferredError
          // 如果消息未设置父级，则使用事件的 parentToolUseId
          if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
            existingToolMsg.parentToolUseId = event.parentToolUseId
          }
        } else {
          // 未找到匹配的 tool_start — 从结果创建消息。
          // 这对于后台子代理的子工具来说是正常的，其中 tool_result 到达
          // 而没有先前的 tool_start。如果 tool_start 稍后到达，findToolMessage 将
          // 通过 toolUseId 定位此消息，并用输入/意图/displayMeta 更新它。
          sessionLog.info(`RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`)
          const fallbackWorkspaceRootPath = managed.workspace.rootPath
          const fallbackSources = loadAllSources(fallbackWorkspaceRootPath)
          const fallbackToolDisplayMeta = await resolveToolDisplayMeta(toolName, undefined, fallbackWorkspaceRootPath, fallbackSources)

          const toolMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: '',
            timestamp: this.monotonic(),
            toolName: toolName,
            toolUseId: event.toolUseId,
            toolResult: formattedResult,
            toolStatus: inferredError ? 'error' : 'completed',
            toolDisplayMeta: fallbackToolDisplayMeta,
            parentToolUseId,
            isError: inferredError,
          }
          managed.messages.push(toolMessage)
        }

        // 向渲染器发送事件，如果：(a) 首次完成，或 (b) 结果内容已更改
        // （例如，安全网用空结果自动完成，然后真实结果稍后到达）
        const resultChanged = wasAlreadyComplete && formattedResult && existingToolMsg?.toolResult !== formattedResult
        if (!wasAlreadyComplete || resultChanged) {
          // 使用现有工具消息的时间戳，或用于排序的回退消息时间戳
          const toolResultTimestamp = existingToolMsg?.timestamp ?? (managed.messages.find(m => m.toolUseId === event.toolUseId)?.timestamp)
          this.sendEvent({
            type: 'tool_result',
            sessionId,
            toolUseId: event.toolUseId,
            toolName: toolName,
            result: formattedResult,
            turnId: event.turnId,
            parentToolUseId,
            isError: inferredError,
            timestamp: toolResultTimestamp,
          }, workspaceId)
        }

        // 安全网：当父任务完成时，将其所有仍待处理的子工具标记为已完成。
        // 这处理了子工具 tool_result 事件从未到达的情况（例如，子代理内部工具
        // 其结果未通过父流公开）。
        if (isParentTaskTool(toolName) || toolName === 'TaskOutput') {
          const pendingChildren = managed.messages.filter(
            m => m.parentToolUseId === event.toolUseId
              && m.toolStatus !== 'completed'
              && m.toolStatus !== 'error'
          )
          for (const child of pendingChildren) {
            child.toolStatus = 'completed'
            child.toolResult = child.toolResult || ''
            sessionLog.info(`CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`)
            this.sendEvent({
              type: 'tool_result',
              sessionId,
              toolUseId: child.toolUseId!,
              toolName: child.toolName || 'unknown',
              result: child.toolResult || '',
              turnId: child.turnId,
              parentToolUseId: event.toolUseId,
            }, workspaceId)
          }
        }

        // 在工具完成后持久化会话，以防止退出时数据丢失
        this.persistSession(managed)
        break
      }

      case 'status':
        this.sendEvent({
          type: 'status',
          sessionId,
          message: event.message,
          statusType: event.message.includes('Compacting') ? 'compacting' : undefined
        }, workspaceId)
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')
        const infoTimestamp = this.monotonic()

        // 持久化压缩消息，以便它们在重新加载后仍然存在
        // 其他信息消息是瞬态的（仅发送给渲染器）
        if (isCompactionComplete) {
          const compactionMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: event.message,
            timestamp: infoTimestamp,
            statusType: 'compaction_complete',
          }
          managed.messages.push(compactionMessage)

          // 在会话状态中标记压缩完成。
          // 这在此处（后端）完成，而不是在渲染器中，这样它
          // 就不会受到压缩期间 CMD+R 的影响。前端重新加载
          // 恢复将看到 awaitingCompaction=false 并触发执行。
          void markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
          sessionLog.info(`Session ${sessionId}: compaction complete, marked pending plan ready`)

          // 发出 usage_update 以便上下文计数徽章立即刷新
          // 在压缩之后，无需等待下一条消息
          if (managed.tokenUsage) {
            this.sendEvent({
              type: 'usage_update',
              sessionId,
              tokenUsage: {
                inputTokens: managed.tokenUsage.inputTokens,
                contextWindow: managed.tokenUsage.contextWindow,
              },
            }, workspaceId)
          }
        }

        this.sendEvent({
          type: 'info',
          sessionId,
          message: event.message,
          statusType: isCompactionComplete ? 'compaction_complete' : undefined,
          timestamp: infoTimestamp,
        }, workspaceId)
        break
      }

      case 'error': {
        // 跳过交接后的错误（计划提交、认证请求）— SDK 可能会在
        // 我们已经停止处理后，从被中断的查询中发出错误。
        if (!managed.isProcessing) {
          sessionLog.info('Skipping error event after handoff/stop:', event.message)
          break
        }

        // 跳过中止错误 — 这些在通过 Query.close() 强制中止时是预期的
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
          sessionLog.info('Skipping abort error event (expected during interrupt)')
          break
        }

        // 防御性：在未被分类为 typed_error 的普通错误中检测认证过期文本
        // （例如 Pi SDK 错误路径或未来的提供商更改）。
        const lowerErr = event.message.toLowerCase()
        const isPlainAuthError =
          lowerErr.includes('token is expired') ||
          lowerErr.includes('authentication token is expired') ||
          lowerErr.includes('please try signing in again') ||
          (lowerErr.includes('401') && (lowerErr.includes('unauthorized') || lowerErr.includes('auth')))

        if (isPlainAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId)) {
          break
        }

        // AgentEvent 使用 `message` 而不是 `error`
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.monotonic()
        }
        managed.messages.push(errorMessage)
        this.sendEvent({ type: 'error', sessionId, error: event.message, timestamp: errorMessage.timestamp }, workspaceId)
        break
      }

      case 'typed_error':
        // 跳过交接后的错误（计划提交、认证请求）
        if (!managed.isProcessing) {
          sessionLog.info('Skipping typed_error event after handoff/stop:', event.error.message || event.error.title)
          break
        }

        // 跳过中止错误 — 这些在通过 Query.close() 强制中止时是预期的
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
          sessionLog.info('Skipping typed abort error event (expected during interrupt)')
          break
        }
        // 类型化错误具有结构化信息 — 发送两种格式以保持兼容性
        sessionLog.info('typed_error:', JSON.stringify(event.error, null, 2))

        // 检查可通过刷新令牌重试的认证错误
        // SDK 子进程在启动时缓存令牌，因此如果它在会话期间过期，
        // 我们会收到 invalid_api_key 错误。我们可以通过以下方式修复：
        // 1. 重置摘要客户端缓存
        // 2. 销毁代理（新代理的 postInit() 会刷新令牌）
        // 3. 重试消息
        const isAuthError = event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'

        if (isAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId, event.error.code)) {
          // 不添加错误消息或发送给渲染器 — 我们通过重试来处理它
          break
        }

        // 构建包含所有诊断字段的丰富错误消息，用于持久化和 UI 显示
        const typedErrorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          // 组合标题和消息以进行内容显示（优雅地处理 undefined）
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.monotonic(),
          // 用于诊断和重试功能的丰富错误字段
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(typedErrorMessage)
        // 发送带有完整结构的 typed_error 事件，供渲染器处理
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: event.error.code,
            title: event.error.title,
            message: event.error.message,
            actions: event.error.actions,
            canRetry: event.error.canRetry,
            details: event.error.details,
            originalError: event.error.originalError,
          },
          timestamp: typedErrorMessage.timestamp,
        }, workspaceId)
        break

      case 'task_backgrounded':
        // 记录到运行中任务注册表，使跨子进程的"状态如何？"查询能枚举活跃任务（WS3）。
        // 渲染器仍通过自己的 atom 显示 chip；这里是主进程的事实来源。
        if (managed) {
          managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            toolUseId: event.toolUseId,
            intent: event.intent,
            startTime: Date.now(),
            status: 'running',
            turnId: event.turnId,
            // Workflow 启动携带一个 wf_ id + 一个实时的子 agent 完成计数。
            ...(event.workflowId ? { workflowId: event.workflowId } : {}),
            ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
          })
          sessionLog.info(`[bg-lifecycle] task backgrounded`, {
            sessionId,
            taskId: event.taskId,
            intent: event.intent,
            turnId: event.turnId,
          })
        }
        // 直接将后台任务事件转发给渲染器
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'workflow_agent_completed':
        // 一个运行中 Workflow 的子 agent 完成了（SubagentStop，按 wf_ id 归因）。
        // 递增所属 workflow chip 的完成计数，让用户看到实时的扇出进度。
        // 轻量级：注册表计数器 + 渲染器转发，无持久化（这可能在每个 workflow 中触发数十次）。
        if (managed) {
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.workflowId && info.workflowId === event.workflowId) {
              info.agentsCompleted = (info.agentsCompleted ?? 0) + 1
              break
            }
          }
        }
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_progress':
        // 更新注册表条目的 elapsed/last-progress（尽力而为 —— async-by-default 路径
        // 可能不发出 progress；渲染器以 startTime 为回退来推导 elapsed）。
        if (managed) {
          // task_progress 以 toolUseId 为键，而非 taskId —— 找到对应条目。
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.toolUseId && info.toolUseId === event.toolUseId) {
              info.elapsedSeconds = event.elapsedSeconds
              info.lastProgressAt = Date.now()
              break
            }
          }
        }
        // 直接将后台任务事件转发给渲染器
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_completed': {
        // 在下方变更状态之前，捕获我们是否已为该任务记录过终止结果，
        // 这样即使收到重复的终止通知，空闲自动浮现（更下方）最多也只触发一次。
        // Workflow 的完成通知可能以返回的 Task ID（注册表键）或 wf_ run id 为键，
        // 因此在放弃前回退到 workflowId 匹配。
        const priorEntry = managed
          ? (managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId))
          : undefined
        const wasAlreadyTerminal = priorEntry
          ? priorEntry.status !== 'running'
          : this.taskOutputIndex.has(event.taskId)

        // 存储输出，以便稍后通过 getTaskOutput() 检索
        if (managed) {
          managed.backgroundTaskOutputs.set(event.taskId, {
            outputFile: event.outputFile || '',
            summary: event.summary || '',
            status: event.status,
            completedAt: Date.now(),
          })
          // getTaskOutput() 的 O(1) 索引 — 避免扫描所有会话
          this.taskOutputIndex.set(event.taskId, sessionId)

          // 把运行中任务注册表条目解析为终止状态，使后续的"状态如何？"查询反映现实，
          // 而非过时的"running"。按 taskId 或 workflowId 匹配
          //（一个 workflow 可能在其 wf_ run id 而非返回的 Task ID 下完成）。
          const running = managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId)
          if (running) {
            running.status = event.status
            running.completedAt = Date.now()
          } else {
            // 对一个我们从没看到转入后台的任务的终止通知（例如它在 task_backgrounded
            // 被匹配之前就在同一子进程内完成了）。记录它，使状态查询仍然诚实。
            managed.backgroundTaskRegistry.set(event.taskId, {
              taskId: event.taskId,
              startTime: Date.now(),
              status: event.status,
              completedAt: Date.now(),
            })
          }
          sessionLog.info(`[bg-lifecycle] task completed`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })

          this.evictStaleBackgroundTasks(managed)
        }
        // 转发给渲染器以进行 UI 更新
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)

        // WS2 keep-alive: when a background agent finishes while the session is
        // IDLE, nobody is consuming its result — the main agent already ended its
        // turn, so the completion only updates the registry/chip and the findings
        // never make it back into the conversation ("the agent never returned the
        // result"). Wake the session with a system-generated follow-up so the agent
        // reads the output and presents it. During an active turn (isProcessing)
        // the terminal notification reaches the agent through the live stream, so
        // we skip then. Gated on keep-alive because only that mode delivers this
        // event between turns; guarded against duplicate notifications.
        if (managed && this.keepBackgroundTasksAlive && !managed.isProcessing && !wasAlreadyTerminal) {
          const taskIntent = managed.backgroundTaskRegistry.get(event.taskId)?.intent
          const outputFile = event.outputFile || managed.backgroundTaskOutputs.get(event.taskId)?.outputFile
          const label = taskIntent ? `"${taskIntent}"` : `task ${event.taskId}`
          const nudge = event.status === 'completed'
            ? [
                `[background-task-completed] The background agent you launched (${label}) has finished.`,
                outputFile ? `Its full output is saved at: ${outputFile}` : '',
                `Read that output file and present the results to the user now. Do NOT spawn another background agent — just read the file and summarize the findings inline.`,
              ].filter(Boolean).join('\n')
            : [
                `[background-task-${event.status}] The background agent you launched (${label}) ended with status "${event.status}".`,
                outputFile ? `Any partial output is at: ${outputFile}.` : '',
                `Briefly let the user know it did not complete successfully. Do NOT spawn another background agent.`,
              ].filter(Boolean).join('\n')
          sessionLog.info(`[bg-lifecycle] surfacing completed background task to idle session`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })
          // Ride the normal turn machinery (resume + persistence). `hidden: true`
          // keeps the nudge out of the transcript — the agent's response (the
          // presented result) renders as a normal assistant turn.
          void this.sendMessage(sessionId, nudge, [], [], { hidden: true }).catch((err) => {
            sessionLog.error(`[bg-lifecycle] failed to surface completed task ${event.taskId}:`, err)
          })
        }
        break
      }

      case 'shell_backgrounded':
        // 存储命令，以便稍后终止进程
        if (event.command && managed) {
          managed.backgroundShellCommands.set(event.shellId, event.command)
          sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`)
        }
        // 转发给渲染器
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'source_activated': {
        // 一个来源在轮次中被自动激活。服务器会安排重新发送
        // 原始消息，并附加 "[<slug> activated]" 后缀，以便无头部署
        // （WebUI、docker 服务器）以与渲染器过去相同的方式链接激活。
        // 渲染器仍然接收事件以呈现激活反馈，但不再
        // 触发自己的 auto_retry（参见 processor.ts）。
        sessionLog.info(`Source "${event.sourceSlug}" activated for session ${sessionId}, scheduling auto-retry`)

        this.sendEvent({
          type: 'source_activated',
          sessionId,
          sourceSlug: event.sourceSlug,
          originalMessage: event.originalMessage,
        }, workspaceId)

        if (!managed) break

        const originalMessage = event.originalMessage ?? ''
        if (!originalMessage.trim()) {
          sessionLog.warn(`Source "${event.sourceSlug}" activated for session ${sessionId}, but originalMessage was empty; skipping auto-retry`)
          break
        }

        const messageWithSuffix = `${originalMessage}\n\n[${event.sourceSlug} activated]`
        const messageCountAtSchedule = managed.messages.length

        // 暂存重试负载，以便来自旧版渲染器的重复 sendMessage
        // （混合版本发布：新服务器 + v0.9.5 Electron 客户端）被去重。
        // 2 秒窗口覆盖了不稳定的移动/代理链路上的 WS 延迟尾部。
        managed.autoRetryPending = {
          content: messageWithSuffix,
          deadlineMs: Date.now() + 2000,
          committed: false,
        }

        if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
        managed.autoRetryTimer = setTimeout(() => {
          const current = this.sessions.get(sessionId)
          if (!current) return
          current.autoRetryTimer = undefined

          // 如果用户在 100 毫秒窗口内发送了后续消息，则跳过 — 他们抢先了。
          if (current.messages.length > messageCountAtSchedule) {
            sessionLog.info(`Auto-retry skipped for ${sessionId}: follow-up message arrived first`)
            current.autoRetryPending = undefined
            return
          }

          // 注意：不要在此处清除 autoRetryPending — sendMessage() 需要看到它
          // 以便旧版渲染器大约 50 毫秒后到达的重复 RPC 被丢弃。
          // 待处理槽位由 sendMessage 中的截止时间检查清除，由
          // 下一个作为重复项丢弃的匹配 sendMessage 清除，或由会话删除清除。
          this.sendMessage(sessionId, messageWithSuffix).catch(err => {
            sessionLog.error(`Auto-retry sendMessage failed for ${sessionId}:`, err)
          })
        }, 100)
        break
      }

      case 'complete':
        // 来自 CraftAgent 的完成事件 — 累加本轮的使用量
        // 发送给渲染器的实际 'complete' 来自 sendMessage 中的 finally 块
        if (event.usage) {
          // 如果未设置，则初始化 tokenUsage
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = 当前上下文大小（本轮发送的完整对话），非累加
          // 每次 API 调用都会发送完整的对话历史，因此我们使用最新值
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens 和 costUsd 在所有轮次中累加（总会话使用量）
          managed.tokenUsage.outputTokens += event.usage.outputTokens
          managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          managed.tokenUsage.costUsd += event.usage.costUsd ?? 0
          // 缓存令牌反映当前状态，非累加
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0
          // 更新上下文窗口（使用最新值 — 如果模型切换，可能会改变）
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // 处理期间用于上下文显示的实时使用量更新
        // 使用最新的上下文大小更新托管会话的 tokenUsage
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // 仅更新 inputTokens（当前上下文大小）— 其他字段在 complete 时累加
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }

          // 发送给渲染器以进行即时 UI 更新
          this.sendEvent({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
              inputTokens: event.usage.inputTokens,
              contextWindow: event.usage.contextWindow,
            },
          }, workspaceId)
        }
        break

      case 'steer_undelivered':
        // Steer 消息未送达（在轮次结束前未触发 PreToolUse）。
        // 重新排队，以便在下一轮作为普通消息发送。
        sessionLog.info(`Steer message undelivered, re-queuing for session ${sessionId}`)
        managed.messageQueue.push({ message: event.message })
        managed.wasInterrupted = true
        break

      // 注意：working_directory_changed 仅由用户发起（通过 updateWorkingDirectory），
      // 代理不再拥有 change_working_directory 工具
    }
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!this.eventSink) {
      sessionLog.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  /**
   * 文本增量批处理队列。
   *
   * Agent 流式输出时可能每秒产生几十个 `text_delta`；如果每条都 IPC 到前端，
   * 会造成渲染线程高负载。这里把同一会话的增量合并，每 `DELTA_BATCH_INTERVAL_MS`
   *（默认 50ms）刷新一次，可把 IPC 频率从 50+/sec 降到约 20/sec。
   *
   * 与 Go 的类比：
   * - 类似 Go 里一个带超时 flush 的 `bytes.Buffer` + `time.After`；
   * - `setTimeout` 相当于一个一次性定时器，类似 `time.NewTimer`。
   */
  private queueDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      // 追加到现有批次
      existing.delta += delta
      // 保留最新的 turnId（应该相同，但以防万一）
      if (turnId) existing.turnId = turnId
    } else {
      // 开始新批次
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    // 如果尚未调度，则调度刷新
    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushDelta(sessionId, workspaceId)
      }, DELTA_BATCH_INTERVAL_MS)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  /**
   * 刷新文本增量批次。
   *
   * 触发时机：
   * - `queueDelta` 设置的 50ms 定时器到期；
   * - `text_complete` 时立即 flush，避免完整消息前还有未发送的增量。
   */
  private flushDelta(sessionId: string, workspaceId: string): void {
    // 清除定时器
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    // 如果有，则发送批量的 delta
    const pending = this.pendingDeltas.get(sessionId)
    if (pending && pending.delta) {
      this.sendEvent({
        type: 'text_delta',
        sessionId,
        delta: pending.delta,
        turnId: pending.turnId
      }, workspaceId)
      this.pendingDeltas.delete(sessionId)
    }
  }

  /**
   * 通过创建新会话并发送提示来执行提示自动化。
   *
   * 当参数列表超出可读性时，选项对象形式取代了之前的位置参数签名 —
   * `thinkingLevel` 是触发因素。
   * 当省略 `thinkingLevel` 时，`createSession` 会回退到工作区默认值（然后是 DEFAULT_THINKING_LEVEL）。
   */
  async executePromptAutomation(
    input: ExecutePromptAutomationInput,
  ): Promise<{ sessionId: string }> {
    const {
      workspaceId,
      workspaceRootPath,
      prompt,
      labels,
      permissionMode,
      mentions,
      llmConnection,
      model,
      thinkingLevel,
      automationName,
      telegramTopic,
      waitForCompletion,
    } = input

    // 如果指定了 llmConnection 但无法解析，则发出警告
    if (llmConnection) {
      const connection = resolveSessionConnection(llmConnection)
      if (!connection) {
        sessionLog.warn(`[Automations] llmConnection "${llmConnection}" not found, using default`)
      }
    }

    // 将 @提及 解析为来源/技能 slug
    const resolved = mentions ? this.resolveAutomationMentions(workspaceRootPath, mentions) : undefined

    // 在将会话分配给工作区配置之前，确保标签存在于其中
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // 如果提供了自动化名称，则使用它，否则回退到提示片段
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // 为此自动化创建一个新会话
    const session = await this.createSession(workspaceId, {
      name: sessionName,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      llmConnection,
      model,
      thinkingLevel,
    })

    // 填充 triggeredBy 元数据，以便显式跳过标题生成
    // 并且会话在重新加载后可被识别为自动化发起的
    const managed = this.sessions.get(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, timestamp: Date.now() }
      this.persistSession(managed)
    }

    // （session_created 事件由上方的 createSession 发出；triggeredBy 在渲染器的
    // hydrate 往返解析之前同步设置，因此会被观察到。）

    // 如果匹配器声明了 `telegramTopic`，则将新会话绑定到其 Telegram 论坛主题。
    // 在 `sendMessage` 之前完成，以便第一个
    // 助手令牌已经通过绑定的主题路由。失败
    // 在绑定器内部记录；会话继续未绑定状态。
    if (this.automationBinder && telegramTopic && telegramTopic.trim().length > 0) {
      try {
        await this.automationBinder({
          workspaceId,
          sessionId: session.id,
          topicName: telegramTopic.trim(),
        })
      } catch (err) {
        sessionLog.warn('[Automations] automation binder threw', {
          sessionId: session.id,
          telegramTopic,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 发送 prompt。
    // 测试运行传入 `waitForCompletion: false`，这样我们在 session 存在且 prompt 已派发后
    // 就立即返回 —— 否则 RPC 会阻塞到整个 turn（含工具调用）结束，触发 30s 客户端超时
    //（craft-agents-oss#943）。无论哪种方式 session 都会实时流式输出；
    // 后台失败会浮现在 session UI 中并在此处记录日志。
    if (waitForCompletion === false) {
      void this.sendMessage(session.id, prompt, undefined, undefined, {
        skillSlugs: resolved?.skillSlugs,
      }).catch((err) => {
        sessionLog.error('[Automations] background sendMessage failed for test run', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return { sessionId: session.id }
    }

    // 发送提示
    await this.sendMessage(session.id, prompt, undefined, undefined, {
      skillSlugs: resolved?.skillSlugs,
    })

    return { sessionId: session.id }
  }

  /**
   * 将自动化提示中的 @提及 解析为来源和技能 slug
   */
  private resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  // ============================================
  // 导出 / 导入 / 分发
  // ============================================

  private async generateRemoteTransferSummary(managed: ManagedSession): Promise<string | null> {
    await this.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !m.isIntermediate)
      .map(m => ({
        type: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ?? backendContext.connection.defaultModel ?? getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
      ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          id: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: managed.workingDirectory,
          sdkCwd: managed.sdkCwd,
          model: managed.model,
          llmConnection: managed.llmConnection,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.connection?.piAuthProvider },
    })

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      agent.destroy()
    }
  }

  async exportRemoteSessionTransfer(sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`)
      return null
    }

    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const summary = await this.generateRemoteTransferSummary(managed)
    if (!summary) {
      sessionLog.warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`)
      return null
    }

    return {
      sourceSessionId: managed.id,
      name: managed.name,
      sessionStatus: managed.sessionStatus,
      labels: managed.labels,
      permissionMode: managed.permissionMode,
      summary,
    }
  }

  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }

    const session = await this.createSession(workspaceId, {
      name: payload.name,
      permissionMode: payload.permissionMode,
      sessionStatus: payload.sessionStatus,
      labels: payload.labels,
    })

    const managed = this.sessions.get(session.id)
    if (!managed) {
      throw new Error(`Transferred session ${session.id} was not created`)
    }

    managed.transferredSessionSummary = payload.summary.trim()
    managed.transferredSessionSummaryApplied = false
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(session.id)

    return { sessionId: session.id }
  }

  /**
   * 将会话导出为可移植的 SessionBundle。
   *
   * 步骤：
   * 1. 验证会话存在并解析其工作区
   * 2. 如果会话正在处理中，则拒绝（调用者必须先停止它）
   * 3. 刷新待处理的持久化写入
   * 4. 将会话目录序列化为一个 bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // 刷新待写入数据，确保 JSONL 文件为最新状态
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * 将会话包导入目标工作区。
   *
   * 步骤：
   * 1. 验证包结构及目标工作区
   * 2. 生成新会话 ID（分支）或使用原 ID（移动）
   * 3. 创建会话目录并写入 JSONL 及文件
   * 4. 在内存中注册会话
   * 5. 触发 session_created 事件
   * 6. 返回新会话 ID 及兼容性警告
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // 确定会话 ID
    const sessionId = mode === 'move'
      ? bundle.session.header.id
      : generateSessionId(workspaceRootPath)

    // 移动时检查 ID 冲突
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // 创建包含所有子目录的会话目录
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)

    // 根据包数据构建存储的会话
    const header = bundle.session.header
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      sdkSessionId: header.sdkSessionId, // 初始保留；后续分支逻辑可能清除
      // 始终为目标工作区重新生成 sdkCwd。
      // 源 sdkCwd 指向原始服务器上的路径
      // 该路径在当前服务器上不存在（跨服务器传输）。
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      permissionMode: header.permissionMode,
      previousPermissionMode: header.previousPermissionMode,
      sessionStatus: header.sessionStatus,
      labels: header.labels,
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      model: header.model,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    // 分支专用：若提供 branchInfo，则设置 SDK 分支
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // 分支专用：清除共享状态并尝试恢复优先策略
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // 恢复优先：尝试在目标工作区找到兼容的 LLM 连接。
      // 若找到且会话有 sdkSessionId，则保留以支持 API 级恢复。
      // 若未找到，则清除 SDK 状态并回退到已传输的会话摘要。
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(workspaceRootPath, sourceProviderType)
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // 恢复路径：存在兼容凭据——保留 SDK 会话 ID
        sessionLog.info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`)
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        // 摘要路径：无兼容连接或无 SDK 会话——清除以重新开始
        if (storedSession.llmConnection) {
          sessionLog.info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`)
        }
        storedSession.sdkSessionId = undefined
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // 清除思考级别，使会话继承工作区默认值
      storedSession.thinkingLevel = undefined
      // 清除工作目录——源路径在另一台服务器上不存在。
      // 用户可在会话传输后设置新的 cwd。
      storedSession.workingDirectory = undefined
    }

    // 检查源兼容性（在写入 JSONL 之前，以便修复得以持久化）
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        sessionLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
    }

    // 检查移动模式下的 LLM 连接兼容性（分支模式已在上方清除）
    if (mode === 'move' && storedSession.llmConnection) {
      sessionLog.info(`[import] Checking LLM connection: "${storedSession.llmConnection}"`)
      const conn = resolveSessionConnection(storedSession.llmConnection, undefined)
      if (!conn) {
        sessionLog.warn(`[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`)
        warnings.push(`LLM connection "${storedSession.llmConnection}" not found in target — session will use default`)
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        sessionLog.info(`[import] LLM connection "${storedSession.llmConnection}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      sessionLog.info('[import] No LLM connection in bundle — will use default')
    }

    // 写入 JSONL 文件（在兼容性检查之后，以便重映射的值持久化）
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    sessionLog.info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`)
    writeSessionJsonl(sessionFile, storedSession)

    // 写入所有包文件（附件、计划、数据、下载等）
    // 使用 restoreFiles() 进行路径遍历、大小及 base64 校验。
    restoreFiles(sessionDir, bundle.files)

    // 在内存中注册——传递不含消息的会话元数据以避免
    // StoredMessage[] 与 Message[] 类型不匹配，然后单独转换消息
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.sessions.set(sessionId, managed)

    // 初始化自动化元数据
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(sessionId, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // 手动构建的（非 createSession 创建），因此显式宣布。
    this.notifySessionCreated(workspaceId, sessionId)

    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * 查找此服务器上与给定提供者类型匹配的 LLM 连接。
   * 优先检查工作区默认连接，然后回退到任何匹配的连接。
   */
  private findCompatibleLlmConnection(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.defaultLlmConnection
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // 回退：任何匹配提供者类型的连接
    const connections = getLlmConnections()
    const match = connections.find(c => c.providerType === providerType)
    return match?.slug ?? null
  }

  /**
   * 清理 SessionManager 持有的所有资源。
   * 应在应用关闭时调用，以防止资源泄漏。
   */
  cleanup(): void {
    sessionLog.info('Cleaning up resources...')

    // 停止所有 ConfigWatcher（文件系统监视器）
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // 释放所有 AutomationSystem（包括调度器、处理器和事件记录器）
    for (const [workspacePath, automationSystem] of this.automationSystems) {
      try {
        automationSystem.dispose()
        sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error)
      }
    }
    this.automationSystems.clear()

    // 清除所有待处理的增量刷新定时器
    for (const [sessionId, timer] of this.deltaFlushTimers) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()

    // 清除待处理的凭据解析器（它们不会被解析，但可防止内存泄漏）
    this.pendingCredentialResolvers.clear()
    this.pendingPermissionRequests.clear()
    this.adminRememberApprovals.clear()

    // 清理所有会话的会话级工具回调
    for (const sessionId of this.sessions.keys()) {
      unregisterSessionScopedToolCallbacks(sessionId)
    }

    sessionLog.info('Cleanup complete')
  }
}

/**
 * 会话存储
 *
 * Workspace 范围内的会话 CRUD 操作。
 * 会话存储在 {workspaceRootPath}/sessions/{id}/session.jsonl
 * 每个会话目录包含：
 * - session.jsonl（主数据，JSONL 格式：第 1 行 header，第 2 行起消息）
 * - attachments/（文件附件）
 * - plans/（Safe Mode 的 plan 文件）
 * - data/（transform_data 工具输出：datatable/spreadsheet 用的 JSON 文件）
 * - long_responses/（因大小限制被摘要的完整工具结果）
 * - downloads/（从 API 源下载的二进制文件：PDF、图片、压缩包等）
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import { getWorkspaceSessionsPath } from '../workspaces/storage.ts';
import { generateUniqueSessionId } from './slug-generator.ts';
import { toPortablePath, expandPath } from '../utils/paths.ts';
import { sanitizeSessionId } from './validation.ts';
import { perf } from '../utils/perf.ts';
import type {
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionTokenUsage,
  SessionHeader,
  SessionStatus,
} from './types.ts';
import type { Plan } from '../agent/plan-types.ts';
import { validateSessionStatus } from '../statuses/validation.ts';
import { debug } from '../utils/debug.ts';
import { getStatusCategory } from '../statuses/storage.ts';
import { readSessionHeader, readSessionJsonl } from './jsonl.ts';
import { sessionPersistenceQueue } from './persistence-queue.ts';

// 为方便使用，重新导出类型
export type { SessionConfig } from './types.ts';

// ============================================================
// 目录工具
// ============================================================

/**
 * 确保 workspace 的 sessions 目录存在。
 */
export function ensureSessionsDir(workspaceRootPath: string): string {
  const dir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取某个会话目录的路径。
 *
 * 安全：使用 sanitizeSessionId() 做纵深防御，防止路径遍历。
 * 调用方仍应提前校验 sessionId。
 */
export function getSessionPath(workspaceRootPath: string, sessionId: string): string {
  // 纵深防御：去掉 sessionId 中的路径成分
  const safeSessionId = sanitizeSessionId(sessionId);
  return join(getWorkspaceSessionsPath(workspaceRootPath), safeSessionId);
}

/**
 * 获取某个会话 JSONL 文件的路径（在会话目录内）。
 */
export function getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'session.jsonl');
}

/**
 * 确保会话目录存在，并包含所有子目录。
 */
export function ensureSessionDir(workspaceRootPath: string, sessionId: string): string {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  // 同时创建 plans、attachments、long_responses、downloads 等子目录
  const plansDir = join(sessionDir, 'plans');
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  const attachmentsDir = join(sessionDir, 'attachments');
  if (!existsSync(attachmentsDir)) {
    mkdirSync(attachmentsDir, { recursive: true });
  }
  const longResponsesDir = join(sessionDir, 'long_responses');
  if (!existsSync(longResponsesDir)) {
    mkdirSync(longResponsesDir, { recursive: true });
  }
  // transform_data 工具输出的 JSON 文件目录（datatable/spreadsheet）
  const dataDir = join(sessionDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  // 从 API 响应下载的二进制文件目录（PDF、图片等）
  const downloadsDir = join(sessionDir, 'downloads');
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * 获取会话的附件目录。
 */
export function getSessionAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'attachments');
}

/**
 * 获取会话的 plan 文件目录。
 */
export function getSessionPlansPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'plans');
}

/**
 * 获取会话的 data 目录（transform_data 工具输出）。
 */
export function getSessionDataPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'data');
}

/**
 * 获取会话的 downloads 目录（API 返回的二进制文件）。
 */
export function getSessionDownloadsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'downloads');
}

// ============================================================
// 会话 ID 生成
// ============================================================

/**
 * 获取已有会话 ID，用于生成新 ID 时做冲突检测。
 */
function getExistingSessionIds(workspaceRootPath: string): Set<string> {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    return new Set();
  }
  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
}

/**
 * 生成人类可读的会话 ID。
 * 格式：YYMMDD-adjective-noun（例如 260111-swift-river）
 */
export function generateSessionId(workspaceRootPath: string): string {
  const existingIds = getExistingSessionIds(workspaceRootPath);
  return generateUniqueSessionId(existingIds);
}

// ============================================================
// 会话 CRUD
// ============================================================

/**
 * 为 workspace 创建一个新会话。
 */
export async function createSession(
  workspaceRootPath: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    permissionMode?: SessionConfig['permissionMode'];
    enabledSourceSlugs?: string[];
    model?: string;
    llmConnection?: string;
    hidden?: boolean;
    sessionStatus?: SessionConfig['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
    projectId?: string;
    parentSessionId?: string;
    taskSlug?: string;
    taskRunId?: string;
    taskNodeId?: string;
    taskDraft?: boolean;
  }
): Promise<SessionConfig> {
  ensureSessionsDir(workspaceRootPath);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceRootPath);

  // 创建会话目录及其子目录（plans、attachments 等）
  ensureSessionDir(workspaceRootPath, sessionId);

  // sdkCwd 在创建时确定，之后不再改变。
  // SDK 把会话 transcript 存在 ~/.claude/projects/{cwd-hash}/ 下。
  // 即使 workingDirectory 后续变化，sdkCwd 也不变，保证能恢复会话。
  const sdkCwd = options?.workingDirectory ?? getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    workingDirectory: options?.workingDirectory,
    sdkCwd,
    permissionMode: options?.permissionMode,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    llmConnection: options?.llmConnection,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
    projectId: options?.projectId,
    parentSessionId: options?.parentSessionId,
    taskSlug: options?.taskSlug,
    taskRunId: options?.taskRunId,
    taskNodeId: options?.taskNodeId,
    taskDraft: options?.taskDraft,
  };

  // 保存一个空会话
  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * 按指定 ID 获取会话；不存在则创建。
 * 用于 --session <id> 命令行参数，允许用户自定义会话 ID。
 */
export async function getOrCreateSessionById(
  workspaceRootPath: string,
  sessionId: string
): Promise<SessionConfig> {
  const existing = loadSession(workspaceRootPath, sessionId);
  if (existing) {
    return {
      id: existing.id,
      sdkSessionId: existing.sdkSessionId,
      workspaceRootPath: existing.workspaceRootPath,
      name: existing.name,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      sdkCwd: existing.sdkCwd,
      workingDirectory: existing.workingDirectory,
    };
  }

  // 指定 ID 不存在则创建新会话
  ensureSessionsDir(workspaceRootPath);
  ensureSessionDir(workspaceRootPath, sessionId);

  const now = Date.now();
  // sdkCwd 设为会话目录，创建后不再改变
  const sdkCwd = getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    sdkCwd,
    createdAt: now,
    lastUsedAt: now,
  };

  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession);

  return session;
}

/**
 * 立即保存会话。
 * 通过持久化队列入队并 flush，确保立刻落盘。
 *
 * 这种统一写路径在 Windows 上更可靠。
 * 写入 JSONL 格式：第 1 行 header，第 2 行起消息。
 */
export async function saveSession(session: StoredSession): Promise<void> {
  sessionPersistenceQueue.enqueue(session);
  await sessionPersistenceQueue.flush(session.id);
}

/**
 * 把会话加入异步持久化队列并防抖。
 * 多次快速调用会合并成一次写入。
 * 活跃会话中使用，避免阻塞主线程。
 */
export { sessionPersistenceQueue, getHeaderMetadataSignature } from './persistence-queue.js'

/**
 * 按 ID 加载完整会话。
 * 从 JSONL 文件读取。
 */
export function loadSession(workspaceRootPath: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);
  if (existsSync(jsonlPath)) {
    const session = readSessionJsonl(jsonlPath);
    if (session) {
      end();
      return session;
    }
  }

  end();
  return null;
}

/**
 * 列出 workspace 中的所有会话。
 *
 * 利用 JSONL header 实现快速加载：只读每个文件的第一行。
 */
export function listSessions(workspaceRootPath: string): SessionMetadata[] {
  const span = perf.span('session.listSessions');
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    span.end();
    return [];
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  span.mark('readdir');
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionId = entry.name;
      const sessionDir = join(sessionsDir, sessionId);
      const jsonlFile = join(sessionDir, 'session.jsonl');

      // 清理崩溃原子写留下的孤立 .tmp 文件， harmless 但占空间
      const tmpFile = jsonlFile + '.tmp';
      if (existsSync(tmpFile)) {
        try { unlinkSync(tmpFile); } catch { /* 忽略 */ }
      }

      if (existsSync(jsonlFile)) {
        const header = readSessionHeader(jsonlFile);
        if (header) {
          const metadata = headerToMetadata(header, workspaceRootPath);
          if (metadata) sessions.push(metadata);
        }
      }
    }
  }
  span.mark('parsed');
  span.setMetadata('count', sessions.length);

  // 按 lastUsedAt 降序排列（最近的在前）
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

/**
 * 把 SessionHeader 转成 SessionMetadata。
 * 用于从 JSONL 第一行快速生成会话列表。
 */
function headerToMetadata(header: SessionHeader, workspaceRootPath: string): SessionMetadata | null {
  try {
    // 兼容旧字段：早期版本叫 todoState
    const rawStatus = header.sessionStatus ?? (header as unknown as { todoState?: string }).todoState;
    // 根据 workspace 状态配置校验 sessionStatus
    const validatedStatus = validateSessionStatus(workspaceRootPath, rawStatus);

    // 统计 plan 文件数量
    const planCount = listPlanFiles(workspaceRootPath, header.id).length;

    // 兼容旧数据：没有 sdkCwd 时回退到 workingDirectory
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    // 解构出 SessionMetadata 不需要或需要覆盖的字段
    const {
      pendingPlanExecution: _pp,
      sessionStatus: _ss, workingDirectory: _wd, sdkCwd: _sc,
      workspaceRootPath: _wrp, ...headerFields
    } = header;

    return {
      ...headerFields,
      workspaceRootPath,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
    } as SessionMetadata;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.id}" in ${workspaceRootPath}:`, error);
    return null;
  }
}

/**
 * 删除会话及其关联文件。
 * 删除整个会话目录。
 */
export function deleteSession(workspaceRootPath: string, sessionId: string): boolean {
  try {
    // 删除会话目录（包含 session.jsonl、attachments、plans 等）
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 清空会话消息但保留元数据。
 * 用于 /clear 命令：重置对话而不新建会话。
 * 同时清空 SDK session ID，让 Claude 开启一次新对话。
 */
export async function clearSessionMessages(workspaceRootPath: string, sessionId: string): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    // 清空消息和 SDK session ID，但保留其他元数据
    session.messages = [];
    session.sdkSessionId = undefined;
    // token 使用量归零
    session.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    };
    await saveSession(session);
  }
}

/**
 * 获取 workspace 最新的会话；没有则创建。
 * 使用 listActiveSessions 排除已归档会话。
 */
export async function getOrCreateLatestSession(workspaceRootPath: string): Promise<SessionConfig> {
  const sessions = listActiveSessions(workspaceRootPath);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      id: latest.id,
      sdkSessionId: latest.sdkSessionId,
      workspaceRootPath: latest.workspaceRootPath,
      name: latest.name,
      createdAt: latest.createdAt,
      lastUsedAt: latest.lastUsedAt,
    };
  }
  return createSession(workspaceRootPath);
}

// ============================================================
// 会话元数据更新
// ============================================================

/**
 * 更新会话的 SDK session ID。
 */
export async function updateSessionSdkId(
  workspaceRootPath: string,
  sessionId: string,
  sdkSessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    session.sdkSessionId = sdkSessionId;
    await saveSession(session);
  }
}

/**
 * 判断是否可以安全更新会话的 sdkCwd。
 *
 * sdkCwd 通常不可变，因为 SDK 把会话 transcript 存在
 * ~/.claude/projects/{cwd-hash}/ 下。但如果还没有发生任何 SDK 交互
 *（没有需要保留的 transcript），就可以安全更新。
 *
 * @returns 没有消息且没有 SDK session ID 时返回 true
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // 安全更新的条件：
  // 1. 还没有发送过消息（没有需要保留的对话）
  // 2. 没有 SDK session ID（sdkCwd 路径下没有 transcript）
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * 更新会话元数据。
 *
 * updates 参数类型解释：
 * Pick<SessionConfig, 'isFlagged' | ...> 从 SessionConfig 中挑出允许修改的字段；
 * Partial<...> 表示这些字段都是可选的。
 * 类似 Go 里传一个可选字段很多的 UpdateRequest struct。
 */
export async function updateSessionMetadata(
  workspaceRootPath: string,
  sessionId: string,
  updates: Partial<Pick<SessionConfig,
    | 'isFlagged'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'permissionMode'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'llmConnection'
    | 'isArchived'
    | 'archivedAt'
    | 'projectId'
  >>
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = updates.workingDirectory;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if (updates.permissionMode !== undefined) session.permissionMode = updates.permissionMode;
  if ('lastReadMessageId' in updates) session.lastReadMessageId = updates.lastReadMessageId;
  if ('hasUnread' in updates) session.hasUnread = updates.hasUnread;
  if ('sharedUrl' in updates) session.sharedUrl = updates.sharedUrl;
  if ('sharedId' in updates) session.sharedId = updates.sharedId;
  if (updates.model !== undefined) session.model = updates.model;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) session.archivedAt = updates.archivedAt;
  if ('projectId' in updates) session.projectId = updates.projectId;

  await saveSession(session);
}

/**
 * 标记会话为 flagged。
 */
export async function flagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: true });
}

/**
 * 取消会话的 flagged 标记。
 */
export async function unflagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: false });
}

/**
 * 设置会话状态。
 */
export async function setSessionStatus(
  workspaceRootPath: string,
  sessionId: string,
  sessionStatus: SessionStatus
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { sessionStatus });
}

/**
 * 设置会话标签。
 */
export async function setSessionLabels(
  workspaceRootPath: string,
  sessionId: string,
  labels: string[]
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { labels });
}

/**
 * 设置或清除 session 的项目绑定。
 * 传入 `null` 即可解绑。
 */
export async function setSessionProjectId(
  workspaceRootPath: string,
  sessionId: string,
  projectId: string | null
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    projectId: projectId === null ? undefined : projectId,
  });
}

/**
 * 解除所有引用了某个 projectId 的 session 的绑定。
 * 在项目被删除时调用 —— session 本身保留，只是取消关联。
 * 返回受影响的 session 数量。
 */
export async function unbindProjectFromSessions(
  workspaceRootPath: string,
  projectId: string
): Promise<number> {
  const sessions = listSessions(workspaceRootPath);
  let touched = 0;
  for (const meta of sessions) {
    const full = loadSession(workspaceRootPath, meta.id);
    if (full?.projectId === projectId) {
      full.projectId = undefined;
      await saveSession(full);
      touched++;
    }
  }
  return touched;
}

/**
 * 归档会话。
 */
export async function archiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: true,
    archivedAt: Date.now(),
  });
}

/**
 * 取消归档会话。
 */
export async function unarchiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: false,
    archivedAt: undefined,
  });
}

// ============================================================
// Pending Plan Execution（Accept & Compact 流程）
// ============================================================

/**
 * 设置 pending plan execution 状态。
 * 用户点击 "Accept & Compact" 时调用：保存 plan 路径，
 * 这样即使页面刷新，compaction 完成后仍能恢复执行。
 */
export async function setPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  planPath: string,
  draftInputSnapshot?: string,
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  session.pendingPlanExecution = {
    planPath,
    draftInputSnapshot,
    awaitingCompaction: true,
    executionDispatched: false,
  };
  await saveSession(session);
}

/**
 * 标记 compaction 已完成。
 * 在 compaction_complete 事件触发时调用：把 awaitingCompaction 设为 false，
 * 刷新后恢复逻辑就知道可以触发执行。
 */
export async function markCompactionComplete(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.awaitingCompaction = false;
  await saveSession(session);
}

/**
 * 标记 pending plan execution 已经从 UI 分发。
 * 防止刷新恢复时把同一条批准消息发送两次。
 */
export async function markPendingPlanExecutionDispatched(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.executionDispatched = true;
  await saveSession(session);
}

/**
 * 清除 pending plan execution 状态。
 * 在 plan 执行已发送、收到新用户消息、或不再需要时调用。
 */
export async function clearPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  delete session.pendingPlanExecution;
  await saveSession(session);
}

/**
 * 获取会话的 pending plan execution 状态。
 * 刷新时用它判断是否需要恢复 plan 执行。
 */
export function getPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string
): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return null;
  return {
    ...session.pendingPlanExecution,
    executionDispatched: session.pendingPlanExecution.executionDispatched === true,
  };
}

// ============================================================
// 会话筛选
// ============================================================

/**
 * 列出已 flagged 的会话（不包含已归档）。
 */
export function listFlaggedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => s.isFlagged === true);
}

/**
 * 列出已完成会话（category 为 closed）。
 * 包括 done、cancelled 以及任何自定义的 closed 状态；不包含已归档。
 */
export function listCompletedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'closed';
  });
}

/**
 * 列出收件箱会话（category 为 open）。
 * 包括 todo、in-progress、needs-review 以及任何自定义的 open 状态；不包含已归档。
 */
export function listInboxSessions(workspaceRootPath: string): SessionMetadata[] {
  return listActiveSessions(workspaceRootPath).filter(s => {
    const category = getStatusCategory(workspaceRootPath, s.sessionStatus || 'todo');
    return category === 'open';
  });
}

/**
 * 列出已归档会话。
 */
export function listArchivedSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived === true);
}

/**
 * 列出活跃（未归档）会话。
 */
export function listActiveSessions(workspaceRootPath: string): SessionMetadata[] {
  return listSessions(workspaceRootPath).filter(s => s.isArchived !== true);
}

/**
 * 删除超过保留天数的已归档会话。
 * @returns 删除的会话数量
 */
export function deleteOldArchivedSessions(workspaceRootPath: string, retentionDays: number): number {
  const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const archivedSessions = listArchivedSessions(workspaceRootPath);
  let deletedCount = 0;

  for (const session of archivedSessions) {
    // 优先用 archivedAt，不存在则回退到 lastUsedAt
    const archiveTime = session.archivedAt ?? session.lastUsedAt;
    if (archiveTime < cutoffTime) {
      if (deleteSession(workspaceRootPath, session.id)) {
        deletedCount++;
      }
    }
  }

  return deletedCount;
}

// ============================================================
// Plan 存储（按会话隔离）
// ============================================================

/**
 * 把字符串转成适合文件名的 slug。
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * 为 plan 生成唯一且可读的文件名。
 */
function generatePlanFileName(plan: Plan, plansDir: string): string {
  let name = plan.title || plan.context?.substring(0, 50) || 'untitled';
  let slug = slugify(name);

  if (slug.length > 40) {
    slug = slug.substring(0, 40).replace(/-$/, '');
  }

  const date = new Date().toISOString().split('T')[0];
  const baseName = `${date}-${slug}`;

  let fileName = baseName;
  let counter = 2;

  while (existsSync(join(plansDir, `${fileName}.md`))) {
    fileName = `${baseName}-${counter}`;
    counter++;
  }

  return fileName;
}

/**
 * 确保会话的 plans 目录存在。
 */
function ensurePlansDir(workspaceRootPath: string, sessionId: string): string {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  return plansDir;
}

/**
 * 把 Plan 对象格式化为 Markdown。
 */
export function formatPlanAsMarkdown(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# ${plan.title}`);
  lines.push('');
  lines.push(`**Status:** ${plan.state}`);
  lines.push(`**Created:** ${new Date(plan.createdAt).toISOString()}`);
  if (plan.updatedAt !== plan.createdAt) {
    lines.push(`**Updated:** ${new Date(plan.updatedAt).toISOString()}`);
  }
  lines.push('');

  if (plan.context) {
    lines.push('## Summary');
    lines.push('');
    lines.push(plan.context);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of plan.steps) {
    const checkbox = step.status === 'completed' ? '[x]' : '[ ]';
    const status = step.status === 'in_progress' ? ' *(in progress)*' : '';
    lines.push(`- ${checkbox} ${step.description}${status}`);
    if (step.details) {
      lines.push(`  - Tools: ${step.details}`);
    }
  }
  lines.push('');

  if (plan.refinementHistory && plan.refinementHistory.length > 0) {
    lines.push('## Refinement History');
    lines.push('');
    for (const entry of plan.refinementHistory) {
      lines.push(`### Round ${entry.round}`);
      lines.push(`**Feedback:** ${entry.feedback}`);
      if (entry.questions && entry.questions.length > 0) {
        lines.push(`**Questions:** ${entry.questions.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * 把 Markdown plan 文件解析回 Plan 对象。
 */
export function parsePlanFromMarkdown(content: string, planId: string): Plan | null {
  try {
    const lines = content.split('\n');

    const titleLine = lines.find(l => l.startsWith('# '));
    const title = titleLine ? titleLine.substring(2).trim() : 'Untitled Plan';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const stateStr = statusLine ? statusLine.replace('**Status:**', '').trim() : 'ready';
    const state = (['creating', 'refining', 'ready', 'executing', 'completed', 'cancelled'].includes(stateStr)
      ? stateStr
      : 'ready') as Plan['state'];

    const summaryIdx = lines.findIndex(l => l === '## Summary');
    const stepsIdx = lines.findIndex(l => l === '## Steps');
    let context = '';
    if (summaryIdx !== -1 && stepsIdx !== -1) {
      context = lines.slice(summaryIdx + 2, stepsIdx).join('\n').trim();
    }

    const steps: Plan['steps'] = [];
    if (stepsIdx !== -1) {
      for (let i = stepsIdx + 2; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('##')) break;
        if (line.startsWith('- [')) {
          const isCompleted = line.startsWith('- [x]');
          const isInProgress = line.includes('*(in progress)*');
          const description = line
            .replace(/^- \[[ x]\] /, '')
            .replace(' *(in progress)*', '')
            .trim();
          steps.push({
            id: `step-${steps.length + 1}`,
            description,
            status: isCompleted ? 'completed' : isInProgress ? 'in_progress' : 'pending',
          });
        }
      }
    }

    return {
      id: planId,
      title,
      state,
      context,
      steps,
      refinementRound: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * 把 plan 保存为 Markdown 文件。
 * @returns 保存后的文件路径
 */
export function savePlanToFile(
  workspaceRootPath: string,
  sessionId: string,
  plan: Plan,
  fileName?: string
): string {
  const plansDir = ensurePlansDir(workspaceRootPath, sessionId);
  const name = fileName || generatePlanFileName(plan, plansDir);
  const filePath = join(plansDir, `${name}.md`);
  const content = formatPlanAsMarkdown(plan);

  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 按文件名加载会话的 plan。
 */
export function loadPlanFromFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): Plan | null {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * 按完整路径加载 plan。
 */
export function loadPlanFromPath(filePath: string): Plan | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const fileName = basename(filePath).replace('.md', '') || 'unknown';
    return parsePlanFromMarkdown(content, fileName);
  } catch {
    return null;
  }
}

/**
 * 列出会话的所有 plan 文件。
 */
export function listPlanFiles(
  workspaceRootPath: string,
  sessionId: string
): Array<{ name: string; path: string; modifiedAt: number }> {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = join(plansDir, f);
        const stats = existsSync(filePath) ? statSync(filePath) : null;
        return {
          name: f.replace('.md', ''),
          path: filePath,
          modifiedAt: stats?.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return files;
  } catch {
    return [];
  }
}

/**
 * 删除会话的 plan 文件。
 */
export function deletePlanFile(
  workspaceRootPath: string,
  sessionId: string,
  fileName: string
): boolean {
  const plansDir = getSessionPlansPath(workspaceRootPath, sessionId);
  const filePath = join(plansDir, `${fileName}.md`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * 获取会话最近修改的 plan 文件。
 */
export function getMostRecentPlanFile(
  workspaceRootPath: string,
  sessionId: string
): { name: string; path: string } | null {
  const files = listPlanFiles(workspaceRootPath, sessionId);
  return files.length > 0 ? files[0]! : null;
}

// ============================================================
// 附件目录
// ============================================================

/**
 * 确保会话的 attachments 目录存在。
 */
export function ensureAttachmentsDir(workspaceRootPath: string, sessionId: string): string {
  const dir = getSessionAttachmentsPath(workspaceRootPath, sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

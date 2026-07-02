/**
 * Sessions 模块（会话模块）
 *
 * 导出 workspace 范围内会话管理的公共 API，
 * 可以理解为 Go 包里对外暴露的公开接口层。
 *
 * 会话以 JSONL 格式落盘：
 * - 第 1 行：SessionHeader（元数据，用于快速列表加载）
 * - 第 2 行起：StoredMessage（每条消息一行）
 */

// 类型导出
export type {
  SessionStatus,
  SessionTokenUsage,
  StoredMessage,
  SessionConfig,
  StoredSession,
  SessionMetadata,
  SessionHeader,
  SessionPersistentField,
} from './types.ts';

// 持久化字段常量
export { SESSION_PERSISTENT_FIELDS } from './types.ts';

// 存储相关函数
export {
  // 目录工具
  ensureSessionsDir,
  ensureSessionDir,
  getSessionPath,
  getSessionFilePath,
  getSessionAttachmentsPath,
  getSessionPlansPath,
  ensureAttachmentsDir,
  // ID 生成
  generateSessionId,
  // 会话 CRUD
  createSession,
  getOrCreateSessionById,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  clearSessionMessages,
  getOrCreateLatestSession,
  // 元数据更新
  updateSessionSdkId,
  updateSessionMetadata,
  canUpdateSdkCwd,
  flagSession,
  unflagSession,
  setSessionStatus,
  setSessionLabels,
  setSessionProjectId,
  unbindProjectFromSessions,
  // Pending plan execution（Accept & Compact 流程）
  setPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  clearPendingPlanExecution,
  getPendingPlanExecution,
  // 会话筛选
  listFlaggedSessions,
  listCompletedSessions,
  listInboxSessions,
  // 归档管理
  archiveSession,
  unarchiveSession,
  listArchivedSessions,
  listActiveSessions,
  deleteOldArchivedSessions,
  // Plan 存储
  formatPlanAsMarkdown,
  parsePlanFromMarkdown,
  savePlanToFile,
  loadPlanFromFile,
  loadPlanFromPath,
  listPlanFiles,
  deletePlanFile,
  getMostRecentPlanFile,
  // 异步持久化队列
  sessionPersistenceQueue,
  // 头部元数据签名（用于抑制自身触发的事件）
  getHeaderMetadataSignature,
} from './storage.ts';

// JSONL 辅助函数（需要直接读写 session 文件时使用）
export {
  readSessionHeader,
  readSessionJsonl,
  writeSessionJsonl,
  createSessionHeader,
} from './jsonl.ts';

// 字段工具
export { pickSessionFields } from './utils.ts';

// 会话 ID 生成/解析工具
export {
  generateDatePrefix,
  generateHumanSlug,
  generateUniqueSessionId,
  parseSessionId,
  isHumanReadableId,
} from './slug-generator.ts';

// 单词表（需要自定义生成规则时可直接使用）
export { ADJECTIVES, NOUNS } from './word-lists.ts';

// 会话 ID 校验（安全相关）
export {
  validateSessionId,
  sanitizeSessionId,
} from './validation.ts';

// 会话打包（导出/导入/分发）
export type {
  SessionBundle,
  BundleFile,
  BundleBranchInfo,
  DispatchMode,
} from './bundle.ts';
export {
  serializeSession,
  validateBundle,
  MAX_BUNDLE_SIZE_BYTES,
} from './bundle.ts';

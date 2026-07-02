/**
 * Session 级工具的回调注册表（session-scoped tool callback registry）
 *
 * 这个模块从 session-scoped-tools.ts 里拆出来，目的是切断两件事的耦合：
 *   1. 回调注册表（Claude 和 Pi 两条后端路径都要用）
 *   2. Claude SDK 的适配层（只有 ClaudeAgent 用）
 * 拆开之后，Pi 后端无需为了用回调表而引入 Claude SDK 的依赖。
 *
 * 类比 Go：相当于一个 `map[sessionID]Callbacks` 的全局表，每个 session 启动时
 * 注册自己的回调，之后还可以 merge（合并）后续才到位的回调（例如浏览器窗口函数）。
 */

import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-tools.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import { debug } from '../utils/debug.ts';

/**
 * 每个 session 可以注册的回调集合。
 *
 * 这些回调都是"由前端 / Electron 主进程注入、供 agent 工具在执行时反向调用"
 * 的能力，类似 Go 里把一组 interface 注入到 handler。
 */
export interface SessionScopedToolCallbacks {
  /**
   * 当用户通过 SubmitPlan 工具提交计划时被调用。
   * 参数是计划 markdown 文件的路径。
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * 当 OAuth / 凭证类工具发起认证请求时调用。
   * 调用方应展示认证 UI，并暂停 agent 执行直到认证完成。
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * call_llm 工具走的 agent 原生 LLM 查询回调（OAuth 路径）。
   * 各后端把它指向自己的 queryLlm 实现。
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;

  /**
   * spawn_session 工具的回调 —— 创建独立 session 并发送初始 prompt。
   * 各后端把它委托给自己的 onSpawnSession 回调。
   */
  spawnSessionFn?: SpawnSessionFn;

  /**
   * browser_* 系列工具使用的浏览器面板函数。
   * 由 Electron 的 session manager 注入，包装 BrowserPaneManager 到当前 session 绑定的浏览器实例。
   */
  browserPaneFns?: BrowserPaneFns;

  /** 设置某个 session 的 labels（不传则默认当前 session） */
  setSessionLabelsFn?: (sessionId: string | undefined, labels: string[]) => void | Promise<void>;
  /** 设置某个 session 的 status（不传则默认当前 session） */
  setSessionStatusFn?: (sessionId: string | undefined, status: string) => void | Promise<void>;
  /** 获取某个 session 的详细信息（不传则默认当前 session） */
  getSessionInfoFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').SessionInfo | null;
  /** 分页列出 workspace 内的 session */
  listSessionsFn?: (options?: import('@craft-agent/session-tools-core').ListSessionsOptions) => import('@craft-agent/session-tools-core').ListSessionsResult;
  /** 从主进程注册表列出某个 session 的后台任务（运行中 + 已终止）。 */
  listBackgroundTasksFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').BackgroundTaskInfo[];
  /** 把 label 的显示名解析为 ID */
  resolveLabelsFn?: (labels: string[]) => import('@craft-agent/session-tools-core').ResolvedLabelsResult;
  /** 把 status 的显示名解析为 ID */
  resolveStatusFn?: (status: string) => import('@craft-agent/session-tools-core').ResolvedStatusResult;
  /** 给另一个 session 发消息（session 间通信）。resolve 后返回送达状态。 */
  sendAgentMessageFn?: (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => Promise<import('@craft-agent/session-tools-core').SendAgentMessageResult>;
  /**
   * 在当前运行的 session 里激活某个 source（source_test 的自动启用流程）。
   * 由 SessionManager 连接到 per-session 的 onSourceActivationRequest 回调，
   * 并配合 backend 相关的就绪信号（Pi 和 Claude 不同）。
   */
  activateSourceInSessionFn?: (sourceSlug: string) => Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'immediate' | 'next-turn';
  }>;
  /** 获取某个 session 的消息通道绑定信息 */
  getMessagingBindingsFn?: (sessionId: string) => Array<{ platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean }>;
  /** 解绑 session 上的消息通道，返回被移除的绑定数量 */
  unbindMessagingChannelFn?: (sessionId: string, platform?: string) => number;
}

// 全局回调注册表：键是 sessionId，值是该 session 的回调集合
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * 为某个 session 注册回调（整体覆盖式写入）
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * 把额外回调合并到某 session 已有的回调集合上。
 *
 * 主要场景：Electron session manager 在 agent 已经注册完核心回调之后，
 * 才把 browser pane 函数补进来。这样无需重新创建工具实例就能扩展能力。
 */
export function mergeSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>
): void {
  const existing = sessionScopedToolCallbackRegistry.get(sessionId) ?? {};
  sessionScopedToolCallbackRegistry.set(sessionId, { ...existing, ...callbacks });
  debug('session-scoped-tools', `Merged callbacks for session ${sessionId}`);
}

/**
 * 注销某 session 的回调（session 销毁时调用，避免内存泄漏）
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * 读取某 session 当前的回调集合（可能为 undefined，表示尚未注册）
 */
export function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}

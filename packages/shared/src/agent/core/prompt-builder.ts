/**
 * PromptBuilder - 系统提示词与上下文构建
 *
 * 【中文学习注释 - 文件级】
 * 本模块负责构造 system prompt 以及每轮注入到 LLM 输入里的上下文块（context blocks）。
 * 是 ClaudeAgent 和 PiAgent 共用的提示词构造工具。
 *
 * 类比后端：它像是一个请求拦截器，在每个 user message 发出去之前，把当前时间、权限模式、
 * source 状态、工作区能力等“非 LLM 生成的上下文”塞进消息体。
 *
 * 核心职责：
 * 1. 构建 Context Parts：分成 volatile（每轮可能变化）和 stable（整个会话不变）两类。
 * 2. volatile 包含：时间、session_state（含 permission mode / plans/data 路径）、source state。
 *    这些必须放在 user message 尾部，不能放进缓存的 system prompt，否则会破坏 prompt caching。
 * 3. stable 包含：workspace_capabilities、working_directory_context，可以放到 system prompt 里复用缓存。
 * 4. 提供 recovery context（会话恢复失败时的兜底上下文）、user preferences 的格式化。
 *
 * Agent 概念速查：
 * - permission mode：safe / ask / allow-all 三种权限模式，决定工具能否自动执行。
 * - source：外部能力来源（MCP server / API / local），会带来连接状态需要注入。
 * - session：一次会话，有自己的 id、工作目录、plans/data 目录。
 * - workspace：工作区，rootPath 下管理 sources/skills/sessions 等。
 * - prompt caching：LLM 服务会缓存 system prompt 前缀以降低成本，volatile 内容塞进去会让缓存失效。
 *
 * TypeScript 注意点：
 * - 使用 private 字段保存 config 和缓存的 pinnedPreferencesPrompt。
 * - 返回 string[] 而不是一个大字符串，方便调用者按自己的顺序拼接。
 */

import { isLocalMcpEnabled } from '../../workspaces/storage.ts';
import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { formatSessionState } from '../mode-manager.ts';
import { getDateTimeContext, getWorkingDirectoryContext } from '../../prompts/system.ts';
import { getSessionPlansPath, getSessionDataPath, getSessionPath } from '../../sessions/storage.ts';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
  RecoveryMessage,
} from './types.ts';

/**
 * 构造提示词与上下文块的工具类。
 *
 * 用法示例：
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // 为某条用户消息构造上下文块
 * const contextParts = promptBuilder.buildContextParts({
 *   permissionMode: 'explore',
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private pinnedPreferencesPrompt: string | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace?.rootPath ?? '';
  }

  // ============================================================
  // 上下文构建
  // ============================================================

  /**
   * 为一条用户消息构造全部上下文块（先 volatile，再 stable）。
   * 返回字符串数组，调用者应把它们拼到用户消息前面。
   *
   * 这是 Claude 路径：组合 {@link buildVolatileContextParts} 与
   * {@link buildStableContextParts}，保证输出与拆分前完全一致（5 个块、顺序相同），
   * 并且一次性的 mode-change 信号每轮只被消费一次（只有 volatile builder 消费它）。
   * 若调用者需要把 volatile 与 stable 放在不同位置（例如 Pi 适配器为了保留 prompt
   * caching —— issue #862），应直接调用那两个半段方法，而不是本方法。
   *
   * @param options - 上下文构造选项
   * @param sourceStateBlock - SourceManager 预格式化的 source 状态块
   * @returns 上下文字符串数组
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    return [
      ...this.buildVolatileContextParts(options, sourceStateBlock),
      ...this.buildStableContextParts(),
    ];
  }

  /**
   * 易变（volatile）上下文块 —— 每轮都可能变化，因此必须挂在 user message 尾部，
   * 而不是缓存的 system prompt 前缀里（issue #862）。把这些内容折进 system prompt
   * 会导致每轮都重新盖章缓存前缀，扼杀后续历史的 prompt-cache 复用。
   *
   * 【中文学习注释】volatile = 易变的。LLM 服务（如 Claude）会对 system prompt 做缓存，
   * 如果每轮都把会变的内容塞进 system prompt，缓存就失效了。所以：
   * - 时间、session_state、source_state 这些每轮可能变的，必须放在 user message 尾部。
   * - 本方法每轮只能调用一次，因为 formatSessionState 会“消费”一次性的 mode-change 信号。
   *
   * 块顺序：
   *  1. date/time（分钟精度）
   *  2. session_state（权限模式 + plans/data 路径；携带 modeChangedAt/modeVersion，
   *     并**消费**一次性的 mode-change 用户信号 —— 详见 {@link formatSessionState}）
   *  3. source state（鉴权/连接状态），仅在提供时加入
   *
   * 每轮必须且只能调用一次，因为它消费一次性 mode 状态。不要为计算缓存调试 hash
   * 第二次调用 —— 应该对已经产出的字符串做 hash。
   *
   * @param options - 上下文构造选项
   * @param sourceStateBlock - SourceManager 预格式化的 source 状态块
   */
  buildVolatileContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // 时间/日期放最前（挂在 user message 尾部以保留 prompt caching）
    parts.push(getDateTimeContext());

    // session_state（权限模式、plans 目录路径、data 目录路径）
    // 只有这个 volatile builder 可以消费一次性的 mode-change 信号
    const sessionId = this.config.session?.id ?? `temp-${Date.now()}`;
    const plansFolderPath = options.plansFolderPath ??
      getSessionPlansPath(this.workspaceRootPath, sessionId);
    const dataFolderPath = options.dataFolderPath ??
      getSessionDataPath(this.workspaceRootPath, sessionId);
    parts.push(formatSessionState(sessionId, {
      plansFolderPath,
      dataFolderPath,
      consumeModeChangeUserSignal: true,
    }));

    // 如果提供了 source 状态块，则加入
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    return parts;
  }

  /**
   * 稳定（stable）上下文块 —— 整个会话期间通常不变，因此可以安全地放在被缓存的
   * system prompt 前缀里（issue #862）。
   *
   * 【中文学习注释】stable = 稳定的。工作区能力、当前工作目录在整个会话期间通常不变，
   * 可以放进 system prompt 被 LLM 缓存，从而降低 token 消耗。这是性能优化点。
   *
   * 块顺序：
   *  1. workspace capabilities
   *  2. working directory（若有）
   *
   * 纯函数、幂等：不含一次性状态，每轮调用任意次数都安全。
   */
  buildStableContextParts(): string[] {
    const parts: string[] = [];

    // 工作区能力
    parts.push(this.formatWorkspaceCapabilities());

    // 工作目录上下文
    const workingDirContext = this.getWorkingDirectoryContext();
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    return parts;
  }

  /**
   * 格式化 workspace capabilities 用于 prompt 注入。
   * 告知 agent 当前工作区可用哪些特性。
   */
  formatWorkspaceCapabilities(): string {
    const capabilities: string[] = [];

    // 检查本地 MCP server 能力
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    return `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;
  }

  /**
   * 获取工作目录上下文用于 prompt 注入。
   */
  getWorkingDirectoryContext(): string | null {
    const sessionId = this.config.session?.id;
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!sessionId;

    return getWorkingDirectoryContext(
      effectiveWorkingDir,
      isSessionRoot,
      this.config.session?.sdkCwd
    );
  }

  // ============================================================
  // 恢复上下文
  // ============================================================

  /**
   * 当 SDK 恢复失败时，根据历史消息构造恢复上下文。
   * 在恢复过程中检测到空响应时调用。
   *
   * @param messages - 要包含进恢复上下文的历史消息
   * @returns 格式化的恢复上下文字符串；无消息则返回 null
   */
  buildRecoveryContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) {
      return null;
    }

    // 把消息格式化成对话块
    const formattedMessages = messages.map((m) => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // 超长消息截断，避免撑爆上下文
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  // ============================================================
  // 用户偏好
  // ============================================================

  /**
   * 格式化用户偏好用于 prompt 注入。
   * 首次调用后会把结果钉住（pin），保证同一 session 内偏好一致。
   *
   * @param forceRefresh - 是否强制刷新缓存的偏好
   * @returns 格式化后的偏好字符串
   */
  formatPreferences(forceRefresh = false): string {
    // 如果已固定偏好设置则直接返回（保证会话内一致）
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // 加载并格式化偏好设置（函数内部会自行读取文件）
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * 清除已钉住的偏好（session 清空时调用）。
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  // ============================================================
  // 配置访问器
  // ============================================================

  /**
   * 更新 workspace 配置。
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = workspace?.rootPath ?? '';
  }

  /**
   * 更新 session 配置。
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
  }

  /**
   * 获取 workspace 根路径。
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * 检查调试模式是否启用。
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * 获取 system prompt 预设。
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}

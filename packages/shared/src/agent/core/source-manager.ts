/**
 * SourceManager - 集中式 Source 状态管理
 *
 * 【中文学习注释 - 文件级】
 * 本文件负责 Agent 的“外部数据源状态管理”。可以把 Source 理解为微服务架构里的外部依赖服务：
 * 有的正在运行（active），有的配置存在但没启动（inactive），有的用户点了启用但构建失败（intended）。
 *
 * 核心职责：
 * 1. 追踪三类状态：activeSlugs（实际在跑）、intendedSlugs（UI 显示启用）、allSources（所有已知 source）。
 * 2. 把 source 状态格式化成 <sources> XML 块，注入到 system prompt / user message 里，让 LLM 知道当前可用哪些工具。
 * 3. 检测“工具调用失败是因为 source 没激活”，触发自动激活重试。
 * 4. 根据 source 配置判断需要哪种认证工具（OAuth / bearer token / 无需认证）。
 *
 * TypeScript 注意点：
 * - Set<string> + LoadedSource[] 的组合使用很常见：Set 做 O(1) 存在性判断，数组保留完整对象。
 * - 方法中的 ?. 可选链和 ?? 空值合并符是 TS 日常写法，比 Golang 的 if err != nil 更紧凑。
 */

import { join } from 'node:path';
import type { LoadedSource } from '../../sources/types.ts';
import { sourceNeedsAuthentication } from '../../sources/credential-manager.ts';
import type { SourceManagerConfig } from './types.ts';

/** 无需先读 guide.md 的内部 source slug */
const GUIDE_EXEMPT_SLUGS = new Set(['session', 'craft-agents-docs']);

/**
 * 为 agent 后端提供集中式 source 状态追踪。
 *
 * 用法示例：
 * ```typescript
 * const sourceManager = new SourceManager({
 *   onDebug: (msg) => console.log(msg),
 * });
 *
 * // source 变化时更新状态
 * sourceManager.updateActiveState(['github', 'slack'], [], ['github', 'slack', 'failing-source']);
 * sourceManager.setAllSources(loadedSources);
 *
 * // 获取格式化后的状态用于上下文注入
 * const contextBlock = sourceManager.formatSourceState();
 * ```
 */
export class SourceManager {
  private config: SourceManagerConfig;

  // source 状态追踪
  private activeSlugs: Set<string> = new Set();
  private intendedSlugs: Set<string> = new Set();
  private allSources: LoadedSource[] = [];
  private knownSlugs: Set<string> = new Set();

  constructor(config: SourceManagerConfig = {}) {
    this.config = config;
  }

  // ============================================================
  // 状态管理
  // ============================================================

  /**
   * 根据实际运行的 server 更新 source 激活状态。
   *
   * 【中文学习注释】更新 source 状态的三元组：
   * - activeSlugs = MCP + API 实际启动成功的 server 名称集合。
   * - intendedSlugs = UI 层显示为“启用”的 source，可能因构建失败而未真正 active。
   * - 两者差异可用于向用户/LLM 报告“哪些 source 构建失败”。
   *
   * 与 Golang 类比：像 service 层更新一个聚合状态对象，Set 替代 map[string]bool。
   *
   * @param mcpServerNames - 实际激活的 MCP server 名
   * @param apiServerNames - 实际激活的 API server 名
   * @param intendedSlugs - UI 显示为“启用”的 source slug（构建失败时可能与 active 不一致）
   */
  updateActiveState(
    mcpServerNames: string[],
    apiServerNames: string[],
    intendedSlugs?: string[]
  ): void {
    // 更新实际激活的 server
    this.activeSlugs = new Set([...mcpServerNames, ...apiServerNames]);

    // 更新“意图上启用”的 source（UI 显示，即使构建失败）
    this.intendedSlugs = new Set(intendedSlugs ?? [...this.activeSlugs]);

    this.config.onDebug?.(`Active sources: ${[...this.activeSlugs].join(', ') || 'none'}`);

    // 记录构建失败的 source
    if (intendedSlugs) {
      const failed = intendedSlugs.filter((s) => !this.activeSlugs.has(s));
      if (failed.length > 0) {
        this.config.onDebug?.(`Sources with failed builds: ${failed.join(', ')}`);
      }
    }
  }

  /**
   * 设置所有可用 source（激活与未激活）。
   */
  setAllSources(sources: LoadedSource[]): void {
    this.allSources = sources;
  }

  /**
   * 获取所有 source。
   */
  getAllSources(): LoadedSource[] {
    return this.allSources;
  }

  /**
   * 检查某 source slug 当前是否激活。
   */
  isSourceActive(slug: string): boolean {
    return this.activeSlugs.has(slug);
  }

  /**
   * 检查某 source slug 是否“意图上激活”（UI 显示为启用）。
   */
  isSourceIntendedActive(slug: string): boolean {
    return this.intendedSlugs.has(slug);
  }

  /**
   * 获取实际激活的 source slug（只有工具可用的）。
   */
  getActiveSlugs(): Set<string> {
    return new Set(this.activeSlugs);
  }

  /**
   * 获取意图上激活的 source slug（UI 显示）。
   */
  getIntendedSlugs(): Set<string> {
    return new Set(this.intendedSlugs);
  }

  /**
   * 标记某 source 已见过（本 session 不再显示介绍文本）。
   */
  markSourceSeen(slug: string): void {
    this.knownSlugs.add(slug);
  }

  /**
   * 标记某 source 未见过（会再次显示介绍文本）。
   */
  markSourceUnseen(slug: string): void {
    this.knownSlugs.delete(slug);
  }

  /**
   * 重置所有“已见过”标记（如 session 清空时）。
   */
  resetSeenSources(): void {
    this.knownSlugs.clear();
  }

  // ============================================================
  // Source 状态格式化
  // ============================================================

  /**
   * 把 source 状态格式化为 XML 块，注入到 user message 中。
   * 展示激活 source、未激活 source，并对新 source 做介绍。
   *
   * 【中文学习注释】这是 SourceManager 最重要的输出方法，把 source 状态转成 XML 字符串，
   * 后续由 PromptBuilder 拼到 user message 里。输出包含：
   * - Active: 当前启用的 source（带 “no tools” 标记表示构建失败）。
   * - Inactive: 未启用的 source 及原因（disabled / needs auth / inactive）。
   * - Guide 提醒：任何带 guide.md 的 source，LLM 必须先 Read guide 才能调用其工具。
   * - New: 本会话第一次出现的 source，附带 tagline 和 guide 路径。
   * - <source_issue>: 对 needs_auth / failed 状态的 source 给出修复提示。
   *
   * @returns 用于上下文注入的格式化 XML 字符串
   */
  formatSourceState(): string {
    // 使用“意图上启用”的 slug，而不只是构建成功的
    const activeSlugs = [...this.intendedSlugs].sort();

    // 未激活 source：在 allSources 中但不在 intended-active 里
    const inactiveSources = this.allSources.filter(
      (s) => !this.intendedSlugs.has(s.config.slug)
    );

    // 本 session 尚未见过的 source
    const unseenSources = this.allSources.filter(
      (s) => !this.knownSlugs.has(s.config.slug)
    );

    // 需要关注的激活 source（needs_auth 或 failed）
    const activeSources = this.allSources.filter(
      (s) => this.intendedSlugs.has(s.config.slug)
    );
    const sourcesNeedingAttention = activeSources.filter(
      (s) => s.config.connectionStatus === 'needs_auth' || s.config.connectionStatus === 'failed'
    );

    // 是否是第一条消息（还没有 source 被见过）
    const isFirstMessage = this.knownSlugs.size === 0;

    // 把当前所有 source 标记为已见过，供下轮使用
    this.allSources.forEach((s) => this.knownSlugs.add(s.config.slug));

    // 拼装输出片段
    const parts: string[] = [];

    // 激活 source 行——对构建失败的加 “no tools” 标记
    if (activeSlugs.length > 0) {
      const activeWithStatus = activeSlugs.map((slug) => {
        const hasWorkingTools = this.activeSlugs.has(slug);
        return hasWorkingTools ? slug : `${slug} (no tools)`;
      });
      parts.push(`Active: ${activeWithStatus.join(', ')}`);
    } else {
      parts.push('Active: none');
    }

    // 未激活 source 及原因
    if (inactiveSources.length > 0) {
      const inactiveList = inactiveSources.map((s) => {
        const reason = !s.config.enabled
          ? 'disabled'
          : sourceNeedsAuthentication(s)
            ? 'needs auth'
            : 'inactive';
        return `${s.config.slug} (${reason})`;
      });
      parts.push(`Inactive: ${inactiveList.join(', ')}`);
    }

    // 持久提醒：只要某个激活 source 有 guide，每轮都提醒 LLM 先读 guide
    const activeSourcesWithGuides = activeSources.filter(
      (s) => s.guide?.raw && !GUIDE_EXEMPT_SLUGS.has(s.config.slug)
    );
    if (activeSourcesWithGuides.length > 0) {
      parts.push('Read each source\'s guide.md before first tool use — calls are blocked until guide is read.');
    }

    // source 介绍（只在首次出现时展示）
    if (unseenSources.length > 0) {
      parts.push('');
      // 只有会话中途新增 source 才显示 "New:" 头，第一条消息不显示
      if (!isFirstMessage) {
        parts.push('New:');
      }
      let hasGuides = false;
      for (const s of unseenSources) {
        const tagline = s.config.tagline || s.config.provider;
        parts.push(`- ${s.config.slug}: ${tagline}`);
        // 为有 guide 的 source 附加 guide 路径（内部 source 除外）
        if (s.guide?.raw && !GUIDE_EXEMPT_SLUGS.has(s.config.slug)) {
          parts.push(`  Guide: ${join(s.folderPath, 'guide.md')}`);
          hasGuides = true;
        }
      }
      if (hasGuides) {
        parts.push('');
        parts.push('IMPORTANT: You MUST read a source\'s guide with the Read tool BEFORE using any of its tools. Tool calls WILL BE REJECTED if the guide has not been read first.');
      }
    }

    let output = `<sources>\n${parts.join('\n')}\n</sources>`;

    // 为需要关注的 source 注入 issue 上下文
    for (const s of sourcesNeedingAttention) {
      const status = s.config.connectionStatus;
      output += `\n\n<source_issue source="${s.config.slug}" status="${status}">`;

      if (s.config.connectionError) {
        output += `\nError: ${s.config.connectionError}`;
      }

      // 根据状态给出修复建议
      const authTool = this.getAuthToolName(s);
      if (authTool) {
        output += `\n\nThis source requires re-authentication. The user may have revoked access or the token expired.`;
        output += `\nTo fix: Re-authenticate using ${authTool}.`;
      } else if (s.config.mcp?.transport === 'stdio') {
        output += `\n\nThis is a local MCP server that is not responding. The server process may need to be restarted.`;
        output += `\nTo fix: Check if the server command/path is correct and the process can start.`;
      } else {
        output += `\n\nThis source's server is unreachable. It may be down or the URL may have changed.`;
        output += `\nTo fix: Check the server URL and network connectivity. Use WebSearch to verify the endpoint is correct.`;
      }
      output += `\n</source_issue>`;
    }

    return output;
  }

  // ============================================================
  // 未激活 Source 检测
  // ============================================================

  /**
   * 检测工具错误是否表示某个未激活 source 可被自动激活。
   *
   * 【中文学习注释】自动激活检测：当 LLM 调用形如 mcp__github__get_issue 的工具失败时，
   * 如果错误信息匹配“No such tool available”或“Tool 'xxx' not found”，且该 source 存在但未激活，
   * 则返回 { sourceSlug, toolName }，让上层 SessionManager 去启动 source 并重试。
   *
   * 与 Golang 类比：类似错误码识别 + 重试策略中的“可恢复错误”判断。
   *
   * @param toolName - 被调用的工具名
   * @param errorMessage - 工具调用返回的错误信息
   * @returns 若是未激活 source 错误则返回 source 信息；否则返回 null
   */
  detectInactiveSourceToolError(
    toolName: string,
    errorMessage: string
  ): { sourceSlug: string; toolName: string } | null {
    // 从错误信息中抽取工具名
    let extractedToolName: string | null = toolName;

    // 模式 1："No such tool available: {toolName}"
    const noSuchToolMatch = errorMessage.match(/No (?:such )?tool available:\s*([^\s<]+)/i);
    if (noSuchToolMatch?.[1]) {
      extractedToolName = noSuchToolMatch[1];
    }

    // 模式 2："Tool '{toolName}' not found"
    if (!extractedToolName) {
      const toolNotFoundMatch = errorMessage.match(/Tool\s+['"`]([^'"`]+)['"`]\s+not found/i);
      if (toolNotFoundMatch?.[1]) {
        extractedToolName = toolNotFoundMatch[1];
      }
    }

    if (!extractedToolName) return null;

    // 只处理 MCP 工具名（mcp__{slug}__{toolname}）
    if (!extractedToolName.startsWith('mcp__')) return null;

    const parts = extractedToolName.split('__');
    if (parts.length < 3) return null;

    const sourceSlug = parts[1]!;

    // 检查 source 是否存在但未激活
    const sourceExists = this.allSources.some((s) => s.config.slug === sourceSlug);
    const isActive = this.activeSlugs.has(sourceSlug);

    if (sourceExists && !isActive) {
      return { sourceSlug, toolName: extractedToolName };
    }

    return null;
  }

  // ============================================================
  // 认证工具
  // ============================================================

  /**
   * 获取某 source 对应的鉴权工具名；无需鉴权则返回 null。
   *
   * @param source - 待检查的 source
   * @returns 鉴权工具名；无需鉴权返回 null
   */
  getAuthToolName(source: LoadedSource): string | null {
    const { type, provider, mcp, api } = source.config;

    // MCP 类型 source
    if (type === 'mcp') {
      if (mcp?.authType === 'oauth') {
        return 'source_oauth_trigger';
      }
      if (mcp?.authType === 'bearer') {
        return 'source_credential_prompt';
      }
      return null;
    }

    // API 类型 source
    if (type === 'api') {
      if (api?.authType === 'none' || api?.authType === undefined) {
        return null;
      }

      // OAuth provider 有各自的触发工具
      switch (provider) {
        case 'google':
          return 'source_google_oauth_trigger';
        case 'slack':
          return 'source_slack_oauth_trigger';
        case 'microsoft':
          return 'source_microsoft_oauth_trigger';
        default:
          // 通用 OAuth API source → OAuth 触发工具
          if (api?.authType === 'oauth') {
            return 'source_oauth_trigger';
          }
          return 'source_credential_prompt';
      }
    }

    return null;
  }

  /**
   * 检查某 source 是否需要鉴权。
   */
  sourceNeedsAuthentication(source: LoadedSource): boolean {
    return sourceNeedsAuthentication(source);
  }
}

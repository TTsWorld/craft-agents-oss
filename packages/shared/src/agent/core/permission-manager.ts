/**
 * PermissionManager - 集中式工具权限评估
 *
 * 【中文学习注释 - 文件级】
 * 本文件是 Agent 核心的“权限门卫”。类比 Golang：它像是 Gin 框架里挂载在路由组上的 middleware，
 * 每个 tool call 进来之前必须先过这道关卡，决定放行、拦截还是让用户确认。
 *
 * 核心职责：
 * 1. 根据权限模式（explore / ask / execute，在 mode-types.ts / mode-manager.ts 中定义）评估 tool call。
 * 2. 对 Bash 命令做只读/危险命令判断。
 * 3. 校验 API 端点是否在白名单内。
 * 4. 维护本会话的“始终允许”白名单（alwaysAllowedCommands / alwaysAllowedDomains）。
 *
 * TypeScript 注意点：
 * - 使用 class + private 字段实现封装，类似 Golang struct + 小写字段，但 TS 的 private 是编译期可见性。
 * - Set<string> 类似于 Golang 的 map[string]struct{}，用于 O(1) 的成员判断。
 * - 通过 shouldAllowToolInMode 等函数委托给现有的 mode-manager，避免两个 Agent 后端行为不一致。
 */

import { homedir } from 'os';
import {
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  getBashRejectionReason,
  formatBashRejectionMessage,
  type ToolCheckResult,
} from '../mode-manager.ts';
import { createLogger } from '../../utils/debug.ts';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';
import type { PermissionManagerConfig, ToolPermissionResult } from './types.ts';

const log = createLogger('permissions');

// 为方便外部使用，再导出这些类型
export type { ToolCheckResult, PermissionMode };

/**
 * ask 模式下始终需要用户许可的危险命令。
 * 无论用户如何配置，这些命令都不会被自动放行。
 */
const DANGEROUS_COMMANDS = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'chmod', 'chown', 'chgrp',
  'mv', 'cp', 'dd', 'mkfs', 'fdisk', 'parted',
  'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff',
  'curl', 'wget', 'ssh', 'scp', 'rsync',
  'git push', 'git reset', 'git rebase', 'git checkout',
]);

/**
 * 为 agent 后端提供集中式权限检查。
 *
 * 用法示例：
 * ```typescript
 * const permManager = new PermissionManager({
 *   workspaceId: workspace.id,
 *   sessionId: session.id,
 *   workingDirectory: session.workingDirectory,
 *   plansFolderPath: getSessionPlansPath(workspace, session.id),
 * });
 *
 * // 检查某工具调用是否被允许
 * const result = permManager.evaluateToolCall('Bash', { command: 'git status' });
 * if (!result.allowed) {
 *   // 按原因拦截
 * }
 * ```
 */
export class PermissionManager {
  private config: PermissionManagerConfig;
  private permissionsContext: PermissionsContext;

  // 本会话“始终允许”的白名单
  private alwaysAllowedCommands: Set<string> = new Set();
  private alwaysAllowedDomains: Set<string> = new Set();

  constructor(config: PermissionManagerConfig) {
    this.config = config;
    // 构造加载自定义权限配置所需的上下文
    // PermissionsContext 需要 workspaceRootPath（workspace 绝对路径）
    this.permissionsContext = {
      workspaceRootPath: config.workingDirectory ?? '',
    };
  }

  // ============================================================
  // 权限模式管理
  // ============================================================

  /**
   * 获取当前 session 的权限模式。
   *
   * 【中文学习注释】权限模式按 session 维度存储在 mode-manager 内部（可理解为基于 sessionId 的全局状态）。
   * 三种模式：safe（只读探索）、ask（写/危险操作需用户确认）、allow-all（完全放行）。
   * 注意这不是从本 class 实例里读，而是读 mode-manager 维护的共享状态，避免 ClaudeAgent / PiAgent 双端不同步。
   */
  getPermissionMode(): PermissionMode {
    return getPermissionMode(this.config.sessionId);
  }

  /**
   * 设置本 session 的权限模式。
   */
  setPermissionMode(mode: PermissionMode): void {
    setPermissionMode(this.config.sessionId, mode);
  }

  /**
   * 切换到下一个权限模式（safe → ask → allow-all → safe）。
   * @returns 切换后的新模式
   */
  cyclePermissionMode(enabledModes?: PermissionMode[]): PermissionMode {
    return cyclePermissionMode(this.config.sessionId, enabledModes);
  }

  // ============================================================
  // 工具权限评估
  // ============================================================

  /**
   * 评估在当前权限模式下某工具调用是否被允许。
   *
   * 【中文学习注释】这是 PermissionManager 的主入口。决策链路：
   *   1. 取当前 session 的 permission mode。
   *   2. 调用 mode-manager 的 shouldAllowToolInMode(toolName, toolInput, mode, context)。
   *   3. 根据返回结果决定：allowed / requiresPermission（允许但需弹窗确认）/ blocked（返回原因）。
   *
   * 与 Golang 类比：很像一个 HTTP handler 里先调用 authz 服务，再根据 error 决定返回 200/403。
   * TS 类型注意：函数参数使用 Record<string, unknown> 表示“任意 key-value 的字典”，
   * 类似 Golang 的 map[string]any，但 any 在 TS 中更严格地写作 unknown，调用方需要断言类型。
   *
   * 判定时会综合考虑：
   * - 当前权限模式（safe / ask / allow-all）
   * - 工具类型（Bash、Write、MCP、API 等）
   * - 工具入参
   * - permissions.json 中的自定义权限规则
   *
   * @param toolName - 被调用的工具名
   * @param toolInput - 工具入参
   * @returns ToolPermissionResult：是否允许；若被拒绝则带原因
   */
  evaluateToolCall(
    toolName: string,
    toolInput: Record<string, unknown>
  ): ToolPermissionResult {
    const mode = this.getPermissionMode();

    // 实际判定逻辑委托给 mode-manager 的 shouldAllowToolInMode
    const result = shouldAllowToolInMode(toolName, toolInput, mode, {
      plansFolderPath: this.config.plansFolderPath,
      dataFolderPath: this.config.dataFolderPath,
      permissionsContext: this.permissionsContext,
    });

    if (result.allowed) {
      if ('requiresPermission' in result && result.requiresPermission) {
        log.info('Tool requires permission', {
          sessionId: this.config.sessionId,
          mode,
          toolName,
          description: result.description,
          toolInput,
        });
        return {
          allowed: true,
          requiresPermission: true,
          description: result.description,
        };
      }
      log.debug('Tool allowed', {
        sessionId: this.config.sessionId,
        mode,
        toolName,
      });
      return { allowed: true };
    }

    log.warn('Tool blocked', {
      sessionId: this.config.sessionId,
      mode,
      toolName,
      reason: result.reason,
      toolInput,
    });

    return {
      allowed: false,
      reason: result.reason,
    };
  }

  /**
   * 检查当前模式下某 bash 命令是否被允许；若被拦截则返回详细原因。
   *
   * 【中文学习注释】Bash 命令的权限判断：
   * - allow-all：直接放行，返回 null。
   * - ask：允许执行，但后续由 shouldPromptInAskMode（pre-tool-use.ts）决定是否弹窗确认。
   * - safe：调用 permissionsConfigCache.getMergedConfig 合并用户自定义规则 + 内置规则，
   *         用 getBashRejectionReason 判断是否为只读命令；若不是则返回拒绝原因。
   *
   * 与 Golang 类比：类似在 service 层先查配置缓存，再调用规则引擎做决策。
   *
   * @param command - 待检查的 bash 命令
   * @returns 允许则返回 null；被拦截则返回拒绝原因字符串
   */
  checkBashCommand(command: string): string | null {
    const mode = this.getPermissionMode();

    // allow-all 模式下所有命令直接放行
    if (mode === 'allow-all') {
      return null;
    }

    // ask 模式下命令允许执行，但最终是否弹窗由 shouldPromptInAskMode 决定
    if (mode === 'ask') {
      return null;
    }

    // safe 模式下按只读规则检查
    const config = permissionsConfigCache.getMergedConfig(this.permissionsContext);
    const rejection = getBashRejectionReason(command, config);

    if (!rejection) {
      return null;
    }

    return formatBashRejectionMessage(rejection, config);
  }

  /**
   * 检查 ask 模式下某 bash 命令是否需要用户许可。
   * 危险命令始终需要许可。
   *
   * 【中文学习注释】ask 模式下，是否“需要用户许可”的判断：
   * - allow-all 不需要；safe 模式不是问，而是直接 block（由 checkBashCommand 负责）。
   * - ask 模式下，提取命令的基命令（如 sudo rm xxx -> rm），若命中 DANGEROUS_COMMANDS 集合，则需要弹窗。
   *
   * @param command - 待检查的 bash 命令
   * @returns 是否需要请求用户许可
   */
  requiresBashPermission(command: string): boolean {
    const mode = this.getPermissionMode();

    // allow-all 模式永远不需要额外许可
    if (mode === 'allow-all') {
      return false;
    }

    // safe 模式下直接拦截，不会走到询问流程
    if (mode === 'safe') {
      return false;
    }

    // ask 模式下判断命令是否属于危险命令
    const baseCommand = this.getBaseCommand(command);
    return this.isDangerousCommand(baseCommand);
  }

  // ============================================================
  // API 端点检查
  // ============================================================

  /**
   * 检查某 API 端点是否被允许。
   * GET 请求始终允许；其它方法按白名单校验。
   *
   * @param method - HTTP 方法（GET、POST 等）
   * @param path - API 端点路径
   * @returns 是否允许该端点
   */
  isApiEndpointAllowed(method: string, path?: string): boolean {
    return isApiEndpointAllowed(method, path, this.permissionsContext);
  }

  // ============================================================
  // 命令分析工具
  // ============================================================

  /**
   * 从 bash 命令字符串中提取基命令（第一个词）。
   * 能处理 sudo 前缀、管道、重定向等常见 shell 结构。
   *
   * @param command - 完整 bash 命令
   * @returns 基命令名
   */
  getBaseCommand(command: string): string {
    const trimmed = command.trim();
    // 提取第一个词，处理常见前缀
    const match = trimmed.match(/^(?:sudo\s+)?(\S+)/);
    return match?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
  }

  /**
   * 检查某命令是否在危险命令列表中。
   *
   * @param baseCommand - 基命令名（来自 getBaseCommand）
   * @returns 是否为危险命令
   */
  isDangerousCommand(baseCommand: string): boolean {
    return DANGEROUS_COMMANDS.has(baseCommand.toLowerCase());
  }

  /**
   * 从网络命令（curl、wget、ssh 等）中提取域名，用于域名白名单检查。
   *
   * @param command - 完整 bash 命令
   * @returns 提取到的域名；找不到返回 null
   */
  extractDomainFromNetworkCommand(command: string): string | null {
    // 匹配常见的 URL 与主机名模式
    const urlMatch = command.match(/https?:\/\/([^\/\s:]+)/);
    if (urlMatch?.[1]) {
      return urlMatch[1];
    }

    // 匹配 ssh 风格的 user@host 模式
    const sshMatch = command.match(/@([^\s:]+)/);
    if (sshMatch?.[1]) {
      return sshMatch[1];
    }

    return null;
  }

  // ============================================================
  // 上下文管理
  // ============================================================

  /**
   * 更新工作目录（用于权限上下文）。
   */
  updateWorkingDirectory(path: string): void {
    this.config.workingDirectory = path;
    this.permissionsContext.workspaceRootPath = path;
  }

  /**
   * 更新 plans 目录路径。
   */
  updatePlansFolderPath(path: string): void {
    this.config.plansFolderPath = path;
  }

  /**
   * 获取当前 session ID。
   */
  getSessionId(): string {
    return this.config.sessionId;
  }

  /**
   * 获取 permissions context 供外部使用。
   */
  getPermissionsContext(): PermissionsContext {
    return this.permissionsContext;
  }

  // ============================================================
  // 会话级白名单
  // ============================================================

  /**
   * 判断某基命令是否已加入本会话白名单。
   *
   * 【中文学习注释】会话级白名单：用户点了“始终允许”后，把命令或域名加到内存 Set 里，
   * 本次会话内再次遇到就自动放行。生命周期随 session 结束而结束，类似 Golang 里 map[string]struct{} 做的本地缓存。
   */
  isCommandWhitelisted(baseCommand: string): boolean {
    return this.alwaysAllowedCommands.has(baseCommand.toLowerCase());
  }

  /**
   * 把某命令加入本会话白名单。
   * 用户点击“始终允许”时调用。
   */
  whitelistCommand(baseCommand: string): void {
    this.alwaysAllowedCommands.add(baseCommand.toLowerCase());
  }

  /**
   * 检查某域名是否已加入网络命令白名单。
   */
  isDomainWhitelisted(domain: string): boolean {
    return this.alwaysAllowedDomains.has(domain.toLowerCase());
  }

  /**
   * 把某域名加入网络命令白名单。
   * 用户对 curl/wget 点击“始终允许”时调用。
   */
  whitelistDomain(domain: string): void {
    this.alwaysAllowedDomains.add(domain.toLowerCase());
  }

  /**
   * 清空本会话所有白名单。
   * 在 session 清空或 dispose 时调用。
   */
  clearWhitelists(): void {
    this.alwaysAllowedCommands.clear();
    this.alwaysAllowedDomains.clear();
  }

  /**
   * 获取已加白的命令集合（调试用）。
   */
  getWhitelistedCommands(): Set<string> {
    return new Set(this.alwaysAllowedCommands);
  }

  /**
   * 获取已加白的域名集合（调试用）。
   */
  getWhitelistedDomains(): Set<string> {
    return new Set(this.alwaysAllowedDomains);
  }
}

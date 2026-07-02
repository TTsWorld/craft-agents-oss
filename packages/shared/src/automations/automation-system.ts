/**
 * AutomationSystem - 自动化系统统一外观类
 *
 * 单一入口，负责：
 * - 为每个 workspace 创建 EventBus 实例
 * - 创建并注册所有 handler
 * - 加载 automations.json 配置
 * - 管理调度器服务
 * - 对会话元数据变化做 diff 并触发事件
 * - 提供 dispose() 清理资源
 *
 * 优点：
 * - 无全局状态，每个 AutomationSystem 实例自包含
 * - 测试时容易构造
 * - SessionManager 只需约 30 行而非约 300 行
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';
import { compactAutomationHistorySync } from './history-store.ts';
import { createLogger } from '../utils/debug.ts';
import { WorkspaceEventBus, type EventPayloadMap } from './event-bus.ts';
import { PromptHandler, EventLogHandler, WebhookHandler, type AutomationsConfigProvider } from './handlers/index.ts';
import { type AutomationsConfig, type AutomationEvent, type AutomationMatcher, type PendingPrompt, type WebhookActionResult, type AppEvent, type AgentEvent, type SdkAutomationCallbackMatcher, type SdkAutomationInput } from './types.ts';
import { validateAutomationsConfig } from './validation.ts';
import { matcherMatchesSdk } from './utils.ts';
import { SchedulerService, type SchedulerTickPayload } from '../scheduler/scheduler-service.ts';

const log = createLogger('automation-system');

// 从 types.ts 重新导出 SessionMetadataSnapshot（单一来源）
export type { SessionMetadataSnapshot } from './types.ts';
import type { SessionMetadataSnapshot } from './types.ts';

// ============================================================================
// AutomationSystem 选项
// ============================================================================

export interface AutomationSystemOptions {
  /** Workspace 根目录（automations.json 所在目录） */
  workspaceRootPath: string;
  /** Workspace ID，用于日志和事件 */
  workspaceId: string;
  /** 命令执行的工作目录 */
  workingDir?: string;
  /** 权限规则中生效的 source slug 列表 */
  activeSourceSlugs?: string[];
  /** 是否启动调度器服务（默认 false） */
  enableScheduler?: boolean;
  /** prompt 准备好后通过此回调执行 */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /** webhook 结果可用时的回调 */
  onWebhookResults?: (results: WebhookActionResult[]) => void;
  /** 自动化执行出错时的回调 */
  onError?: (event: AutomationEvent, error: Error) => void;
  /** 事件在重试后丢失时的回调 */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// AutomationSystem 实现
// ============================================================================

export class AutomationSystem implements AutomationsConfigProvider {
  readonly eventBus: WorkspaceEventBus;

  private readonly options: AutomationSystemOptions;
  private config: AutomationsConfig | null = null;
  private promptHandler: PromptHandler | null = null;
  private webhookHandler: WebhookHandler | null = null;
  private eventLogHandler: EventLogHandler | null = null;
  private scheduler: SchedulerService | null = null;
  private disposed = false;

  // 会话元数据追踪（从 SessionManager 迁移过来）
  private readonly lastKnownMetadata: Map<string, SessionMetadataSnapshot> = new Map();

  constructor(options: AutomationSystemOptions) {
    this.options = options;
    this.eventBus = new WorkspaceEventBus(options.workspaceId);

    // 加载配置
    this.loadConfig();

    // 创建 handler
    this.createHandlers();

    // 如果启用则启动调度器
    if (options.enableScheduler) {
      this.startScheduler();
    }

    log.debug(`[AutomationSystem] Created for workspace: ${options.workspaceId}`);
  }

  // ============================================================================
  // 配置管理
  // ============================================================================

  /**
   * 读取、解析并校验 automations.json。
   * loadConfig/reloadConfig 共用此流程。
   * 返回原始 JSON 和校验结果，避免 backfillIds 时重复读盘。
   */
  private readAndValidateConfig(configPath: string): { raw: unknown; validation: import('./types.ts').AutomationsValidationResult } {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const validation = validateAutomationsConfig(raw);
    return { raw, validation };
  }

  /**
   * 从 automations.json 加载自动化配置。
   */
  private loadConfig(): void {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      log.debug(`[AutomationSystem] No automations config found at ${configPath}`);
      this.config = { automations: {} };
      return;
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        console.warn('[AutomationSystem] Invalid automations config:', validation.errors);
        this.config = { automations: {} };
        return;
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      this.rotateHistory();
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Loaded ${actionCount} actions from ${configPath}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      console.warn('[AutomationSystem] Failed to load automations config:', error);
      this.config = { automations: {} };
    }
  }

  /**
   * 重新加载 automations.json。
   * 在 automations.json 变更后调用。
   */
  reloadConfig(): { success: boolean; automationCount: number; errors: string[] } {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);

    if (!existsSync(configPath)) {
      this.config = { automations: {} };
      return { success: true, automationCount: 0, errors: [] };
    }

    try {
      const { raw, validation } = this.readAndValidateConfig(configPath);

      if (!validation.valid) {
        return { success: false, automationCount: 0, errors: validation.errors };
      }

      this.config = validation.config;
      this.backfillIds(configPath, raw);
      const actionCount = this.getActionCount();
      log.debug(`[AutomationSystem] Reloaded ${actionCount} actions`);
      return { success: true, automationCount: actionCount, errors: [] };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';
      return { success: false, automationCount: 0, errors: [`Failed to parse JSON: ${error}`] };
    }
  }

  /**
   * 为 raw 配置中缺少 ID 的 matcher 补齐 ID。
   * 直接操作已经解析好的 raw JSON，避免再次读盘。
   * 只在确实有缺失 ID 时才写回文件 - 后续加载通常是 no-op。
   */
  private backfillIds(configPath: string, raw: unknown): void {
    try {
      const obj = raw as Record<string, unknown>;
      const eventMap = (obj.automations ?? obj.tasks ?? obj.hooks) as Record<string, unknown[]> | undefined;
      if (!eventMap) return;

      let changed = false;
      for (const matchers of Object.values(eventMap)) {
        if (!Array.isArray(matchers)) continue;
        for (const m of matchers as Record<string, unknown>[]) {
          if (!m.id) { m.id = generateShortId(); changed = true; }
        }
      }

      if (changed) {
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
        log.debug('[AutomationSystem] Backfilled missing matcher IDs');
      }
    } catch {
      // 非关键操作 - 下次 IPC 变更时还会再补齐
    }
  }

  /**
   * 启动时压缩 automations-history.jsonl：双层保留策略。
   * 1) 每个 automation ID 只保留最近 N 条。
   * 2) 如果总数仍超过全局上限，则丢弃最旧的记录。
   * 在初始化时同步运行 - 此时单线程，不会和异步追加竞争。
   */
  private rotateHistory(): void {
    try {
      compactAutomationHistorySync(this.options.workspaceRootPath);
    } catch {
      // 非关键 - 压缩失败不影响功能
    }
  }

  /**
   * 获取 action 总数。
   */
  private getActionCount(): number {
    if (!this.config) return 0;
    return Object.values(this.config.automations).reduce(
      (sum, matchers) => sum + (matchers?.reduce((s, m) => s + m.actions.length, 0) ?? 0),
      0
    );
  }

  // ============================================================================
  // AutomationsConfigProvider 实现
  // ============================================================================

  getConfig(): AutomationsConfig | null {
    return this.config;
  }

  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[] {
    return this.config?.automations[event] ?? [];
  }

  // ============================================================================
  // Handler（处理器）
  // ============================================================================

  /**
   * 创建并注册所有 handler。
   */
  private createHandlers(): void {
    // Prompt 处理器
    this.promptHandler = new PromptHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onPromptsReady: this.options.onPromptsReady,
        onError: this.options.onError,
      },
      this
    );
    this.promptHandler.subscribe(this.eventBus);

    // Webhook 处理器
    this.webhookHandler = new WebhookHandler(
      {
        workspaceId: this.options.workspaceId,
        workspaceRootPath: this.options.workspaceRootPath,
        onWebhookResults: this.options.onWebhookResults,
        onError: this.options.onError,
      },
      this
    );
    this.webhookHandler.subscribe(this.eventBus);

    // Event log 处理器
    this.eventLogHandler = new EventLogHandler({
      workspaceRootPath: this.options.workspaceRootPath,
      workspaceId: this.options.workspaceId,
      onEventLost: this.options.onEventLost,
    });
    this.eventLogHandler.subscribe(this.eventBus);

    log.debug(`[AutomationSystem] Handlers created and subscribed`);
  }

  // ============================================================================
  // 调度器
  // ============================================================================

  /**
   * 启动调度器服务。
   */
  private startScheduler(): void {
    if (this.scheduler) return;

    this.scheduler = new SchedulerService(async (payload: SchedulerTickPayload) => {
      await this.eventBus.emit('SchedulerTick', {
        workspaceId: this.options.workspaceId,
        timestamp: Date.now(),
        localTime: payload.localTime,
        utcTime: payload.timestamp,
      });
    });

    this.scheduler.start();
    log.debug(`[AutomationSystem] Scheduler started`);
  }

  /**
   * 停止调度器服务。
   */
  stopScheduler(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      log.debug(`[AutomationSystem] Scheduler stopped`);
    }
  }

  // ============================================================================
  // 会话元数据 Diff
  // ============================================================================

  /**
   * 更新会话元数据，并为变化触发相应事件。
   *
   * 这替代了原先 SessionManager 中的 diff 逻辑。
   * 在会话元数据变化时调用。
   *
   * @param sessionId - 会话 ID
   * @param next - 新的元数据快照
   * @returns 实际触发的事件列表
   */
  async updateSessionMetadata(
    sessionId: string,
    next: SessionMetadataSnapshot
  ): Promise<AppEvent[]> {
    const prev = this.lastKnownMetadata.get(sessionId) ?? {};
    const emittedEvents: AppEvent[] = [];
    const timestamp = Date.now();

    // 所有事件共用的字段
    const sessionName = next.sessionName;
    const labels = next.labels ?? [];

    // 权限模式变化
    if (prev.permissionMode !== next.permissionMode) {
      await this.eventBus.emit('PermissionModeChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldMode: prev.permissionMode ?? '',
        newMode: next.permissionMode ?? '',
      });
      emittedEvents.push('PermissionModeChange');
    }

    // 标签变化（数组 diff）
    const prevLabels = new Set(prev.labels ?? []);
    const nextLabels = new Set(next.labels ?? []);

    for (const label of nextLabels) {
      if (!prevLabels.has(label)) {
        await this.eventBus.emit('LabelAdd', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelAdd');
      }
    }

    for (const label of prevLabels) {
      if (!nextLabels.has(label)) {
        await this.eventBus.emit('LabelRemove', {
          sessionId,
          sessionName,
          workspaceId: this.options.workspaceId,
          timestamp,
          labels: [...nextLabels],
          label,
        });
        emittedEvents.push('LabelRemove');
      }
    }

    // 标记变化
    const wasFlagged = prev.isFlagged ?? false;
    const isFlagged = next.isFlagged ?? false;
    if (wasFlagged !== isFlagged) {
      await this.eventBus.emit('FlagChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        isFlagged,
      });
      emittedEvents.push('FlagChange');
    }

    // 会话状态变化
    if (prev.sessionStatus !== next.sessionStatus) {
      await this.eventBus.emit('SessionStatusChange', {
        sessionId,
        sessionName,
        workspaceId: this.options.workspaceId,
        timestamp,
        labels,
        oldState: prev.sessionStatus ?? '',
        newState: next.sessionStatus ?? '',
      });
      emittedEvents.push('SessionStatusChange');
    }

    // 更新存储的元数据
    this.lastKnownMetadata.set(sessionId, { ...next });

    if (emittedEvents.length > 0) {
      log.debug(`[AutomationSystem] Emitted ${emittedEvents.length} events for session ${sessionId}: ${emittedEvents.join(', ')}`);
    }

    return emittedEvents;
  }

  /**
   * 移除会话元数据追踪。
   * 在会话被删除时调用。
   */
  removeSessionMetadata(sessionId: string): void {
    this.lastKnownMetadata.delete(sessionId);
    log.debug(`[AutomationSystem] Removed metadata for session ${sessionId}`);
  }

  /**
   * 获取某会话已存储的元数据。
   */
  getSessionMetadata(sessionId: string): SessionMetadataSnapshot | undefined {
    return this.lastKnownMetadata.get(sessionId);
  }

  /**
   * 设置会话初始元数据（不触发事件）。
   * 在加载已有会话时调用。
   */
  setInitialSessionMetadata(sessionId: string, metadata: SessionMetadataSnapshot): void {
    this.lastKnownMetadata.set(sessionId, { ...metadata });
  }

  // ============================================================================
  // 直接事件触发
  // ============================================================================

  /**
   * 触发 LabelConfigChange 事件。
   * 在 labels/config.json 变更时调用。
   */
  async emitLabelConfigChange(): Promise<void> {
    await this.eventBus.emit('LabelConfigChange', {
      workspaceId: this.options.workspaceId,
      timestamp: Date.now(),
    });
  }

  /**
   * 直接触发事件（用于边界情况）。
   */
  async emit<T extends AutomationEvent>(event: T, payload: EventPayloadMap[T]): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  // ============================================================================
  // Agent 事件执行（后端无关）
  // ============================================================================

  /**
   * 直接执行 agent 事件自动化（不经过 Claude SDK）。
   * 这是非 Claude 后端（Codex、Copilot、Pi）从 automations.json 触发 agent 事件的后端无关入口。
   *
   * 对每个匹配 matcher 构建环境变量并评估匹配。
   * 命令执行已移除 - 现在所有自动化动作都通过 prompt 方式（由 PromptHandler 创建会话）执行。
   * 捕获所有错误 - 自动化不能打断 agent 主流程。
   *
   * @param signal - 可选的 AbortSignal，用于取消执行
   * @returns 匹配到的 matcher 数量（用于诊断/测试）
   */
  async executeAgentEvent(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<number> {
    if (!this.config) return 0;

    const matchers = this.config.automations[event];
    if (!matchers?.length) return 0;

    let matchedCount = 0;

    for (const matcher of matchers) {
      if (!matcherMatchesSdk(matcher, event, input)) continue;

      matchedCount++;

      // 注意：命令执行已移除。非 Claude 后端的 prompt 执行尚未实现。
      // 当前方法仅校验匹配（包括 condition 门控）- 实际执行是空操作。
      log.debug(`[AutomationSystem] Matched ${event} automation (prompt-based execution pending)`);
    }

    return matchedCount;
  }

  // ============================================================================
  // SDK 自动化集成
  // ============================================================================

  /**
   * 从 automations.json 定义构建 SDK hook 回调。
   *
   * 命令执行已移除 - 所有自动化动作现在通过 prompt 方式执行（PromptHandler 创建会话）。
   * Agent 事件自动化目前还不支持通过 prompt 触发，因此返回空对象。
   */
  buildSdkHooks(): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>> {
    return {};
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  /**
   * 检查系统是否已 dispose。
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * dispose 自动化系统，清理所有资源。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    log.debug(`[AutomationSystem] Disposing for workspace: ${this.options.workspaceId}`);

    // 停止调度器
    this.stopScheduler();

    // dispose handler
    this.promptHandler?.dispose();
    this.webhookHandler?.dispose();
    await this.eventLogHandler?.dispose();

    // dispose 事件总线
    this.eventBus.dispose();

    // 清理元数据
    this.lastKnownMetadata.clear();

    this.disposed = true;
    log.debug(`[AutomationSystem] Disposed`);
  }
}

/**
 * AutomationHandler 接口与公共类型
 *
 * 定义事件总线系统中所有 automation handler 的契约。
 * 每个 handler：
 * - 在总线上订阅感兴趣的事件（类似 Go 里给 http.ServeMux 注册处理器）
 * - 执行自己的业务逻辑
 * - 自包含，可单独测试
 */

import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationEvent, AutomationsConfig, AutomationMatcher, PendingPrompt } from '../types.ts';

// ============================================================================
// Handler 接口
// ============================================================================

/**
 * 所有 automation handler 的基础接口。
 * handler 订阅事件并独立处理。
 */
export interface AutomationHandler {
  /** 在事件总线上订阅事件 */
  subscribe(bus: EventBus): void;

  /** 清理资源并取消订阅 */
  dispose(): void | Promise<void>;
}

// ============================================================================
// Handler 选项
// ============================================================================

/** 创建 PromptHandler 所需的选项 */
export interface PromptHandlerOptions {
  /** Workspace ID */
  workspaceId: string;
  /** 历史文件存放的 workspace 根目录 */
  workspaceRootPath: string;
  /** 当前会话 ID（如果在会话上下文中执行） */
  sessionId?: string;
  /** 提示词准备好后通过此回调交给调用方执行 */
  onPromptsReady?: (prompts: PendingPrompt[]) => void;
  /** 提示词执行失败时的回调 */
  onError?: (event: AutomationEvent, error: Error) => void;
}

/** 创建 EventLogHandler 所需的选项 */
export interface EventLogHandlerOptions {
  /** 日志文件存放的 workspace 根目录 */
  workspaceRootPath: string;
  /** 日志条目中的 workspace ID */
  workspaceId: string;
  /** 日志写入失败（重试后仍失败）时的回调 */
  onEventLost?: (events: string[], error: Error) => void;
}

// ============================================================================
// Handler 结果类型
// ============================================================================

/** prompt 处理结果 */
export interface PromptProcessingResult {
  event: AutomationEvent;
  prompts: PendingPrompt[];
  durationMs: number;
}

// ============================================================================
// 配置提供接口
// ============================================================================

/**
 * 获取自动化配置的接口。
 * 让 handler 与配置加载逻辑解耦，方便测试时注入假配置。
 */
export interface AutomationsConfigProvider {
  /** 获取当前自动化配置 */
  getConfig(): AutomationsConfig | null;

  /** 获取某个事件下配置的所有 matcher */
  getMatchersForEvent(event: AutomationEvent): AutomationMatcher[];
}

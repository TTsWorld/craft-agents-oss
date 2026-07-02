/**
 * PromptHandler - 处理 App 事件中的 prompt 动作
 *
 * 订阅 App 事件，收集匹配的 prompt action，通过回调交给调用方执行。
 * 本身不直接调用 LLM，只负责“发现 prompt 并准备好环境变量”。
 */

import { createLogger } from '../../utils/debug.ts';
import type { EventBus, BaseEventPayload } from '../event-bus.ts';
import type { AutomationHandler, PromptHandlerOptions, AutomationsConfigProvider } from './types.ts';
import { APP_EVENTS, type AutomationEvent, type PromptAction, type PendingPrompt, type AppEvent } from '../types.ts';
import type { PermissionMode } from '../../agent/mode-types.ts';
import { matcherMatches, buildEnvFromPayload, expandEnvVars, parsePromptReferences } from '../utils.ts';
import { deriveAutomationName } from '../name-utils.ts';

const log = createLogger('prompt-handler');

// ============================================================================
// PromptHandler 实现
// ============================================================================

export class PromptHandler implements AutomationHandler {
  private readonly options: PromptHandlerOptions;
  private readonly configProvider: AutomationsConfigProvider;
  private bus: EventBus | null = null;
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null;

  constructor(options: PromptHandlerOptions, configProvider: AutomationsConfigProvider) {
    this.options = options;
    this.configProvider = configProvider;
  }

  /**
   * 订阅事件总线上的 App 事件。
   */
  subscribe(bus: EventBus): void {
    this.bus = bus;
    this.boundHandler = this.handleEvent.bind(this);
    bus.onAny(this.boundHandler);
    log.debug(`[PromptHandler] Subscribed to event bus`);
  }

  /**
   * 处理单个事件：匹配 prompt 动作并生成 PendingPrompt。
   */
  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    // 只处理 App 事件；Agent 事件不在这里触发 prompt
    if (!APP_EVENTS.includes(event as AppEvent)) {
      return;
    }

    const matchers = this.configProvider.getMatchersForEvent(event);
    if (matchers.length === 0) return;

    // 按 matcher 分组，方便后续按 matcher 写历史
    const matcherPrompts: Array<{
      matcherId: string | undefined;
      automationName: string;
      telegramTopic: string | undefined;
      prompts: Array<{ prompt: PromptAction; labels?: string[]; permissionMode?: PermissionMode }>;
    }> = [];

    for (const matcher of matchers) {
      // payload 先 as 成 Record 用于匹配；这是 TS 类型断言，不修改运行时数据
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue;

      const prompts: Array<{ prompt: PromptAction; labels?: string[]; permissionMode?: PermissionMode }> = [];
      for (const action of matcher.actions) {
        if (action.type === 'prompt') {
          prompts.push({ prompt: action, labels: matcher.labels, permissionMode: matcher.permissionMode });
        }
      }
      if (prompts.length > 0) {
        const telegramTopic = matcher.telegramTopic?.trim();
        matcherPrompts.push({
          matcherId: matcher.id,
          automationName: deriveAutomationName(event, matcher),
          telegramTopic: telegramTopic && telegramTopic.length > 0 ? telegramTopic : undefined,
          prompts,
        });
      }
    }

    if (matcherPrompts.length === 0) return;

    const totalPrompts = matcherPrompts.reduce((s, m) => s + m.prompts.length, 0);
    log.debug(`[PromptHandler] Processing ${totalPrompts} prompts for ${event}`);

    // 构建事件相关的环境变量（包含 CRAFT_*）
    const env = buildEnvFromPayload(event, payload);

    // 逐个 matcher 生成 PendingPrompt
    const pendingPrompts: PendingPrompt[] = [];

    for (const { matcherId, automationName, telegramTopic, prompts } of matcherPrompts) {
      // telegramTopic 支持环境变量展开；展开后为空字符串则丢弃
      const expandedTopic = telegramTopic ? expandEnvVars(telegramTopic, env).trim() : undefined;
      const finalTopic = expandedTopic && expandedTopic.length > 0 ? expandedTopic : undefined;

      for (const { prompt, labels, permissionMode } of prompts) {
        // 展开 prompt 中的 $VAR / ${VAR}
        const expandedPrompt = expandEnvVars(prompt.prompt, env);

        // 解析 @source/@skill 引用
        const references = parsePromptReferences(expandedPrompt);

        // 展开 label 中的环境变量
        const expandedLabels = labels?.map(label => expandEnvVars(label, env));

        pendingPrompts.push({
          sessionId: this.options.sessionId,
          matcherId,
          automationName,
          prompt: expandedPrompt,
          mentions: references.mentions,
          labels: expandedLabels,
          permissionMode,
          llmConnection: prompt.llmConnection,
          model: prompt.model,
          thinkingLevel: prompt.thinkingLevel,
          telegramTopic: finalTopic,
        });
      }
    }

    // 通过回调把准备好的 prompt 交给调用方
    if (pendingPrompts.length > 0 && this.options.onPromptsReady) {
      log.debug(`[PromptHandler] Delivering ${pendingPrompts.length} prompts`);
      this.options.onPromptsReady(pendingPrompts);
    }
  }

  /**
   * 清理资源并取消订阅。
   */
  dispose(): void {
    if (this.bus && this.boundHandler) {
      this.bus.offAny(this.boundHandler);
      this.boundHandler = null;
    }
    this.bus = null;
    log.debug(`[PromptHandler] Disposed`);
  }
}

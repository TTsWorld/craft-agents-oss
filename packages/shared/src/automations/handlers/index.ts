/**
 * Automation Handlers - 统一重新导出
 *
 * 把 prompt、event-log、webhook 三个 handler 以及公共类型集中暴露，
 * 方便外部通过 `handlers/index.ts` 一次性引入。
 */

export type {
  AutomationHandler,
  PromptHandlerOptions,
  EventLogHandlerOptions,
  PromptProcessingResult,
  AutomationsConfigProvider,
} from './types.ts';

export { PromptHandler } from './prompt-handler.ts';
export { EventLogHandler } from './event-log-handler.ts';
export { WebhookHandler, type WebhookHandlerOptions } from './webhook-handler.ts';

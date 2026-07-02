/**
 * Send Developer Feedback Handler（发送开发反馈处理器）
 *
 * 把 Agent 写的任意 Markdown 反馈持久化给开发团队。
 * 通过注入的 submitFeedback 回调实现，避免直接依赖文件路径。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult, DeveloperFeedback } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// send_developer_feedback 参数：反馈内容
export interface SendDeveloperFeedbackArgs {
  message: string;
}

/**
 * 处理 send_developer_feedback tool 调用。
 *
 * 校验消息非空后生成唯一 ID，再调用上下文里的 submitFeedback 回调完成持久化。
 */
export async function handleSendDeveloperFeedback(
  ctx: SessionToolContext,
  args: SendDeveloperFeedbackArgs
): Promise<ToolResult> {
  if (!ctx.submitFeedback) {
    return errorResponse('Developer feedback is not available in this environment.');
  }

  const message = args.message?.trim();
  if (!message) {
    return errorResponse('Feedback message cannot be empty.');
  }

  try {
    const now = Date.now();
    const shortId = Math.random().toString(36).slice(2, 8);

    const feedback: DeveloperFeedback = {
      id: `fb_${now}_${shortId}`,
      timestamp: new Date(now).toISOString(),
      sessionId: ctx.sessionId,
      message,
    };

    ctx.submitFeedback(feedback);
    return successResponse('Feedback sent to the development team. Thanks for sharing!');
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send feedback: ${msg}`);
  }
}

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// send_agent_message 参数：目标会话 ID、消息内容、可选附件
export interface SendAgentMessageArgs {
  sessionId: string;
  message: string;
  attachments?: Array<{ path: string; name?: string }>;
}

/**
 * 处理 send_agent_message tool 调用。
 * 允许一个会话向另一个会话发送消息，实现会话间通信（类似 Go 里跨 goroutine 发消息，但这里是持久化会话）。
 */
export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  // 防止自己给自己发消息，避免递归循环
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // 构造发送者信封，让目标会话知道是谁发来的
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const wrappedMessage = [
      `[Message from session "${ctx.sessionId}" (${senderName})]`,
      `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
      '',
      '---',
      '',
      args.message,
    ].join('\n');

    const result = await ctx.sendAgentMessage(args.sessionId, wrappedMessage, args.attachments);

    // Report the real delivery status instead of an unconditional "sent". A busy
    // target queues the message behind its current turn; an idle target starts
    // now. This is what lets the sender avoid guessing (e.g. never invent "the
    // app restarted") — for actual task status, call list_background_tasks.
    if (result.delivery === 'queued') {
      return successResponse(
        `Message queued for session ${args.sessionId} — it is currently processing another turn. ` +
          `It will handle your message after the current turn finishes. Do not assume it was read yet; ` +
          `wait for a reply or query status before concluding anything.`
      );
    }

    return successResponse(
      `Message delivered to session ${args.sessionId}; it will start processing independently now.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}

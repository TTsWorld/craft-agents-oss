/**
 * Messaging session tools（消息通道绑定管理工具）
 *
 * 提供 list_messaging_channels 和 unbind_messaging_channel。
 * 注意：绑定（bind）不是通过 agent 传入任意 channelId 完成的，
 * 而是靠 pairing code 在聊天侧或 UI 侧完成，避免 agent 把会话绑定到不该访问的频道。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// ---------------------------------------------------------------------------
// list_messaging_channels：列出当前会话已绑定的消息通道
// ---------------------------------------------------------------------------

export interface ListMessagingChannelsArgs {
  sessionId?: string;
}

export async function handleListMessagingChannels(
  ctx: SessionToolContext,
  args: ListMessagingChannelsArgs,
): Promise<ToolResult> {
  if (!ctx.getMessagingBindings) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const sessionId = args.sessionId ?? ctx.sessionId;
    const bindings = ctx.getMessagingBindings(sessionId);

    if (bindings.length === 0) {
      return successResponse(`No messaging channels bound to session ${sessionId}.`);
    }

    const lines = bindings.map((b) => {
      const baseLabel = b.channelName || b.channelId;
      // Telegram 超级群的话题（thread）显示为 "Group › Topic"，方便区分同一群组下的不同话题；
      // 普通私信或未开启话题的绑定保持原样。
      const channelLabel = b.threadId !== undefined
        ? `${baseLabel} › Topic #${b.threadId}`
        : baseLabel;
      return `- ${b.platform}: ${channelLabel} (${b.enabled ? 'active' : 'disabled'})`;
    });

    return successResponse(
      `Messaging bindings for session ${sessionId}:\n${lines.join('\n')}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list messaging channels: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// unbind_messaging_channel：解绑当前会话的消息通道
// ---------------------------------------------------------------------------

export interface UnbindMessagingChannelArgs {
  platform?: 'telegram' | 'whatsapp';
}

export async function handleUnbindMessagingChannel(
  ctx: SessionToolContext,
  args: UnbindMessagingChannelArgs,
): Promise<ToolResult> {
  if (!ctx.unbindMessagingChannel) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const removed = ctx.unbindMessagingChannel(ctx.sessionId, args.platform);
    if (removed > 0) {
      const platformLabel = args.platform ?? 'all platforms';
      return successResponse(`Unbound ${removed} messaging channel(s) for ${platformLabel}.`);
    }
    return successResponse('No messaging channels were bound to this session.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to unbind messaging channel: ${message}`);
  }
}

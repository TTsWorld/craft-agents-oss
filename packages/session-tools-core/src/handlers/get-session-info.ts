import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// 获取会话信息的参数：不传 sessionId 表示查询当前会话
export interface GetSessionInfoArgs {
  sessionId?: string;
}

/**
 * 处理 get_session_info tool 调用。
 * 从上下文中读取指定会话或当前会话的元数据，并以格式化 JSON 返回。
 */
export async function handleGetSessionInfo(
  ctx: SessionToolContext,
  args: GetSessionInfoArgs
): Promise<ToolResult> {
  if (!ctx.getSessionInfo) {
    return errorResponse('get_session_info is not available in this context.');
  }

  try {
    const info = ctx.getSessionInfo(args.sessionId);
    if (!info) {
      return errorResponse(`Session not found: ${args.sessionId ?? ctx.sessionId}`);
    }
    return successResponse(JSON.stringify(info, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to get session info: ${message}`);
  }
}

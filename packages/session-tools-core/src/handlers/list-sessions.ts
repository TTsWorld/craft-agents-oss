import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// list_sessions 的查询参数：可按状态、标签、关键字筛选与排序
export interface ListSessionsArgs {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/**
 * 处理 list_sessions tool 调用。
 * 把查询条件透传给上下文中的 listSessions，返回会话列表的格式化 JSON。
 */
export async function handleListSessions(
  ctx: SessionToolContext,
  args: ListSessionsArgs
): Promise<ToolResult> {
  if (!ctx.listSessions) {
    return errorResponse('list_sessions is not available in this context.');
  }

  try {
    const result = ctx.listSessions({
      status: args.status,
      label: args.label,
      search: args.search,
      sortBy: args.sortBy,
      limit: args.limit,
      offset: args.offset,
    });
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list sessions: ${message}`);
  }
}

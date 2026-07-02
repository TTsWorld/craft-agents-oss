import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// set_session_labels 参数：不传 sessionId 表示操作当前会话
export interface SetSessionLabelsArgs {
  sessionId?: string;
  labels: string[];
}

/**
 * 处理 set_session_labels tool 调用。
 * 给会话打标签；如果上下文支持 resolveLabels，会先把显示名解析为内部 ID，并拒绝未知标签。
 */
export async function handleSetSessionLabels(
  ctx: SessionToolContext,
  args: SetSessionLabelsArgs
): Promise<ToolResult> {
  if (!ctx.setSessionLabels) {
    return errorResponse('set_session_labels is not available in this context.');
  }

  try {
    let labels = args.labels;

    // 把显示名解析为内部 ID；遇到未知标签直接报错
    if (ctx.resolveLabels) {
      const { resolved, unknown, available, reasons } = ctx.resolveLabels(labels);
      if (unknown.length > 0) {
        const lines = unknown.map((entry) => {
          const reason = reasons?.[entry] ?? 'unknown label';
          return `  - "${entry}" — ${reason}`;
        });
        return errorResponse(
          `Labels rejected:\n${lines.join('\n')}\n\n` +
          `Available label IDs: ${available.join(', ')}.\n` +
          `Use "id::value" only for labels configured with a valueType (number, date, string, or link).`
        );
      }
      labels = resolved;
    }

    await ctx.setSessionLabels(args.sessionId, labels);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(
      labels.length === 0
        ? `Labels cleared on ${target}.`
        : `Labels set on ${target}: ${labels.join(', ')}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set labels: ${message}`);
  }
}

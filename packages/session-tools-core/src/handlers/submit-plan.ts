/**
 * SubmitPlan Handler（提交计划处理器）
 *
 * 把计划文件提交给用户审批。这会触发计划展示 UI，并暂停 Agent 执行，直到用户响应。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// submit_plan 参数：计划文件路径
export interface SubmitPlanArgs {
  planPath: string;
}

/**
 * 处理 submit_plan tool 调用。
 *
 * 流程：
 * 1. 校验计划文件存在；
 * 2. 读取文件确认可读；
 * 3. 调用 onPlanSubmitted 回调（会话管理器会据此 forceAbort，暂停当前 turn）；
 * 4. 返回成功提示。
 */
export async function handleSubmitPlan(
  ctx: SessionToolContext,
  args: SubmitPlanArgs
): Promise<ToolResult> {
  const { planPath } = args;

  // 校验文件存在
  if (!ctx.fs.exists(planPath)) {
    return errorResponse(
      `Plan file not found at ${planPath}. Please write the plan file first using the Write tool.`
    );
  }

  // 读取文件确认内容有效
  try {
    ctx.fs.readFile(planPath);
  } catch (error) {
    return errorResponse(
      `Failed to read plan file: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // 通知会话管理器计划已提交；这会触发 forceAbort，等待用户反馈
  ctx.callbacks.onPlanSubmitted(planPath);

  return successResponse('Plan submitted for review. Waiting for user feedback.');
}

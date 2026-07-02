/**
 * 文件：Claude SDK query() 流消费辅助函数
 *
 * 角色：专门处理 call_llm 工具对 Claude SDK query() 的调用。把 SDK 的异步消息流
 * 收敛成 { text, warning }，便于上层 LLMQueryResult 复用。
 *
 * 重点：
 * - SDK 可能以两种形式报告非成功结果：yield 一个 subtype 为 error_max_turns 等
 *   的 result 消息，或者直接抛异常。
 * - 函数会尽量保留已累积的部分文本（partial output），实在没 salvage 到内容才
 *   重新抛出异常。
 */

/**
 * Helpers for consuming Claude SDK `query()` streams for the call_llm tool.
 *
 * Extracted from `ClaudeAgent.queryLlm` so the max-turns / partial-output
 * handling can be unit-tested without standing up a full ClaudeAgent.
 */

import type { SDKMessage, SDKResultError, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import type { LLMQueryResult } from './llm-tool.ts';

type SdkResultErrorSubtype = SDKResultError['subtype'];

const ERROR_SUBTYPE_LABELS: Record<SdkResultErrorSubtype, string> = {
  error_max_turns: 'Model stopped at max turns',
  error_max_budget_usd: 'Model stopped at budget cap',
  error_max_structured_output_retries: 'Structured output retries exhausted',
  error_during_execution: 'Model errored during execution',
};

/** Format an SDK error-result into a one-line human warning. */
export function summarizeSdkError(r: SDKResultError): string {
  const base = ERROR_SUBTYPE_LABELS[r.subtype] ?? `Model stopped (${r.subtype})`;
  const extra = r.errors?.length ? ` — ${r.errors.join('; ')}` : '';
  return `${base}${extra} (num_turns=${r.num_turns})`;
}

/**
 * Consume an SDK `query()` async iterable and return the accumulated
 * assistant text (or structured output) plus an optional warning.
 *
 * Handles both shapes the SDK emits on non-success completions:
 * - Yielded `result` message with an error subtype (e.g. `error_max_turns`).
 * - Thrown exception mid-stream (SDK's current behavior for max-turns).
 *
 * Re-throws when nothing was salvaged, so callers still see a hard failure
 * for genuinely broken cases (auth, network, etc.).
 */
export async function consumeLlmQueryMessages(
  iter: AsyncIterable<SDKMessage>,
  onDebug?: (msg: string) => void,
): Promise<LLMQueryResult> {
  let text = '';
  let structuredOutput: unknown = undefined;
  let warning: string | undefined;

  try {
    for await (const msg of iter) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            text += block.text;
          }
        }
      }
      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultSuccess | SDKResultError;
        if (resultMsg.subtype === 'success') {
          structuredOutput = (resultMsg as SDKResultSuccess).structured_output;
        } else {
          const errorMsg = resultMsg as SDKResultError;
          warning = summarizeSdkError(errorMsg);
          onDebug?.(
            `[queryLlm] SDK result subtype=${errorMsg.subtype}` +
            ` num_turns=${errorMsg.num_turns}` +
            ` stop_reason=${errorMsg.stop_reason}` +
            ` errors=${JSON.stringify(errorMsg.errors ?? [])}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onDebug?.(`[queryLlm] SDK threw: ${message} (accumulated ${text.length} chars of partial text)`);
    if (!text.trim() && structuredOutput === undefined) {
      throw error;
    }
    warning = `Model stopped early: ${message}`;
  }

  if (structuredOutput !== undefined) {
    return { text: JSON.stringify(structuredOutput, null, 2), warning };
  }
  return { text: text.trim(), warning };
}

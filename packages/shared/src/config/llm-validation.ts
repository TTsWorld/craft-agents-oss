/**
 * 集中式 LLM 连接验证。
 *
 * 通过 Claude Agent SDK 发起一次最小查询来验证连接是否可用，
 * 走和真实 Agent session 相同的代码路径（query()，maxTurns:1）。
 * 这种方式比单纯 ping 地址更可靠：能同时验证凭据、模型、端点。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultOptions } from '../agent/options.ts';
import { debug } from '../utils/debug.ts';

/** 验证配置 */
export interface LlmValidationConfig {
  /** 用于测试的模型 ID */
  model: string;
  /** API key（对应 x-api-key header） */
  apiKey?: string;
  /** OAuth / bearer token（对应 Authorization: Bearer header） */
  oauthToken?: string;
  /** 自定义 base URL，用于 Anthropic 兼容端点 */
  baseUrl?: string;
}

/** 验证结果 */
export interface LlmValidationResult {
  /** 是否验证通过 */
  success: boolean;
  /** 失败时的可读错误信息 */
  error?: string;
}

/**
 * 验证 Anthropic 或 Anthropic 兼容端点的 LLM 连接。
 *
 * 通过 Claude Agent SDK 发一条最小请求，验证：
 * - 凭据是否有效
 * - 模型是否可访问
 * - 端点是否可达
 *
 * @returns 验证结果；失败时附带解析后的用户友好错误信息
 */
export async function validateAnthropicConnection(
  config: LlmValidationConfig
): Promise<LlmValidationResult> {
  debug('[llm-validation] Validating connection', { model: config.model, hasApiKey: !!config.apiKey, hasOAuth: !!config.oauthToken, baseUrl: config.baseUrl });

  // 构造环境变量覆盖，避免直接修改全局 process.env
  const envOverrides: Record<string, string> = {};

  if (config.apiKey) {
    envOverrides.ANTHROPIC_API_KEY = config.apiKey;
    // 同时清空 OAuth，避免两种凭据冲突
    envOverrides.CLAUDE_CODE_OAUTH_TOKEN = '';
  } else if (config.oauthToken) {
    envOverrides.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
    // 同时清空 API key，避免两种凭据冲突
    envOverrides.ANTHROPIC_API_KEY = '';
  }

  if (config.baseUrl) {
    envOverrides.ANTHROPIC_BASE_URL = config.baseUrl;
  }

  const abortController = new AbortController();

  try {
    const options = {
      ...getDefaultOptions(envOverrides),
      model: config.model,
      maxTurns: 1,
      abortController,
      systemPrompt: 'Reply with OK.',
      tools: [] as string[], // 不启用任何 tool
      persistSession: false,
    };

    const q = query({ prompt: 'hi', options });

    // 消费流式响应：只要拿到 assistant 消息即可判断成功或失败
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        // SDK 可能在 assistant 消息里报告错误
        if (msg.error) {
          abortController.abort();
          return { success: false, error: parseValidationError(msg.error) };
        }
        // 收到正常响应，连接可用，提前中止
        abortController.abort();
        break;
      }
    }

    return { success: true };
  } catch (error) {
    abortController.abort();
    const msg = error instanceof Error ? error.message : String(error);
    debug('[llm-validation] Validation failed:', msg);
    return { success: false, error: parseValidationError(msg) };
  }
}

/**
 * 把 SDK/网络错误转换成用户友好的提示文案。
 * 所有连接验证的错误文案都在这里统一翻译。
 */
export function parseValidationError(msg: string): string {
  const lowerMsg = msg.toLowerCase();

  // 连接类错误：服务不可达
  if (lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound') || lowerMsg.includes('fetch failed')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.';
  }

  // 鉴权失败
  if (lowerMsg.includes('401') || lowerMsg.includes('unauthorized') || lowerMsg.includes('authentication')) {
    return 'Authentication failed. Check your API key or OAuth token.';
  }

  // 权限不足
  if (lowerMsg.includes('403') || lowerMsg.includes('forbidden') || lowerMsg.includes('permission')) {
    return 'Access denied. Check your API key permissions.';
  }

  // 限流 / 配额
  if (lowerMsg.includes('429') || lowerMsg.includes('rate limit') || lowerMsg.includes('quota')) {
    return 'Rate limited or quota exceeded. Try again later.';
  }

  // 计费问题
  if (lowerMsg.includes('402') || lowerMsg.includes('credit') || lowerMsg.includes('billing') || lowerMsg.includes('insufficient')) {
    return 'Billing issue. Check your account credits or payment method.';
  }

  // 模型不存在
  if (lowerMsg.includes('model not found') || lowerMsg.includes('invalid model')) {
    return 'Model not found. Check the connection configuration.';
  }

  // 端点 404（排除包含 model 字样的情况）
  if (lowerMsg.includes('404') && !lowerMsg.includes('model')) {
    return 'Endpoint not found. Ensure the server supports the Anthropic Messages API.';
  }

  // 服务端异常
  if (lowerMsg.includes('500') || lowerMsg.includes('502') || lowerMsg.includes('503') || lowerMsg.includes('service unavailable')) {
    return 'API temporarily unavailable. Try again in a few seconds.';
  }

  // 兜底：截断过长的原始信息
  return msg.slice(0, 200);
}

/**
 * 基于 Claude Agent SDK 的 AI URL 校验模块
 *
 * 使用 Claude Haiku 做轻量、低成本的 URL 校验，并能结合上下文理解
 * 哪些是合法的 Craft MCP URL 格式。
 *
 * 类比 Go：可以把这里的 async function 理解成返回 (UrlValidationResult, error) 的函数，
 * TS 里用 Promise<UrlValidationResult> 来表达异步结果。
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultOptions } from '../agent/options.ts';
import { getDefaultSummarizationModel } from '../config/models.ts';

import { debug } from '../utils/debug.ts';
import { parseError, parseSDKErrorText, type AgentError } from '../agent/errors.ts';
import { getLastApiError } from '../interceptor-common.ts';

/**
 * URL 校验结果结构
 * 在 TS 里 interface 类似 Go 的 interface：先定义一组字段契约，其他地方按契约使用。
 */
export interface UrlValidationResult {
  // 是否通过校验
  valid: boolean;
  // 校验失败时给用户的简单错误提示（可空字段用 ? 表示）
  error?: string;
  // API/计费类失败时带类型的错误对象，UI 侧可渲染为 ErrorBanner
  typedError?: AgentError;
}

// 系统提示词（Prompt）：发给 Claude 的“岗位说明书”，告诉它只做 URL 校验这一件事
// 常量用大写 + 反引号字符串（模板字符串）声明，内容保持不变
const SYSTEM_PROMPT = `You are a URL validator for Craft MCP servers. Your ONLY job is to validate if a URL is a valid Craft MCP URL.

VALID URL EXAMPLES:
- https://mcp.craft.do/links/DSdsfdsjkf34235/mcp
- https://mcp.craft.do/links/ABC123/mcp
- https://mcp.craft.do/links/xY9-abc_123/mcp

INVALID URL EXAMPLES AND WHY:
- mcp.craft.do/links/abc/mcp → Missing https:// protocol
- http://mcp.craft.do/links/abc/mcp → Must use https://, not http://
- https://evil.com/mcp.craft.do/links/abc → Wrong domain (must be exactly mcp.craft.do)
- https://mcp.craft.do.evil.com/links/abc → Wrong domain (subdomain attack)
- https://user:pass@mcp.craft.do/links/abc → Credentials in URL not allowed
- https://mcp.craft.do → Missing /links/ path
- https://google.com → Completely wrong domain

VALIDATION RULES:
1. Protocol must be https://
2. Hostname must be exactly "mcp.craft.do" (no subdomains, no other domains)
3. Path should start with /links/
4. No credentials (user:pass@) in the URL
5. Must be a syntactically valid URL
6. The input should only be the URL string, nothing else NO sentences OR extra text
7. Make sure the URL only contains allowed characters (letters, numbers, hyphens, underscores) in the link ID part

RESPONSE FORMAT:
Respond with ONLY a JSON object, no other text:
{"valid": true}
or
{"valid": false, "error": "Helpful error message for the user"}

ERROR MESSAGES should be user-friendly and suggest how to fix the issue.`;

/**
 * 使用 Claude Haiku 校验 MCP URL
 * @param url 待校验的 URL 字符串
 * @param apiKey 可选的 Anthropic API key
 * @param oauthToken 可选的 OAuth token
 * @returns Promise<UrlValidationResult> 异步返回校验结果
 */
export async function validateMcpUrl(
  url: string,
  apiKey?: string,
  oauthToken?: string,
): Promise<UrlValidationResult> {
  debug('[url-validator] Validating URL:', url);

  try {
    // 组装调用 Claude SDK 的选项
    // ... 是展开运算符，类似 Go 的 struct 字面量嵌套：先复制默认配置，再覆盖部分字段
    const options: Options = {
      ...getDefaultOptions(),
      model: getDefaultSummarizationModel(),
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      tools: [], // 不需要 tool use，这里只做纯文本分析
      ...(apiKey ? { apiKey } : {}),
      ...(oauthToken ? { oauthToken } : {}),
    };

    let responseText = '';

    // 流式调用 Claude：query 返回一个异步迭代器（类似 Go 里 range over channel）
    // for await...of 会逐条读取模型返回的消息
    for await (const message of query({ prompt: `Validate this URL: ${url}`, options })) {
      // 只取 assistant（模型）角色的文本内容
      if (message.type === 'assistant') {
        // message.message.content 是数组，遍历拼接文本块
        for (const block of message.message.content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      }
    }

    debug('[url-validator] Response:', responseText);

    // 先检查 SDK 是否把错误信息直接以文本形式返回（在抛出异常之前就会输出）
    const sdkError = parseSDKErrorText(responseText);
    if (sdkError) {
      debug('[url-validator] Detected SDK error in response');
      return { valid: false, typedError: sdkError };
    }

    // 从模型回复中提取 JSON：match 返回第一个 { ... } 匹配项
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      debug('[url-validator] Failed to parse JSON from response');
      return { valid: false, error: 'Unable to validate URL' };
    }

    // 解析并标准化返回值：只有 result.valid 严格等于 true 才认为通过
    const result = JSON.parse(jsonMatch[0]);
    return {
      valid: result.valid === true,
      error: result.error,
    };
  } catch (err) {
    debug('[url-validator] Error:', err);

    // 优先从拦截器里取最后捕获的 API 错误（通常最准确，比如 401/429/500）
    const apiError = getLastApiError();
    if (apiError) {
      debug('[url-validator] Found captured API error:', apiError.status, apiError.message);
      // 用状态码 + 消息构造 Error，再交给 parseError 识别错误类型
      const typedError = parseError(new Error(`${apiError.status} ${apiError.message}`));
      if (typedError.code !== 'unknown_error') {
        return { valid: false, typedError };
      }
    }

    // 兜底：解析抛出来的异常
    const typedError = parseError(err);

    // 如果是已识别的 API/计费类错误，返回 typedError 给 UI 展示为 ErrorBanner
    // 如果是 unknown_error，则降级为简单的字符串错误提示
    if (typedError.code !== 'unknown_error') {
      return { valid: false, typedError };
    }

    // 未知错误：返回用户友好的简单错误信息
    return { valid: false, error: `URL validation failed: ${typedError.originalError || 'Unknown error'}` };
  }
}

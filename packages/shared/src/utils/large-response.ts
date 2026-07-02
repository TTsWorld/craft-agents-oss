/**
 * 大响应处理工具
 *
 * 对大工具结果进行统一的保存 + prompt 构建 + 格式化。
 * 遵循 title-generator.ts 的模式：纯函数，不调用 SDK/LLM。
 *
 * 调用方通过各自 Agent 的 runMiniCompletion() 来编排摘要过程。
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { debug } from './debug.ts';
import {
  looksLikeBinary,
  extractBase64Binary,
  detectExtensionFromMagic,
  saveBinaryResponse,
  sanitizeFilename,
  formatBytes,
} from './binary-detection.ts';

// ============================================================
// 常量（从 summarize.ts 重新导出以方便使用）
// ============================================================

/**
 * 默认的单个结果摘要阈值（约 48KB 纯文本，base64 等 token 密集内容会更低）。
 *
 * 调用点如果能拿到当前模型的 `contextWindow`，建议优先使用 {@link tokenLimitFor}——
 * 模型感知的尺寸可以避免中等上下文模型（如 64k）被多个刚好低于阈值的工具结果撑满窗口。
 *
 * 从 15k 降到 12k，是因为观察到单个 56KB 且富含 base64 的 Read 结果按 4 字符/token 估算约 14k token，
 * 但实际 tokenizer 中消耗更高。降低上限并结合 {@link estimateTokensDensityAware} 留出余量。
 */
export const TOKEN_LIMIT = 12000;

/** 可送入摘要的最大 token 数（约 400KB）。超过则只保存文件 + 预览。 */
export const MAX_SUMMARIZATION_INPUT = 100000;

/** 会话目录下存放完整工具结果的规范子文件夹 */
export const LONG_RESPONSES_DIR = 'long_responses';

/**
 * 模型感知单个结果阈值的地板。低于此大小时，
 * "文件引用 + 摘要消息" 的长度与原内容差不多，摘要不再划算。
 */
const TOKEN_LIMIT_FLOOR = 2_000;

/** 单个工具结果可占模型上下文窗口的比例。
 *  10% 让大约 4 个结果在需要收紧前都能放下。 */
const PER_RESULT_CONTEXT_FRACTION = 0.10;

// ============================================================
// Token 估算
// ============================================================

/**
 * 根据文本长度估算 token 数（粗略：4 字符/token）。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 启用密度感知修正的最小长度。低于此大小时修正无意义，反正结果能放下。
 */
const DENSITY_AWARE_MIN_LENGTH = 20_000;

/** 被认定为 base64 密集段的最小连续长度。设为 60 可捕获野外常见的断行 base64——
 *  RFC 2045 MIME 每 76 字符换行、PEM 每 64 字符、某些自定义编码 60 字符。
 *  短字母数字串（不含 :/?& 的 URL、UUID、标识符）低于此阈值，误报率低。
 *
 *  十六进制摘要（SHA-256 = 64 字符，SHA-512 = 128）和 JWT 会命中——
 *  它们在实际 tokenizer 中也是 token 密集的，因此以它们为主的工具结果理应溢出。 */
const BASE64_RUN_MIN = 60;

/** 总字符中必须有多大比例位于长 base64 风格段内，才触发密度修正。 */
const BASE64_DENSITY_THRESHOLD = 0.70;

/** base64 在实际 tokenizer（Anthropic、GPT、Llama）中的有效字符/token 约 1.3–1.7。 */
const BASE64_CHARS_PER_TOKEN = 1.5;

/**
 * 密度感知 token 估算。普通文本与 {@link estimateTokens} 一致，
 * 但会修正富含 base64 的内容（邮件 MIME 正文、含嵌入式二进制的 JSON、dump 的证书等），
 * 因为这类内容按 4 字符/token 会低估约 2.5 倍。
 *
 * 触发条件（需同时满足）：
 *  - 文本长度 ≥ {@link DENSITY_AWARE_MIN_LENGTH}
 *  - ≥ {@link BASE64_DENSITY_THRESHOLD} 的字符位于长度 ≥ {@link BASE64_RUN_MIN} 的未中断 base64 字符集段内
 *
 * 触发后返回 `text.length / 1.5` 而非 `text.length / 4`。
 */
export function estimateTokensDensityAware(text: string): number {
  if (text.length < DENSITY_AWARE_MIN_LENGTH) return estimateTokens(text);
  const runRegex = new RegExp(`[A-Za-z0-9+/=]{${BASE64_RUN_MIN},}`, 'g');
  let denseChars = 0;
  for (const match of text.matchAll(runRegex)) {
    denseChars += match[0].length;
  }
  if (denseChars / text.length >= BASE64_DENSITY_THRESHOLD) {
    return Math.ceil(text.length / BASE64_CHARS_PER_TOKEN);
  }
  return estimateTokens(text);
}

/**
 * 根据当前模型上下文窗口缩放单个结果摘要阈值。
 * 200k 窗口模型返回 {@link TOKEN_LIMIT} 上限（12k）；
 * 64k 窗口模型返回 6_400；窗口低于约 20k 时触发地板（2_000）。
 *
 * 调用点没有模型上下文时传 `undefined`，会返回固定默认值以保持向后兼容。
 *
 * @param contextWindow - 模型上下文窗口大小
 * @returns 计算后的 token 阈值
 */
export function tokenLimitFor(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return TOKEN_LIMIT;
  return Math.max(
    TOKEN_LIMIT_FLOOR,
    Math.min(TOKEN_LIMIT, Math.floor(contextWindow * PER_RESULT_CONTEXT_FRACTION)),
  );
}

// ============================================================
// 保存到磁盘
// ============================================================

export interface SaveResult {
  /** Read/Grep 使用的绝对路径 */
  absolutePath: string;
  /** 相对会话目录的路径（例如 "long_responses/2026-02-09_gmail_users_me.txt"），供 transform_data 使用 */
  relativePath: string;
}

/**
 * 将大响应保存到会话的 long_responses/ 文件夹。
 * 不存在时自动创建文件夹。
 *
 * @param sessionPath - 会话文件夹路径
 * @param toolName - 工具名（如 "gmail"、"api_stripe"）
 * @param label - 文件名附加标签（如 API 路径）
 * @param content - 要保存的完整响应内容
 * @returns 保存后的绝对路径和相对路径；失败返回 null
 */
export function saveLargeResponse(
  sessionPath: string,
  toolName: string,
  label: string,
  content: string
): SaveResult | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const safeLabel = label.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const filename = `${timestamp}_${toolName}_${safeLabel}.txt`;
    const absolutePath = join(responsesDir, filename);

    writeFileSync(absolutePath, content, 'utf-8');

    const relativePath = relative(sessionPath, absolutePath);

    debug('large-response', `Saved ${content.length} bytes to ${relativePath}`);
    return { absolutePath, relativePath };
  } catch (error) {
    debug('large-response', `Failed to save: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// 结构化媒体提取（JSON 载荷）
// ============================================================

interface SavedJsonArtifact extends SaveResult {
  filename: string;
}

interface SavedAsset {
  absolutePath: string;
  relativePath: string;
  mimeType: string | null;
  ext: string;
  size: number;
  sizeHuman: string;
  sha256: string;
  jsonPath: string;
  source: 'data-url' | 'raw-base64';
}

interface JsonAssetExtractionResult {
  originalJsonPath: string;
  linkedJsonPath: string;
  assets: SavedAsset[];
}

function saveJsonArtifact(
  sessionPath: string,
  toolName: string,
  suffix: string,
  content: string
): SavedJsonArtifact | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const safeTool = sanitizeFilename(toolName || 'tool_result');
    const filename = `${timestamp}_${safeTool}_${suffix}.json`;
    const absolutePath = join(responsesDir, filename);
    writeFileSync(absolutePath, content, 'utf-8');
    return {
      absolutePath,
      relativePath: relative(sessionPath, absolutePath),
      filename,
    };
  } catch (error) {
    debug('large-response', `Failed to save JSON artifact: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function inferMimeFromContext(container: unknown): string | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  const obj = container as Record<string, unknown>;
  const keys = ['mimeType', 'media_type', 'mime', 'contentType', 'content_type'];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function saveExtractedAsset(
  sessionPath: string,
  toolName: string,
  buffer: Buffer,
  ext: string,
  mimeType: string | null,
  jsonPath: string,
  source: 'data-url' | 'raw-base64'
): SavedAsset | null {
  try {
    const assetsDir = join(sessionPath, 'downloads', 'assets');
    mkdirSync(assetsDir, { recursive: true });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const safeTool = sanitizeFilename(toolName || 'tool_result');
    const safeExt = ext.startsWith('.') ? ext : `.${ext || 'bin'}`;
    const filename = `${safeTool}_${sha256.slice(0, 16)}${safeExt}`;
    const absolutePath = join(assetsDir, filename);

    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, buffer, { flag: 'wx' });
    }

    return {
      absolutePath,
      relativePath: relative(sessionPath, absolutePath),
      mimeType,
      ext: safeExt,
      size: buffer.length,
      sizeHuman: formatBytes(buffer.length),
      sha256,
      jsonPath,
      source,
    };
  } catch (error) {
    debug('large-response', `Failed to save extracted asset: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function extractAssetsFromStructuredJson(
  text: string,
  sessionPath: string,
  toolName: string
): JsonAssetExtractionResult | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const linked = JSON.parse(JSON.stringify(parsed)) as unknown;
  const assets: SavedAsset[] = [];

  const walk = (node: unknown, path: string, parent: Record<string, unknown> | unknown[] | null, key: string | number | null) => {
    if (typeof node === 'string') {
      const extraction = extractBase64Binary(node);
      if (!extraction || !parent || key === null) return;

      const contextMime = inferMimeFromContext(parent);
      const mime = extraction.mimeType || contextMime;
      const ext = extraction.ext || '.bin';
      const saved = saveExtractedAsset(sessionPath, toolName, extraction.buffer, ext, mime, path, extraction.source);
      if (!saved) return;

      const replacement = {
        assetRef: {
          path: saved.absolutePath,
          relativePath: saved.relativePath,
          mimeType: saved.mimeType,
          ext: saved.ext,
          size: saved.size,
          sizeHuman: saved.sizeHuman,
          sha256: saved.sha256,
          jsonPath: saved.jsonPath,
          source: saved.source,
        },
      };

      if (Array.isArray(parent)) {
        parent[key as number] = replacement;
      } else {
        (parent as Record<string, unknown>)[String(key)] = replacement;
      }
      assets.push(saved);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${path}[${idx}]`, node, idx));
      return;
    }

    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const childPath = path === '$' ? `$.${k}` : `${path}.${k}`;
        walk(v, childPath, obj, k);
      }
    }
  };

  walk(linked, '$', null, null);

  if (assets.length === 0) return null;

  const originalArtifact = saveJsonArtifact(sessionPath, toolName, 'original', text);
  const linkedArtifact = saveJsonArtifact(sessionPath, toolName, 'linked', JSON.stringify(linked, null, 2));

  if (!originalArtifact || !linkedArtifact) return null;

  return {
    originalJsonPath: originalArtifact.absolutePath,
    linkedJsonPath: linkedArtifact.absolutePath,
    assets,
  };
}

function formatStructuredMediaExtractionMessage(result: JsonAssetExtractionResult): string {
  const assetsList = result.assets
    .map((asset, index) => `${index + 1}. ${asset.absolutePath} (${asset.sizeHuman}, ${asset.mimeType || asset.ext.slice(1).toUpperCase()}, from ${asset.jsonPath})`)
    .join('\n');

  return [
    '[Structured media assets extracted and saved]',
    '',
    `Original JSON: ${result.originalJsonPath}`,
    `Linked JSON: ${result.linkedJsonPath}`,
    `Assets extracted: ${result.assets.length}`,
    assetsList ? `\n${assetsList}` : '',
    '',
    'Use the linked JSON for analysis and click asset file paths to preview/open the extracted media.',
  ].join('\n');
}

// ============================================================
// 摘要 Prompt 构建器
// ============================================================

/**
 * 摘要上下文。
 */
export interface SummarizationContext {
  /** 工具或 API 名称 */
  toolName: string;
  /** API 调用的可选端点/路径 */
  path?: string;
  /** 工具输入参数 */
  input?: Record<string, unknown>;
  /** 模型调用工具前声明的意图 */
  intent?: string;
  /** 用户原始请求（兜底上下文） */
  userRequest?: string;
}

/**
 * 为大工具结果构建摘要 prompt。
 * 纯函数——不调用 SDK。
 *
 * @param text - 大响应文本
 * @param context - 工具调用上下文
 * @returns 可直接传给 runMiniCompletion() 的 prompt 字符串
 */
export function buildSummarizationPrompt(text: string, context: SummarizationContext): string {
  // 安全序列化输入
  let inputContext = 'No specific parameters provided.';
  if (context.input) {
    try {
      inputContext = `Request parameters: ${JSON.stringify(context.input)}`;
    } catch {
      inputContext = 'Request parameters: [non-serializable input]';
    }
  }

  const endpointContext = context.path ? `Endpoint: ${context.path}` : '';

  // 优先使用模型声明的意图，其次用户请求
  const intentContext = context.intent
    ? `The AI assistant's goal: "${context.intent.slice(0, 500)}"`
    : context.userRequest
      ? `User's original request: "${context.userRequest.slice(0, 300)}"`
      : '';

  // 截断响应以适配摘要限制
  const maxChars = MAX_SUMMARIZATION_INPUT * 4; // ~400KB
  const truncated = text.length > maxChars;
  const responseText = truncated
    ? text.substring(0, maxChars) + '\n\n[... truncated for summarization ...]'
    : text;

  return `You are summarizing a tool result that was too large to fit in context.

Tool: ${context.toolName}
${endpointContext}
${inputContext}
${intentContext ? `\n${intentContext}` : ''}
${truncated ? '\nNote: The response was truncated before summarization due to extreme size.' : ''}

Your task:
1. Extract the MOST RELEVANT information based on the stated goal or request above
2. Preserve key data points, IDs, URLs, and actionable information that relate to the goal
3. Summarize long text content but keep essential details needed to complete the task
4. Format the output cleanly for the AI assistant to use

Tool result to summarize:
${responseText}

Provide a concise but comprehensive summary that captures the essential information needed to accomplish the stated goal.`;
}

// ============================================================
// 结果消息格式化
// ============================================================

export interface FormatOptions {
  estimatedTokens: number;
  /** 相对会话目录的路径（供 transform_data 引用） */
  relativePath: string;
  /** 绝对路径（供 Read/Grep 引用） */
  absolutePath: string;
  /** runMiniCompletion 提供的摘要（如果有） */
  summary?: string;
  /** 无摘要时的回退预览（响应前 N 字符） */
  preview?: string;
}

/**
 * 格式化模型看到的大响应消息。
 * 包含 Read/Grep 和 transform_data 两种文件引用。
 */
export function formatLargeResponseMessage(opts: FormatOptions): string {
  const { estimatedTokens, relativePath, absolutePath, summary, preview } = opts;

  const fileRef = [
    `Full data saved to: ${absolutePath}`,
    `- Use Read/Grep to access specific content`,
    `- Use transform_data with inputFiles: ["${relativePath}"] for data analysis`,
  ].join('\n');

  if (summary) {
    return `[Large response (~${estimatedTokens} tokens) summarized]\n\n${fileRef}\n\n${summary}`;
  }

  if (preview) {
    return `[Response too large (~${estimatedTokens} tokens)]\n\n${fileRef}\n\nPreview:\n${preview}...`;
  }

  return `[Response too large (~${estimatedTokens} tokens)]\n\n${fileRef}`;
}

// ============================================================
// 高层管道（编排保存 + 摘要 + 格式化）
// ============================================================

export interface HandleLargeResponseOptions {
  /** 完整响应文本 */
  text: string;
  /** 会话文件夹路径 */
  sessionPath: string;
  /** 工具调用上下文 */
  context: SummarizationContext;
  /** 可选的摘要回调——通常是 agent.runMiniCompletion.bind(agent) */
  summarize?: (prompt: string) => Promise<string | null>;
  /** 当前模型的上下文窗口——参见 {@link guardLargeResult} */
  contextWindow?: number;
}

export interface HandleLargeResponseResult {
  /** 返回给模型的格式化消息 */
  message: string;
  /** 保存文件的绝对路径 */
  filePath: string;
  /** 是否已摘要（相对于仅预览） */
  wasSummarized: boolean;
}

/**
 * 轻量保护包装器：结果过大或包含二进制数据时返回替换文本，
 * 否则返回 null，让结果原样透传。
 *
 * 接受 string | Buffer：
 * - Buffer：对原始字节做二进制检测（保存文件时保证数据完整）。api-tools 使用，它有原始 HTTP 响应 buffer。
 * - string：通过 Buffer 转换做二进制检测。MCP pool 和 Claude SDK 使用，那里数据已是字符串。
 *
 * 管道：二进制检查 →（若是文本）大小检查 → 保存 + 摘要。
 *
 * 被 McpClientPool.callTool()、api-tools.ts、claude-agent.ts 共享。
 */
export async function guardLargeResult(
  input: string | Buffer,
  opts: {
    sessionPath: string;
    toolName: string;
    input?: Record<string, unknown>;
    intent?: string;
    summarize?: (prompt: string) => Promise<string | null>;
    /** 当前模型的上下文窗口——提供时，单个结果阈值通过 {@link tokenLimitFor} 缩放；
     *  调用点没有模型知识时省略，保留固定默认值。 */
    contextWindow?: number;
  }
): Promise<string | null> {
  // 1. 二进制检测——在任何文本处理之前先检查
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  if (looksLikeBinary(buffer)) {
    debug('large-response', `${opts.toolName}: binary content detected (${buffer.length} bytes)`);
    const ext = detectExtensionFromMagic(buffer) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, buffer, null);
    if (result.type === 'file_download') {
      return `[Binary content detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${ext.slice(1).toUpperCase() || 'unknown'}\n\nUse the Read tool or reference this path to work with the file.`;
    }
    return `[Binary content detected but save failed: ${result.error}]`;
  }

  // 2. 转为字符串（已是 string 时无操作；通过二进制检查的 Buffer 则 toString）
  const text = typeof input === 'string' ? input : buffer.toString('utf-8');

  // 2b. 结构化 JSON 提取路径——保留原始 JSON，提取二进制资源，
  // 并生成 linked JSON，把 base64 块替换为文件引用。
  const structuredExtraction = extractAssetsFromStructuredJson(text, opts.sessionPath, opts.toolName);
  if (structuredExtraction) {
    debug('large-response', `${opts.toolName}: extracted ${structuredExtraction.assets.length} media assets from structured JSON payload`);
    return formatStructuredMediaExtractionMessage(structuredExtraction);
  }

  // 2c. 内联 base64 编码二进制检测（data URL 和原始 base64 块）
  const base64Result = extractBase64Binary(text);
  if (base64Result) {
    debug('large-response', `${opts.toolName}: ${base64Result.source} binary detected (${base64Result.buffer.length} decoded bytes)`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${base64Result.ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, base64Result.buffer, base64Result.mimeType);
    if (result.type === 'file_download') {
      return `[Base64-encoded binary detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${base64Result.ext.slice(1).toUpperCase() || 'unknown'}\n\nThe tool result contained base64-encoded binary data which has been decoded and saved.`;
    }
    return `[Base64-encoded binary detected but save failed: ${result.error}]`;
  }

  // 3. 现有大小检查 + 摘要流程（提供 contextWindow 时启用模型感知）。
  // 使用密度感知估算，让富含 base64 的文本（MIME、JSON 嵌入式二进制）
  // 无法通过 4 字符/token 启发式溜进对话上下文。
  if (estimateTokensDensityAware(text) <= tokenLimitFor(opts.contextWindow)) return null;
  const result = await handleLargeResponse({
    text,
    sessionPath: opts.sessionPath,
    context: { toolName: opts.toolName, input: opts.input, intent: opts.intent },
    summarize: opts.summarize,
    contextWindow: opts.contextWindow,
  });
  return result?.message ?? null;
}

/**
 * 完整管道：保存到磁盘、可选摘要、格式化结果消息。
 *
 * 当工具结果超过 TOKEN_LIMIT 时调用。
 * 如果提供了 `summarize` 回调且 token 数在 MAX_SUMMARIZATION_INPUT 内，
 * 会用构建好的 prompt 调用它；否则回退到预览。
 *
 * @returns 格式化结果；文本不够大时返回 null
 */
export async function handleLargeResponse(
  opts: HandleLargeResponseOptions
): Promise<HandleLargeResponseResult | null> {
  const { text, sessionPath, context, summarize, contextWindow } = opts;
  const estimatedTokens = estimateTokensDensityAware(text);

  if (estimatedTokens <= tokenLimitFor(contextWindow)) {
    return null; // 不够大——调用方应原样返回
  }

  debug('large-response', `${context.toolName}: ${text.length} bytes, ~${estimatedTokens} tokens`);

  // 1. 保存完整响应到磁盘
  const saveResult = saveLargeResponse(
    sessionPath,
    context.toolName,
    context.path || '',
    text
  );

  if (!saveResult) {
    // 保存失败——返回无文件引用的预览
    const preview = text.substring(0, 2000);
    return {
      message: `[Response too large (~${estimatedTokens} tokens)]\n\nPreview:\n${preview}...`,
      filePath: '',
      wasSummarized: false,
    };
  }

  const { absolutePath, relativePath } = saveResult;

  // 2. 如果在限制内且提供了回调，尝试摘要
  let summary: string | undefined;
  if (summarize && estimatedTokens <= MAX_SUMMARIZATION_INPUT) {
    try {
      const prompt = buildSummarizationPrompt(text, context);
      const result = await summarize(prompt);
      if (result) {
        summary = result;
      }
    } catch (error) {
      debug('large-response', `Summarization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. 格式化消息
  const message = formatLargeResponseMessage({
    estimatedTokens,
    relativePath,
    absolutePath,
    summary,
    preview: summary ? undefined : text.substring(0, 2000),
  });

  return { message, filePath: absolutePath, wasSummarized: !!summary };
}

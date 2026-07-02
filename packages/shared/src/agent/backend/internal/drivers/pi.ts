/**
 * 本文件实现 `piDriver`：Pi SDK（一个统一路由 OpenAI / Copilot / Bedrock 等多家模型的 SDK）
 * 在 Craft Agent 中的驱动（ProviderDriver）。
 *
 * 覆盖以下职责：
 *  - runtime 路径解析：构建 Pi 子进程所需的 server / interceptor / node 路径与 provider 配置。
 *  - 模型列表获取：包含针对 GitHub Copilot 的两层 fallback——
 *      1) 直连 HTTP：用 GitHub OAuth token 换 Copilot API token，再 GET /models；
 *      2) Pi SDK 静态目录：兜底使用 SDK 内置的模型清单。
 *  - Anthropic 兼容端点的轻量 HTTP 连接测试：避免起完整 Pi 子进程导致 20s 超时。
 *
 * Go 类比：类似为一个 provider 实现一个 Driver interface
 * （包含 BuildRuntime / FetchModels / TestConnection / ValidateStoredConnection 等方法）。
 */
import type { ProviderDriver, DriverTestConnectionArgs } from '../driver-types.ts';
import type { ModelDefinition } from '../../../../config/models.ts';
import { getAllPiModels, getPiModelsForAuthProvider, isDeprecatedClaudeOpus46Model } from '../../../../config/models-pi.ts';
import { getPiProviderBaseUrl } from '../../../../config/models-pi.ts';

// ── Copilot 模型类型 ────────────────────────────────────────────────────
type RawCopilotModel = {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  // policy.state：Copilot 模型的启用/禁用状态（enabled / disabled 等）
  policy?: { state: string };
  contextWindow?: number;
};

// ── 直连 HTTP 方案 ───────────────────────────────────────────────────

/**
 * 标识自己为 VS Code Copilot 客户端的请求头（与 Pi SDK 保持一致）。
 *
 * `as const` 为字面量常量断言：让 TS 把每个属性推断为具体的字面量字符串类型
 * （如 `'GitHubCopilotChat/0.35.0'`），而非宽泛的 `string`，便于后续严格类型检查。
 */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

/**
 * 从 Copilot API token 的 `proxy-ep` 字段中提取 API base URL。
 *
 * @param token Copilot API token（由 GitHub OAuth token 交换而来）
 * @returns 解析出的 base URL；解析失败返回 `null`
 */
function getBaseUrlFromToken(token: string): string | null {
  // 用正则从 token 中抠出 proxy-ep=... 的真实 API 入口主机
  const match = token.match(/proxy-ep=([^;]+)/);
  // `match?.[1]` 为可选链：若 match 为 null 则整体为 undefined，避免抛错
  if (!match?.[1]) return null;
  // 把代理主机 `proxy.xxx` 改写成 API 主机 `api.xxx`
  const apiHost = match[1].replace(/^proxy\./, 'api.');
  return `https://${apiHost}`;
}

/**
 * 通过 HTTP 直接从 Copilot API 拉取模型列表。
 *
 * 步骤：
 *  1. （经 Pi SDK）用 GitHub OAuth token 换取 Copilot API token；
 *  2. 从 token 的 `proxy-ep` 字段提取真实 API base URL；
 *  3. GET /models 获取带 policy state 的实时模型清单。
 *
 * 该方案不调用 CLI 子进程，避免 PATH 问题与环境变量污染。
 *
 * @param githubToken  GitHub OAuth token（作为 refreshToken / accessToken）
 * @param timeoutMs    请求超时（毫秒）
 * @returns 模型原始数据数组（`Promise<RawCopilotModel[]>` 为异步结果，
 *          类似 Go 里返回 `([]RawCopilotModel, error)` 的 future 值）。
 */
async function listModelsViaHttp(
  githubToken: string,
  timeoutMs: number,
): Promise<RawCopilotModel[]> {
  // 运行时按需加载 `@earendil-works/pi-ai/oauth` 模块（dynamic import）。
  // 类似 Go 的 plugin.Open，但在 TS/Node 里更常用：把依赖延迟到调用时才解析，
  // 既减少启动开销，也避免该模块在本文件被 import 时副作用过早执行。
  const { refreshGitHubCopilotToken } = await import('@earendil-works/pi-ai/oauth');

  // 步骤 1：用 GitHub OAuth token 换 Copilot API token
  const creds = await refreshGitHubCopilotToken(githubToken);
  const copilotToken = creds.access;

  // 步骤 2：从 token 中解析出 base URL
  const baseUrl = getBaseUrlFromToken(copilotToken);
  if (!baseUrl) {
    throw new Error('Could not extract API base URL from Copilot token (missing proxy-ep)');
  }

  console.warn(`[listModelsViaHttp] token exchange OK, baseUrl=${baseUrl}`);

  // 步骤 3：GET /models
  // 这里用 AbortController + setTimeout 实现请求超时，类比 Go 的 context.WithTimeout：
  // 到点触发 controller.abort()，fetch 因 signal 被中断而抛 AbortError。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${copilotToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!res.ok) {
      // 响应非 2xx：读取响应文本用于错误信息（读取失败则回退为空串）
      const text = await res.text().catch(() => '');
      throw new Error(`Copilot API ${res.status}: ${text.slice(0, 300)}`);
    }

    // `Record<string, unknown>` 类似 Go 的 `map[string]interface{}`：键为 string、值类型未知。
    const data = await res.json() as Record<string, unknown>;
    // 兼容两种响应格式：{ models: [...] } 与 { data: [...] }
    const models = (data.models || data.data || []) as Record<string, unknown>[];

    console.warn(`[listModelsViaHttp] GET /models returned ${models.length} models`);

    return models.map(m => ({
      id: m.id as string,
      name: (m.name || m.id) as string,
      supportedReasoningEfforts: (m.supportedReasoningEfforts || m.supported_reasoning_efforts) as string[] | undefined,
      policy: m.policy as { state: string } | undefined,
      contextWindow: ((m.capabilities as Record<string, unknown>)?.limits as Record<string, unknown>)?.max_context_window_tokens as number | undefined,
    }));
  } catch (err) {
    // 超时（abort）时抛更友好的错误信息
    if ((err as Error).name === 'AbortError') {
      throw new Error('Copilot models API timed out');
    }
    throw err;
  } finally {
    // 无论成功失败都清理定时器，避免 Node 进程因挂起的 timer 无法退出
    clearTimeout(timer);
  }
}

/** 需要排除的模型 ID 前缀——这些旧模型会污染模型选择器。 */
const EXCLUDED_MODEL_PREFIXES = ['gpt-4', 'gpt-3.5'];

/**
 * 过滤原始模型，只保留 policy 显式启用的，并剔除旧模型。
 *
 * @param models 从 Copilot API 拉到的原始模型列表
 * @returns 仅含 policy.state === 'enabled' 且未被前缀/弃用规则排除的模型
 */
function filterEnabledModels(models: RawCopilotModel[]): RawCopilotModel[] {
  return models.filter(m =>
    m.policy?.state === 'enabled'
    && !EXCLUDED_MODEL_PREFIXES.some(prefix => m.id.startsWith(prefix))
    && !isDeprecatedClaudeOpus46Model(m.id),
  );
}

/**
 * 把原始 Copilot 模型转换为本项目统一的 `ModelDefinition` 格式。
 *
 * @param models 过滤后的原始模型
 * @returns 用于配置 / UI 展示的 ModelDefinition 列表
 */
function toModelDefinitions(models: RawCopilotModel[]): ModelDefinition[] {
  return models.map(m => ({
    id: m.id,
    name: m.name,
    shortName: m.name,
    description: '',
    // `as const` 字面量断言：保证 provider 字段是 `'pi'` 字面量类型而非 string
    provider: 'pi' as const,
    // `200_000` 为数值字面量分隔符，等价于 200000；超时未给 contextWindow 时回退此值
    contextWindow: m.contextWindow || 200_000,
    supportsThinking: !!(m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0),
  }));
}

/**
 * 按 policy.state 分类统计模型数量，并打印日志，便于排查「为何某模型没出现」。
 *
 * @param tag    场景标签（如 tier1-httpApi）
 * @param models 待统计的原始模型
 */
function logModelBreakdown(tag: string, models: RawCopilotModel[]): void {
  const byState = new Map<string, string[]>();
  for (const m of models) {
    // `??` 为空值合并：左侧为 null/undefined 时取右侧值。这里把缺失 policy 的归为 'no-policy'。
    const state = m.policy?.state ?? 'no-policy';
    const list = byState.get(state) ?? [];
    list.push(m.id);
    byState.set(state, list);
  }
  const breakdown = [...byState.entries()].map(([s, ids]) => `${s}=${ids.length}(${ids.join(',')})`).join('; ');
  console.warn(`[fetchCopilotModels] ${tag}: total=${models.length} enabled=${filterEnabledModels(models).length} | ${breakdown}`);
}

/**
 * 拉取 Copilot 模型列表，带两层 fallback：
 *
 * 1. **直连 HTTP API** —— 用 Pi SDK 的 GitHub OAuth token 换取 Copilot API token，
 *    再 GET /models。返回带 policy state 的实时清单，只展示 enabled 的模型；
 *    不启 CLI 子进程，避免 PATH 与环境变量污染。
 * 2. **Pi SDK 静态目录** —— Pi SDK 内置的硬编码模型表。不受用户 policy 过滤，
 *    但作为最后兜底始终可用。
 */
async function fetchCopilotModels(
  piSdkGitHubToken: string,
  timeoutMs: number,
): Promise<ModelDefinition[]> {

  // ── 第一层：直连 HTTP API ──────────────────────────────────────
  try {
    const raw = await listModelsViaHttp(piSdkGitHubToken, timeoutMs);
    if (raw.length > 0) {
      logModelBreakdown('tier1-httpApi', raw);
      const enabled = filterEnabledModels(raw);
      if (enabled.length > 0) {
        return toModelDefinitions(enabled);
      }
      // 所有模型都被 policy 禁用——不常见但可能发生；记录日志后继续 fallback 到静态目录
      console.warn(`[fetchCopilotModels] tier1-httpApi: ${raw.length} models returned but 0 enabled by policy`);
    }
  } catch (err) {
    console.warn(`[fetchCopilotModels] tier1-httpApi failed: ${(err as Error).message}`);
  }

  // ── 第二层：Pi SDK 静态目录（兜底） ─────────────────────────────
  const staticModels = getPiModelsForAuthProvider('github-copilot');
  if (staticModels.length > 0) {
    console.warn(`[fetchCopilotModels] tier2-staticCatalog: falling back to ${staticModels.length} Pi SDK models`);
    return staticModels;
  }

  throw new Error('No Copilot models available from any source.');
}

/**
 * 对暴露 Anthropic-compatible messages 端点的 Pi provider 做轻量直连 HTTP 测试。
 * 避免拉起完整 Pi 子进程（SDK 初始化开销可能超过 20s 测试超时）。
 */
async function testAnthropicCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    });

    if (res.ok) return { success: true };

    const text = await res.text().catch(() => '');
    return { success: false, error: `${res.status} ${text}`.slice(0, 500) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, error: 'Connection test timed out' };
    }
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export const piDriver: ProviderDriver = {
  provider: 'pi',
  buildRuntime: ({ context, providerOptions, resolvedPaths }) => ({
    paths: {
      piServer: resolvedPaths.piServerPath,
      interceptor: resolvedPaths.interceptorBundlePath,
      node: resolvedPaths.nodeRuntimePath,
    },
    piAuthProvider: providerOptions?.piAuthProvider || context.connection?.piAuthProvider,
    baseUrl: context.connection?.baseUrl,
    customEndpoint: context.connection?.customEndpoint,
    customModels: context.connection?.models?.map(m => {
      if (typeof m === 'string') return m;
      const supportsImages = typeof m.supportsImages === 'boolean'
        ? m.supportsImages
        : undefined;
      if (m.contextWindow || supportsImages !== undefined) {
        return {
          id: m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(supportsImages !== undefined ? { supportsImages } : {}),
        };
      }
      return m.id;
    }),
  }),
  fetchModels: async ({ connection, credentials, timeoutMs }) => {
    // Copilot OAuth：通过 HTTP 直接从 Copilot API 拉模型。
    // 用 GitHub OAuth token（即我们的 refreshToken）换取 Copilot API token，
    // 再 GET /models 获取实时模型清单。
    const copilotGitHubToken = credentials.oauthRefreshToken || credentials.oauthAccessToken;
    if (connection.piAuthProvider === 'github-copilot' && copilotGitHubToken) {
      const models = await fetchCopilotModels(copilotGitHubToken, timeoutMs);
      return { models };
    }

    // 其它 Pi provider：使用 Pi SDK 内置的静态模型表
    const models = connection.piAuthProvider
      ? getPiModelsForAuthProvider(connection.piAuthProvider)
      : getAllPiModels();

    if (models.length === 0) {
      throw new Error(
        `No Pi models found for provider: ${connection.piAuthProvider ?? 'all'}`,
      );
    }

    return { models };
  },
  testConnection: async (args: DriverTestConnectionArgs): Promise<{ success: boolean; error?: string } | null> => {
    const piAuthProvider = args.connection?.piAuthProvider;
    if (!piAuthProvider) {
      // 没有 provider hint，回退到通用子进程测试路径
      return null;
    }

    // 从 Pi SDK 注册表解析模型的 API 类型。
    // 对 anthropic-messages 类型 provider，做轻量直连 HTTP 测试，
    // 避免拉起完整 Pi 子进程导致超时。
    let modelApi: string | undefined;
    let modelBaseUrl: string | undefined;
    try {
      const { getModels } = await import('@earendil-works/pi-ai/compat');
      const models = getModels(piAuthProvider as Parameters<typeof getModels>[0]);
      const requestedId = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
      const match = models.find(m => m.id === requestedId) || models[0];
      if (match) {
        modelApi = (match as { api?: string }).api;
        modelBaseUrl = (match as { baseUrl?: string }).baseUrl;
      }
    } catch { /* 忽略错误，继续走子进程路径 */ }

    if (modelApi !== 'anthropic-messages') {
      // 非 Anthropic API 类型需要完整 Pi SDK，交给 factory.ts 处理
      return null;
    }

    const baseUrl = args.baseUrl?.trim() || modelBaseUrl || getPiProviderBaseUrl(piAuthProvider);
    if (!baseUrl) {
      return { success: false, error: 'Could not determine API endpoint for provider' };
    }

    // 去掉 Pi SDK 的 'pi/' 前缀 —— Anthropic-compatible 端点只接受裸模型 ID
    let bareModel = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
    // MiniMax 国内 API 不接受模型名里的 'MiniMax-' 前缀
    if (piAuthProvider === 'minimax-cn' && bareModel.startsWith('MiniMax-')) {
      bareModel = bareModel.slice('MiniMax-'.length);
    }
    return testAnthropicCompatible(args.apiKey, baseUrl, bareModel, args.timeoutMs);
  },
  validateStoredConnection: async () => ({ success: true }),
};

// Anthropic 厂商 driver：封装对 Anthropic / Claude 官方 API 的连接校验、
// 模型列表拉取与运行时构建。实现 driver-types.ts 中的 ProviderDriver 接口。
//
// 概念提示（面向初学者）：
// - driver：单厂商的适配层，把上层统一接口翻译成该厂商 SDK / HTTP API 的具体调用。
// - session：一次与 Agent 的对话；这里 prepareRuntime 为拉起一个 Claude session 做环境准备。
// - tool use / MCP：Claude 模型可在对话中调用工具；MCP（Model Context Protocol）是工具/资源的标准协议。
import type { ProviderDriver } from '../driver-types.ts';
import { applyAnthropicRuntimeBootstrap } from '../runtime-resolver.ts';
import { validateAnthropicConnection } from '../../../../config/llm-validation.ts';
import { DEFAULT_MODEL, getModelById, getModelContextWindow, normalizeDeprecatedModelId } from '../../../../config/models.ts';

// anthropicDriver 是该 driver 的导出实例，实现 ProviderDriver 接口。
// `as const` 在 TS 中把对象字面量收窄为字面量类型，这里用于把 provider 字段
// 固定为 'anthropic' 字面量（而非宽泛的 string）。
export const anthropicDriver: ProviderDriver = {
  provider: 'anthropic',

  // 启动早期：尽量设置运行时路径（claude 可执行文件位置等），缺失也不抛错。
  // 真正的缺失会在会话启动（prepareRuntime）阶段才报错，避免应用启动卡住。
  // hostRuntime / resolvedPaths 通过解构从参数对象取出（TS 解构语法，类似 Go 的多返回值拆包）。
  initializeHostRuntime: ({ hostRuntime, resolvedPaths }) => {
    // 尽力设置路径，缺失不抛错；缺失项会在会话启动 prepareRuntime 阶段统一捕获。
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths, { strict: false });
  },

  // 会话启动前：严格设置运行时路径，找不到必需的 SDK 二进制会抛错。
  prepareRuntime: ({ hostRuntime, resolvedPaths }) => {
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths);
  },

  // Anthropic 直连后端不需要额外的子进程运行时载荷，返回空对象即可。
  // （Claude SDK 走原生二进制，不像 Pi 需要拉起 pi-agent-server 子进程。）
  buildRuntime: () => ({}),

  // 拉取该账号下可用的 Claude 模型列表。
  // 函数参数解构 { connection, credentials }：直接从 DriverFetchModelsArgs 取需要的字段。
  // 返回类型 Promise<ModelFetchResult> 表示这是一个异步函数（类比 Go 里返回 future / 用 channel 等待）。
  fetchModels: async ({ connection, credentials }) => {
    // 历史迁移后，只有直连 'anthropic' 的连接会进到这个 driver；
    // iam_credentials / service_account_file 已不再是 anthropic 的合法鉴权类型。

    const apiKey = credentials.apiKey;
    const oauthAccessToken = credentials.oauthAccessToken;

    // API Key 和 OAuth 令牌至少需要一个，否则无法调用 API。
    if (!apiKey && !oauthAccessToken) {
      throw new Error('Anthropic credentials required to fetch models');
    }

    // baseUrl 优先用连接自定义值，回退到官方端点。
    const baseUrl = connection.baseUrl || 'https://api.anthropic.com';
    // Record<string, string> 是 TS 内置工具类型，表示键值都为 string 的索引对象，
    // 类比 Go 的 map[string]string。下面按鉴权方式动态填充请求头。
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else {
      headers.authorization = `Bearer ${oauthAccessToken}`;
    }

    // 分页拉取所有原始模型。`Array<{...}>` 显式声明元素结构类型。
    const allRawModels: Array<{
      id: string;
      display_name: string;
      created_at: string;
      type: string;
    }> = [];
    let afterId: string | undefined;  // 游标式分页的起始 id

    do {
      // URLSearchParams 用于拼装查询字符串（limit=100&after_id=xxx）。
      const params = new URLSearchParams({ limit: '100' });
      if (afterId) params.set('after_id', afterId);

      const response = await fetch(`${baseUrl}/v1/models?${params}`, { headers });
      if (!response.ok) {
        throw new Error(`Anthropic /v1/models failed: ${response.status} ${response.statusText}`);
      }

      // `as { ... }` 是类型断言：fetch 返回 unknown，这里断言成已知结构。
      // 注意 TS 运行时不做校验，结构错误只能在后续访问字段时暴露。
      const data = await response.json() as {
        data: Array<{ id: string; display_name: string; created_at: string; type: string }>;
        has_more: boolean;
        first_id: string;
        last_id: string;
      };
      // `...data.data` 是数组展开（spread），把每页元素追加进累积数组。
      if (data.data) allRawModels.push(...data.data);

      // 还有更多页：用最后一条 id 作为下一页游标；否则退出循环。
      if (data.has_more && data.last_id) {
        afterId = data.last_id;
      } else {
        break;
      }
    } while (true);  // do/while(true) 循环，靠内部 break 退出。

    if (allRawModels.length === 0) {
      throw new Error('No models returned from Anthropic API');
    }

    // 用 Set 做去重，类比 Go 里用 map[string]struct{} 去重。
    const seen = new Set<string>();
    const models = allRawModels
      // 第一道过滤：只保留 claude- 前缀，排除 claude-2 / claude-instant / claude-1 等旧模型。
      .filter(m => m.id.startsWith('claude-') && !m.id.startsWith('claude-2') && !m.id.startsWith('claude-instant') && !m.id.startsWith('claude-1'))
      // 线上 Anthropic API 仍可能列出已废弃模型；启动时不要把它们回写到活跃的连接目录。
      // 第二道过滤：剔除已废弃模型 id（normalizeDeprecatedModelId 把废弃 id 映射到新 id，
      // 若映射后与原 id 不同则说明它是废弃别名，过滤掉避免回写进连接目录）。
      .filter(m => normalizeDeprecatedModelId(m.id) === m.id)
      // 第三道过滤：去重。
      .filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      // 映射为前端使用的 ModelDefinition 结构。
      .map(m => {
        // 先查本地注册表（带有人工维护的 name/shortName/description/能力标记）。
        const registryModel = getModelById(m.id);
        return {
          id: m.id,
          // `?.` 是可选链：registryModel 可能为 undefined，安全访问其字段，遇到 undefined 短路返回 undefined。
          // `??` 是空值合并：左侧为 null/undefined 时取右侧默认值。
          name: registryModel?.name ?? m.display_name,
          shortName: registryModel?.shortName ?? (() => {
            // shortName 兜底逻辑：从模型 id 中剥离日期快照、版本号、latest 后缀等，得到简短展示名。
            const stripped = m.id
              .replace('claude-', '')
              .replace(/-\d{8}$/, '')        // 去掉形如 -20250101 的日期快照
              .replace(/-latest$/, '');       // 去掉 -latest 后缀
            const variant = stripped
              .replace(/^[\d.-]+/, '')        // 去掉开头版本号
              .replace(/-[\d.]+$/, '')        // 去掉结尾版本号
              .replace(/^-/, '');             // 去掉可能残留的前导 -
            // charAt(0).toUpperCase() 把首字母大写；返回 variant 或回退 stripped。
            return variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : stripped;
          })(),
          description: registryModel?.description ?? '',
          descriptionKey: registryModel?.descriptionKey,
          // `as const` 断言 provider 为字面量类型 'anthropic'，匹配 ModelDefinition 的联合类型定义。
          provider: 'anthropic' as const,
          // 上下文窗口优先用注册表值，否则回退默认 200_000（200K，TS 数字分隔符增强可读性）。
          contextWindow: getModelContextWindow(m.id) ?? 200_000,
          supportsThinking: registryModel?.supportsThinking,
          supportsImages: registryModel?.supportsImages,
        };
      });

    return {
      models,
      // 默认模型：优先用全局 DEFAULT_MODEL（若存在于拉取结果中），否则取第一个。
      serverDefault: models.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id,
    };
  },

  // 校验启动时已持久化的连接是否仍可用。返回 {success, error?}。
  validateStoredConnection: async ({ slug, connection, credentialManager }) => {
    // 历史迁移后，只有直连 'anthropic' 的连接会进入此 driver。

    // OAuth 类型连接：校验 access token 是否仍有效。
    if (connection.providerType === 'anthropic' && connection.authType === 'oauth') {
      // 动态 import：避免在模块顶层硬依赖 auth/state，减小冷启动开销（类比 Go 的延迟加载插件）。
      const { getValidClaudeOAuthToken } = await import('../../../../auth/state.ts');
      const tokenResult = await getValidClaudeOAuthToken(slug);
      if (!tokenResult.accessToken) {
        // token 失效，返回需要重新登录的错误信息（优先用迁移提示）。
        const errorMsg = tokenResult.migrationRequired?.message || 'OAuth token expired. Please re-authenticate.';
        return { success: false, error: errorMsg };
      }
      return { success: true };
    }

    // 非 OAuth：根据 authType 从凭证管理器或环境变量取出凭据。
    let apiKey: string | null = null;
    let oauthToken: string | null = null;

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint') {
      apiKey = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'bearer_token') {
      oauthToken = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'environment') {
      // 从环境变量取 key。
      apiKey = process.env.ANTHROPIC_API_KEY || null;
      if (!apiKey) {
        return { success: false, error: 'ANTHROPIC_API_KEY environment variable not set' };
      }
    } else if (connection.authType === 'none') {
      // 'none' 类型（如本地 ollama 兼容端点）用一个占位 key。
      apiKey = 'ollama';
    }

    // 既没 api key 也没 oauth token 且不是 'none' 类型 → 取不到凭据，判失败。
    if (!apiKey && !oauthToken && connection.authType !== 'none') {
      return { success: false, error: 'Could not retrieve credentials' };
    }

    // `!` 非空断言：告诉 TS 这里 defaultModel 一定存在（由上层保证）。
    const testModel = connection.defaultModel!;
    // 实际发起一次最小请求做连通性 + 鉴权验证。
    const validationResult = await validateAnthropicConnection({
      model: testModel,
      apiKey: apiKey || undefined,
      oauthToken: oauthToken || undefined,
      baseUrl: connection.baseUrl || undefined,
    });

    if (!validationResult.success) {
      return { success: false, error: validationResult.error };
    }

    return { success: true };
  },
};

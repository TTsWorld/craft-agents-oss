/**
 * LLM Connections
 *
 * 用户可添加、配置、切换的命名提供商配置。
 * 每个 session 在第一条消息后会锁定到一个具体连接；
 * workspace 可以设置默认连接。
 */

// 从集中式注册表导入模型类型和列表
// 注意：Pi SDK 函数（getPiModelsForAuthProvider、getAllPiModels）不在这里导入，
// 因为 @earendil-works/pi-ai 会间接引入 @aws-sdk，后者使用 Node.js `stream` 模块，
// 会破坏 Vite 渲染进程构建。Pi 模型解析改为在应用启动时通过 registerPiModelResolver() 注入。
import {
  type ModelDefinition,
  ANTHROPIC_MODELS,
  normalizeDeprecatedModelId,
} from './models';
import type { CredentialManager } from '../credentials/manager.ts';

// ============================================================
// Pi 模型解析器（依赖注入，避免 Pi SDK 进入 renderer）
// ============================================================

/** Pi 模型解析函数类型：给定 piAuthProvider 返回模型列表 */
type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let _piModelResolver: PiModelResolver = () => [];

/**
 * 注册 Pi 模型解析函数。
 * 必须在主进程应用启动、任何 Pi 连接被使用前调用。
 * 这样 renderer bundle 就不会把 @earendil-works/pi-ai 打包进去。
 */
export function registerPiModelResolver(resolver: PiModelResolver): void {
  _piModelResolver = resolver;
}

// ============================================================
// 类型定义
// ============================================================

/**
 * 提供商类型：决定使用哪个后端/SDK 实现。
 * 与认证方式是正交的：同一个 provider 可以支持多种 authType。
 *
 * - 'anthropic'：直连 Anthropic API（api.anthropic.com），使用 Claude Agent SDK
 * - 'pi'：Pi 统一 LLM API（通过 @earendil-works/pi-ai 支持 20+ 提供商）
 * - 'pi_compat'：Pi 自定义端点（Ollama、自托管模型、Anthropic 兼容端点）
 *
 * 旧值（bedrock、vertex、anthropic_compat）会在启动时由 storage.ts 里的
 * migrateLegacyProviderTypes() 迁移。
 */
export type LlmProviderType =
  | 'anthropic'
  | 'pi'
  | 'pi_compat';

/**
 * @deprecated 请改用 LlmProviderType。保留仅用于迁移兼容。
 */
export type LlmConnectionType = 'anthropic' | 'openai' | 'openai-compat';

/**
 * 连接的认证机制。
 * 决定 UI 展示形式、凭据存储格式以及运行时如何把凭据传给 SDK。
 *
 * 简单 token 认证：
 * - 'api_key'：单个 API key，端点固定已知
 * - 'api_key_with_endpoint'：API key + 自定义端点 URL
 * - 'bearer_token'：单个 bearer token（header 与 API key 不同）
 *
 * OAuth 流程（浏览器跳转）：
 * - 'oauth'：浏览器 OAuth 流程，provider 由 providerType 决定
 *
 * 云厂商认证：
 * - 'iam_credentials'：AWS 风格（Access Key + Secret Key + Region）
 * - 'service_account_file'：GCP 风格 JSON 文件上传
 * - 'environment'：从环境变量自动检测
 *
 * 无需认证：
 * - 'none'：本地模型如 Ollama 不需要认证
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

/**
 * 连接模型列表的“所有权”模式。
 * - automaticallySyncedFromProvider：自动与提供商默认列表同步
 * - userDefined3Tier：保留用户自选的 Best/Balanced/Fast 三档列表
 */
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

/**
 * 自定义 API 端点的协议。
 * 决定 Pi SDK 使用哪种流式适配器发请求。
 */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/**
 * 自定义端点协议配置。
 * 当用户配置任意 API 端点（Ollama、DashScope、vLLM 等）时设置。
 */
export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  /** 针对任意端点的显式图片能力提示，永远不会自动猜测 */
  supportsImages?: boolean;
}

/**
 * 当用户在前一轮 Agent 仍在流式输出/处理时发送新消息的行为策略。
 *
 * - 'steer'：尝试把消息送入当前正在执行的 turn（Pi 原生 `.steer()`
 *   或 Claude 的 PreToolUse `additionalContext` hook）。后端不支持时回退到 abort+queue。
 * - 'queue'： holding 消息，等当前 turn 自然结束后再作为新 turn 重放。
 *   不会中止，也不会破坏性打断。
 *
 * 默认值按 providerType 走 {@link defaultMidStreamBehavior}；
 * 所有读取都应通过 {@link resolveMidStreamBehavior}，
 * 以保证该字段出现之前创建的连接也能拿到正确的默认值。
 */
export type MidStreamBehavior = 'steer' | 'queue';

/**
 * LLM 连接配置。
 * 存储在 config.llmConnections 数组中。
 */
export interface LlmConnection {
  /** URL 安全标识符，如 'anthropic-api'、'ollama-local' */
  slug: string;

  /** UI 展示名，如 'Anthropic (API Key)'、'Ollama' */
  name: string;

  /** 提供商类型，决定后端/SDK 实现 */
  providerType: LlmProviderType;

  /**
   * @deprecated 请改用 providerType。保留仅用于迁移兼容。
   */
  type?: LlmConnectionType;

  /** 自定义 base URL（*_compat 必填，其他可选覆盖） */
  baseUrl?: string;

  /** 认证机制 */
  authType: LlmAuthType;

  /** 覆盖可用模型（用于不支持模型列表的自定义端点） */
  models?: Array<ModelDefinition | string>;

  /** 该连接的默认模型 */
  defaultModel?: string;

  /**
   * 模型列表所有权模式。
   * - automaticallySyncedFromProvider：保持与提供商默认列表同步
   * - userDefined3Tier：保留用户自选的 Best/Balanced/Fast 列表
   */
  modelSelectionMode?: ModelSelectionMode;

  /**
   * Pi auth provider 名称，如 'anthropic'、'openai'、'github-copilot'。
   * 决定 Pi SDK 用哪个提供商的凭据发起 LLM 调用。
   * 仅对 providerType='pi' 的连接有意义。
   */
  piAuthProvider?: string;

  /**
   * 自定义端点协议配置。
   * 当用户配置任意 API 端点（Ollama、DashScope、vLLM 等）时设置，
   * 决定 Pi SDK 使用哪种流式适配器。
   */
  customEndpoint?: CustomEndpointConfig;

  /**
   * 用户在中途发送新消息时的行为策略。
   * 可选，用于兼容该字段出现之前创建的 config.json ——
   * 读取时通过 {@link resolveMidStreamBehavior} 回退到按提供商的默认值
   * （{@link defaultMidStreamBehavior}）。
   */
  midStreamBehavior?: MidStreamBehavior;

  // --- 解析后的 Anthropic OAuth 身份（issue #838） ---
  // 从 token exchange 响应中捕获；用于 UI 标记两个 Claude 连接是否指向同一账号。
  // 全部可选且 fail-soft：没有身份时不展示任何内容。
  oauthAccountUuid?: string;
  oauthAccountEmail?: string;
  oauthOrganizationUuid?: string;
  oauthOrganizationName?: string;
  oauthProfileVerifiedAt?: number; // epoch 毫秒

  // --- 时间戳 ---

  /** 连接创建时间 */
  createdAt: number;

  /** 连接最后使用时间 */
  lastUsedAt?: number;
}

/**
 * 带认证状态的 LLM 连接。
 * UI 用它展示哪些连接已就绪可用。
 */
export interface LlmConnectionWithStatus extends LlmConnection {
  /** 是否已有有效凭据 */
  isAuthenticated: boolean;

  /** 认证检查失败时的错误信息 */
  authError?: string;

  /** 是否为全局默认连接 */
  isDefault?: boolean;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 判断给定 modelId 在当前认证 flavor 下是否不能用作 mini/摘要模型。
 *
 * - `codex-mini-latest` 始终禁止（Pi SDK  outright 拒绝）。
 * - 当 `piAuthProvider === 'openai-codex'` 时（ChatGPT Plus/Pro OAuth 或
 *   ChatGPT-JWT API key），所有 `*codex-mini*` 变体（如 `gpt-5.1-codex-mini`）
 *   都被禁止 —— ChatGPT 后端会报："The '<model>' model is not supported when using Codex with a ChatGPT account."。
 *   普通 OpenAI API key 使用 provider 'openai'，不受影响。
 */
export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (bare === 'codex-mini-latest') return true;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return false;
}

/**
 * 获取某个连接的 mini/轻量模型 ID。
 * 按提供商搜索：
 *   - Anthropic：找 id/name 里含 "haiku" 的模型
 *   - Pi：找 id/name 里含 "mini" 或 "flash" 的模型
 *   - 其他：返回列表最后一个模型
 *
 * 还会根据 piAuthProvider 跳过会被拒绝的模型（如 ChatGPT 账号下的 codex-mini）。
 *
 * 用于 mini agent、标题生成、mini completion 等轻量场景。
 */
export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * 获取某个连接的摘要模型 ID。
 * 搜索逻辑与 getMiniModel() 相同，但独立出来，
 * 以便摘要和 mini agent 的模型可以分别演进。
 *
 * 用于响应摘要、API tool 摘要等场景。
 */
export function getSummarizationModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * 按提供商解析“小模型”的共享实现。
 * 供 getMiniModel() 和 getSummarizationModel() 使用。
 *
 *   - Anthropic：找 "haiku"
 *   - Pi：找 "mini" 或 "flash"
 *   - 其他：返回列表最后一个模型
 *
 * 会跳过被 {@link isDeniedMiniModelId} 禁止的模型。
 */
function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isAllowedModel = (m: ModelDefinition | string): boolean =>
    !isDeniedMiniModelId(toId(m), connection.piAuthProvider);

  // 按提供商选择关键词
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    keywords.push('mini', 'flash');
  } else {
    // 聚合类 provider（copilot 等）尝试所有常见小模型关键词
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    const match = connection.models.find(m => {
      if (!isAllowedModel(m)) return false;
      const searchStr = toSearchStr(m);
      return keywords.some(k => searchStr.includes(k));
    });
    if (match) {
      return toId(match);
    }
  }

  // 兜底：从后往前找第一个被允许的模型；实在不行返回最后一个
  const fallback = [...connection.models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : toId(connection.models[connection.models.length - 1]!);
}

/**
 * 从展示名生成 URL 安全的 slug。
 * @param name - 要转换的展示名
 * @returns URL 安全 slug
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * 检查 slug 是否合法（URL 安全、非空）。
 * @param slug - 要检查的 slug
 * @returns 合法返回 true
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

/**
 * 获取 LLM 连接的凭据 key。
 * 格式：llm::{slug}::{credentialType}
 *
 * @param slug - 连接 slug
 * @param credentialType - 凭据类型（'api_key' 或 'oauth_token'）
 * @returns 凭据 key 字符串
 */
export function getLlmCredentialKey(slug: string, credentialType: 'api_key' | 'oauth_token'): string {
  return `llm::${slug}::${credentialType}`;
}

/**
 * 各认证机制对应的凭据存储类型。
 */
export type LlmCredentialStorageType =
  | 'api_key'           // 单 token 直接存值
  | 'oauth_token'       // OAuth token（access、refresh、expiry）
  | 'iam_credentials'   // AWS 风格（accessKeyId、secretAccessKey、region）
  | 'service_account'   // JSON 文件内容
  | null;               // 不需要存储（environment 或 none）

/**
 * 把 LlmAuthType 映射为凭据存储类型。
 * 决定 credential manager 如何存储凭据。
 *
 * @param authType - LLM 认证类型
 * @returns 凭据存储类型；不需要存储时返回 null
 */
export function authTypeToCredentialStorageType(authType: LlmAuthType): LlmCredentialStorageType {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
      return 'api_key';
    case 'oauth':
      return 'oauth_token';
    case 'iam_credentials':
      return 'iam_credentials';
    case 'service_account_file':
      return 'service_account';
    case 'environment':
    case 'none':
      return null;
  }
}

/**
 * @deprecated 请改用 authTypeToCredentialStorageType。
 * 迁移期间保留向后兼容。
 */
export function authTypeToCredentialType(authType: LlmAuthType): 'api_key' | 'oauth_token' | null {
  const storageType = authTypeToCredentialStorageType(authType);
  if (storageType === 'api_key' || storageType === 'oauth_token') {
    return storageType;
  }
  return null;
}

/**
 * 判断某种认证类型是否需要自定义端点 URL。
 * @param authType - LLM 认证类型
 * @returns 若需要显示端点 URL 输入框则返回 true
 */
export function authTypeRequiresEndpoint(authType: LlmAuthType): boolean {
  return authType === 'api_key_with_endpoint';
}

/**
 * 判断是否为 "compat" 提供商。
 * Compat 提供商使用自定义端点，需要显式配置模型列表。
 * @param providerType - 提供商类型
 * @returns 是 pi_compat 时返回 true
 */
export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi_compat';
}

/**
 * 判断提供商类型是否使用 Anthropic Claude Agent SDK。
 * 只有直连 Anthropic API 的连接才使用 Claude SDK。
 * @param providerType - 提供商类型
 * @returns 使用 Anthropic SDK 返回 true
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic';
}

/**
 * 判断连接是否指向本地模型运行时（环回地址）。
 */
export function isLocalConnection(conn: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!conn.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(conn.baseUrl.trim()).hostname;
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * 判断提供商类型是否使用 Pi 统一 API。
 * @param providerType - 提供商类型
 * @returns 使用 Pi 返回 true
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * 给定提供商类型的默认“中途发送”行为。
 *
 * - 'anthropic' → 'queue'：Claude 模拟 steer（PreToolUse hook 注入）有真实失败场景 ——
 *   如果 turn 结束前没有 tool 触发，steer 会变成 `steer_undelivered` 并被重新排队，
 *   白付原 turn 的 token。默认 queue 更可预测。
 * - 'pi' / 'pi_compat' → 'steer'：Pi 原生 `.steer()` 是非破坏性的
 *   （在当前 tool 完成后投递，保留完整上下文），默认 steer 没有明显副作用。
 */
export function defaultMidStreamBehavior(providerType: LlmProviderType): MidStreamBehavior {
  return providerType === 'anthropic' ? 'queue' : 'steer';
}

/**
 * 读取连接实际生效的 mid-stream 行为策略。
 *
 * 这是单一事实来源 —— 所有需要决定 steer 还是 queue 的调用方都应走这里，
 * 这样 legacy 连接（该字段出现前创建）以及异常值都能回退到按提供商的默认值。
 */
export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  if (connection.midStreamBehavior === 'steer' || connection.midStreamBehavior === 'queue') {
    return connection.midStreamBehavior;
  }
  return defaultMidStreamBehavior(connection.providerType);
}

/**
 * 返回一个新 LlmConnection，把指定模型的 `supportsImages` 覆盖值设置好。
 *
 * 集中处理 `connection.models[]` 里 string 与 object 的混合格式：
 *   - string 条目 → 提升为 `{ id, name, shortName, supportsImages: enabled }`
 *   - object 条目 → 只更新 supportsImages
 *   - 模型不在列表中 → 原样返回连接（防御性）
 *
 * 纯函数，不修改输入。上游通过 `saveLlmConnection` 做持久化。
 * 自定义端点模型的 object 形式为 `{ id, name?, shortName?, contextWindow?, supportsImages? }`
 *（由 storage schema 透传校验）。name/shortName 提升时默认等于 id，
 * 这样下游 renderer 读取 `m.name` 时仍能看到标签。
 */
export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): LlmConnection {
  if (!connection.models) return connection;
  const idOf = (m: ModelDefinition | string) => (typeof m === 'string' ? m : m.id);
  const idx = connection.models.findIndex(m => idOf(m) === modelId);
  if (idx === -1) return connection;

  const entry = connection.models[idx]!;
  const nextEntry =
    typeof entry === 'string'
      ? { id: entry, name: entry, shortName: entry, supportsImages: enabled }
      : { ...entry, supportsImages: enabled };

  const nextModels = connection.models.slice();
  nextModels[idx] = nextEntry as ModelDefinition;
  return { ...connection, models: nextModels };
}

/**
 * 判断连接上某个模型是否接受图片输入。
 *
 * 对于 `pi_compat`（自定义端点）连接，逻辑与 Pi 的 `buildCustomEndpointModelDef` 一致：
 *   单模型 `supportsImages` 覆盖
 *   ?? 连接级 `customEndpoint.supportsImages` 默认值
 *   ?? false
 *
 * 非 `pi_compat` 连接 renderer 不拥有 catalog —— Pi SDK 内置 provider 定义和 Anthropic API
 * 自行决定。这里保守返回 true（让上游决定）。
 */
export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  if (!isCompatProvider(connection.providerType)) return true;

  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  if (entry && typeof entry !== 'string' && typeof entry.supportsImages === 'boolean') {
    return entry.supportsImages;
  }
  return connection.customEndpoint?.supportsImages ?? false;
}

/**
 * 从注册表获取某提供商类型的默认模型列表。
 * 对 *_compat 提供商返回空数组 —— 它们应使用 connection.models。
 *
 * @param providerType - 提供商类型
 * @param piAuthProvider - Pi 场景下可选的 auth provider，用于过滤 Pi 模型
 * @returns 注册表中的模型列表；compat 返回空数组
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat 提供商要求从连接里显式配置模型列表
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Pi：通过注册好的解析器获取模型（避免在 renderer 中导入 Pi SDK）
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  // Anthropic 使用裸 Anthropic ID 的 Claude 模型
  return ANTHROPIC_MODELS;
}

/**
 * 获取某个连接提供商类型的默认模型列表。
 * 与 getModelsForProviderType() 不同：compat 返回带 `pi/` 前缀的模型 ID 而非空数组。
 *
 * 在需要填充或回填连接 models 时使用这里。
 *
 * @param providerType - 连接中的提供商类型
 * @param piAuthProvider - 可选的 Pi auth provider，用于过滤 Pi 模型
 * @returns 标准 provider 返回 ModelDefinition[]，compat 返回 string[]
 */
/**
 * 各 Pi auth provider 的优先默认模型 ID。
 * Pi SDK 返回的模型顺序是任意的（按 ID 字母排序），可能导致旧模型排在前面。
 * 这张表保证 getDefaultModelForConnection() 选到现代、稳定的模型。
 *
 * 格式：裸模型 ID（不带 pi/ 前缀）。匹配 pi/{id} 或 pi/{id}-*。
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  'openai-codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // 优先稳定模型，让连接设置测试（使用 getDefaultModelForConnection）落在可靠模型上。
  // gemini-3-pro-preview 和 gemini-3.1-pro-preview 在 2026 年 4 月实测对 generateContent
  // 间歇无响应，因此故意排除在默认值之外。
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'github-copilot': ['claude-sonnet-4-6', 'gpt-5', 'o4-mini', 'claude-haiku-4-5'],
  'amazon-bedrock': ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider);
    // 把优先默认模型排在前面，让 getDefaultModelForConnection 选到现代模型。
    // Bedrock 返回的 ID 形如 pi/us.anthropic.claude-opus-4-8，
    // 而优先表是裸 ID，因此需要同时按直接匹配和 Bedrock 反向映射来比较。
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      const findPreferredIndex = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        // 先直接匹配（非 Bedrock provider 适用）
        const direct = preferred.findIndex(p => bare === p || bare.startsWith(`${p}-`))
        if (direct >= 0) return direct
        // Bedrock：反向映射原生 ID 到裸 ID 再匹配
        const reversed = fromBedrockNativeId(bare)
        if (reversed !== bare) {
          return preferred.findIndex(p => reversed === p || reversed.startsWith(`${p}-`))
        }
        return -1
      }
      models.sort((a, b) => {
        const aPrio = findPreferredIndex(a.id) ?? preferred.length;
        const bPrio = findPreferredIndex(b.id) ?? preferred.length;
        return (aPrio >= 0 ? aPrio : preferred.length) - (bPrio >= 0 ? bPrio : preferred.length);
      });
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // 动态 — 用户自己指定
  // anthropic
  return ANTHROPIC_MODELS;
}

/**
 * 获取连接提供商类型的默认模型 ID。
 * 派生自 getDefaultModelsForConnection() 的第一项 —— 单一事实来源。
 *
 * @param providerType - 连接中的提供商类型
 * @param piAuthProvider - 可选的 Pi auth provider
 * @returns 默认模型 ID 字符串
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // 动态 provider — 无默认
  return typeof first === 'string' ? first : first.id;
}

/**
 * 从可用回退中解析实际生效的 LLM 连接 slug。
 *
 * UI 各处使用的统一回退链：
 *   1. session 显式指定的连接（第一条消息后锁定）
 *   2. workspace 级默认覆盖
 *   3. 全局默认（isDefault 标记的连接）
 *   4. 第一个可用连接
 *
 * @param sessionConnection  - session 级别连接 slug（session.llmConnection）
 * @param workspaceDefault   - workspace 级别默认连接 slug
 * @param connections        - 所有可用连接（带状态元数据）
 * @returns 解析出的 slug；没有连接时返回 undefined
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(c => c.isDefault)?.slug
    ?? connections[0]?.slug
}

/**
 * 检查 session 锁定的连接是否已不可用（被删除或移除）。
 * 仅当 session 显式设置了 llmConnection 且该连接不在当前列表中时才返回 true。
 * 没有显式连接的 session（走回退链）不算“不可用”。
 *
 * @param sessionConnection - session 级别连接 slug
 * @param connections - 所有可用连接
 * @returns session 连接已不存在时返回 true
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  return !connections.some(c => c.slug === sessionConnection)
}

/**
 * 判断认证类型是否使用浏览器 OAuth 流程。
 * @param authType - LLM 认证类型
 * @returns 应触发浏览器 OAuth 时返回 true
 */
export function authTypeIsOAuth(authType: LlmAuthType): boolean {
  return authType === 'oauth';
}

/**
 * 判断某 provider 是否支持给定的 auth type。
 * 返回类型系统内的有效组合。
 *
 * @param providerType - 提供商类型
 * @param authType - 要检查的认证类型
 * @returns 是有效组合时返回 true
 */
export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType
): boolean {
  const validCombinations: Record<LlmProviderType, LlmAuthType[]> = {
    anthropic: ['api_key', 'oauth'],
    pi: ['api_key', 'oauth', 'iam_credentials', 'environment', 'none'],
    pi_compat: ['api_key_with_endpoint', 'none'],
  };

  return validCombinations[providerType]?.includes(authType) ?? false;
}

/**
 * 裸 Anthropic 模型 ID → Bedrock 跨区域 inference profile ID。
 * 使用 US inference profiles（us.*）— 新 Claude 模型需要按需吞吐量时必须用。
 * 直接用 model ID（anthropic.claude-*）会被 Bedrock 拒绝并提示
 * "Retry your request with the ID or ARN of an inference profile"。
 *
 * 来源：Pi SDK registry（models.generated.js）的 us.* 变体。
 */
const BEDROCK_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'claude-fable-5': 'us.anthropic.claude-fable-5',
  'claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // 旧模型（用于迁移已有连接）
  'claude-opus-4-5-20251101': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  // 基础 ID（无 region 前缀）也映射到 US inference profile
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'anthropic.claude-fable-5': 'us.anthropic.claude-fable-5',
  'anthropic.claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
}

/** 反向映射：已知 Bedrock ID 变体 → 裸 Anthropic ID */
const BEDROCK_REVERSE_MAP: Record<string, string> = {
  // US inference profiles
  'us.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'us.anthropic.claude-fable-5': 'claude-fable-5',
  'us.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profiles
  'eu.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'eu.anthropic.claude-fable-5': 'claude-fable-5',
  'eu.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profiles
  'global.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'global.anthropic.claude-fable-5': 'claude-fable-5',
  'global.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  // 无 region 前缀的基础 ID
  'anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'anthropic.claude-fable-5': 'claude-fable-5',
  'anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
}

/**
 * 从 AWS region 推导 Bedrock inference profile 的 region 前缀。
 * 返回 'us'、'eu'，或其他 region 默认回退 'us'。
 */
export function deriveBedrockRegionPrefix(awsRegion?: string): string {
  if (!awsRegion) return 'us'
  if (awsRegion.startsWith('eu-')) return 'eu'
  // US region 及其他（ap-*、me-* 等）使用 US inference profiles
  return 'us'
}

/**
 * 把裸 Anthropic 模型 ID 映射为 Bedrock 原生 ID。
 * 使用给定 region 前缀（默认 'us'）生成 inference profile ID。
 * 已是原生或未知 ID 则原样通过。
 */
export function toBedrockNativeId(modelId: string, regionPrefix?: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  const nativeId = BEDROCK_MODEL_MAP[normalizedModelId]
  if (!nativeId) return normalizedModelId
  if (!regionPrefix || regionPrefix === 'us') return nativeId
  // BEDROCK_MODEL_MAP 存的是 us.* 变体，需要替换 region 前缀
  return nativeId.replace(/^us\./, `${regionPrefix}.`)
}

/** 把 Bedrock 原生模型 ID 反向映射为裸 Anthropic ID。已是裸 ID 或未知则原样通过。 */
export function fromBedrockNativeId(modelId: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  return BEDROCK_REVERSE_MAP[normalizedModelId] ?? normalizedModelId
}

/**
 * 为 Bedrock 存储/使用规范化模型 ID。
 * 去掉 pi/ 前缀，并把裸 Anthropic ID 映射为 Bedrock 原生格式。
 * 幂等：已是原生 ID 时原样通过。
 */
export function normalizeBedrockModelId(
  modelId: string | undefined,
  regionPrefix?: string,
): string {
  if (!modelId) return '';
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId
  return toBedrockNativeId(bare, regionPrefix)
}

// ============================================================
// 迁移辅助函数
// ============================================================

/**
 * 把旧版连接类型迁移为新的 provider type。
 * 配置迁移期间使用。
 *
 * @param legacyType - 旧 LlmConnectionType 值
 * @returns 新 LlmProviderType 值
 */
export function migrateConnectionType(legacyType: LlmConnectionType): LlmProviderType {
  switch (legacyType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'pi';
    case 'openai-compat':
      return 'pi_compat';
  }
}

/**
 * 把旧版认证类型迁移为新的 auth type。
 * 根据旧类型和是否有自定义端点决定新类型。
 *
 * @param legacyAuthType - 旧认证类型（'api_key' | 'oauth' | 'none'）
 * @param hasCustomEndpoint - 连接是否有自定义 baseUrl
 * @returns 新 LlmAuthType 值
 */
export function migrateAuthType(
  legacyAuthType: 'api_key' | 'oauth' | 'none',
  hasCustomEndpoint: boolean
): LlmAuthType {
  switch (legacyAuthType) {
    case 'api_key':
      // 有自定义端点时升级为 api_key_with_endpoint
      return hasCustomEndpoint ? 'api_key_with_endpoint' : 'api_key';
    case 'oauth':
      return 'oauth';
    case 'none':
      return 'none';
  }
}

// ============================================================
// 认证环境变量解析
// ============================================================

const CLAUDE_BEDROCK_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const

const CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET = new Set<string>(
  CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

/**
 * 清空会触发 Claude Bedrock 路由的环境变量。
 * 用于避免直连 Anthropic 连接被意外路由到 Bedrock。
 */
export function clearClaudeBedrockRoutingEnvVars(
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  for (const key of CLAUDE_BEDROCK_ROUTING_ENV_KEYS) {
    delete targetEnv[key]
  }
}

/**
 * 把受管理的 Anthropic 认证环境变量重置为进程启动时的基线值。
 * 用于切换连接后清理上一个连接的残留环境变量。
 */
export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * 解析 LLM 连接认证环境变量的结果。
 */
export interface ResolvedAuthEnvVars {
  /** 要设置的环境变量，如 ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN */
  envVars: Record<string, string>;
  /** 是否成功解析到凭据 */
  success: boolean;
  /** 解析过程中遇到的警告信息 */
  warning?: string;
}

/**
 * 为 LLM 连接解析认证所需的环境变量。
 *
 * 与具体提供商无关：根据 providerType 决定设置哪些 env var、如何获取凭据。
 * 被以下地方共享：
 * - `SessionManager.reinitializeAuth()`（应用到 process.env）
 * - `ClaudeAgent.postInit()`（应用到 process.env + envOverrides）
 *
 * 内部自行处理 auth 的提供商（openai、copilot、pi）返回空 envVars ——
 * 它们的 auth 在 postInit() 里通过原生机制管理。
 *
 * @param connection - LLM 连接配置
 * @param connectionSlug - 连接 slug，用于凭据查找
 * @param credentialManager - 凭据管理器实例
 * @param getValidOAuthToken - 获取有效（已刷新）OAuth token 的函数
 * @returns 解析后的环境变量和状态
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
  getValidOAuthToken: (slug: string) => Promise<{ accessToken?: string | null }>,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // 只有基于 Anthropic SDK 的提供商才用环境变量认证
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  // 设置自定义 base URL
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // 无 key 的本地提供商（如 Ollama）
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    if (connection.providerType === 'anthropic') {
      // Anthropic OAuth 使用 getValidClaudeOAuthToken，内部处理 token 刷新
      const tokenResult = await getValidOAuthToken(connectionSlug);
      if (tokenResult.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = tokenResult.accessToken;
      } else {
        return { envVars, success: false, warning: `Failed to get OAuth token for: ${connectionSlug}` };
      }
    } else {
      // 旧版迁移后的 fallback OAuth 路径（正常运行不应走到这里）
      const llmOAuth = await credentialManager.getLlmOAuth(connectionSlug);
      if (llmOAuth?.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken;
      } else {
        return { envVars, success: false, warning: `No OAuth token found for: ${connectionSlug}` };
      }
    }
  } else if (authType === 'environment') {
    // 环境变量认证：凭据来自 process.env，无需注入
    return { envVars, success: true };
  }

  return { envVars, success: true };
}

/**
 * 把旧版 LlmConnection 迁移为新格式。
 * 创建带有 providerType 的新连接对象。
 *
 * @param legacy - 带 'type' 字段的旧连接
 * @returns 带 'providerType' 字段的新连接
 */
export function migrateLlmConnection(legacy: {
  slug: string;
  name: string;
  type: LlmConnectionType;
  baseUrl?: string;
  authType: 'api_key' | 'oauth' | 'none';
  models?: ModelDefinition[];
  defaultModel?: string;
  createdAt: number;
  lastUsedAt?: number;
}): LlmConnection {
  const providerType = migrateConnectionType(legacy.type);
  const hasCustomEndpoint = !!legacy.baseUrl && legacy.type !== 'anthropic';
  const authType = migrateAuthType(legacy.authType, hasCustomEndpoint);

  return {
    slug: legacy.slug,
    name: legacy.name,
    providerType,
    type: legacy.type, // 保留以兼容旧代码
    baseUrl: legacy.baseUrl,
    authType,
    models: legacy.models,
    defaultModel: legacy.defaultModel,
    createdAt: legacy.createdAt,
    lastUsedAt: legacy.lastUsedAt,
  };
}

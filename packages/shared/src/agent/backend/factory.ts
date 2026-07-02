/**
 * Agent 工厂（Agent Factory）
 *
 * 本文件是整个 Agent 子系统的"工厂入口"。根据传入的配置（config）创建对应的
 * AI Agent 后端实例：ClaudeAgent 或 PiAgent。所有后端都直接实现 AgentBackend
 * 接口（类似 Go 中所有实现都满足同一个 interface）。
 *
 * 当前支持两条 SDK 路径（Provider）：
 * - ClaudeAgent（Anthropic）：默认实现，基于 @anthropic-ai/claude-agent-sdk
 * - PiAgent（Pi）：基于 @earendil-works/pi-ai SDK
 *
 * LLM Connection（模型连接配置）如何决定 SDK 选择与凭据路由：
 * - 后端可以从 LLM connection 配置记录创建出来
 * - providerType（provider 类型）决定选用哪条 SDK 路径（即实例化哪个 Agent 类），
 *   也决定凭据路由（credentials routing，凭据往哪条链路送）
 * - authType（鉴权类型，如 api_key / oauth_token 等）决定凭据如何被取回与传递
 *
 * Go 类比：本文件类似 Go 里的 `NewClient(cfg)` 工厂函数 + driver registry（注册表）模式，
 * 根据 cfg.Provider 在注册表里找到对应的 driver 来构造客户端。
 */

import type {
  AgentBackend,
  BackendConfig,
  AgentProvider,
  LlmProviderType,
  LlmAuthType,
  CoreBackendConfig,
  BackendHostRuntimeContext,
} from './types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import {
  getLlmConnection,
  getDefaultLlmConnection,
  type LlmConnection,
} from '../../config/storage.ts';
// 仅在遗留迁移（legacy migration）函数里用到这些已废弃的类型
import type { LlmConnectionType, CustomEndpointConfig } from '../../config/llm-connections.ts';
// 导入 provider-auth 组合的校验辅助函数（用来检查 provider 与 authType 是否匹配）
import {
  isValidProviderAuthCombination,
} from '../../config/llm-connections.ts';
import { parseValidationError, type LlmValidationResult } from '../../config/llm-validation.ts';
import type { ModelFetchResult } from '../../config/model-fetcher.ts';
// 模型解析（model resolution）相关的工具
import { getModelProvider, DEFAULT_MODEL, normalizeDeprecatedModelId } from '../../config/models.ts';
import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCredentialManager } from '../../credentials/index.ts';
import type {
  BackendModelFetchCredentials,
  BackendProviderOptions,
  BackendResolutionContext,
  ProviderDriver,
  ResolvedBackendConfig,
  StoredConnectionValidationResult,
} from './internal/driver-types.ts';
import { getDefaultProviderType } from './internal/driver-types.ts';
import {
  resolveBackendHostTooling as resolveHostToolingPaths,
  resolveBackendRuntimePaths,
} from './internal/runtime-resolver.ts';
import { anthropicDriver } from './internal/drivers/anthropic.ts';
import { piDriver } from './internal/drivers/pi.ts';

// Driver 注册表：把每个 AgentProvider 映射到对应的 ProviderDriver。
// TS 语法 Record<AgentProvider, ProviderDriver> 类似 Go 的 map[AgentProvider]ProviderDriver，
// 但 TS 的 Record 还能在编译期保证覆盖所有 union 成员（缺一个 key 会报错）。
const DRIVER_REGISTRY: Record<AgentProvider, ProviderDriver> = {
  anthropic: anthropicDriver,
  pi: piDriver,
};

// 根据 provider 名从注册表中取出对应的 driver；找不到就抛错。
// Go 类比：类似 registry[provider] + ok 判断，这里直接抛异常。
function getProviderDriver(provider: AgentProvider): ProviderDriver {
  const driver = DRIVER_REGISTRY[provider];
  if (!driver) {
    throw new Error(`No backend driver registered for provider: ${provider}`);
  }
  return driver;
}

// 解析出 provider 对应的 driver 以及运行时路径（runtime paths）。
// 把"找 driver"和"算路径"两件事合并成一个调用，给上层用。
function resolveDriverRuntime(
  provider: AgentProvider,
  hostRuntime: BackendHostRuntimeContext,
) {
  const driver = getProviderDriver(provider);
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime);
  return { driver, resolvedPaths };
}

/**
 * 根据已保存的 auth type（鉴权类型）推断 provider。
 *
 * 把鉴权类型映射到对应的 provider：
 * - api_key、oauth_token → 默认走 Anthropic（Claude）
 *
 * 注意：provider 现在由 LLM connection type 决定，不再由 auth type 决定。
 * 保留本函数只是为了向后兼容（backward compatibility）。
 *
 * @param authType - 已保存的鉴权类型字符串
 * @returns 推断出的 provider（'anthropic' | 'pi'）
 */
export function detectProvider(authType: string): AgentProvider {
  switch (authType) {
    case 'api_key':
    case 'oauth_token':
      return 'anthropic';

    // 未知类型默认走 Anthropic
    default:
      return 'anthropic';
  }
}

/**
 * 根据配置创建对应的 backend 实例。
 *
 * @param config - Backend 配置，包含 provider 选择等字段
 * @returns 已初始化的 AgentBackend 实例
 * @throws Error 当请求的 provider 还未实现时抛出
 *
 * @example
 * ```typescript
 * // 创建 Anthropic（Claude）backend
 * const backend = createBackend({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // 创建 Pi backend（通过 Pi SDK 把 OpenAI / Copilot / Bedrock 等厂商路由进来）
 * const piBackend = createBackend({
 *   provider: 'pi',
 *   workspace: myWorkspace,
 * });
 * ```
 */
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case 'anthropic':
      // ClaudeAgent 直接实现 AgentBackend 接口
      return new ClaudeAgent(config);

    case 'pi':
      // PiAgent 直接实现 AgentBackend 接口
      // 鉴权通过 Pi 自带的 AuthStorage 以 API key 形式处理
      return new PiAgent(config);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * 根据配置创建对应的 agent。本质是 createBackend 的别名，新代码建议优先用这个名字。
 */
export const createAgent = createBackend;

/**
 * 根据预先解析好的 context 和与 provider 无关的核心配置（core config）创建 backend。
 * provider 特有的运行时解析（runtime resolution）通过内部 driver 注册表完成。
 */
export function createBackendFromResolvedContext(args: {
  context: ResolvedBackendContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  // providerOptions?: 表示该字段可选；TS 中的 ? 类似 Go 里用指针表达"可能为空"。
  providerOptions?: BackendProviderOptions;
}): AgentBackend {
  const { context, coreConfig, hostRuntime, providerOptions } = args;
  const { driver, resolvedPaths } = resolveDriverRuntime(context.provider, hostRuntime);

  const buildArgs = {
    context,
    coreConfig,
    hostRuntime,
    resolvedPaths,
    providerOptions,
  };

  // driver.prepareRuntime?.(...): 可选链调用，等价于 if (driver.prepareRuntime) driver.prepareRuntime(...)
  driver.prepareRuntime?.(buildArgs);
  const runtime = driver.buildRuntime(buildArgs);

  const config: ResolvedBackendConfig = {
    // ...coreConfig 是对象展开（spread），把 coreConfig 的字段铺进来，类似 Go 里结构体嵌入后拷贝字段。
    ...coreConfig,
    provider: context.provider,
    // ?? 是空值合并运算符：左侧为 null/undefined 时才取右侧。
    providerType: context.connection?.providerType ?? getDefaultProviderType(context.provider),
    authType: context.authType || getDefaultAuthType(context.provider),
    model: context.resolvedModel,
    connectionSlug: context.connection?.slug,
    runtime,
  };

  return createBackend(config);
}

/**
 * 在 App 启动时执行一次性的 backend host runtime 接线（wiring）。
 * 把运行时/启动相关细节（如 Claude SDK 可执行文件、Pi 的 interceptor bundle）
 * 关在 backend 内部，不让外层直接感知。
 */
export function initializeBackendHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext;
}): void {
  const { hostRuntime } = args;

  for (const provider of getAvailableProviders()) {
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, hostRuntime);
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths });
  }
}

/**
 * 从通用的 host runtime 元数据里解析出由 backend 管理的宿主工具路径（如 ripgrep）。
 */
export function resolveBackendHostTooling(args: {
  hostRuntime: BackendHostRuntimeContext;
}): {
  // ripgrep 可执行文件路径，可能为空
  ripgrepPath?: string;
} {
  return resolveHostToolingPaths(args.hostRuntime);
}

/**
 * 获取当前可用的 provider 列表。
 *
 * @returns 已有可用实现的 provider 标识数组（'anthropic' | 'pi' 的联合类型数组）
 */
export function getAvailableProviders(): AgentProvider[] {
  // 这里的 ['anthropic', 'pi'] 是 AgentProvider 联合类型的全部成员
  return ['anthropic', 'pi'];
}

/**
 * 判断某个 provider 是否可用。
 *
 * @param provider - 待检查的 provider
 * @returns 如果该 provider 有可用实现则返回 true
 */
export function isProviderAvailable(provider: AgentProvider): boolean {
  return getAvailableProviders().includes(provider);
}

// ============================================================
// LLM Connection Support
// ============================================================

/**
 * 把 LLM connection 里的 providerType 映射为 AgentProvider（决定实例化哪个 SDK 后端）。
 *
 * AgentProvider 决定上层该创建哪个后端类：
 * - 'anthropic' → ClaudeAgent
 * - 'pi' → PiAgent
 *
 * @param providerType - LLM connection 中的完整 provider 类型
 * @returns 用于 SDK 选择的 agent provider
 */
export function providerTypeToAgentProvider(providerType: LlmProviderType): AgentProvider {
  switch (providerType) {
    // Anthropic SDK 后端（仅直连 API）
    case 'anthropic':
      return 'anthropic';

    // Pi 后端（历史 bedrock/vertex/anthropic_compat 经迁移后也路由到 pi）
    case 'pi':
    case 'pi_compat':
      return 'pi';

    default:
      // 穷尽性检查：确保联合类型所有成员都被覆盖
      const _exhaustive: never = providerType;
      return 'anthropic';
  }
}

/**
 * @deprecated 请改用 providerTypeToAgentProvider。
 * 把遗留的 LLM connection type 映射为 agent provider。
 *
 * @param connectionType - 遗留的 LLM connection 类型
 * @returns 对应的 agent provider
 */
export function connectionTypeToProvider(connectionType: LlmConnectionType): AgentProvider {
  switch (connectionType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai-compat':
      return 'pi'; // 历史 OpenAI connection 现在统一路由到 Pi
    default:
      return 'anthropic';
  }
}

/**
 * @deprecated 请直接用 LlmAuthType，无需映射。
 * 把遗留的 LLM auth type 映射为后端 auth type。
 *
 * @param authType - 遗留的 LLM connection auth type
 * @returns 对应的后端 auth type
 */
export function connectionAuthTypeToBackendAuthType(
  authType: LlmAuthType
): LlmAuthType | undefined {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'oauth':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
      // 后端能处理的鉴权类型直接透传
      return authType;
    case 'none':
    case 'environment':
      // 这些鉴权类型不需要显式传递凭据
      return undefined;
  }
}

/**
 * 为 session 解析最合适的 LLM connection。
 * 解析顺序：session 级 > workspace 默认 > 全局默认
 *
 * @param sessionConnection - session 中指定的 connection slug（可能为空）
 * @param workspaceDefaultConnection - workspace 默认 connection slug（可能为空）
 * @returns 解析到的 LLM connection；找不到则返回 null
 */
export function resolveSessionConnection(
  sessionConnection?: string,
  workspaceDefaultConnection?: string
): LlmConnection | null {
  // 1. Session 级 connection（首次发消息后锁定）
  if (sessionConnection) {
    const connection = getLlmConnection(sessionConnection);
    if (connection) return connection;
  }

  // 2. Workspace default
  if (workspaceDefaultConnection) {
    const connection = getLlmConnection(workspaceDefaultConnection);
    if (connection) return connection;
  }

  // 3. Global default
  const defaultSlug = getDefaultLlmConnection();
  if (!defaultSlug) return null;
  return getLlmConnection(defaultSlug);
}

/**
 * 与 provider 无关的解析结果，供 session / IPC 编排层使用。
 */
export interface ResolvedBackendContext extends BackendResolutionContext {}

/**
 * 一次性解析 connection + provider/auth/model/capabilities。
 * 让主进程编排层无需写 provider 分支判断。
 */
export function resolveBackendContext(args: {
  sessionConnectionSlug?: string;
  workspaceDefaultConnectionSlug?: string;
  managedModel?: string;
}): ResolvedBackendContext {
  const connection = resolveSessionConnection(
    args.sessionConnectionSlug,
    args.workspaceDefaultConnectionSlug
  );

  const provider = connection
    ? providerTypeToAgentProvider(connection.providerType || 'anthropic')
    : 'anthropic';

  const authType = connection
    ? connectionAuthTypeToBackendAuthType(connection.authType)
    : undefined;

  const resolvedModel = resolveModelForProvider(provider, args.managedModel, connection);

  return {
    connection,
    provider,
    authType,
    resolvedModel,
    capabilities: BACKEND_CAPABILITIES[provider],
  };
}

/**
 * 为设置阶段的连接测试解析 provider hint。
 * 避免在 Electron main 的 IPC handler 里写 provider 特定逻辑。
 */
export function resolveSetupTestConnectionHint(args: {
  provider: AgentProvider;
  baseUrl?: string;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
}): Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'> {
  if (args.provider === 'pi') {
    if (args.customEndpoint && args.baseUrl?.trim()) {
      return {
        providerType: 'pi_compat',
        piAuthProvider: args.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai',
        customEndpoint: args.customEndpoint,
      };
    }

    return {
      providerType: 'pi',
      piAuthProvider: args.piAuthProvider,
    };
  }

  return {
    providerType: args.baseUrl ? 'pi_compat' : 'anthropic',
  };
}

/**
 * 与 provider 无关的模型发现，用于“刷新模型列表”流程。
 * 分派给各 provider driver 处理，把 SDK 细节关在后端内部。
 */
export async function fetchBackendModels(args: {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
}): Promise<ModelFetchResult> {
  const provider = providerTypeToAgentProvider(args.connection.providerType);
  const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);
  const timeoutMs = args.timeoutMs ?? 30_000;

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  });

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for provider: ${provider}`);
  }

  return driver.fetchModels({
    connection: args.connection,
    credentials: args.credentials,
    hostRuntime: args.hostRuntime,
    resolvedPaths,
    timeoutMs,
  });
}

/**
 * 与 provider 无关的“已保存连接”校验。
 * 避免在 Electron main 的 IPC handler 里写 provider/auth 分支。
 */
export async function validateStoredBackendConnection(args: {
  slug: string;
  hostRuntime: BackendHostRuntimeContext;
}): Promise<StoredConnectionValidationResult> {
  try {
    const connection = getLlmConnection(args.slug);
    if (!connection) {
      return { success: false, error: 'Connection not found' };
    }

    const credentialManager = getCredentialManager();
    const hasCredentials = await credentialManager.hasLlmCredentials(
      args.slug,
      connection.authType,
      connection.providerType,
    );

    if (!hasCredentials && connection.authType !== 'none') {
      return { success: false, error: 'No credentials configured' };
    }

    const provider = providerTypeToAgentProvider(connection.providerType);
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);

    driver.initializeHostRuntime?.({
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });

    if (!driver.validateStoredConnection) {
      return { success: true };
    }

    return driver.validateStoredConnection({
      slug: args.slug,
      connection,
      credentialManager,
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: parseValidationError(msg) };
  }
}

/**
 * 根据 LLM connection 创建后端配置。
 *
 * @param connection - LLM connection 配置
 * @param baseConfig - 基础后端配置（workspace、session 等）
 * @returns 可直接传给 createBackend() 的完整 BackendConfig
 */
export function createConfigFromConnection(
  connection: LlmConnection,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType' | 'providerType'>
): BackendConfig {
  // 优先用新的 providerType，没有则回退到遗留 type
  const providerType = connection.providerType || (connection.type ? connectionTypeToProvider(connection.type) as unknown as LlmProviderType : 'anthropic');
  const provider = providerTypeToAgentProvider(providerType);

  return {
    ...baseConfig,
    provider,
    providerType,
    authType: connection.authType,
    connectionSlug: connection.slug,
    // 若 baseConfig 没指定模型，则使用 connection 的默认模型
    model: baseConfig.model || connection.defaultModel,
  };
}

/**
 * 根据 LLM connection 的 slug 创建后端实例。
 *
 * @param connectionSlug - LLM connection 的 slug
 * @param baseConfig - 基础后端配置（workspace、session 等）
 * @returns 已初始化的 AgentBackend 实例
 * @throws Error 当 connection 不存在或 provider-auth 组合不合法时抛出
 */
export function createBackendFromConnection(
  connectionSlug: string,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
  hostRuntime?: BackendHostRuntimeContext,
  providerOptions?: BackendProviderOptions,
): AgentBackend {
  const connection = getLlmConnection(connectionSlug);
  if (!connection) {
    throw new Error(`LLM connection not found: ${connectionSlug}`);
  }

  // 创建 backend 前先校验 provider-auth 组合是否合法
  // 这样可以尽早捕获错误配置，并给出清晰的错误信息
  if (!isValidProviderAuthCombination(connection.providerType, connection.authType)) {
    throw new Error(
      `Invalid LLM connection configuration: provider '${connection.providerType}' ` +
      `does not support auth type '${connection.authType}'. ` +
      `Please update the connection settings for '${connection.name}'.`
    );
  }

  const context: ResolvedBackendContext = {
    connection,
    provider: providerTypeToAgentProvider(connection.providerType || 'anthropic'),
    authType: connectionAuthTypeToBackendAuthType(connection.authType),
    resolvedModel: resolveModelForProvider(
      providerTypeToAgentProvider(connection.providerType || 'anthropic'),
      baseConfig.model,
      connection
    ),
    capabilities: BACKEND_CAPABILITIES[providerTypeToAgentProvider(connection.providerType || 'anthropic')],
  };

  if (hostRuntime) {
    return createBackendFromResolvedContext({
      context,
      coreConfig: baseConfig,
      hostRuntime,
      providerOptions,
    });
  }

  const config = createConfigFromConnection(connection, {
    ...baseConfig,
    model: context.resolvedModel,
  });
  return createBackend(config);
}

// ============================================================
// Backend Capabilities
// ============================================================

/**
 * 声明式能力表：每个 backend provider 的能力。
 * session 层据此做决策，不必再硬编码 provider 字符串判断。
 */
export const BACKEND_CAPABILITIES: Record<AgentProvider, {
  /** 该后端是否需要独立的 HTTP pool server（外部子进程无法直接访问 McpClientPool 时使用） */
  needsHttpPoolServer: boolean;
}> = {
  // Anthropic SDK 直接走本地二进制，不需要独立 HTTP pool server
  anthropic: { needsHttpPoolServer: false },
  // Pi 子进程通过 stdio/JSONL 通信，也不需要 HTTP pool server
  pi: { needsHttpPoolServer: false },
};

// ============================================================
// Auth Type Resolution
// ============================================================

/**
 * 当没有显式指定 auth type 时，返回 provider 的默认值。
 *
 * - anthropic: undefined（Claude 使用环境变量，不通过显式 authType）
 * - pi: 'api_key'
 */
export function getDefaultAuthType(provider: AgentProvider): LlmAuthType | undefined {
  switch (provider) {
    case 'anthropic': return undefined;
    case 'pi':        return 'api_key';
    default:          return undefined;
  }
}

// ============================================================
// Model Resolution
// ============================================================

/**
 * 为指定 provider 解析模型 ID，并校验其是否在 connection 的模型列表中。
 *
 * 各 provider 的默认/校验策略不同：
 * - Anthropic: 回退到 DEFAULT_MODEL（Opus）
 * - Pi: 回退到空字符串（Pi 内部自行选择模型）
 *
 * @param provider - agent provider
 * @param managedModel - session 上保存的模型（用户选择）
 * @param connection - LLM connection 配置（含 defaultModel 与 models[]）
 * @returns 解析后的模型 ID 字符串
 */
export function resolveModelForProvider(
  provider: AgentProvider,
  managedModel: string | undefined,
  connection: LlmConnection | null
): string {
  // 跨 provider 保护：若模型属于另一个 provider，则回退到 connection 的默认模型。
  // 例如避免把 Claude 模型发给 Pi。
  if (managedModel) {
    managedModel = normalizeDeprecatedModelId(managedModel);
    const modelProvider = getModelProvider(managedModel);
    if (modelProvider && modelProvider !== provider) {
      managedModel = undefined; // 清空 —— 让后续逻辑落到 connection 默认模型
    }
  }

  let connectionDefault = connection?.defaultModel
    ? normalizeDeprecatedModelId(connection.defaultModel)
    : undefined;

  if (provider === 'pi' && connection?.models?.length) {
    const connectionModelIds = connection.models.map(m => typeof m === 'string' ? m : m.id);
    if (managedModel && !connectionModelIds.includes(managedModel)) {
      managedModel = undefined;
    }
    if (connectionDefault && !connectionModelIds.includes(connectionDefault)) {
      connectionDefault = connectionModelIds[0];
    }
  }

  switch (provider) {
    case 'pi':
      return managedModel || connectionDefault || '';
    default:
      return managedModel || connectionDefault || DEFAULT_MODEL;
  }
}

// ============================================================
// Runtime Artifact Helpers
// ============================================================

/**
 * 清理被禁用 source 留下的后端运行时产物。
 * 当前主要删除 source 目录下的 bridge credential 缓存文件。
 */
export async function cleanupSourceRuntimeArtifacts(
  workspaceRootPath: string,
  disabledSourceSlugs: string[],
): Promise<void> {
  for (const sourceSlug of disabledSourceSlugs) {
    const cachePath = join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
    await rm(cachePath, { force: true });
  }
}

// ============================================================
// 与 Provider 无关的连接测试
// ============================================================

export async function testBackendConnection(args: {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
  allowEmptyApiKey?: boolean;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
}): Promise<{ success: boolean; error?: string }> {
  const trimmedKey = args.apiKey.trim();
  if (!trimmedKey && !args.allowEmptyApiKey) {
    return { success: false, error: 'API key is required' };
  }

  const tempSlug = `__test-${Date.now()}`;
  const cm = getCredentialManager();
  if (trimmedKey) {
    await cm.setLlmApiKey(tempSlug, trimmedKey);
  }

  try {
    const testModel = args.model;
    const providerType = args.connection?.providerType ?? getDefaultProviderType(args.provider);
    const now = Date.now();
    const authType: LlmAuthType = (
      providerType === 'pi_compat'
    )
      ? 'api_key_with_endpoint'
      : 'api_key';

    const syntheticConnection = {
      slug: tempSlug,
      name: 'Temporary Connection Test',
      providerType,
      authType,
      defaultModel: testModel,
      createdAt: now,
      piAuthProvider: args.connection?.piAuthProvider,
      customEndpoint: args.connection?.customEndpoint,
      ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
    } as LlmConnection;

    const context: ResolvedBackendContext = {
      connection: syntheticConnection,
      provider: args.provider,
      authType,
      resolvedModel: testModel,
      capabilities: BACKEND_CAPABILITIES[args.provider],
    };

    const { driver, resolvedPaths } = resolveDriverRuntime(args.provider, args.hostRuntime);
    if (driver.testConnection) {
      const driverResult = await driver.testConnection({
        provider: args.provider,
        apiKey: trimmedKey,
        model: testModel,
        baseUrl: args.baseUrl,
        connection: args.connection,
        hostRuntime: args.hostRuntime,
        resolvedPaths,
        timeoutMs: args.timeoutMs ?? 20000,
      });
      // null 表示 driver 不处理该测试；继续走通用子进程测试路径
      if (driverResult !== null) return driverResult;
    }

    const cwd = homedir();
    const agent = createBackendFromResolvedContext({
      context,
      coreConfig: {
        workspace: { id: '__test', name: 'Connection Test', slug: '__test', rootPath: cwd, createdAt: 0 },
        session: { id: `test-${now}`, workspaceRootPath: cwd, createdAt: 0, lastUsedAt: 0 },
        isHeadless: true,
        miniModel: testModel,
        envOverrides: args.provider === 'anthropic'
          ? {
            ANTHROPIC_API_KEY: trimmedKey,
            ...(args.baseUrl?.trim() ? { ANTHROPIC_BASE_URL: args.baseUrl.trim() } : {}),
          }
          : undefined,
      },
      hostRuntime: args.hostRuntime,
      providerOptions: { piAuthProvider: args.connection?.piAuthProvider },
    });

    const readAgentStderr = (): string => {
      const maybe = agent as unknown as { getRecentStderr?: () => string };
      return typeof maybe.getRecentStderr === 'function' ? maybe.getRecentStderr() : '';
    };
    const withStderrContext = (message: string): string => {
      const stderr = readAgentStderr();
      if (!stderr) return `${message} (subprocess produced no stderr output)`;
      return `${message}\n--- subprocess stderr (last ~8KB) ---\n${stderr}`;
    };

    try {
      const timeoutMs = args.timeoutMs ?? 20000;
      const text = await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(withStderrContext(`Connection test timed out after ${timeoutMs}ms`))),
            timeoutMs
          )
        ),
      ]);

      return text
        ? { success: true }
        : { success: false, error: 'No response from provider. Check your API key.' };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      // 如果超时分支已经包含 stderr 上下文，则避免重复追加
      const enriched = base.includes('subprocess stderr') ? base : withStderrContext(base);
      return { success: false, error: enriched };
    } finally {
      agent.destroy();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cm.deleteLlmApiKey(tempSlug).catch(() => {});
  }
}

// ============================================================
// 连接校验
// ============================================================

/**
 * 校验 LLM connection，按 provider 分派到具体校验逻辑。
 *
 * - Anthropic/compat/Bedrock/Vertex: 通过 Claude Agent SDK 校验（发一个 maxTurns:1 的查询）
 * - OpenAI/Copilot/Pi: 直接返回成功（这些 provider 在连接时校验，没有预检接口）
 *
 * 更详尽的 provider 专属校验（模型列表、OAuth 刷新等）见
 * apps/electron/src/main/ipc.ts 里的 IPC handler。
 *
 * @param connection - 待校验的 LLM connection
 * @param credentials - 用于校验的 API key 或 OAuth token
 * @returns 校验结果
 */
export async function validateConnection(
  connection: LlmConnection,
  credentials: { apiKey?: string; oauthToken?: string },
): Promise<LlmValidationResult> {
  const provider = providerTypeToAgentProvider(connection.providerType);

  switch (provider) {
    case 'anthropic': {
      // 基于 Anthropic 的 provider 可通过 Claude Agent SDK 进行校验
      const { validateAnthropicConnection } = await import('../../config/llm-validation.ts');
      return validateAnthropicConnection({
        model: connection.defaultModel || DEFAULT_MODEL,
        apiKey: credentials.apiKey,
        oauthToken: credentials.oauthToken,
        baseUrl: connection.baseUrl,
      });
    }

    case 'pi':
      // Pi 在连接时通过其 auth storage 完成校验，没有预检接口
      return { success: true };

    default:
      return { success: true };
  }
}

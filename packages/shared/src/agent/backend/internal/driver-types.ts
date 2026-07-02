// 本文件是 backend 内部实现的核心类型层，定义了各 LLM 厂商 driver
// （driver 可类比 Go 的 interface 实现：每个厂商一个，封装对该厂商 SDK 的查询/校验/运行时构建逻辑）
// 与上层 backend 框架之间的契约接口。所有 driver 都实现 ProviderDriver 接口，
// 上层通过统一的 ProviderDriver 抽象来调用不同厂商，无需关心具体差异。
import type {
  AgentProvider,
  BackendConfig,
  BackendHostRuntimeContext,
  CoreBackendConfig,
  LlmAuthType,
  LlmProviderType,
} from '../types.ts';
import type { LlmConnection } from '../../../config/storage.ts';
import type { ModelFetchResult } from '../../../config/model-fetcher.ts';
import type { CredentialManager } from '../../../credentials/manager.ts';
import type { ResolvedBackendRuntimePaths } from './runtime-resolver.ts';

// 后端运行时所需的各类可执行文件 / 服务进程路径集合。
// 这些路径在启动时由 runtime-resolver 解析后注入，driver 用它们来拉起子进程
// （例如 session-mcp-server、pi-agent-server 等 MCP 服务）。
// 可选属性（?:）表示某些厂商 / 打包形态下不一定全部需要。
export interface BackendRuntimePaths {
  copilotCli?: string;      // 旧版 Copilot CLI 路径（兼容字段）
  interceptor?: string;     // 网络拦截器 bundle 路径（用于 Pi 子进程的 --preload）
  sessionServer?: string;   // session-mcp-server 入口（会话级 MCP 工具服务）
  node?: string;            // node / bun 运行时可执行文件路径
  bridgeServer?: string;    // bridge-mcp-server 入口（桥接 MCP 服务）
  piServer?: string;        // pi-agent-server 入口（Pi 后端主进程）
}

// 传递给底层 backend 子进程的运行时配置载荷。
// `extends Record<string, unknown>` 是 TS 的交叉类型写法，等价于 Go 里
// struct 内嵌一个 map[string]interface{} —— 既保留强类型字段，又允许透传任意未知字段。
export interface BackendRuntimePayload extends Record<string, unknown> {
  paths?: BackendRuntimePaths;
  piAuthProvider?: string;  // Pi 厂商下的具体 provider（如 github-copilot、minimax-cn）
  /** Custom base URL from the LLM connection (e.g. Azure OpenAI endpoint). 自定义基础 URL，例如 Azure OpenAI 端点。 */
  baseUrl?: string;
  /** Custom endpoint protocol config (api type for routing). 自定义端点协议配置，用于路由选择 API 类型。 */
  customEndpoint?: { api: string; supportsImages?: boolean };
  /** Models registered for a custom endpoint. Strings default to 128K context; objects allow overrides.
   *  自定义端点注册的模型列表。纯字符串默认按 128K 上下文处理；对象形式允许覆盖上下文长度 / 图片支持等属性。 */
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
}

// 解析后端配置时的上下文，描述当前 LLM 连接、provider、鉴权方式、已解析的模型
// 以及能力需求（如是否需要 HTTP 池服务）。driver 据此决定运行时构建策略。
export interface BackendResolutionContext {
  connection: LlmConnection | null;   // 当前 LLM 连接配置，可能为空（首次解析）
  provider: AgentProvider;             // 顶层 provider 标识（anthropic / pi）
  authType?: LlmAuthType;              // 鉴权方式（api_key、oauth、bearer_token 等）
  resolvedModel: string;               // 已解析确定的模型 ID
  capabilities: {
    needsHttpPoolServer: boolean;      // 是否需要独立 HTTP 池子进程（多用于代理 / 并发管理）
  };
}

// provider 级别的可选项，目前仅用于 Pi 的 provider 子类型透传。
export interface BackendProviderOptions {
  piAuthProvider?: string;
}

// 拉取模型列表时所需的凭证集合。联合了 API Key 与 OAuth 两种常见凭据形式。
export interface BackendModelFetchCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

// 传递给 driver 中需要 host 运行时上下文方法的公共参数。
// Host 运行时上下文（appRootPath、isPackaged 等）让 driver 能判断打包 / 开发环境。
export interface DriverHostRuntimeArgs {
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
}

// 构建运行时载荷（buildRuntime）所需的完整参数。
export interface DriverBuildArgs {
  context: BackendResolutionContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
  providerOptions?: BackendProviderOptions;
}

// 拉取模型列表方法的参数。
// `extends DriverHostRuntimeArgs` 是 TS 的接口继承，相当于 Go 的 struct 内嵌。
export interface DriverFetchModelsArgs extends DriverHostRuntimeArgs {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  timeoutMs: number;  // 拉取超时时间（毫秒）
}

// 校验已存储连接的结果。shouldRefreshModels 用于提示上层在连接变化后重新拉取模型列表。
export interface StoredConnectionValidationResult {
  success: boolean;
  error?: string;
  shouldRefreshModels?: boolean;
}

// 校验已存储连接的参数（应用启动时验证持久化的连接是否仍有效）。
export interface DriverValidateStoredConnectionArgs extends DriverHostRuntimeArgs {
  slug: string;                // 连接的唯一 slug 标识
  connection: LlmConnection;
  credentialManager: CredentialManager;  // 加密凭证管理器，负责读写 API Key 等
}

// 测试连接的参数（用户新建 / 编辑连接时的连通性测试）。
// `Pick<LlmConnection, ...>` 是 TS 的工具类型，从 LlmConnection 中只选取部分字段，
// 相当于 Go 里定义一个只含几个字段的小 struct。
export interface DriverTestConnectionArgs extends DriverHostRuntimeArgs {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
  timeoutMs: number;
}

// 核心 driver 契约接口：每个 LLM 厂商实现此接口，上层 backend 据此多态调用。
// 类比 Go 的 interface，所有方法（除 buildRuntime 外）都是可选的 —— 不同厂商
// 可按需实现部分能力，未实现的方法由上层走默认 / 回退路径。
export interface ProviderDriver {
  provider: AgentProvider;
  // 启动早期、尽量设置运行时路径但不抛错（缺失的路径会在 prepareRuntime 阶段才报错）。
  initializeHostRuntime?: (args: DriverHostRuntimeArgs) => void;
  // 拉取该 provider 可用模型列表（异步，返回 ModelFetchResult）。
  fetchModels?: (args: DriverFetchModelsArgs) => Promise<ModelFetchResult>;
  // 校验已存储连接在启动时是否仍可用。
  validateStoredConnection?: (args: DriverValidateStoredConnectionArgs) => Promise<StoredConnectionValidationResult>;
  // 用户配置时的实时连通性测试。返回 null 表示该 driver 不处理测试，交由上层通用流程。
  testConnection?: (args: DriverTestConnectionArgs) => Promise<{ success: boolean; error?: string } | null>;
  // 会话启动前的运行时准备（设置环境变量、路径等）。
  prepareRuntime?: (args: DriverBuildArgs) => void;
  // 唯一必选方法：构建交给子进程的运行时载荷。返回 BackendRuntimePayload。
  buildRuntime: (args: DriverBuildArgs) => BackendRuntimePayload;
}

/**
 * 内部使用的已解析配置，由具体 backend 实现消费。在 BackendConfig 基础上附带运行时载荷。
 */
export interface ResolvedBackendConfig extends BackendConfig {
  runtime?: BackendRuntimePayload;
}

// 从 BackendConfig 中安全取出运行时载荷，缺失时返回空对象。
// `as BackendRuntimePayload` 是 TS 的类型断言（类比 Go 里 interface{} 的类型断言，
// 但 TS 在运行时不做检查，这里因为 ?? {} 兜底所以安全）。
export function getBackendRuntime(config: BackendConfig): BackendRuntimePayload {
  return (config.runtime ?? {}) as BackendRuntimePayload;
}

// 根据顶层 provider 返回默认的 providerType（用于 LlmConnection.providerType 字段）。
// switch 没有 default 分支：TS 在启用 exhaustiveness 检查时会强制覆盖所有联合类型成员，
// 相当于 Go 中 switch 一个有穷枚举。
export function getDefaultProviderType(provider: AgentProvider): LlmProviderType {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'pi':
      return 'pi';
  }
}

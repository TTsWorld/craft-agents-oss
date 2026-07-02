/**
 * Agent 后端抽象层。
 *
 * 这个模块为 AI agent（Claude、Pi）提供统一接口，实现无缝 provider 切换。
 *
 * 命名约定：
 * - ClaudeAgent: Claude SDK 实现（直接实现 AgentBackend）
 * - PiAgent: Pi 统一 API 实现
 * - AgentBackend: 所有 agent 都实现的接口
 * - createAgent: 创建 agent 的工厂函数
 *
 * 用法：
 * ```typescript
 * import { createAgent, type AgentBackend } from '@craft-agent/shared/agent/backend';
 *
 * const agent = createAgent({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * for await (const event of agent.chat('Hello')) {
 *   console.log(event);
 * }
 * ```
 */

// 核心类型
export type {
  AgentBackend,
  AgentProvider,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  ChatOptions,
  RecoveryMessage,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  PostInitResult,
} from './types.ts';

// 枚举必须作为值导出，不能只导出类型
export { AbortReason } from './types.ts';

// 工厂函数
export {
  createBackend,
  createAgent,
  detectProvider,
  getAvailableProviders,
  isProviderAvailable,
  // LLM Connection 支持
  connectionTypeToProvider,
  connectionAuthTypeToBackendAuthType,
  resolveSessionConnection,
  resolveBackendContext,
  resolveSetupTestConnectionHint,
  createConfigFromConnection,
  createBackendFromConnection,
  createBackendFromResolvedContext,
  initializeBackendHostRuntime,
  resolveBackendHostTooling,
  fetchBackendModels,
  validateStoredBackendConnection,
  providerTypeToAgentProvider,
  // 能力与工具
  BACKEND_CAPABILITIES,
  resolveModelForProvider,
  getDefaultAuthType,
  cleanupSourceRuntimeArtifacts,
  testBackendConnection,
  // 连接校验
  validateConnection,
} from './factory.ts';

// 共享基础设施
export { BaseEventAdapter } from './base-event-adapter.ts';
export { EventQueue } from './event-queue.ts';

// Provider 特定的事件适配器
export { ClaudeEventAdapter } from './claude/event-adapter.ts';
export { PiEventAdapter } from './pi/event-adapter.ts';

// 具体 Agent 实现由 factory.ts 内部 import；外部应使用 createAgent()/createBackend()

/**
 * session-tools-core
 *
 * 供 Claude（同进程）和 Codex（子进程）两种实现共享的 session 级 tool 工具函数。
 *
 * @packageDocumentation
 */

// 类型
export type {
  // 凭证类型
  CredentialInputMode,

  // 服务类型
  GoogleService,
  SlackService,
  MicrosoftService,

  // 认证请求类型
  AuthRequestType,
  BaseAuthRequest,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  AuthRequest,
  AuthResult,

  // IPC 类型
  CallbackMessage,

  // Tool 结果类型
  TextContent,
  ToolResult,

  // 开发者反馈
  DeveloperFeedback,

  // 校验类型
  ValidationIssue,
  ValidationResult,

  // Source 配置类型
  SourceType,
  McpTransport,
  McpAuthType,
  ApiAuthType,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConfig,
  ConnectionStatus,
} from './types.ts';

// 响应辅助函数
export {
  successResponse,
  errorResponse,
  textContent,
  multiBlockResponse,
} from './response.ts';

// Source 辅助函数
export {
  getSourcePath,
  getSourceConfigPath,
  getSourceGuidePath,
  sourceExists,
  sourceConfigExists,
  loadSourceConfig,
  listSourceSlugs,
  getSkillPath,
  getSkillMdPath,
  skillExists,
  skillMdExists,
  listSkillSlugs,
  generateRequestId,
  // 多 header 凭证辅助函数
  detectCredentialMode,
  getEffectiveHeaderNames,
} from './source-helpers.ts';

// 校验
export {
  // 结果辅助函数
  validResult,
  invalidResult,
  mergeResults,

  // 格式化
  formatValidationResult,

  // JSON 工具
  readJsonFile,
  validateJsonFileHasFields,
  zodErrorToIssues,

  // Slug 校验
  SLUG_REGEX,
  validateSlug,

  // Skill 校验
  SkillMetadataSchema,
  validateSkillContent,

  // Source 校验
  SOURCE_CONFIG_REQUIRED_FIELDS,
  SOURCE_TYPES,
  validateSourceConfigBasic,
} from './validation.ts';

// 上下文接口
export type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  LoadedSource,
  // MCP 校验类型
  StdioMcpConfig,
  HttpMcpConfig,
  StdioValidationResult,
  McpValidationResult,
  ApiTestResult,
  // Session 自我管理类型
  SessionInfo,
  SessionListItem,
  ListSessionsOptions,
  ListSessionsResult,
  BackgroundTaskInfo,
  SendAgentMessageResult,
  ResolvedLabelsResult,
  ResolvedStatusResult,
} from './context.ts';

export { createNodeFileSystem } from './context.ts';

// 处理器导出
export {
  // 提交计划
  handleSubmitPlan,
  // 配置校验
  handleConfigValidate,
  // Skill 校验
  handleSkillValidate,
  // Mermaid 校验
  handleMermaidValidate,
  // Source 测试
  handleSourceTest,
  // OAuth 触发
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
  // 凭证提示
  handleCredentialPrompt,
  // 更新偏好
  handleUpdatePreferences,
  // 数据转换
  handleTransformData,
  // 脚本沙箱
  handleScriptSandbox,
  // 渲染模板
  handleRenderTemplate,
  // 发送开发者反馈
  handleSendDeveloperFeedback,
} from './handlers/index.ts';

export type {
  SubmitPlanArgs,
  ConfigValidateArgs,
  SkillValidateArgs,
  MermaidValidateArgs,
  SourceTestArgs,
  SourceOAuthTriggerArgs,
  GoogleOAuthTriggerArgs,
  SlackOAuthTriggerArgs,
  MicrosoftOAuthTriggerArgs,
  CredentialPromptArgs,
  UpdatePreferencesArgs,
  TransformDataArgs,
  ScriptSandboxArgs,
  RenderTemplateArgs,
  SendDeveloperFeedbackArgs,
} from './handlers/index.ts';

// Tool 定义 —— 唯一数据源
export {
  // 单个 Zod schema
  SubmitPlanSchema,
  ConfigValidateSchema,
  SkillValidateSchema,
  MermaidValidateSchema,
  SourceTestSchema,
  SourceOAuthTriggerSchema,
  CredentialPromptSchema,
  CallLlmSchema,
  UpdatePreferencesSchema,
  TransformDataSchema,
  ScriptSandboxSchema,
  RenderTemplateSchema,
  // Browser tool 的 schema
  BrowserToolSchema,
  // 开发者反馈 schema
  SendDeveloperFeedbackSchema,
  // 描述
  TOOL_DESCRIPTIONS,
  // 注册表
  SESSION_TOOL_DEFS,
  SESSION_TOOL_NAMES,
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_REGISTRY_TOOL_NAMES,
  SESSION_SAFE_ALLOWED_TOOL_NAMES,
  SESSION_SAFE_BLOCKED_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  // 过滤后的辅助视图
  getSessionToolDefs,
  getSessionToolNames,
  getSessionBackendToolNames,
  getSessionRegistryToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  // JSON Schema 转换器
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

export type {
  SessionToolExecutionMode,
  SessionToolSafeMode,
  SessionToolDef,
  RegistrySessionToolDef,
  BackendSessionToolDef,
  SessionToolHandler,
  JsonSchemaToolDef,
  SessionToolFilterOptions,
  SessionToolNameOptions,
} from './tool-defs.ts';

/**
 * Session Tools Core - Handlers（会话级工具处理器入口）
 *
 * 集中导出所有与会话（session）相关的 tool handler。
 * handler 是 Agent 收到 tool use 请求后真正执行业务逻辑的函数，类似 Go 里 HTTP 路由对应的 handler。
 * 这些处理器同时供 Claude 和 Codex 两种实现使用。
 */

// SubmitPlan：向用户提交计划并暂停执行，等待用户确认
export { handleSubmitPlan } from './submit-plan.ts';
export type { SubmitPlanArgs } from './submit-plan.ts';

// Config Validate：校验 config.json、sources、statuses 等配置
export { handleConfigValidate } from './config-validate.ts';
export type { ConfigValidateArgs } from './config-validate.ts';

// Skill Validate：校验 SKILL.md 格式与必填字段
export { handleSkillValidate } from './skill-validate.ts';
export type { SkillValidateArgs } from './skill-validate.ts';

// Mermaid Validate：校验 Mermaid 图表语法
export { handleMermaidValidate } from './mermaid-validate.ts';
export type { MermaidValidateArgs } from './mermaid-validate.ts';

// Source Test：完整测试某个 source（连接、认证、图标等）
export { handleSourceTest } from './source-test.ts';
export type { SourceTestArgs } from './source-test.ts';

// OAuth Triggers：触发各类 OAuth 登录流程
export {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './source-oauth.ts';
export type {
  SourceOAuthTriggerArgs,
  GoogleOAuthTriggerArgs,
  SlackOAuthTriggerArgs,
  MicrosoftOAuthTriggerArgs,
} from './source-oauth.ts';

// Credential Prompt：弹出安全输入框让用户填写凭证
export { handleCredentialPrompt } from './credential-prompt.ts';
export type { CredentialPromptArgs } from './credential-prompt.ts';

// Update Preferences：更新用户偏好设置（时区、位置等）
export { handleUpdatePreferences } from './update-preferences.ts';
export type { UpdatePreferencesArgs } from './update-preferences.ts';

// Transform Data：用脚本转换数据文件，供表格/图表预览使用
export { handleTransformData } from './transform-data.ts';
export type { TransformDataArgs } from './transform-data.ts';

// Script Sandbox：在隔离环境中执行用户脚本（Python/Node/Bun）
export { handleScriptSandbox } from './script-sandbox.ts';
export type { ScriptSandboxArgs } from './script-sandbox.ts';

// Render Template：用 Mustache 模板渲染 HTML
export { handleRenderTemplate } from './render-template.ts';
export type { RenderTemplateArgs } from './render-template.ts';

// Send Developer Feedback：把 Agent 的反馈发给开发团队
export { handleSendDeveloperFeedback } from './send-developer-feedback.ts';
export type { SendDeveloperFeedbackArgs } from './send-developer-feedback.ts';

// Session Self-Management：会话自身的标签、状态、查询
export { handleSetSessionLabels } from './set-session-labels.ts';
export type { SetSessionLabelsArgs } from './set-session-labels.ts';
export { handleSetSessionStatus } from './set-session-status.ts';
export type { SetSessionStatusArgs } from './set-session-status.ts';
export { handleGetSessionInfo } from './get-session-info.ts';
export type { GetSessionInfoArgs } from './get-session-info.ts';
export { handleListSessions } from './list-sessions.ts';
export type { ListSessionsArgs } from './list-sessions.ts';
export { handleListBackgroundTasks } from './list-background-tasks.ts';
export type { ListBackgroundTasksArgs } from './list-background-tasks.ts';

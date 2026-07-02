/**
 * Source OAuth Handlers（Source OAuth 触发处理器）
 *
 * 触发各类 OAuth 认证流程的 handler：
 * - MCP OAuth（OAuth 2.0 + PKCE）
 * - Google OAuth（Gmail、Calendar、Drive 等）
 * - Slack OAuth
 * - Microsoft OAuth（Outlook、OneDrive、Teams 等）
 *
 * 每个 handler 都会构造一个 AuthRequest，通过 ctx.callbacks.onAuthRequest 触发浏览器弹窗。
 */

import type { SessionToolContext } from '../context.ts';
import type {
  ToolResult,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  GoogleService,
  SlackService,
  MicrosoftService,
} from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { generateRequestId } from '../source-helpers.ts';
import { basename } from 'node:path';

// ============================================================
// MCP OAuth Trigger：MCP source 的通用 OAuth 触发
// ============================================================

export interface SourceOAuthTriggerArgs {
  sourceSlug: string;
}

/**
 * 处理 source_oauth_trigger tool 调用。
 * 为 MCP source 触发 OAuth 2.0 + PKCE 流程。
 */
export async function handleSourceOAuthTrigger(
  ctx: SessionToolContext,
  args: SourceOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;

  // 加载 source 配置
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // 校验 source 是否配置了 OAuth：支持 MCP OAuth 和通用的 API OAuth
  const isMcpOAuth = source.type === 'mcp' && source.mcp?.authType === 'oauth';
  const isApiOAuth = source.type === 'api' && source.api?.authType === 'oauth';

  if (!isMcpOAuth && !isApiOAuth) {
    return errorResponse(
      `Source '${sourceSlug}' is not configured for OAuth authentication.`
    );
  }

  // 如果 source 已经认证过，先尝试静默刷新 token。
  // 若 connectionStatus 为 needs_auth 或 isAuthenticated 为 false，则跳过刷新直接进入浏览器授权。
  if (source.isAuthenticated && ctx.credentialManager) {
    const workspaceId = basename(ctx.workspacePath) || '';
    const loadedSource = {
      config: source,
      guide: null,
      folderPath: '',
      workspaceRootPath: ctx.workspacePath,
      workspaceId,
    };

    const refreshedToken = await ctx.credentialManager.refresh(loadedSource);
    if (refreshedToken) {
      return successResponse(
        `Token for source '${sourceSlug}' has been refreshed successfully. The source is ready — proceed with using its tools directly.`
      );
    }
  }

  // 构造 OAuth 认证请求
  const authRequest: McpOAuthAuthRequest = {
    type: 'oauth',
    requestId: generateRequestId('oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
  };

  // 触发认证请求；调用后当前 turn 会被 forceAbort，等待用户在浏览器完成授权
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `OAuth authentication requested for '${source.name}'. Opening browser for authentication.`
  );
}

// ============================================================
// Google OAuth Trigger
// ============================================================

export interface GoogleOAuthTriggerArgs {
  sourceSlug: string;
}

/**
 * 处理 source_google_oauth_trigger tool 调用。
 * 为 Google source 触发 OAuth，支持 Gmail、Calendar、Drive 等服务。
 */
export async function handleGoogleOAuthTrigger(
  ctx: SessionToolContext,
  args: GoogleOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;

  // 加载 source 配置
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // 校验这是 Google source
  if (source.provider !== 'google') {
    const hint = !source.provider
      ? `Add "provider": "google" to config.json and retry.`
      : `This source has provider '${source.provider}'. Use source_oauth_trigger for MCP sources.`;
    return errorResponse(
      `Source '${sourceSlug}' is not configured as a Google API source. ${hint}`
    );
  }

  // 检查 Google OAuth 凭据是否已配置（如果上下文提供该方法）
  if (ctx.isGoogleOAuthConfigured) {
    const api = source.api;
    if (!ctx.isGoogleOAuthConfigured(api?.googleOAuthClientId, api?.googleOAuthClientSecret)) {
      return errorResponse(
        `Google OAuth credentials not configured for source '${sourceSlug}'.

To authenticate with Google services, you need to provide your own OAuth credentials.

**Option 1: Add credentials to source config**
Edit the source's config.json and add:
\`\`\`json
{
  "api": {
    "googleOAuthClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "googleOAuthClientSecret": "YOUR_CLIENT_SECRET"
  }
}
\`\`\`

**Option 2: Set environment variables**
\`\`\`bash
export GOOGLE_OAUTH_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
export GOOGLE_OAUTH_CLIENT_SECRET="YOUR_CLIENT_SECRET"
\`\`\``
      );
    }
  }

  // 检查是否已经有有效 token
  if (source.isAuthenticated && ctx.credentialManager) {
    const workspaceId = basename(ctx.workspacePath) || '';
    const loadedSource = {
      config: source,
      guide: null,
      folderPath: '',
      workspaceRootPath: ctx.workspacePath,
      workspaceId,
    };
    const hasValidToken = await ctx.credentialManager.getToken(loadedSource);
    if (hasValidToken) {
      return successResponse(`Source '${sourceSlug}' is already authenticated.`);
    }
  }

  // 确定要请求的 Google 服务范围
  let service: GoogleService | undefined;
  if (source.api?.googleService) {
    service = source.api.googleService;
  } else if (ctx.inferGoogleService) {
    service = ctx.inferGoogleService(source.api?.baseUrl);
  }

  // 构造认证请求
  const authRequest: GoogleOAuthAuthRequest = {
    type: 'oauth-google',
    requestId: generateRequestId('google-oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    service,
  };

  // 触发认证请求
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Google OAuth requested for '${source.name}'. Opening browser for authentication.`
  );
}

// ============================================================
// Slack OAuth Trigger
// ============================================================

export interface SlackOAuthTriggerArgs {
  sourceSlug: string;
}

/**
 * 处理 source_slack_oauth_trigger tool 调用。
 * 为 Slack source 触发 OAuth，获取 workspace 访问权限。
 */
export async function handleSlackOAuthTrigger(
  ctx: SessionToolContext,
  args: SlackOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;

  // 加载 source 配置
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // 校验这是 Slack source
  if (source.provider !== 'slack') {
    const hint = !source.provider
      ? `Add "provider": "slack" to config.json and retry.`
      : `This source has provider '${source.provider}'.`;
    return errorResponse(
      `Source '${sourceSlug}' is not configured as a Slack API source. ${hint}`
    );
  }

  // Slack OAuth 只支持 API source，不支持 MCP
  if (source.type !== 'api') {
    let hint = '';
    if (source.type === 'mcp') {
      hint = `For Slack integration, use the native Slack API approach (type: "api", provider: "slack") instead of an MCP server. This enables proper OAuth authentication via source_slack_oauth_trigger.`;
    }
    return errorResponse(
      `source_slack_oauth_trigger only works with API sources (type: "api"), not ${source.type} sources. ${hint}`
    );
  }

  // 检查是否已经有有效 token
  if (source.isAuthenticated && ctx.credentialManager) {
    const workspaceId = basename(ctx.workspacePath) || '';
    const loadedSource = {
      config: source,
      guide: null,
      folderPath: '',
      workspaceRootPath: ctx.workspacePath,
      workspaceId,
    };
    const hasValidToken = await ctx.credentialManager.getToken(loadedSource);
    if (hasValidToken) {
      return successResponse(`Source '${sourceSlug}' is already authenticated.`);
    }
  }

  // 确定要请求的 Slack 服务范围
  let service: SlackService | undefined;
  if (source.api?.slackService) {
    service = source.api.slackService;
  } else if (ctx.inferSlackService) {
    service = ctx.inferSlackService(source.api?.baseUrl) || 'full';
  } else {
    service = 'full';
  }

  // 构造认证请求
  const authRequest: SlackOAuthAuthRequest = {
    type: 'oauth-slack',
    requestId: generateRequestId('slack-oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    service,
  };

  // 触发认证请求
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Slack OAuth requested for '${source.name}'. Opening browser for authentication.`
  );
}

// ============================================================
// Microsoft OAuth Trigger
// ============================================================

export interface MicrosoftOAuthTriggerArgs {
  sourceSlug: string;
}

/**
 * 处理 source_microsoft_oauth_trigger tool 调用。
 * 为 Microsoft source 触发 OAuth，支持 Outlook、OneDrive、Teams 等。
 */
export async function handleMicrosoftOAuthTrigger(
  ctx: SessionToolContext,
  args: MicrosoftOAuthTriggerArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;

  // 加载 source 配置
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // 校验这是 Microsoft source
  if (source.provider !== 'microsoft') {
    const hint = !source.provider
      ? `Add "provider": "microsoft" to config.json and retry.`
      : `This source has provider '${source.provider}'.`;
    return errorResponse(
      `Source '${sourceSlug}' is not configured as a Microsoft API source. ${hint}`
    );
  }

  // 检查是否已经有有效 token
  if (source.isAuthenticated && ctx.credentialManager) {
    const workspaceId = basename(ctx.workspacePath) || '';
    const loadedSource = {
      config: source,
      guide: null,
      folderPath: '',
      workspaceRootPath: ctx.workspacePath,
      workspaceId,
    };
    const hasValidToken = await ctx.credentialManager.getToken(loadedSource);
    if (hasValidToken) {
      return successResponse(`Source '${sourceSlug}' is already authenticated.`);
    }
  }

  // 确定要请求的 Microsoft 服务范围
  let service: MicrosoftService | undefined;
  if (source.api?.microsoftService) {
    service = source.api.microsoftService;
  } else if (ctx.inferMicrosoftService) {
    service = ctx.inferMicrosoftService(source.api?.baseUrl);
  }

  // 如果无法推断服务范围，必须显式配置
  if (!service) {
    return errorResponse(
      `Cannot determine Microsoft service for source '${sourceSlug}'. Set microsoftService ('outlook', 'microsoft-calendar', 'onedrive', 'teams', or 'sharepoint') in api config.`
    );
  }

  // 构造认证请求
  const authRequest: MicrosoftOAuthAuthRequest = {
    type: 'oauth-microsoft',
    requestId: generateRequestId('microsoft-oauth'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    service,
  };

  // 触发认证请求
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Microsoft OAuth requested for '${source.name}'. Opening browser for authentication.`
  );
}

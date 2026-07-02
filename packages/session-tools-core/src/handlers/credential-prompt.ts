/**
 * Credential Prompt Handler（凭据弹窗处理器）
 *
 * 通过安全输入 UI 让用户为某个 source 输入凭证（API Key、用户名/密码、多 header 等）。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult, CredentialAuthRequest, CredentialInputMode } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { generateRequestId, detectCredentialMode, getEffectiveHeaderNames } from '../source-helpers.ts';

// source_credential_prompt 的参数：目标 source、认证模式、UI 标签与提示等
export interface CredentialPromptArgs {
  sourceSlug: string;
  mode: CredentialInputMode;
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  /** 多 header 认证时需要的 header 名列表，例如 ["DD-API-KEY", "DD-APPLICATION-KEY"] */
  headerNames?: string[];
  passwordRequired?: boolean;
}

/**
 * 处理 source_credential_prompt tool 调用。
 *
 * 流程：
 * 1. 加载 source 配置；
 * 2. 根据 source 配置和参数推断实际认证模式（例如自动升级为多 header）；
 * 3. 构造 CredentialAuthRequest；
 * 4. 通过 onAuthRequest 触发 UI 弹窗（这会导致当前 turn 被 forceAbort）。
 */
export async function handleCredentialPrompt(
  ctx: SessionToolContext,
  args: CredentialPromptArgs
): Promise<ToolResult> {
  const { sourceSlug, mode, labels, description, hint, headerNames, passwordRequired } = args;

  // 加载 source 配置
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Source '${sourceSlug}' not found.`);
  }

  // 推断实际认证模式：如果 source 已配置 headerNames，会自动升级为 multi-header 模式
  const effectiveMode = detectCredentialMode(source, mode, headerNames);
  const effectiveHeaderNames = getEffectiveHeaderNames(source, headerNames);

  // passwordRequired 仅对 basic 认证有意义
  if (passwordRequired !== undefined && effectiveMode !== 'basic') {
    return errorResponse(
      `passwordRequired parameter only applies to basic auth mode. You specified mode="${mode}" with passwordRequired=${passwordRequired}.`
    );
  }

  // 构造认证请求对象
  const authRequest: CredentialAuthRequest = {
    type: 'credential',
    requestId: generateRequestId('cred'),
    sessionId: ctx.sessionId,
    sourceSlug,
    sourceName: source.name,
    mode: effectiveMode,
    labels,
    description,
    hint,
    headerName: source.api?.headerName,
    headerNames: effectiveHeaderNames,
    // 把 source URL 传给密码管理器，方便匹配已存凭证
    sourceUrl: source.api?.baseUrl || source.mcp?.url,
    passwordRequired,
  };

  // 触发认证弹窗；调用后当前会话 turn 会被中断，等待用户输入
  ctx.callbacks.onAuthRequest(authRequest);

  return successResponse(
    `Authentication requested for '${source.name}'. Waiting for user input.`
  );
}

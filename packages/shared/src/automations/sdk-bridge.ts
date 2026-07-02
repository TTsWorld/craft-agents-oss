/**
 * SDK Bridge - 为 Claude SDK 自动化集成构建环境变量
 *
 * 把 SDK 自动化输入字段映射为 CRAFT_* 环境变量，供命令执行使用。
 */

import { sanitizeForShell } from './security.ts';
import { cleanEnv } from './utils.ts';
import type { AgentEvent, SdkAutomationInput } from './types.ts';

/**
 * 根据 SDK 自动化输入构建环境变量。
 * 不同事件类型会写入不同的 CRAFT_* 变量；用户可控内容都会经过 sanitizeForShell 转义。
 */
export function buildEnvFromSdkInput(event: AgentEvent, input: SdkAutomationInput): Record<string, string> {
  const env: Record<string, string> = {
    ...cleanEnv(),      // 先复制当前进程环境变量
    CRAFT_EVENT: event, // 当前触发的事件名
  };

  // 按事件类型映射字段，用户输入统一做 shell 安全转义
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      if (input.tool_name) env.CRAFT_TOOL_NAME = input.tool_name; // 工具名为内部值，无需转义
      if (input.tool_input) env.CRAFT_TOOL_INPUT = sanitizeForShell(JSON.stringify(input.tool_input));
      if (input.tool_response) env.CRAFT_TOOL_RESPONSE = sanitizeForShell(input.tool_response);
      break;

    case 'PostToolUseFailure':
      if (input.tool_name) env.CRAFT_TOOL_NAME = input.tool_name;
      if (input.tool_input) env.CRAFT_TOOL_INPUT = sanitizeForShell(JSON.stringify(input.tool_input));
      if (input.error) env.CRAFT_ERROR = sanitizeForShell(input.error);
      break;

    case 'UserPromptSubmit':
      if (input.prompt) env.CRAFT_PROMPT = sanitizeForShell(input.prompt);
      break;

    case 'SessionStart':
      if (input.source) env.CRAFT_SOURCE = input.source;
      if (input.model) env.CRAFT_MODEL = input.model;
      break;

    case 'SubagentStart':
    case 'SubagentStop':
      if (input.agent_id) env.CRAFT_AGENT_ID = input.agent_id;
      if (input.agent_type) env.CRAFT_AGENT_TYPE = input.agent_type;
      break;

    case 'Notification':
      if (input.message) env.CRAFT_MESSAGE = sanitizeForShell(input.message);
      if (input.title) env.CRAFT_TITLE = sanitizeForShell(input.title);
      break;

    // SessionEnd、Stop、PreCompact、PermissionRequest、Setup 没有额外字段
    default:
      break;
  }

  return env;
}

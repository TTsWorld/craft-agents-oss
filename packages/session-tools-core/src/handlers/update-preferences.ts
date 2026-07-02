/**
 * Update User Preferences Handler（更新用户偏好处理器）
 *
 * 更新已存储的用户偏好（姓名、时区、位置、备注等）。
 * 通过注入的 updatePreferences 回调实现，避免直接依赖 @craft-agent/shared。
 *
 * 注意：UI 语言不在此处由用户编辑，它跟随 Appearance → Language，
 * 由主进程的 i18n IPC handler 内部维护。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// update_user_preferences 参数：所有字段都是可选的
export interface UpdatePreferencesArgs {
  name?: string;
  timezone?: string;
  city?: string;
  region?: string;
  country?: string;
  notes?: string;
  includeCoAuthoredBy?: boolean;
}

/**
 * 处理 update_user_preferences tool 调用。
 *
 * 校验并合并用户传入的字段，再调用上下文的 updatePreferences 回调完成持久化。
 */
export async function handleUpdatePreferences(
  ctx: SessionToolContext,
  args: UpdatePreferencesArgs
): Promise<ToolResult> {
  if (!ctx.updatePreferences) {
    return errorResponse('Preferences update is not available in this environment.');
  }

  try {
    const updates: Record<string, unknown> = {};

    if (args.name && typeof args.name === 'string') {
      updates.name = args.name;
    }
    if (args.timezone && typeof args.timezone === 'string') {
      updates.timezone = args.timezone;
    }

    // 位置字段合并成一个 location 对象
    if (args.city || args.region || args.country) {
      const location: Record<string, string> = {};
      if (args.city && typeof args.city === 'string') {
        location.city = args.city;
      }
      if (args.region && typeof args.region === 'string') {
        location.region = args.region;
      }
      if (args.country && typeof args.country === 'string') {
        location.country = args.country;
      }
      updates.location = location;
    }

    // notes 直接覆盖原值
    if (args.notes && typeof args.notes === 'string') {
      updates.notes = args.notes;
    }

    // includeCoAuthoredBy 必须是显式 boolean
    if (typeof args.includeCoAuthoredBy === 'boolean') {
      updates.includeCoAuthoredBy = args.includeCoAuthoredBy;
    }

    // 统计实际更新了哪些字段，用于返回提示
    const fields = Object.keys(updates).filter(k => k !== 'location');
    if (updates.location) {
      fields.push(...Object.keys(updates.location as Record<string, string>).map(k => `location.${k}`));
    }

    if (fields.length === 0) {
      return successResponse('No preferences were updated (no valid fields provided)');
    }

    ctx.updatePreferences(updates);
    return successResponse(`Updated user preferences: ${fields.join(', ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to update preferences: ${message}`);
  }
}

/**
 * Default Views
 *
 * 新 workspace（或缺少 views.json 时）使用的内置视图。
 * 用户可以修改或删除它们 —— 这些只是初始默认值。
 */

import type { ViewConfig } from './types.ts';

/**
 * 返回要写入 views.json 的默认视图列表。
 * 每个视图代表一种常见的 session 状态，方便用户一眼看到。
 */
export function getDefaultViews(): ViewConfig[] {
  return [
    {
      id: 'view-new',
      name: 'New',
      description: 'Sessions with unread messages',
      color: 'accent',
      expression: 'hasUnread == true',
    },
    {
      id: 'view-plan',
      name: 'Plan',
      description: 'Sessions with a pending plan awaiting approval',
      color: 'info',
      expression: 'hasPendingPlan == true',
    },
    {
      id: 'view-explore',
      name: 'Explore',
      description: 'Sessions in Explore (read-only) mode',
      color: 'foreground/50',
      expression: 'permissionMode == "safe"',
    },
    {
      id: 'view-processing',
      name: 'Processing',
      description: 'Sessions where the agent is currently running',
      color: 'success',
      expression: 'isProcessing == true',
    },
  ];
}

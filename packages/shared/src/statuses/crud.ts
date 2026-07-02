/**
 * 状态 CRUD 操作
 *
 * 对状态配置进行增删改查，并执行业务规则：
 * - 固定状态（fixed）不能删除，也不能改分类
 * - 默认状态（default）不能删除
 * - ID 必须唯一
 */

import { loadStatusConfig, saveStatusConfig } from './storage.ts';
import type { StatusConfig, CreateStatusInput, UpdateStatusInput } from './types.ts';

/**
 * 把显示名称转成 URL 安全的 slug
 *
 * 例如 "In Progress" → "in-progress"。
 */
function generateStatusSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

/**
 * 创建一个新的自定义状态
 *
 * @throws 如果 ID 冲突或校验失败会抛出 Error
 */
export function createStatus(
  workspaceRootPath: string,
  input: CreateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);

  // 生成唯一 ID：先按 label 生成 slug，重复则加后缀 -2、-3...
  let id = generateStatusSlug(input.label);
  let suffix = 2;
  while (config.statuses.some(s => s.id === id)) {
    id = `${generateStatusSlug(input.label)}-${suffix}`;
    suffix++;
  }

  const maxOrder = Math.max(...config.statuses.map(s => s.order), -1);

  const status: StatusConfig = {
    id,
    label: input.label,
    color: input.color,
    icon: input.icon,
    category: input.category,
    isFixed: false,
    isDefault: false,
    order: maxOrder + 1,
  };

  config.statuses.push(status);
  saveStatusConfig(workspaceRootPath, config);

  return status;
}

/**
 * 更新某个状态（label、color、icon、category）
 *
 * 不能修改 ID 以及 isFixed/isDefault 标志。
 * 如果是 fixed 状态并试图修改受保护字段会抛错。
 *
 * @throws Error
 */
export function updateStatus(
  workspaceRootPath: string,
  statusId: string,
  updates: UpdateStatusInput
): StatusConfig {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  // fixed 状态不允许修改分类
  if (status.isFixed && updates.category && updates.category !== status.category) {
    throw new Error('Cannot change category of fixed status');
  }

  // 只更新传入的字段：!== undefined 表示“显式传了值”
  if (updates.label !== undefined) status.label = updates.label;
  if (updates.color !== undefined) status.color = updates.color;
  if (updates.icon !== undefined) status.icon = updates.icon;
  if (updates.category !== undefined) status.category = updates.category;

  saveStatusConfig(workspaceRootPath, config);
  return status;
}

/**
 * 删除一个状态
 *
 * @throws 如果是 fixed 或 default 状态会抛错
 * @returns 被自动迁移到 'todo' 的 session 数量
 */
export function deleteStatus(
  workspaceRootPath: string,
  statusId: string
): { migrated: number } {
  const config = loadStatusConfig(workspaceRootPath);
  const status = config.statuses.find(s => s.id === statusId);

  if (!status) {
    throw new Error(`Status '${statusId}' not found`);
  }

  if (status.isFixed) {
    throw new Error(`Cannot delete fixed status '${statusId}'`);
  }

  if (status.isDefault) {
    throw new Error(`Cannot delete default status '${statusId}'. Modify it instead.`);
  }

  // 从配置中移除该状态
  config.statuses = config.statuses.filter(s => s.id !== statusId);
  saveStatusConfig(workspaceRootPath, config);

  // 把使用该状态的 session 迁移到 'todo'
  const migrated = migrateSessionsFromDeletedStatus(workspaceRootPath, statusId);

  return { migrated };
}

/**
 * 重新排序状态
 *
 * orderedIds 数组的顺序就是最终显示顺序。
 */
export function reorderStatuses(
  workspaceRootPath: string,
  orderedIds: string[]
): void {
  const config = loadStatusConfig(workspaceRootPath);

  // 先校验所有 ID 都合法
  const validIds = new Set(config.statuses.map(s => s.id));
  for (const id of orderedIds) {
    if (!validIds.has(id)) {
      throw new Error(`Invalid status ID: ${id}`);
    }
  }

  // 按数组下标更新 order
  for (let i = 0; i < orderedIds.length; i++) {
    const status = config.statuses.find(s => s.id === orderedIds[i]);
    if (status) {
      status.order = i;
    }
  }

  saveStatusConfig(workspaceRootPath, config);
}

/**
 * 重置为默认配置
 *
 * 警告：这会删除所有自定义状态！
 */
export function resetToDefaults(workspaceRootPath: string): void {
  const { getDefaultStatusConfig } = require('./storage.ts');
  const config = getDefaultStatusConfig();
  saveStatusConfig(workspaceRootPath, config);

  // 把现在无效的状态迁移到 'todo'
  const validIds = new Set(config.statuses.map((s: StatusConfig) => s.id));
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');
  const sessions = listSessions(workspaceRootPath);

  for (const session of sessions) {
    if (session.sessionStatus && !validIds.has(session.sessionStatus)) {
      updateSessionMetadata(workspaceRootPath, session.id, { sessionStatus: 'todo' });
    }
  }
}

/**
 * 把被删除状态关联的 session 迁移到 'todo'
 *
 * 由 deleteStatus() 内部调用。
 */
function migrateSessionsFromDeletedStatus(
  workspaceRootPath: string,
  deletedStatusId: string
): number {
  // 这里用 require 动态导入 session 存储函数，避免循环依赖。
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');

  const sessions = listSessions(workspaceRootPath);
  let migratedCount = 0;

  for (const session of sessions) {
    if (session.sessionStatus === deletedStatusId) {
      updateSessionMetadata(workspaceRootPath, session.id, { sessionStatus: 'todo' });
      migratedCount++;
    }
  }

  return migratedCount;
}

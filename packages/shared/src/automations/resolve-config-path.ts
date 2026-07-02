/**
 * 自动化配置路径解析器
 *
 * 负责把 workspace 根目录解析为 automations.json 的完整路径，
 * 并生成 matcher 使用的短 ID。
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AUTOMATIONS_CONFIG_FILE } from './constants.ts';

/**
 * 生成一个 6 位十六进制短 ID，用于唯一标识一个 matcher。
 * 使用 crypto.randomBytes(3) 提供 24 位熵（约 1600 万种组合）。
 */
export function generateShortId(): string {
  return randomBytes(3).toString('hex');
}

/**
 * 解析 workspace 的自动化配置文件完整路径。
 * @param workspaceRoot - workspace 根目录
 */
export function resolveAutomationsConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, AUTOMATIONS_CONFIG_FILE);
}

/**
 * Craft Agent 的集中式路径配置。
 *
 * 支持通过环境变量 CRAFT_CONFIG_DIR 运行多个独立实例：
 * 如果从带编号的目录启动（如 craft-tui-agent-1），detect-instance.sh
 * 会把 CRAFT_CONFIG_DIR 设为 ~/.craft-agent-1，让多个实例使用各自独立的配置。
 *
 * 默认（无编号目录）：~/.craft-agent/
 * 实例 1（-1 后缀）：~/.craft-agent-1/
 * 实例 2（-2 后缀）：~/.craft-agent-2/
 */

import { homedir } from 'os';
import { join } from 'path';

// 多实例开发时可通过环境变量覆盖；生产环境或普通 dev 目录回退到默认路径
export const CONFIG_DIR = process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');

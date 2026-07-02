/**
 * CLI 工具图标解析器
 *
 * 解析 bash 命令字符串，识别已知的 CLI 工具（git、npm、docker 等），
 * 并解析出用于 turn card 渲染的显示名称 + 图标。
 *
 * 映射表存放在 ~/.craft-agent/tool-icons/tool-icons.json，旁边是图标文件，
 * 因此用户可以自定义工具和图标。
 *
 * 命令解析支持：
 * - 简单命令：`git status`
 * - 环境变量前缀：`NODE_ENV=prod npm run build`
 * - 链式命令：`git add . && npm publish`
 * - 管道：`git log | head -10`
 * - 前缀命令：`sudo docker ps`、`time npm test`
 * - 路径前缀：`/usr/local/bin/node` → `node`
 * - 相对路径：`./node_modules/.bin/jest` → `jest`
 */

import { existsSync } from 'fs';
import { join, basename } from 'path';
import { parse as shellParse } from 'shell-quote';
import { encodeIconToDataUrl } from './icon-encoder.ts';
import { readJsonFileSync } from './files.ts';

// ============================================
// 类型
// ============================================

/**
 * 单个工具图标条目。
 * TS 的 `interface` 用于描述对象结构，类似 Go 中带标签的 struct。
 */
export interface ToolIconEntry {
  /** 唯一工具标识，例如 "git" */
  id: string;
  /** UI 中显示的可读名称，例如 "Git" */
  displayName: string;
  /** tool-icons.json 同目录下的图标文件名，例如 "git.ico" */
  icon: string;
  /** 映射到该工具的 CLI 命令名列表，例如 ["git"] */
  commands: string[];
}

/**
 * 工具图标配置。
 */
export interface ToolIconConfig {
  /** 前向兼容的模式版本 */
  version: number;
  /** 工具定义数组 */
  tools: ToolIconEntry[];
}

/**
 * 工具图标匹配结果。
 */
export interface ToolIconMatch {
  /** 工具标识 */
  id: string;
  /** UI 显示名称 */
  displayName: string;
  /** Base64 编码的 data URL，可直接用于 <img src="..."> */
  iconDataUrl: string;
}

// ============================================
// 命令解析
// ============================================

/**
 * 透明前缀命令集合——它们本身运行另一个命令，
 * 因此跳过它们，看下一个 token 找真正的工具名。
 */
const PREFIX_COMMANDS = new Set([
  'sudo', 'time', 'nice', 'nohup', 'env', 'timeout',
  'strace', 'ltrace', 'ionice', 'taskset', 'watch',
  'caffeinate', // macOS
]);

/**
 * 判断 token 是否为环境变量赋值（如 FOO=bar）。
 * 它们出现在命令名之前，应跳过。
 */
function isEnvAssignment(token: string): boolean {
  // 必须包含 '='，且以字母或下划线开头（合法环境变量名）
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * 将 bash 命令字符串拆分为多个子命令。
 * 在 &&、||、;、| 操作符处拆分，同时尊重引号字符串。
 *
 * @returns 拆分并去空的子命令字符串数组
 */
export function splitCommands(commandStr: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < commandStr.length) {
    const char = commandStr[i];
    const next = commandStr[i + 1];

    // 跟踪引号状态（双引号内跳过转义引号）
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      // 转义引号不切换状态
      if (i > 0 && commandStr[i - 1] === '\\') {
        current += char;
        i++;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }

    // 仅在引号外拆分
    if (!inSingleQuote && !inDoubleQuote) {
      // && 操作符
      if (char === '&' && next === '&') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // || 操作符
      if (char === '|' && next === '|') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // | 管道（单 |，不是 ||）
      if (char === '|') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // ; 分隔符
      if (char === ';') {
        if (current.trim()) commands.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += char;
    i++;
  }

  // 别忘了最后一条命令
  if (current.trim()) {
    commands.push(current.trim());
  }

  return commands;
}

/**
 * 从单条子命令中提取命令名。
 * 剥离环境变量前缀、透明前缀命令（sudo、time 等）、路径前缀（/usr/local/bin/node → node）。
 *
 * 也处理 shell 包装模式，如 `/bin/zsh -lc 'git status'`，
 * 通过提取并递归解析内部命令来得到真正的工具名。
 *
 * @returns 裸命令名；找不到返回 undefined
 */
export function extractCommandName(subCommand: string): string | undefined {
  // 用 shell-quote 做正确的分词（处理引号、转义等）
  // shell-quote 不支持所有 bash 语法（如 ${var%pattern} 后缀匹配），
  // 遇到不支持的构造会抛出——解析失败时优雅退出
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(subCommand);
  } catch {
    return undefined;
  }

  // 只保留字符串 token（shell-quote 可能返回操作符对象）
  const tokens = parsed.filter((t): t is string => typeof t === 'string');

  let idx = 0;

  // 跳过开头的环境变量赋值
  while (idx < tokens.length && isEnvAssignment(tokens[idx]!)) {
    idx++;
  }

  // 跳过透明前缀命令（sudo、time 等）
  // 也处理 `sudo -u root docker ps`：跳过前缀后的 flag
  while (idx < tokens.length) {
    const token = tokens[idx]!;
    const cmdName = basename(token);

    if (PREFIX_COMMANDS.has(cmdName)) {
      idx++;
      // 跳过前缀命令后的 flag（如 sudo -u root）
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        idx++;
      }
      // timeout 等命令后面跟数字参数，也跳过
      if (cmdName === 'timeout' && idx < tokens.length && /^\d+/.test(tokens[idx]!)) {
        idx++;
      }
      continue;
    }

    // 处理 shell 包装：bash/zsh/sh 带 -c 参数
    if (['bash', 'zsh', 'sh'].includes(cmdName)) {
      // 在剩余 token 中找 -c 或组合参数如 -lc
      const remaining = tokens.slice(idx + 1);
      const cFlagIdx = remaining.findIndex(t => t === '-c' || (t.startsWith('-') && t.includes('c')));

      if (cFlagIdx !== -1 && cFlagIdx + 1 < remaining.length) {
        // -c/-lc 后面的参数就是内部命令，递归解析
        const innerCommand = remaining[cFlagIdx + 1];
        if (innerCommand) {
          return extractCommandName(innerCommand);
        }
      }
    }

    break;
  }

  if (idx >= tokens.length) {
    return undefined;
  }

  const rawCommand = tokens[idx]!;

  // 去掉路径前缀：/usr/local/bin/node → node，./node_modules/.bin/jest → jest
  return basename(rawCommand);
}

/**
 * 从 bash 命令字符串中提取所有命令名。
 * 处理链式命令（&&、||、;）和管道（|）。
 *
 * @param commandStr - 完整 bash 命令字符串，例如 "git add . && npm publish"
 * @returns 按顺序排列的命令名数组，例如 ["git", "npm"]
 */
export function extractCommandNames(commandStr: string): string[] {
  if (!commandStr || !commandStr.trim()) {
    return [];
  }

  const subCommands = splitCommands(commandStr);
  const names: string[] = [];

  for (const sub of subCommands) {
    const name = extractCommandName(sub);
    if (name) {
      names.push(name);
    }
  }

  return names;
}

// ============================================
// 配置加载
// ============================================

const TOOL_ICONS_JSON = 'tool-icons.json';

/**
 * 从包含 tool-icons.json 的目录加载工具图标配置。
 *
 * @param toolIconsDir - tool-icons 目录路径（如 ~/.craft-agent/tool-icons/）
 * @returns 解析后的配置；缺失或无效则返回 null
 */
export function loadToolIconConfig(toolIconsDir: string): ToolIconConfig | null {
  try {
    const configPath = join(toolIconsDir, TOOL_ICONS_JSON);
    if (!existsSync(configPath)) {
      return null;
    }
    const config = readJsonFileSync<ToolIconConfig>(configPath);

    // 基础校验
    if (!config.tools || !Array.isArray(config.tools)) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

// ============================================
// 解析
// ============================================

/**
 * 构建命令名 → 工具条目的查找映射，加速解析。
 * 每次加载配置时调用一次，而不是每条命令都调用。
 */
function buildCommandMap(config: ToolIconConfig): Map<string, ToolIconEntry> {
  const map = new Map<string, ToolIconEntry>();
  for (const tool of config.tools) {
    for (const cmd of tool.commands) {
      // 第一个映射生效（有重复时）
      if (!map.has(cmd)) {
        map.set(cmd, tool);
      }
    }
  }
  return map;
}

/**
 * 将 bash 命令字符串解析为工具图标匹配。
 *
 * 解析命令提取 CLI 工具名，然后依次在 tool-icons.json 映射中查找，
 * 返回第一个存在有效图标文件的工具。
 *
 * @param commandStr - 完整 bash 命令字符串，例如 "git add . && npm publish"
 * @param toolIconsDir - ~/.craft-agent/tool-icons/ 路径，包含 tool-icons.json 和图标文件
 * @returns 包含 displayName 和 base64 iconDataUrl 的匹配；无匹配返回 undefined
 */
export function resolveToolIcon(
  commandStr: string,
  toolIconsDir: string
): ToolIconMatch | undefined {
  const config = loadToolIconConfig(toolIconsDir);
  if (!config) {
    return undefined;
  }

  const commandMap = buildCommandMap(config);
  const commandNames = extractCommandNames(commandStr);

  // 按顺序扫描所有命令，返回第一个有有效图标的
  for (const cmdName of commandNames) {
    const tool = commandMap.get(cmdName);
    if (!tool) continue;

    // 解析图标文件路径（图标文件名相对于 toolIconsDir）
    const iconPath = join(toolIconsDir, tool.icon);
    const iconDataUrl = encodeIconToDataUrl(iconPath);

    if (iconDataUrl) {
      return {
        id: tool.id,
        displayName: tool.displayName,
        iconDataUrl,
      };
    }
  }

  return undefined;
}

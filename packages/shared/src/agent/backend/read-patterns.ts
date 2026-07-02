/**
 * Shell 命令的"读文件操作"识别模块
 *
 * 本模块借助第三方库 bash-parser 把一段 shell 命令字符串解析成 AST（抽象语法树），
 * 再从 AST 里识别出"其实只是在读文件"的命令：cat / head / tail / sed -n。
 * 识别结果（含起止行号）会返回给 event adapter（事件适配器），由它把这条
 * 本来显示为 Bash 工具调用的事件，改写成 Read 类工具事件，这样 UI 上展示更直观、
 * 与真正的文件读取工具体验一致。
 *
 * 之所以要解析成 AST，而不是用正则去硬匹配，是因为要正确处理 shell wrapper
 * （如 /bin/zsh -lc 'cat file' 这种包了一层 shell 的情况）、各种引号与转义——
 * 这些用正则很容易漏判。遇到 shell wrapper 时会递归解析内层命令；PowerShell
 * 命令走单独路径（bash-parser 不支持 PS 语法）。
 *
 * Go 类比：整体类似一个手写的 AST visitor —— 先 parser 产出语法树，再用一组
 * 类型判定 + 字段访问函数在树上做模式匹配。
 */

/// <reference path="../bash-parser.d.ts" />
import bashParser from 'bash-parser';
import { looksLikePowerShell, extractPowerShellReadTarget } from '../powershell-validator.ts';

// ============================================================
// 类型定义
// ============================================================

/**
 * 识别结果的对外结构：描述"这条命令实际在读取哪个文件的哪些行"。
 *
 * `interface X extends Y` 表示 X 继承 Y 的全部字段 —— 类似 Go 里把 Y 作为
 * 匿名字段内嵌进 X 结构体的效果（这里 ReadCommandInfo 自身不继承别的，但下面的
 * ASTNode 系列展示了这种内嵌复用）。
 */
export interface ReadCommandInfo {
  /** 正在被读取的文件路径 */
  filePath: string;
  /** 起始行号（从 1 开始计数，1-indexed） */
  startLine?: number;
  /** 结束行号（从 1 开始计数，且是闭区间，inclusive） */
  endLine?: number;
  /** 原始的 shell 命令字符串，供 UI overlay 展示用 */
  originalCommand: string;
}

// AST 节点类型（bash-parser 生成语法树中的部分节点子集）
// 下面四个 interface 用 extends 复用 ASTNode 的 type 字段，并在各自节点上
// 补充该节点特有的字段。Go 类比：相当于 ASTNode 是基结构体，子节点内嵌它。
interface ASTNode {
  type: string;
}

interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
}

interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  suffix?: ASTNode[];
}

interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// 会读取文件的命令名集合。
// `Set<T>` 是一个只存唯一值的集合 —— 类似 Go 的 `map[T]struct{}`，常用于
// "判断某元素是否属于一组"的 O(1) 查找（这里用 .has(name) 判断命令名是否属于读命令）。
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed']);

// 用作 shell wrapper 的可执行文件名集合（zsh/bash/sh 等会再带一层 -c/-lc 执行内层命令）
const SHELL_EXECUTABLES = new Set([
  '/bin/zsh',
  '/bin/bash',
  '/bin/sh',
  'zsh',
  'bash',
  'sh',
]);

// ============================================================
// 主解析入口
// ============================================================

/**
 * 解析一条 shell 命令，判断它是否实质上是一个"读文件"操作。
 *
 * 支持的命令形态：
 * - cat file.ts
 * - sed -n '1,260p' file.ts
 * - head -n 50 file.ts
 * - tail -n 50 file.ts
 * - Shell wrapper 形态：/bin/zsh -lc 'cat file.ts'
 *
 * @returns 若判定为读操作则返回 ReadCommandInfo，否则返回 null
 */
export function parseReadCommand(command: string): ReadCommandInfo | null {
  // PowerShell 走单独路径：bash-parser 无法处理 PS 语法
  if (looksLikePowerShell(command)) {
    const filePath = extractPowerShellReadTarget(command);
    if (filePath) return { filePath, originalCommand: command };
  }

  try {
    // `as ScriptNode` 是类型断言（type assertion）：TS 里我们"断言"bashParser
    // 返回的 AST 根节点就是 ScriptNode 类型，编译期跳过对它更宽泛类型的检查。
    // Go 类比：类似 `root.(*ScriptNode)` 这种类型断言，但 TS 的断言只是编译期声明、
    // 运行期不做任何转换或检查，断错了一样会跑（后续字段访问才可能炸）。
    const ast = bashParser(command) as ScriptNode;
    const cmd = extractSimpleCommand(ast);
    if (!cmd) return null;

    // 处理 shell wrapper：/bin/zsh -lc 'inner command'
    if (isShellWrapper(cmd)) {
      const innerCommand = getInnerCommand(cmd);
      if (innerCommand) {
        // 递归解析内层命令（一层 wrapper 剥掉后，内层可能仍是个读命令）
        const innerResult = parseReadCommand(innerCommand);
        if (innerResult) {
          // 保留最外层的完整命令字符串用于 UI 展示
          return { ...innerResult, originalCommand: command };
        }
      }
      return null;
    }

    // 不是 wrapper，直接当普通读命令解析
    return parseDirectReadCommand(cmd, command);
  } catch {
    // 解析报错说明这条命令不是我们认得的简单读命令，按"非读操作"处理
    return null;
  }
}

// ============================================================
// AST 辅助函数
// ============================================================

/**
 * 从 AST 中提取出"单一的简单命令"节点。
 * 如果脚本里含有多条命令或复杂结构（管道、循环等），则返回 null。
 */
function extractSimpleCommand(ast: ScriptNode): CommandNode | null {
  if (ast.type !== 'Script' || ast.commands.length !== 1) {
    return null;
  }

  const firstCmd = ast.commands[0];
  if (firstCmd && firstCmd.type === 'Command') {
    return firstCmd as CommandNode;
  }

  return null;
}

/**
 * 把命令节点 suffix 里的参数提取成字符串数组。
 */
function getArgs(cmd: CommandNode): string[] {
  if (!cmd.suffix) return [];

  // `.filter((node): node is WordNode => node.type === 'Word')` 是类型谓词
  // （type predicate）：这个箭头函数除了返回 true/false，还向 TS 编译器承诺
  // "凡是返回 true 的入参都是 WordNode 类型"。于是 filter 之后的数组元素类型
  // 会从宽泛的 ASTNode 收窄成 WordNode，后面就能安全访问 .text。
  // Go 类比：类似 `if w, ok := node.(*WordNode); ok { ... }` —— 等价于把
  // "类型断言 + bool 判定"两步合一。
  return cmd.suffix
    .filter((node): node is WordNode => node.type === 'Word')
    .map((word) => word.text);
}

/**
 * 判断这条命令是不是 shell wrapper（zsh / bash / sh）。
 */
function isShellWrapper(cmd: CommandNode): boolean {
  const name = cmd.name?.text;
  return name !== undefined && SHELL_EXECUTABLES.has(name);
}

/**
 * 从 shell wrapper 命令里抽出被包裹的内层命令字符串。
 * 寻找 -c 标志，或以 'c' 结尾的组合标志（如 -lc），其后紧跟的就是内层命令。
 */
function getInnerCommand(cmd: CommandNode): string | null {
  const args = getArgs(cmd);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    // 找 -c 这种单独标志，或者 -lc 这种组合标志
    if (arg === '-c' || (arg.startsWith('-') && arg.endsWith('c') && arg.length > 1)) {
      // 紧跟在它后面的参数就是要执行的内层命令字符串
      const nextArg = args[i + 1];
      if (nextArg) {
        return nextArg;
      }
    }
  }

  return null;
}

// ============================================================
// Command-Specific Parsers
// ============================================================

/**
 * 解析直接的读文件命令（没有被 shell wrapper 包裹）。
 */
function parseDirectReadCommand(cmd: CommandNode, original: string): ReadCommandInfo | null {
  const name = cmd.name?.text;
  if (!name || !READ_COMMANDS.has(name)) return null;

  const args = getArgs(cmd);

  switch (name) {
    case 'cat':
      return parseCatCommand(args, original);
    case 'sed':
      return parseSedCommand(args, original);
    case 'head':
      return parseHeadCommand(args, original);
    case 'tail':
      return parseTailCommand(args, original);
    default:
      return null;
  }
}

/**
 * 解析 cat 命令：cat file.ts
 * 只匹配简单的单文件 cat（无参数、无多文件）。
 */
function parseCatCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  // 简单的单文件 cat（无参数、无多文件）
  if (args.length === 1 && firstArg && !firstArg.startsWith('-')) {
    return {
      filePath: firstArg,
      originalCommand: original,
    };
  }
  return null;
}

/**
 * 解析按行读取的 sed 命令：
 * - sed -n '1,100p' file.ts（行范围）
 * - sed -n '50p' file.ts（单行）
 */
function parseSedCommand(args: string[], original: string): ReadCommandInfo | null {
  const flag = args[0];
  const pattern = args[1];
  const filePath = args[2];

  // 必须是 -n 静默打印模式，且至少有三个参数
  if (flag !== '-n' || !pattern || !filePath) {
    return null;
  }

  // 范围模式：'1,100p' 或 1,100p
  const rangeMatch = pattern.match(/^'?(\d+),(\d+)p'?$/);
  if (rangeMatch) {
    const start = rangeMatch[1];
    const end = rangeMatch[2];
    if (start && end) {
      return {
        filePath,
        startLine: parseInt(start, 10),
        endLine: parseInt(end, 10),
        originalCommand: original,
      };
    }
  }

  // 单行模式：'50p' 或 50p
  const singleMatch = pattern.match(/^'?(\d+)p'?$/);
  if (singleMatch) {
    const lineStr = singleMatch[1];
    if (lineStr) {
      const line = parseInt(lineStr, 10);
      return {
        filePath,
        startLine: line,
        endLine: line,
        originalCommand: original,
      };
    }
  }

  return null;
}

/**
 * 解析 head 命令：
 * - head -n 50 file.ts
 * - head -50 file.ts
 */
function parseHeadCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];

  // head -n 50 file.ts
  if (firstArg === '-n' && secondArg && thirdArg) {
    const n = parseInt(secondArg, 10);
    if (!isNaN(n)) {
      return {
        filePath: thirdArg,
        startLine: 1,
        endLine: n,
        originalCommand: original,
      };
    }
  }

  // head -50 file.ts（短形式）
  if (args.length === 2 && firstArg && firstArg.startsWith('-') && secondArg) {
    const n = parseInt(firstArg.slice(1), 10);
    if (!isNaN(n)) {
      return {
        filePath: secondArg,
        startLine: 1,
        endLine: n,
        originalCommand: original,
      };
    }
  }

  return null;
}

/**
 * 解析 tail 命令：
 * - tail -n 50 file.ts
 *
 * 注意：由于不知道文件总长度，tail 无法给出精确起止行号。
 */
function parseTailCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];

  // tail -n 50 file.ts
  if (firstArg === '-n' && secondArg && thirdArg) {
    const n = parseInt(secondArg, 10);
    if (!isNaN(n)) {
      return {
        filePath: thirdArg,
        // tail 不设置起止行号
        originalCommand: original,
      };
    }
  }

  // tail -50 file.ts（短形式）
  if (args.length === 2 && firstArg && firstArg.startsWith('-') && secondArg) {
    const n = parseInt(firstArg.slice(1), 10);
    if (!isNaN(n)) {
      return {
        filePath: secondArg,
        originalCommand: original,
      };
    }
  }

  return null;
}


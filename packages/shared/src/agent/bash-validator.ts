/**
 * Bash Command Validator
 *
 * 本模块用于 Explore 模式（只读探索模式，permission mode 的一种）下，
 * 通过 bash-parser 把 shell 字符串解析成 AST（抽象语法树），再递归校验
 * 每一个子命令是否属于白名单只读命令。这样既能让 `git status && git log`
 * 这类复合命令在所有部分都安全时被放行，又能拦截危险构造（写入、命令替换等）。
 *
 * 主要 AST 节点类型（中文含义）：
 * - Command（命令）：简单命令，包含命令名和参数
 * - LogicalExpression（逻辑表达式）：&&（与）或 ||（或）连接的命令链
 * - Pipeline（管道）：用 | 串联的命令（cmd1 | cmd2）
 * - Subshell（子 shell）：括号内的命令 ( ... )
 * - Redirect（重定向）：文件重定向操作符（>, >>, < 等）
 * - CommandExpansion（命令替换）：$(...) 反引号形式的命令替换
 *
 * "fail closed"（失败即拒绝）原则：凡是 bash-parser 产生的、本模块没有显式
 * 处理的节点类型（如 If / While / For / Case / Function），一律拒绝执行，
 * 绝不"看不懂就放行"。这是安全代码的基本要求。
 *
 * Go 类比：本模块对每种 AST 节点类型写一个 validator 函数，整体相当于一个
 * 递归的 visitor —— 类似 Go 里对 json / 树形节点做遍历访问的 visitor 模式。
 */

/// <reference path="./bash-parser.d.ts" />
import bashParser from 'bash-parser';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a bash command AST.
 * 校验一条 bash 命令 AST 后返回的结果。
 * Tracks which subcommands passed/failed for detailed error messages.
 * 同时记录各子命令的通过/失败情况，用于生成详细的错误信息。
 */
export interface BashValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  /** 若被拒绝，这里给出主要的拒绝原因 */
  reason?: BashValidationReason;
  /** Individual results for compound commands */
  /** 复合命令中每个子命令的逐项结果 */
  subcommandResults?: SubcommandResult[];
}

/** 单个子命令的校验结果（用于复合命令的明细） */
export interface SubcommandResult {
  /** The command text that was validated */
  /** 被校验的那段子命令文本 */
  command: string;
  allowed: boolean;
  reason?: string;
}

/**
 * Detailed reason why validation failed.
 * 校验失败的具体原因（带类型的可辨识联合），用于生成有用的错误信息。
 * Used to generate helpful error messages.
 *
 * TS 语法提示：下面这种 `{type:'pipeline'; ...} | {type:'redirect'; ...}`
 * 形式叫做 discriminated union（可辨识联合）。每个分支都用一个共同的字面量
 * 字段 `type` 作为"标签"来区分，调用方用 switch(node.type) 就能让 TS 自动
 * 缩窄类型。可以类比 Go 里带 tag 字段的 sum type，只是 TS 是结构化的。
 */
export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'background_execution'; explanation: string };

// ============================================================
// AST Node Types (from bash-parser)
// bash-parser 生成的 AST 节点类型定义
// ============================================================

/** 所有 AST 节点的公共基类，都带一个 type 字段用于 visitor 分发 */
interface ASTNode {
  type: string;
}

/** 单词节点：一个普通 token，可能包含展开（expansion）信息 */
interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
  expansion?: ExpansionNode[];
}

/** 命令节点：一条简单命令，包含命令名、前缀（赋值/重定向）和后缀（参数/重定向） */
interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  prefix?: ASTNode[];
  suffix?: ASTNode[];
  /** True if command runs in background with & operator */
  /** 为真表示命令通过 & 在后台运行 */
  async?: boolean;
}

/** 逻辑表达式节点：&&（and）或 ||（or）连接的左右两个子命令 */
interface LogicalExpressionNode extends ASTNode {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
}

/** 管道节点：用 | 串联的多个命令 */
interface PipelineNode extends ASTNode {
  type: 'Pipeline';
  commands: ASTNode[];
}

/** 子 shell 节点：括号 ( ... ) 内的命令，内部是一个 CompoundList */
interface SubshellNode extends ASTNode {
  type: 'Subshell';
  list: CompoundListNode;
}

/** 复合列表节点：一组按顺序执行的命令（如子 shell 内部） */
interface CompoundListNode extends ASTNode {
  type: 'CompoundList';
  commands: ASTNode[];
}

/** 重定向节点：文件重定向操作（>, >>, < 等）及其目标文件 */
interface RedirectNode extends ASTNode {
  type: 'Redirect';
  op: { text: string; type: string };
  file: WordNode;
}

/** 展开节点：单词内部的展开结构（命令替换 / 参数展开 / 进程替换等） */
interface ExpansionNode {
  type: string;
  command?: string;
  commandAST?: ScriptNode;
}

/** 脚本节点：bash-parser 解析顶层命令得到的根节点 */
interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// ============================================================
// Dangerous Argument Patterns
// 危险参数模式：命令本身是只读的，但其参数能执行子命令或写入
// ============================================================

/**
 * Command arguments that execute subcommands or perform writes.
 * 会执行子命令或产生写入的命令参数。
 * These are program-level features (not shell constructs) that the AST parser
 * 这些是程序级特性（不是 shell 语法构造），AST 解析器无法识别 —— 例如
 * cannot detect — e.g., `find -exec` runs arbitrary commands despite `find`
 * `find -exec touch file \;` 尽管本身是只读搜索工具，但 `-exec` 会执行任意命令。
 * being a read-only search tool.
 *
 * Checked BEFORE the regex allowlist pattern match in validateCommand().
 * 在 validateCommand() 里早于正则白名单匹配进行检查。
 *
 * TS 语法提示：`Record<string, Set<string>>` 表示"键是 string、值是 Set<string>
 * 的对象/map"。可以类比 Go 里的 `map[string]map[string]struct{}`（用集合去重）。
 */
const DANGEROUS_COMMAND_ARGS: Record<string, Set<string>> = {
  find: new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete']),
};

/** 所有 awk 系列命令名（awk 及其变体），用于针对性检测其脚本里的危险调用 */
const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/**
 * 检测 awk 脚本里是否会执行外部命令。
 * 返回拒绝原因字符串；如果安全则返回 null。
 */
function getDangerousAwkReason(commandParts: string[]): string | null {
  // commandParts[0] is awk/gawk/mawk/nawk - inspect script/args only
  // commandParts[0] 是 awk/gawk/mawk/nawk —— 只检查后面的脚本/参数部分
  const scriptText = commandParts.slice(1).join(' ');

  // TS 语法提示：正则的 `.test(str)` 类似 Go 的 `regexp.MatchString(pattern, str)`，
  // 返回布尔值表示是否匹配。
  if (/\bsystem\s*\(/i.test(scriptText)) {
    return 'awk system() executes arbitrary shell commands';
  }

  // command | getline executes an external command and reads from it
  // command | getline 会执行外部命令并读取其输出
  if (/\|\s*getline\b/i.test(scriptText)) {
    return 'awk command pipes to getline execute external commands';
  }

  // print ... | "cmd" (or with quoted command forms) executes external commands
  // print ... | "cmd"（或带引号命令的形式）会执行外部命令
  if (/\bprint\b[^\n]*\|\s*["'`]/i.test(scriptText)) {
    return 'awk print-to-command pipes execute external commands';
  }

  return null;
}

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a bash command using AST analysis.
 *
 * @param command - The bash command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validateBashCommand(
  command: string,
  patterns: CompiledBashPattern[]
): BashValidationResult {
  // Parse the command into an AST
  let ast: ScriptNode;
  try {
    ast = bashParser(command) as ScriptNode;
  } catch (error) {
    debug('[BashValidator] Parse error:', error);
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Validate the AST recursively
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(ast, patterns, subcommandResults);

  return {
    ...result,
    subcommandResults: subcommandResults.length > 0 ? subcommandResults : undefined,
  };
}

/**
 * Recursively validate an AST node.
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  switch (node.type) {
    case 'Script':
      return validateScript(node as ScriptNode, patterns, results);

    case 'Command':
      return validateCommand(node as CommandNode, patterns, results);

    case 'LogicalExpression':
      return validateLogicalExpression(node as LogicalExpressionNode, patterns, results);

    case 'Pipeline':
      // Validate each command in the pipeline individually.
      // If all commands are in the allowlist, the pipeline is safe.
      // e.g., `git log | head` is allowed because both commands are read-only.
      return validatePipeline(node as PipelineNode, patterns, results);

    case 'Subshell':
      return validateSubshell(node as SubshellNode, patterns, results);

    case 'CompoundList':
      return validateCompoundList(node as CompoundListNode, patterns, results);

    default:
      // Unknown node type — fail closed. bash-parser may produce node types
      // we don't explicitly handle (If, While, For, Case, Function, etc.).
      // Block them rather than silently allowing arbitrary constructs.
      debug('[BashValidator] Unknown node type (blocked):', node.type);
      return {
        allowed: false,
        reason: {
          type: 'parse_error',
          error: `Unsupported shell construct: "${node.type}". Only simple commands, pipelines, logical expressions (&&/||), and subshells are supported in Explore mode`,
        },
      };
  }
}

/**
 * Validate a Script node (top-level).
 */
function validateScript(
  node: ScriptNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a simple Command node.
 * Checks for:
 * 1. Command name matches safe patterns
 * 2. No redirects in suffix
 * 3. No command expansions in any word
 */
function validateCommand(
  node: CommandNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Check for background execution (&) - always blocked as it allows
  // running commands asynchronously which could hide malicious activity
  if (node.async) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) runs commands asynchronously which could hide malicious activity',
      },
    };
  }

  // Build the full command string for pattern matching
  const commandParts: string[] = [];

  // Add command name
  if (node.name) {
    // Check for expansions in command name
    const expansionCheck = checkWordForExpansions(node.name);
    if (expansionCheck) {
      return { allowed: false, reason: expansionCheck };
    }
    commandParts.push(node.name.text);
  }

  // Add prefix (assignments, redirects before command)
  if (node.prefix) {
    for (const item of node.prefix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      }

      // Block environment variable assignments in command prefix.
      // e.g., PATH=/evil ls, LD_PRELOAD=/evil/lib.so ls, FOO=bar cmd
      // These modify the command's environment, potentially enabling
      // PATH hijacking or library injection (LD_PRELOAD).
      if (item.type === 'AssignmentWord') {
        return {
          allowed: false,
          reason: {
            type: 'env_assignment',
            explanation: `Environment variable assignment "${(item as WordNode).text}" modifies command behavior (e.g., PATH hijacking, LD_PRELOAD injection)`,
          },
        };
      }
    }
  }

  // Add suffix (arguments, redirects after command)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      } else if (item.type === 'Word') {
        const word = item as WordNode;

        // Check for command expansions in arguments
        const expansionCheck = checkWordForExpansions(word);
        if (expansionCheck) {
          return { allowed: false, reason: expansionCheck };
        }

        commandParts.push(word.text);
      }
    }
  }

  // Check for command arguments that enable sub-command execution or writes.
  // e.g., `find -exec touch file \;` — the `-exec` flag runs arbitrary commands.
  // These are program-level features invisible to the shell AST.
  const cmdName = node.name?.text;
  if (cmdName) {
    const normalizedCmd = cmdName.toLowerCase();

    if (AWK_COMMANDS.has(normalizedCmd)) {
      const awkReason = getDangerousAwkReason(commandParts);
      if (awkReason) {
        const subResult: SubcommandResult = {
          command: commandParts.join(' '),
          allowed: false,
          reason: awkReason,
        };
        results.push(subResult);
        return {
          allowed: false,
          reason: {
            type: 'unsafe_command',
            command: commandParts.join(' '),
            explanation: awkReason,
          },
        };
      }
    }

    if (DANGEROUS_COMMAND_ARGS[normalizedCmd]) {
      const dangerousArgs = DANGEROUS_COMMAND_ARGS[normalizedCmd];
      for (const part of commandParts) {
        if (dangerousArgs.has(part)) {
          const subResult: SubcommandResult = {
            command: commandParts.join(' '),
            allowed: false,
            reason: `Argument "${part}" executes subcommands or performs writes`,
          };
          results.push(subResult);
          return {
            allowed: false,
            reason: {
              type: 'unsafe_command',
              command: commandParts.join(' '),
              explanation: `"${part}" allows arbitrary command execution or file modification within "${normalizedCmd}"`,
            },
          };
        }
      }
    }
  }

  // Build the command string and check against patterns
  const commandStr = commandParts.join(' ');

  // Check if command matches any safe pattern
  const matchesPattern = patterns.some(pattern => pattern.regex.test(commandStr));

  const subResult: SubcommandResult = {
    command: commandStr,
    allowed: matchesPattern,
    reason: matchesPattern ? undefined : 'Not in read-only allowlist',
  };
  results.push(subResult);

  if (!matchesPattern) {
    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: 'Command is not in the read-only allowlist',
      },
    };
  }

  return { allowed: true };
}

/**
 * Validate a LogicalExpression (&&, ||).
 * Both sides must be valid for the expression to be allowed.
 */
function validateLogicalExpression(
  node: LogicalExpressionNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Validate left side
  const leftResult = validateNode(node.left, patterns, results);
  if (!leftResult.allowed) {
    return leftResult;
  }

  // Validate right side
  const rightResult = validateNode(node.right, patterns, results);
  if (!rightResult.allowed) {
    return rightResult;
  }

  return { allowed: true };
}

/**
 * Validate a Pipeline node (cmd1 | cmd2 | ...).
 * Each command in the pipeline must be valid for the whole pipeline to be allowed.
 */
function validatePipeline(
  node: PipelineNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a Subshell node (...).
 * The inner commands must all be valid.
 */
function validateSubshell(
  node: SubshellNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  return validateNode(node.list, patterns, results);
}

/**
 * Validate a CompoundList (list of commands in subshell or similar).
 */
function validateCompoundList(
  node: CompoundListNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Check a Word node for dangerous expansions.
 * Returns a rejection reason if found, null if safe.
 */
function checkWordForExpansions(word: WordNode): BashValidationReason | null {
  if (!word.expansion) {
    return null;
  }

  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion') {
      return {
        type: 'command_expansion',
        explanation: `Command substitution $(...) executes embedded commands (found in: ${word.text})`,
      };
    }

    // Process substitution <(...) or >(...)
    // bash-parser may represent these differently, check for common patterns
    if (exp.type === 'ProcessSubstitution') {
      return {
        type: 'process_substitution',
        explanation: `Process substitution executes commands (found in: ${word.text})`,
      };
    }

    // Parameter expansion ($VAR, ${VAR}, ${VAR:-default}) can make commands
    // behave unpredictably based on environment state.
    // e.g., `cat $HOME/.ssh/id_rsa` reads sensitive files via expansion.
    if (exp.type === 'ParameterExpansion') {
      return {
        type: 'parameter_expansion',
        explanation: `Variable expansion \${...} makes command behavior dependent on environment state (found in: ${word.text})`,
      };
    }
  }

  return null;
}

/**
 * Safe input redirect operators that don't write to files.
 */
const SAFE_INPUT_REDIRECTS = new Set([
  '<',    // Input redirect - read-only
  '<&',   // Duplicate input file descriptor
]);

/**
 * Check if a redirect is safe (read-only or to /dev/null).
 *
 * Safe redirects:
 * - Input redirects: <, <&
 * - Output redirects to /dev/null (e.g., >/dev/null, 2>/dev/null)
 * - File descriptor duplication (e.g., 2>&1) - just duplicates, doesn't write to file
 */
function isRedirectSafe(redirect: RedirectNode): boolean {
  const op = redirect.op.text;

  // Input redirects are always safe (read-only)
  if (SAFE_INPUT_REDIRECTS.has(op)) {
    return true;
  }

  const target = redirect.file?.text;

  // Output redirects to /dev/null are safe
  if (target === '/dev/null') {
    return true;
  }

  // File descriptor duplication (e.g., 2>&1) is safe - it just redirects to another fd
  // These have targets like "1", "2" (file descriptor numbers)
  if (op === '>&' && target && /^\d+$/.test(target)) {
    return true;
  }

  return false;
}

/**
 * Get explanation for a redirect operator.
 */
function getRedirectExplanation(op: string): string {
  const explanations: Record<string, string> = {
    '>': 'overwrites file contents',
    '>>': 'appends to file',
    '>&': 'redirects file descriptors',
    '>|': 'forces overwrite (clobber)',
    '<<': 'here-document could inject arbitrary content',
  };

  return explanations[op] || `redirect operator "${op}" modifies file I/O`;
}

/**
 * Check if the command string contains dangerous control characters.
 *
 * Note: Newlines and carriage returns are NOT blocked here because bash-parser
 * correctly parses them as command separators, and the AST validation will
 * check each command individually. Only null bytes are blocked as they could
 * cause issues at lower levels (C bindings, string handling).
 */
export function hasControlCharacters(command: string): { char: string; explanation: string } | null {
  const dangerous: Record<string, string> = {
    '\x00': 'Null byte can truncate strings unexpectedly',
  };

  for (const char of command) {
    if (dangerous[char]) {
      return { char: '\\0', explanation: dangerous[char] };
    }
  }

  return null;
}

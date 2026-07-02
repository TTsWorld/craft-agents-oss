/**
 * PowerShell 命令校验器
 *
 * 借助 PowerShell 自带的 System.Management.Automation.Language.Parser 构造出
 * 完整的 AST，进而在 Explore 模式下对命令做精细校验。整体思路与 bash-validator.ts
 * 一致，只是面向 PowerShell 语法。
 *
 * AST 节点类型（来自 PowerShell 解析器）：
 * - ScriptBlockAst: 根节点
 * - PipelineAst: 由管道串联的命令
 * - CommandAst: 单条简单命令及其元素
 * - CommandExpressionAst: 以表达式形式出现的命令
 * - SubExpressionAst: $(...) 形式的子表达式
 * - ScriptBlockExpressionAst: { ... } 形式的脚本块
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';

// ============================================================
// 模块根目录（在 Electron 启动时设置）
// ============================================================

/**
 * PowerShell 解析脚本所在的根目录。
 * 在 Electron 启动时通过 setPowerShellValidatorRoot(__dirname) 一次性设置。
 */
let _validatorRoot: string | undefined;

/**
 * 登记包含 PowerShell 解析脚本的目录。
 * 应用启动时调用一次即可：setPowerShellValidatorRoot(join(__dirname, 'resources'))
 *
 * 设置后，校验器会到该目录下查找 powershell-parser.ps1。
 */
export function setPowerShellValidatorRoot(dir: string): void {
  _validatorRoot = dir;
  debug('[PowerShellValidator] Root set to:', dir);
}

// ============================================================
// 类型定义
// ============================================================

/**
 * 校验一条 PowerShell 命令后的结果
 */
export interface PowerShellValidationResult {
  allowed: boolean;
  /** 拒绝时的主要原因（仅当 allowed=false 时有意义） */
  reason?: PowerShellValidationReason;
  /** 复合命令中各子命令的逐条结果 */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  command: string;
  allowed: boolean;
  reason?: string;
}

export type PowerShellValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; target: string; explanation: string }
  | { type: 'subexpression'; explanation: string }
  | { type: 'script_block'; explanation: string }
  | { type: 'invoke_expression'; explanation: string }
  | { type: 'dot_sourcing'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'background_execution'; explanation: string }
  | { type: 'assignment'; explanation: string }
  | { type: 'powershell_unavailable'; explanation: string };

// ============================================================
// AST 节点类型（对应 PowerShell 解析器输出的 JSON）
// ============================================================

interface ASTNode {
  Type: string;
  Text: string;
}

interface ScriptBlockAst extends ASTNode {
  Type: 'ScriptBlockAst';
  BeginBlock?: NamedBlockAst;
  ProcessBlock?: NamedBlockAst;
  EndBlock?: NamedBlockAst;
}

interface NamedBlockAst extends ASTNode {
  Type: 'NamedBlockAst';
  Statements: ASTNode[];
  Unnamed: boolean;
}

interface PipelineAst extends ASTNode {
  Type: 'PipelineAst';
  PipelineElements: ASTNode[];
  Background: boolean;
}

interface CommandAst extends ASTNode {
  Type: 'CommandAst';
  CommandElements: ASTNode[];
  Redirections: ASTNode[];
  InvocationOperator: string;
}

interface CommandExpressionAst extends ASTNode {
  Type: 'CommandExpressionAst';
  Expression: ASTNode;
}

interface StringConstantExpressionAst extends ASTNode {
  Type: 'StringConstantExpressionAst';
  Value: string;
  StringConstantType: string;
}

interface VariableExpressionAst extends ASTNode {
  Type: 'VariableExpressionAst';
  VariablePath: string;
  Splatted: boolean;
}

interface SubExpressionAst extends ASTNode {
  Type: 'SubExpressionAst';
  SubExpression: ASTNode;
}

interface ScriptBlockExpressionAst extends ASTNode {
  Type: 'ScriptBlockExpressionAst';
  ScriptBlock: ASTNode;
}

interface FileRedirectionAst extends ASTNode {
  Type: 'FileRedirectionAst';
  Location: ASTNode;
  Append: boolean;
  FromStream: string;
}

interface AssignmentStatementAst extends ASTNode {
  Type: 'AssignmentStatementAst';
  Left: ASTNode;
  Right: ASTNode;
  Operator: string;
}

interface ExpandableStringExpressionAst extends ASTNode {
  Type: 'ExpandableStringExpressionAst';
  Value: string;
  NestedExpressions: ASTNode[];
}

interface CommandParameterAst extends ASTNode {
  Type: 'CommandParameterAst';
  ParameterName: string;
  Argument?: ASTNode;
}

interface InvokeMemberExpressionAst extends ASTNode {
  Type: 'InvokeMemberExpressionAst';
  Expression: ASTNode;
  Member: ASTNode;
  Arguments: ASTNode[];
  Static: boolean;
}

interface ParseResult {
  success: boolean;
  ast?: ScriptBlockAst;
  parseErrors?: Array<{ Message: string; Text: string; ErrorId: string }>;
  error?: string;
}

// ============================================================
// 危险 Cmdlet 与模式
// ============================================================

/**
 * 因会写文件或执行代码而被判定为"危险"的 Cmdlet 列表
 */
const DANGEROUS_CMDLETS = new Set([
  // 写文件
  'out-file',
  'set-content',
  'add-content',
  'new-item',
  'copy-item',
  'move-item',
  'remove-item',
  'rename-item',
  'clear-content',

  // 执行代码
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'start-process',
  'start',
  'saps',

  // 执行脚本
  'invoke-item',
  'ii',

  // 带输出下载
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',

  // 修改注册表
  'set-itemproperty',
  'new-itemproperty',
  'remove-itemproperty',

  // 修改服务/进程
  'stop-process',
  'kill',
  'stop-service',
  'start-service',
  'restart-service',
  'set-service',

  // 危险别名
  'del',
  'rd',
  'rm',
  'rmdir',
  'erase',
  'ri',
  'mi',
  'ni',
  'sp',
]);

/**
 * 判断某个 Cmdlet 名是否属于"危险 Cmdlet"
 */
function isDangerousCmdlet(cmdlet: string): boolean {
  return DANGEROUS_CMDLETS.has(cmdlet.toLowerCase());
}

// ============================================================
// PowerShell 进程管理
// ============================================================

let powershellAvailable: boolean | null = null;
let powershellPath: string | null = null;

/**
 * 检查本机是否有 PowerShell（pwsh）可用。
 * 为了与现有校验流程兼容，采用同步检查。
 */
export function isPowerShellAvailable(): boolean {
  if (powershellAvailable !== null) {
    return powershellAvailable;
  }

  // 先尝试 pwsh（PowerShell Core，跨平台），再按名尝试 Windows PowerShell
  const candidates: string[] = ['pwsh', 'powershell'];

  // 在 Windows 上，再把 powershell.exe 的全路径作为兜底加入候选。
  // 因为 spawn 出来的子进程（如 Electron 启动的）可能拿不到完整的系统 PATH，
  // 仅凭 'powershell' 这个名字可能失败 —— 虽然 Windows 一定装了它。
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        encoding: 'utf8',
        shell: true,
      });

      if (result.status === 0) {
        powershellPath = cmd;
        powershellAvailable = true;
        debug('[PowerShellValidator] Found PowerShell:', powershellPath);
        return true;
      }
    } catch {
      // 试下一个候选
    }
  }

  powershellAvailable = false;
  debug('[PowerShellValidator] PowerShell not available');
  return false;
}

/**
 * 获取 PowerShell 解析脚本的全路径。
 * 要求启动时已调用过 setPowerShellValidatorRoot()。
 */
function getParserScriptPath(): string {
  if (!_validatorRoot) {
    throw new Error(
      'PowerShell validator root not set. Call setPowerShellValidatorRoot() at startup.'
    );
  }
  return join(_validatorRoot, 'powershell-parser.ps1');
}

/**
 * 调用 PowerShell 原生解析器解析一条命令。
 * 为了与现有校验流程兼容采用同步实现。
 */
function parseCommand(command: string): ParseResult {
  if (!powershellPath) {
    return { success: false, error: 'PowerShell not available' };
  }

  const scriptPath = getParserScriptPath();

  try {
    const result = spawnSync(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Command', command],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10MB，大型 AST 时用得到
      }
    );

    if (result.error) {
      return {
        success: false,
        error: `Failed to spawn PowerShell: ${result.error.message}`,
      };
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    if (result.status !== 0 && !stdout) {
      return {
        success: false,
        error: stderr || `PowerShell exited with code ${result.status}`,
      };
    }

    try {
      return JSON.parse(stdout) as ParseResult;
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse PowerShell output: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      error: `PowerShell execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================================
// 校验逻辑
// ============================================================

/**
 * 通过 AST 分析校验一条 PowerShell 命令。
 *
 * @param command - 待校验的 PowerShell 命令字符串
 * @param patterns - 已编译的允许命令正则列表
 * @returns 校验结果（若被拒绝，附带详细原因）
 */
export function validatePowerShellCommand(
  command: string,
  patterns: CompiledBashPattern[]
): PowerShellValidationResult {
  // 先确认 PowerShell 可用
  if (!isPowerShellAvailable()) {
    return {
      allowed: false,
      reason: {
        type: 'powershell_unavailable',
        explanation: 'PowerShell is not available on this system',
      },
    };
  }

  // 解析命令
  const parseResult = parseCommand(command);

  if (!parseResult.success || !parseResult.ast) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.error || 'Unknown parse error',
      },
    };
  }

  // 检查解析阶段产生的错误
  if (parseResult.parseErrors && parseResult.parseErrors.length > 0) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.parseErrors.map(e => e.Message).join('; '),
      },
    };
  }

  // 对 AST 做结构校验
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(parseResult.ast, patterns, subcommandResults);

  return {
    ...result,
    subcommandResults: subcommandResults.length > 0 ? subcommandResults : undefined,
  };
}

/**
 * 递归校验 AST 节点
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  if (!node) {
    return { allowed: true };
  }

  switch (node.Type) {
    case 'ScriptBlockAst':
      return validateScriptBlock(node as ScriptBlockAst, patterns, results);

    case 'NamedBlockAst':
      return validateNamedBlock(node as NamedBlockAst, patterns, results);

    case 'PipelineAst':
      return validatePipeline(node as PipelineAst, patterns, results);

    case 'CommandAst':
      return validateCommand(node as CommandAst, patterns, results);

    case 'CommandExpressionAst':
      return validateCommandExpression(node as CommandExpressionAst, patterns, results);

    case 'AssignmentStatementAst':
      // 赋值会改变状态，直接拒绝
      return {
        allowed: false,
        reason: {
          type: 'assignment',
          explanation: 'Variable assignment could modify state',
        },
      };

    case 'SubExpressionAst':
      // $(...) 子表达式会执行其内部命令，拒绝
      return {
        allowed: false,
        reason: {
          type: 'subexpression',
          explanation: '$(...) subexpressions execute embedded commands',
        },
      };

    case 'ScriptBlockExpressionAst':
      // { } 脚本块可执行任意代码，拒绝
      return {
        allowed: false,
        reason: {
          type: 'script_block',
          explanation: 'Script blocks { } can execute arbitrary code',
        },
      };

    default:
      // 其他类型：检查其中是否含危险结构
      return validateGenericNode(node, patterns, results);
  }
}

/**
 * 校验 ScriptBlockAst（根节点）
 */
function validateScriptBlock(
  node: ScriptBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // 逐个校验其中的代码块
  for (const block of [node.BeginBlock, node.ProcessBlock, node.EndBlock]) {
    if (block) {
      const result = validateNode(block, patterns, results);
      if (!result.allowed) {
        return result;
      }
    }
  }
  return { allowed: true };
}

/**
 * 校验 NamedBlockAst
 */
function validateNamedBlock(
  node: NamedBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  for (const stmt of node.Statements || []) {
    const result = validateNode(stmt, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * 校验 PipelineAst
 */
function validatePipeline(
  node: PipelineAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // 检查是否后台执行
  if (node.Background) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) could hide malicious activity',
      },
    };
  }

  // 逐段校验管道中的每个元素
  for (const element of node.PipelineElements || []) {
    const result = validateNode(element, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}

/**
 * 校验 CommandAst
 */
function validateCommand(
  node: CommandAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // 检查调用运算符
  if (node.InvocationOperator === 'Dot') {
    return {
      allowed: false,
      reason: {
        type: 'dot_sourcing',
        explanation: 'Dot-sourcing (.) executes scripts in current scope',
      },
    };
  }

  if (node.InvocationOperator === 'Ampersand') {
    return {
      allowed: false,
      reason: {
        type: 'script_block',
        explanation: 'Call operator (&) executes commands/scripts',
      },
    };
  }

  // 检查文件重定向
  for (const redirect of node.Redirections || []) {
    if (redirect.Type === 'FileRedirectionAst') {
      const fileRedirect = redirect as FileRedirectionAst;
      const target = fileRedirect.Location?.Text || 'unknown';

      // 允许重定向到 $null（PowerShell 中的 /dev/null）
      if (target.toLowerCase() === '$null') {
        continue;
      }

      return {
        allowed: false,
        reason: {
          type: 'redirect',
          target,
          explanation: `File redirection to "${target}" writes to filesystem`,
        },
      };
    }
  }

  // 拼接命令字符串，用于 pattern 匹配
  const commandParts: string[] = [];

  for (const element of node.CommandElements || []) {
    // 先检查每个元素是否含危险结构
    const dangerCheck = checkForDangerousConstructs(element);
    if (dangerCheck) {
      return { allowed: false, reason: dangerCheck };
    }

    // 提取文本用于后续 pattern 匹配
    const text = getElementText(element);
    if (text) {
      commandParts.push(text);
    }
  }

  const commandStr = commandParts.join(' ');
  const cmdletName = commandParts[0] || '';

  // 是否为内置的危险 Cmdlet
  if (isDangerousCmdlet(cmdletName)) {
    const subResult: SubcommandResult = {
      command: commandStr,
      allowed: false,
      reason: `Cmdlet "${cmdletName}" can modify system state`,
    };
    results.push(subResult);

    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: `Cmdlet "${cmdletName}" can modify system state`,
      },
    };
  }

  // 与只读 pattern 列表比对（PowerShell 大小写不敏感：
  // Get-Process == get-process == GET-PROCESS）
  const matchesPattern = patterns.some(pattern => {
    // 先用原始正则试一次
    if (pattern.regex.test(commandStr)) {
      return true;
    }
    // 若正则未带 i 标志，再以大小写不敏感方式重试一次
    if (!pattern.regex.flags.includes('i')) {
      try {
        const caseInsensitiveRegex = new RegExp(pattern.source, pattern.regex.flags + 'i');
        return caseInsensitiveRegex.test(commandStr);
      } catch {
        // 重建正则失败则沿用之前的结果
        return false;
      }
    }
    return false;
  });

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
 * 校验 CommandExpressionAst
 */
function validateCommandExpression(
  node: CommandExpressionAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  return validateNode(node.Expression, patterns, results);
}

/**
 * 对任意节点做"危险结构"通用检查
 */
function validateGenericNode(
  node: ASTNode,
  _patterns: CompiledBashPattern[],
  _results: SubcommandResult[]
): PowerShellValidationResult {
  const dangerCheck = checkForDangerousConstructs(node);
  if (dangerCheck) {
    return { allowed: false, reason: dangerCheck };
  }

  return { allowed: true };
}

/**
 * 在 AST 节点中扫描已知的危险结构
 */
function checkForDangerousConstructs(node: ASTNode): PowerShellValidationReason | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'SubExpressionAst':
      return {
        type: 'subexpression',
        explanation: `$(...) subexpression executes embedded commands (found: ${node.Text})`,
      };

    case 'ScriptBlockExpressionAst':
      return {
        type: 'script_block',
        explanation: `Script block { } can execute arbitrary code (found: ${node.Text})`,
      };

    case 'ExpandableStringExpressionAst': {
      const expandable = node as ExpandableStringExpressionAst;
      // 字符串里嵌了子表达式也要拒绝
      for (const nested of expandable.NestedExpressions || []) {
        if (nested.Type === 'SubExpressionAst') {
          return {
            type: 'subexpression',
            explanation: `String contains $(...) subexpression (found: ${node.Text})`,
          };
        }
      }
      break;
    }

    case 'InvokeMemberExpressionAst': {
      // 方法调用可能危险
      const invoke = node as InvokeMemberExpressionAst;
      const memberText = invoke.Member?.Text?.toLowerCase() || '';

      // 拦截可能执行代码的方法名
      const dangerousMethods = ['invoke', 'invokescript', 'create', 'start'];
      if (dangerousMethods.some(m => memberText.includes(m))) {
        return {
          type: 'invoke_expression',
          explanation: `Method invocation could execute code (found: ${node.Text})`,
        };
      }
      break;
    }
  }

  return null;
}

/**
 * 从命令元素中取其文本表示
 */
function getElementText(node: ASTNode): string | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value;

    case 'VariableExpressionAst':
      return `$${(node as VariableExpressionAst).VariablePath}`;

    case 'CommandParameterAst':
      return node.Text;

    default:
      return node.Text;
  }
}

/**
 * 同步判断一条命令"看起来像不像 PowerShell 语法"。
 * 用于决定到底走 PowerShell 校验器还是 bash 校验器。
 */
export function looksLikePowerShell(command: string): boolean {
  const psPatterns = [
    // Cmdlet 形式：动词-名词
    /\b(Get|Set|New|Remove|Add|Clear|Write|Read|Out|ConvertTo|ConvertFrom|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|Format|Export|Import|Start|Stop|Invoke|Enable|Disable|Register|Unregister|Update|Find|Install|Uninstall|Save|Publish|Push|Pop)-\w+/i,

    // 管道里出现 PowerShell 变量
    /\$\w+\s*\|/,

    // PowerShell 运算符
    /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join)\s/i,

    // 数组 / 哈希表字面量
    /@\([^)]*\)/,
    /@\{[^}]*\}/,

    // PowerShell 专有 Cmdlet
    /\b(Where-Object|Select-Object|ForEach-Object|Sort-Object|Group-Object|Measure-Object)\b/i,

    // 与 Unix 不同、PowerShell 特有的常用别名
    /\b(gci|gcm|gps|gsv|gjb)\b/i,
  ];

  return psPatterns.some(p => p.test(command));
}

// ============================================================
// 写入目标路径提取（用于 plans 目录例外放行）
// ============================================================

/**
 * 识别并剥离 `powershell.exe -Command "..."` 外壳，返回其中的内层命令。
 *
 * Codex 在 Windows 上经常把 PowerShell 命令包成：
 *   "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Set-Content -Path \"...\" ..."
 *   powershell.exe -NoProfile -Command "..."
 *   pwsh -Command "..."
 *
 * PS AST 解析时会把 `powershell.exe` 当成顶层命令（而非里面的 Cmdlet），
 * 导致 extractPowerShellWriteTarget() 失败。这里先把这层壳剥掉、把转义引号还原，
 * 再交给真正的提取逻辑重新解析。
 */
export function unwrapPowerShellCommand(command: string): string | null {
  // 匹配："C:\...\powershell.exe" -Command "inner"  或  powershell.exe -Command "inner"  或  pwsh -Command "inner"
  // -Command 之前允许出现 -NoProfile / -NonInteractive 之类的开关
  const match = command.match(
    /^(?:"[^"]*[/\\]?(?:powershell|pwsh)(?:\.exe)?"\s+|(?:powershell|pwsh)(?:\.exe)?\s+)(?:-(?!Command)\w+\s+)*-Command\s+"((?:[^"\\]|\\.)*)"\s*$/i
  );
  if (!match?.[1]) return null;
  // 把 \" 还原成 "
  return match[1].replace(/\\"/g, '"');
}

/** 读取类 Cmdlet */
const READ_CMDLETS = ['get-content', 'gc', 'type'];

/** 写入类 Cmdlet */
const WRITE_CMDLETS = ['out-file', 'set-content', 'add-content'];

/**
 * 借助 AST 分析，从 PowerShell 写命令中提取目标文件路径。
 * 用于判断一条写命令是否落在 plans 目录内（若是则放行）。
 *
 * @param command - PowerShell 命令字符串
 * @returns 若识别为写命令则返回目标路径，否则返回 null
 */
export function extractPowerShellWriteTarget(command: string): string | null {
  if (!isPowerShellAvailable()) return null;

  // 若被 powershell.exe -Command "..." 包了一层，先剥掉再递归解析内层命令。
  // 因为 PS AST 会把 powershell.exe 当作顶层命令，看不到真正的写 Cmdlet。
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellWriteTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // 找到管道中"最后一条"命令（写 Cmdlet 通常出现在这里）
  const lastCmd = findLastPipelineCommand(parseResult.ast);
  if (!lastCmd) return null;

  // 判断它是不是写 Cmdlet
  const cmdName = getCommandName(lastCmd);
  if (!cmdName || !WRITE_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // 提取 -FilePath / -Path 参数对应的值
  let targetPath = extractParameterValue(lastCmd, ['FilePath', 'Path']);

  // 兜底：尝试位置参数（如 Out-File C:\temp\file.txt）
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(lastCmd);
  }

  if (targetPath) {
    debug('[PowerShellValidator] Extracted write target:', targetPath);
  }
  return targetPath;
}

/**
 * 借助 AST 分析，从 PowerShell 读命令中提取目标文件路径。
 * 用于检测文件读取（Get-Content/gc/type），服务于前置依赖追踪。
 *
 * 能处理一些复杂写法，例如：
 * - Get-Content -Path "file.txt" -Encoding UTF8
 * - gc file.txt | Select-String "pattern"
 * - powershell.exe -Command "Get-Content file.txt"
 *
 * @param command - PowerShell 命令字符串
 * @returns 若识别为读命令则返回目标路径，否则返回 null
 */
export function extractPowerShellReadTarget(command: string): string | null {
  if (!isPowerShellAvailable()) return null;

  // 若被 powershell.exe -Command "..." 包了一层，先剥掉再递归解析
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellReadTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // 找到管道中"第一条"命令（读 Cmdlet 通常作为数据源出现在这里）
  const firstCmd = findFirstPipelineCommand(parseResult.ast);
  if (!firstCmd) return null;

  // 判断它是不是读 Cmdlet
  const cmdName = getCommandName(firstCmd);
  if (!cmdName || !READ_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // 提取 -Path / -LiteralPath 参数对应的值
  let targetPath = extractParameterValue(firstCmd, ['Path', 'LiteralPath']);

  // 兜底：位置参数（如 Get-Content C:\temp\file.txt）
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(firstCmd);
  }

  return targetPath;
}

/**
 * 在 AST 中找到"管道里第一条" CommandAst。
 * 读 Cmdlet 通常作为数据源出现在管道头部。
 */
function findFirstPipelineCommand(ast: ASTNode): CommandAst | null {
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  const firstElement = pipeline.PipelineElements[0];
  if (firstElement?.Type === 'CommandAst') {
    return firstElement as CommandAst;
  }
  return null;
}

/**
 * 在 AST 中找到"管道里最后一条" CommandAst
 */
function findLastPipelineCommand(ast: ASTNode): CommandAst | null {
  // 定位到第一条管道
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  // 取管道末尾的元素
  const lastElement = pipeline.PipelineElements[pipeline.PipelineElements.length - 1];
  if (lastElement?.Type === 'CommandAst') {
    return lastElement as CommandAst;
  }
  return null;
}

/**
 * 递归地在 AST 中查找第一条 PipelineAst
 */
function findFirstPipeline(node: ASTNode): PipelineAst | null {
  if (!node) return null;

  if (node.Type === 'PipelineAst') {
    return node as PipelineAst;
  }

  // 进入 ScriptBlockAst
  if (node.Type === 'ScriptBlockAst') {
    const scriptBlock = node as ScriptBlockAst;
    for (const block of [scriptBlock.EndBlock, scriptBlock.ProcessBlock, scriptBlock.BeginBlock]) {
      if (block) {
        const result = findFirstPipeline(block);
        if (result) return result;
      }
    }
  }

  // 进入 NamedBlockAst
  if (node.Type === 'NamedBlockAst') {
    const namedBlock = node as NamedBlockAst;
    for (const stmt of namedBlock.Statements || []) {
      const result = findFirstPipeline(stmt);
      if (result) return result;
    }
  }

  return null;
}

/**
 * 从 CommandAst 中取出命令名
 */
function getCommandName(cmd: CommandAst): string | null {
  if (!cmd.CommandElements?.length) return null;

  const firstElement = cmd.CommandElements[0];
  // 命令名通常是 StringConstantExpressionAst
  if (firstElement?.Type === 'StringConstantExpressionAst') {
    return (firstElement as StringConstantExpressionAst).Value || null;
  }
  return null;
}

/**
 * 从 CommandAst 中提取某个命名参数（如 -FilePath / -Path）对应的值
 */
function extractParameterValue(cmd: CommandAst, paramNames: string[]): string | null {
  if (!cmd.CommandElements) return null;

  const lowerParamNames = paramNames.map(p => p.toLowerCase());

  for (let i = 0; i < cmd.CommandElements.length; i++) {
    const element = cmd.CommandElements[i];

    // 寻找 CommandParameterAst（命名参数）
    if (element?.Type === 'CommandParameterAst') {
      const param = element as CommandParameterAst;
      const paramName = param.ParameterName?.toLowerCase();

      if (paramName && lowerParamNames.includes(paramName)) {
        // 参数值可能在 Argument 属性，也可能在下一个元素
        if (param.Argument) {
          return extractStringValue(param.Argument);
        }
        // 取下一个元素作为值
        const nextElement = cmd.CommandElements[i + 1];
        if (nextElement && nextElement.Type !== 'CommandParameterAst') {
          return extractStringValue(nextElement);
        }
      }
    }
  }

  return null;
}

/**
 * 从 CommandAst 中提取第一个位置参数（positional argument）。
 * 跳过下标 0（命令名）以及所有命名参数（CommandParameterAst）和它们的值，
 * 返回剩下的第一个字符串元素。
 *
 * 用于处理形如 Out-File C:\temp\file.txt 这种路径作为位置参数（没有 -FilePath 标志）的写法。
 */
function extractFirstPositionalArg(cmd: CommandAst): string | null {
  if (!cmd.CommandElements || cmd.CommandElements.length < 2) return null;

  let i = 1; // 跳过下标 0（Cmdlet 名）
  while (i < cmd.CommandElements.length) {
    const element = cmd.CommandElements[i];
    if (element?.Type === 'CommandParameterAst') {
      // 跳过参数名和它的值（下一个元素）
      i += 2;
      continue;
    }
    // 第一个非参数元素就是位置参数
    if (!element) return null;
    return extractStringValue(element);
  }
  return null;
}

/**
 * 从多种 AST 节点类型中提取字符串值
 */
function extractStringValue(node: ASTNode): string | null {
  if (!node) return null;

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value || null;
    case 'ExpandableStringExpressionAst':
      return (node as ExpandableStringExpressionAst).Value || null;
    default:
      // 兜底取 Text 字段（原始文本），并去掉首尾引号
      return node.Text?.replace(/^['"]|['"]$/g, '') || null;
  }
}

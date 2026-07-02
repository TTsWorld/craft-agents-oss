// 模块加载时读取 CRAFT_DEBUG 环境变量（供 SDK 子进程使用）
// 对浏览器/renderer 上下文做保护：那里 process 可能未定义
let debugEnabled = typeof process !== 'undefined' && process.env?.CRAFT_DEBUG === '1';

/**
 * 检查是否处于 CLI JSON-only 模式。
 * 该模式下禁用 debug 输出，避免污染结构化 stdout。
 */
function isCliJsonOnlyMode(): boolean {
  return typeof process !== 'undefined' && process.env?.CRAFT_CLI_JSON_ONLY === '1';
}

/**
 * 运行时环境检测
 */
type Environment = 'electron-main' | 'electron-renderer' | 'cli';

/**
 * 检测当前运行环境。
 * @returns 'electron-main' | 'electron-renderer' | 'cli'
 */
function detectEnvironment(): Environment {
  // 没有 process 对象说明在浏览器/renderer 上下文
  if (typeof process === 'undefined') {
    return 'electron-renderer';
  }
  // Electron 主进程
  if ((process as any).type === 'browser') {
    return 'electron-main';
  }
  // Electron 渲染进程（开启了 nodeIntegration）
  if ((process as any).type === 'renderer') {
    return 'electron-renderer';
  }
  // 默认：CLI / 脚本
  return 'cli';
}

let electronLog: unknown | null = null;
let electronLogChecked = false;

/**
 * 懒加载 electron-log 模块。
 * 仅在 Electron 主进程中可用；失败时返回 null，避免崩溃。
 */
function getElectronLog(): { info?: (message: string) => void } | null {
  if (electronLogChecked) {
    return (electronLog as { info?: (message: string) => void } | null) ?? null;
  }
  electronLogChecked = true;
  try {
    // 可选依赖——仅在 Electron 主进程中可用
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require('electron-log/main');
    electronLog = loaded?.default ?? loaded ?? null;
  } catch {
    electronLog = null;
  }
  return (electronLog as { info?: (message: string) => void } | null) ?? null;
}

/**
 * 启用 debug 日志。应在传递 --debug 标志时调用。
 */
export function enableDebug(): void {
  debugEnabled = true;
}

/**
 * 检查 debug 模式是否已启用。
 */
export function isDebugEnabled(): boolean {
  if (isCliJsonOnlyMode()) return false;
  return debugEnabled;
}

/**
 * 安全地将对象序列化为 JSON，处理循环引用。
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    // 用 WeakSet 追踪已访问对象，遇到循环引用时替换为 [Circular]
    const seen = new WeakSet();
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  }
}

/**
 * 格式化日志消息，附带时间戳和可选作用域。
 */
function formatMessage(scope: string | undefined, message: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const scopeStr = scope ? `[${scope}] ` : '';
  const argsStr = args.length > 0
    ? ' ' + args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ')
    : '';
  return `${timestamp} ${scopeStr}${message}${argsStr}\n`;
}

/**
 * 根据环境输出日志。
 *
 * 所有环境都输出到 console.error（renderer 用 console.log）。
 * Electron 主进程还会通过 electron-log 写入 main.log。
 */
function output(formatted: string): void {
  const env = detectEnvironment();

  // 如果可用，把 debug 日志同时镜像到 electron-log，使其出现在 main.log
  if (env === 'electron-main') {
    const log = getElectronLog();
    log?.info?.(formatted.trim());
  }

  if (env === 'electron-renderer') {
    // renderer 中使用 console.log，方便 DevTools 查看
    console.log(formatted.trim());
  } else if (typeof process !== 'undefined' && process.stderr) {
    // 主进程/CLI 使用 stderr，避免干扰 stdout
    process.stderr.write(formatted);
  } else {
    // 意外环境回退到 console
    console.log(formatted.trim());
  }
}

/**
 * Debug 日志工具，根据环境自动路由。
 * 仅在通过 --debug 启用 debug 模式时才会输出。
 *
 * 输出路由：
 * - Electron 主进程：console + 文件
 * - Electron 渲染进程：console（DevTools）
 * - CLI/脚本：console
 *
 * @example
 * debug('Processing request')
 * debug('User data', { id: 123 })
 */
export function debug(message: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return;
  output(formatMessage(undefined, message, args));
}

/**
 * 创建带作用域的 logger。
 * 作用域会显示在方括号中：[scope] message
 *
 * @example
 * const log = createLogger('agent');
 * log.debug('Starting session');
 * log.info('Connected to MCP');
 * log.error('Failed to connect', error);
 */
export function createLogger(scope: string) {
  const logWithLevel = (level: string, message: string, args: unknown[]) => {
    if (!isDebugEnabled()) return;
    const levelStr = level.toUpperCase().padEnd(5);
    output(formatMessage(scope, `${levelStr} ${message}`, args));
  };

  return {
    debug: (message: string, ...args: unknown[]) => logWithLevel('debug', message, args),
    info: (message: string, ...args: unknown[]) => logWithLevel('info', message, args),
    warn: (message: string, ...args: unknown[]) => logWithLevel('warn', message, args),
    error: (message: string, ...args: unknown[]) => logWithLevel('error', message, args),
  };
}

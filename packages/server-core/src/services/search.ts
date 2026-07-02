/**
 * 会话内容搜索服务
 *
 * 文件职责：
 *   - 使用 ripgrep 在会话 JSONL 文件中搜索用户/助手消息内容。
 *   - 返回按会话聚合的匹配结果，包含会话 ID、行号和上下文摘要。
 *   - 支持取消进行中的搜索、超时控制、大小写不敏感等选项。
 *
 * 实现要点：
 *   - 不在 Node.js 中逐行读取大文件，而是把过滤逻辑下沉到 ripgrep，
 *     减少 70% 以上的数据传输。
 *   - ripgrep 输出 JSON（--json），Node.js 侧只做轻量解析与摘要提取。
 *   - 摘要提取使用正则而非 JSON.parse，避免对超大消息行做完整反序列化。
 *
 * 与 Golang 的类比：
 *   - `spawn` 启动子进程类似 Golang 的 `exec.Command`；
 *     这里通过 EventEmitter（stdout.on('data')）流式读取输出，
 *     类似 Golang 中 `cmd.StdoutPipe()` + `bufio.Scanner`。
 *   - `SearchUnavailableError` 是自定义错误类，约等于 Golang 中定义一个 error 变量
 *     `var ErrSearchUnavailable = errors.New(...)`，调用方可用 `instanceof` 或 `.name` 判断。
 *
 * TS 特性小记：
 *   - `Record<string, unknown>` 表示“任意字符串键，值类型未知”，比 `any` 更安全。
 *   - 函数返回 `Promise<SessionSearchResult[]>` 声明异步函数返回的 Promise 解析值类型。
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolveBackendHostTooling } from '@craft-agent/shared/agent/backend';
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform';

/**
 * 搜索服务不可用错误。
 * 典型原因：ripgrep 二进制未找到。客户端应捕获并展示“搜索不可用”而非“0 结果”。
 */
export class SearchUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SearchUnavailableError';
  }
}

/** 当前正在执行的 ripgrep 进程；新搜索到来时先取消旧进程 */
let currentSearchProcess: ChildProcess | null = null;

/** 模块级 PlatformServices 引用；通过 setSearchPlatform() 注入 */
let _platform: PlatformServices | null = null;

/** 作用域日志器；setSearchPlatform() 注入真实 logger 后自动升级 */
let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler');
let searchLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'search');

/**
 * 注入平台服务与日志器。
 * @param platform - 运行时平台上下文
 */
export function setSearchPlatform(platform: PlatformServices): void {
  _platform = platform;
  handlerLog = createScopedLogger(platform.logger, 'handler');
  searchLog = createScopedLogger(platform.logger, 'search');
}

/** 单条匹配结果 */
export interface SearchMatch {
  /** 会话 ID（从文件路径解析） */
  sessionId: string;
  /** 在 JSONL 文件中的行号 */
  lineNumber: number;
  /** 带上下文的匹配摘要 */
  snippet: string;
  /** 原始匹配文本（不带上下文） */
  matchText: string;
}

/** 单个会话的聚合搜索结果 */
export interface SessionSearchResult {
  sessionId: string;
  /** 该会话中匹配总数 */
  matchCount: number;
  /** 前几条带上下文的匹配 */
  matches: SearchMatch[];
}

/** 搜索选项 */
export interface SearchOptions {
  /** 最大等待时间（毫秒）。默认：5000 */
  timeout?: number;
  /** 每个会话最多返回几条匹配。默认：3 */
  maxMatchesPerSession?: number;
  /** 最多返回多少个会话。默认：50 */
  maxSessions?: number;
  /** 是否忽略大小写。默认：true */
  ignoreCase?: boolean;
  /** 搜索 ID，用于跨阶段日志关联 */
  searchId?: string;
}

/**
 * 获取 ripgrep 可执行文件路径。
 * 路径发现委托给后端运行时工具解析器，支持开发/打包不同布局。
 * @returns ripgrep 路径；未初始化时抛出错误
 */
function getRipgrepPath(): string | undefined {
  if (!_platform) throw new Error('setSearchPlatform() must be called before search');
  const { ripgrepPath } = resolveBackendHostTooling({
    hostRuntime: {
      appRootPath: _platform.appRootPath,
      resourcesPath: _platform.resourcesPath,
      isPackaged: _platform.isPackaged,
    },
  });
  return ripgrepPath;
}

/**
 * 转义字符串中的正则特殊字符。
 * @param str - 原始查询字符串
 * @returns 可用于安全构造正则的字面量字符串
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从原始 JSON 行中快速提取摘要，避免完整 JSON.parse。
 * 优先提取 "content" 字段，其次是 text block，最后是行内窗口。
 *
 * @param rawLine - ripgrep 输出的原始匹配行
 * @param matchText - 匹配文本，用于定位窗口
 * @param maxLength - 摘要最大长度，默认 150
 * @returns 提取的摘要字符串
 */
function extractSnippetFast(rawLine: string, matchText: string, maxLength = 150): string {
  try {
    // 用正则提取 "content" 字段值
    // 同时兼容字符串 content 与数组 content 的开头
    const contentMatch = rawLine.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    if (contentMatch) {
      // 普通字符串 content：反转义并提取匹配点周围的窗口
      const content = contentMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      const lowerContent = content.toLowerCase();
      const lowerMatch = matchText.toLowerCase();
      const matchPos = lowerContent.indexOf(lowerMatch);

      if (matchPos >= 0) {
        const halfLength = Math.floor(maxLength / 2);
        const start = Math.max(0, matchPos - halfLength);
        const end = Math.min(content.length, start + maxLength);

        let snippet = content.slice(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < content.length) snippet = snippet + '...';
        return snippet;
      }

      // 匹配点不在 content 字段内，返回 content 开头
      if (content.length > maxLength) {
        return content.slice(0, maxLength) + '...';
      }
      return content;
    }

    // content 可能是数组（Claude 格式），提取第一个 text block
    const textBlockMatch = rawLine.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (textBlockMatch) {
      const text = textBlockMatch[1]
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

      if (text.length > maxLength) {
        return text.slice(0, maxLength) + '...';
      }
      return text;
    }

    // 兜底：在原始行内围绕匹配点提取窗口
    const lowerLine = rawLine.toLowerCase();
    const lowerMatch = matchText.toLowerCase();
    const matchPos = lowerLine.indexOf(lowerMatch);

    if (matchPos >= 0) {
      const halfLength = Math.floor(maxLength / 2);
      const start = Math.max(0, matchPos - halfLength);
      const end = Math.min(rawLine.length, start + maxLength);
      let snippet = rawLine.slice(start, end).replace(/\\n/g, ' ');
      if (start > 0) snippet = '...' + snippet;
      if (end < rawLine.length) snippet = snippet + '...';
      return snippet;
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * 使用 ripgrep 搜索会话内容。
 *
 * 过滤策略：
 *   - 只搜索 session.jsonl 文件；
 *   - 通过正则要求 "type":"user|assistant" 与 query 同时出现在同一行，
 *     跳过 tool_result 等超大行；
 *   - 解析后跳过 isIntermediate=true 的临时消息与 base64 内容，减少误报。
 *
 * @param query - 搜索关键词（纯文本，会自动转义）
 * @param sessionsDir - 会话目录路径
 * @param options - 搜索选项
 * @returns 按匹配数降序排列的会话结果数组
 */
export async function searchSessions(
  query: string,
  sessionsDir: string,
  options: SearchOptions = {}
): Promise<SessionSearchResult[]> {
  const {
    timeout = 5000,
    maxMatchesPerSession = 3,
    maxSessions = 50,
    ignoreCase = true,
    searchId = Date.now().toString(36),
  } = options;

  if (!query.trim()) {
    return [];
  }

  const startTime = Date.now();
  searchLog.info('ripgrep:start', { searchId, query });

  const rgPath = getRipgrepPath();
  handlerLog.debug('[search] Ripgrep path:', rgPath);
  if (!rgPath || !existsSync(rgPath)) {
    handlerLog.error('[search] ripgrep binary not found:', rgPath);
    throw new SearchUnavailableError(`ripgrep binary not found: ${rgPath ?? 'undefined'}`);
  }

  handlerLog.debug('[search] Sessions directory:', sessionsDir);
  if (!existsSync(sessionsDir)) {
    handlerLog.warn('[search] Sessions directory not found:', sessionsDir);
    return [];
  }

  return new Promise((resolve) => {
    const results = new Map<string, SessionSearchResult>();
    let buffer = '';

    // 构造 ripgrep 参数
    const args = [
      '--json',           // JSON 输出格式（NDJSON）
      '--max-count', '10', // 每文件最多 10 条匹配，防止结果过大
      '-g', '**/session.jsonl', // 只搜索 session.jsonl 文件
    ];

    if (ignoreCase) {
      args.push('-i');
    }

    // 构造正则过滤条件：
    // 1. 只匹配 user/assistant 消息行（跳过超大的 tool_result 行）
    // 2. 要求 query 出现在同一行内
    // 这样在 ripgrep 层就完成过滤，避免向 Node.js 传输 70 倍以上的无关数据。
    //
    // 注意："type" 字段位置不固定；messageToStored() 先用 rest-spread 再写入 type，
    // 因此 "type" 可能出现在 JSON 行的任意位置，而不仅在 "id" 之后。
    const escapedQuery = escapeRegex(query);
    args.push('-e', `"type":"(user|assistant)".*${escapedQuery}|${escapedQuery}.*"type":"(user|assistant)"`);
    args.push(sessionsDir);

    // 若旧搜索仍在运行则取消（用户输入了新查询）
    if (currentSearchProcess) {
      // Windows 没有 SIGTERM，直接 kill；其余平台发送 SIGTERM
      if (process.platform === 'win32') {
        currentSearchProcess.kill();
      } else {
        currentSearchProcess.kill('SIGTERM');
      }
      currentSearchProcess = null;
    }

    const rg = spawn(rgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    currentSearchProcess = rg;

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      // Windows 没有 SIGTERM，直接 kill；其余平台发送 SIGTERM
      if (process.platform === 'win32') {
        rg.kill();
      } else {
        rg.kill('SIGTERM');
      }
      handlerLog.warn('[search] Search timed out after', timeout, 'ms');
    }, timeout);

    rg.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // 处理完整行
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 不完整的行保留在缓冲区

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const result = JSON.parse(line);

          // 只处理 'match' 类型结果
          if (result.type !== 'match') continue;

          const data = result.data;
          const filePath = data.path?.text;
          if (!filePath) continue;

          // 从路径解析 session ID：.../sessions/{sessionId}/session.jsonl
          const pathParts = filePath.split(/[/\\]/);
          const jsonlIndex = pathParts.findIndex((p: string) => p === 'session.jsonl');
          if (jsonlIndex < 1) continue;

          const sessionId = pathParts[jsonlIndex - 1];
          if (!sessionId) continue;

          // 跳过 JSONL 文件头（第 1 行）
          const lineNumber = data.line_number;
          if (lineNumber === 1) continue;

          // 获取原始行内容
          const rawLine = data.lines?.text || '';

          // 通过快速字符串搜索跳过中间消息，无需 JSON.parse
          // 比解析整行消息 JSON 快得多
          if (rawLine.includes('"isIntermediate":true')) continue;

          // 跳过 base64 编码内容（图片、附件）
          // 查询词可能命中 base64 噪声，产生误报。
          // 覆盖 content block（"type":"base64"）与附件缩略图。
          if (rawLine.includes('base64')) continue;

          // 获取或创建该会话的结果对象
          let sessionResult = results.get(sessionId);
          if (!sessionResult) {
            sessionResult = {
              sessionId,
              matchCount: 0,
              matches: [],
            };
            results.set(sessionId, sessionResult);
          }

          sessionResult.matchCount += data.submatches?.length || 1;

          // 只为前 maxSessions 个会话提取摘要（其余只做计数）
          // ripgrep 继续计数，方便 UI 展示“共 X 个会话，显示前 Y 个”
          if (results.size <= maxSessions && sessionResult.matches.length < maxMatchesPerSession) {
            const matchText = data.submatches?.[0]?.match?.text || query;

            // 使用快速摘要提取（避免 JSON.parse）
            sessionResult.matches.push({
              sessionId,
              lineNumber,
              snippet: extractSnippetFast(rawLine, matchText),
              matchText,
            });
          }
        } catch (e) {
          // 跳过格式错误的 JSON 行
          handlerLog.debug('[search] Failed to parse ripgrep output:', e);
        }
      }
    });

    rg.stderr.on('data', (data: Buffer) => {
      handlerLog.warn('[search] ripgrep stderr:', data.toString());
    });

    // 记录实际执行的命令
    handlerLog.debug('[search] Running ripgrep:', rgPath, args.join(' '));

    rg.on('close', (code) => {
      clearTimeout(timeoutHandle);
      // 若当前搜索仍是本次搜索，则清空引用
      if (currentSearchProcess === rg) {
        currentSearchProcess = null;
      }

      if (code !== 0 && code !== 1) {
        // 退出码 1 表示未找到匹配，不算错误
        handlerLog.debug('[search] ripgrep exited with code:', code);
      }

      // 将 Map 转成数组，并按匹配数降序排列
      const resultArray = Array.from(results.values());
      resultArray.sort((a, b) => b.matchCount - a.matchCount);

      searchLog.info('ripgrep:complete', {
        searchId,
        durationMs: Date.now() - startTime,
        totalSessions: results.size,
        returnedSessions: Math.min(resultArray.length, maxSessions),
      });

      resolve(resultArray);
    });

    rg.on('error', (error) => {
      clearTimeout(timeoutHandle);
      handlerLog.error('[search] ripgrep error:', error);
      resolve([]);
    });
  });
}

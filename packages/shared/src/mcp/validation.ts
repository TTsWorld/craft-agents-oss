/**
 * MCP 连接校验
 *
 * 通过 CraftMcpClient 直接连接 HTTP/SSE MCP server 并列出工具，
 * 避免 spawning Claude Code 子进程（在 Electron macOS sandbox 下会被杀掉，见 issue #697）。
 */

import { CraftMcpClient } from './client.js';
import { debug } from '../utils/debug.ts';
import { normalizeMcpUrl } from '../sources/server-builder.ts';
import type { McpTransport } from '../sources/types.ts';

/**
 * 记录某个工具输入模式（input schema）里不合法的属性。
 */
export interface InvalidProperty {
  toolName: string;
  propertyPath: string;
  propertyKey: string;
}

/**
 * MCP 校验结果。
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  // 联合类型字面量：errorType 只能从这几个字符串里取值，类似 Go 的 const 枚举。
  errorType?: 'failed' | 'needs-auth' | 'pending' | 'invalid-schema' | 'disabled' | 'unknown';
  serverInfo?: {
    name: string;
    version: string;
  };
  invalidProperties?: InvalidProperty[];
  /** 连接成功时返回 server 上可用的工具名列表 */
  tools?: string[];
}

/**
 * 工具输入模式（input schema）中合法属性名的正则。
 * 允许：字母、数字、下划线、点、横线，长度 1-64。
 *
 * 这是 Anthropic API 在服务端强制执行的规则，
 * MCP 规范本身并没有对属性名做限制，
 * @anthropic-ai/sdk 和 @anthropic-ai/claude-agent-sdk 也没有导出这个规则。
 *
 * 违反时的 API 错误示例：
 * "tools.0.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'"
 *
 * @see https://github.com/modelcontextprotocol/go-sdk/issues/169 - 确认这是 Claude 特有的限制
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 */
export const ANTHROPIC_PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * 递归查找 JSON schema 中不符合命名规则的所有属性名，返回带路径的列表。
 */
function findInvalidProperties(
  schema: Record<string, unknown>,
  path = ''
): { path: string; key: string }[] {
  const invalid: { path: string; key: string }[] = [];

  if (!schema || typeof schema !== 'object') {
    return invalid;
  }

  // 检查 properties 对象里的每个属性名。
  if (schema.properties && typeof schema.properties === 'object') {
    // `as Record<string, unknown>` 是类型断言：把 unknown 类型的对象转换成可索引字典。
    const properties = schema.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (!ANTHROPIC_PROPERTY_NAME_PATTERN.test(key)) {
        invalid.push({
          path: path ? `${path}.${key}` : key,
          key,
        });
      }
      // 递归检查嵌套 schema。
      const nestedSchema = properties[key];
      if (nestedSchema && typeof nestedSchema === 'object') {
        invalid.push(
          ...findInvalidProperties(
            nestedSchema as Record<string, unknown>,
            path ? `${path}.${key}` : key
          )
        );
      }
    }
  }

  // 检查数组 items 的 schema。
  if (schema.items && typeof schema.items === 'object') {
    invalid.push(
      ...findInvalidProperties(
        schema.items as Record<string, unknown>,
        path ? `${path}[]` : '[]'
      )
    );
  }

  // 检查 additionalProperties 如果是 schema 对象。
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    invalid.push(
      ...findInvalidProperties(
        schema.additionalProperties as Record<string, unknown>,
        path ? `${path}.<additionalProperties>` : '<additionalProperties>'
      )
    );
  }

  return invalid;
}

/**
 * HTTP/SSE MCP 连接的校验配置。
 */
export interface McpValidationConfig {
  /** MCP server URL */
  mcpUrl: string;
  /** 传输类型：'http' 或 'sse'，默认 'http' */
  mcpTransport?: McpTransport;
  /** 自定义请求头（在认证头之前合并） */
  mcpHeaders?: Record<string, string>;
  /** MCP server 的 access token（OAuth 或 bearer） */
  mcpAccessToken?: string;
}

/**
 * 把底层连接错误映射成用户可理解的结果。
 * 这里是启发式规则，原始错误消息仍然是第一信息来源。
 */
function classifyConnectionError(err: unknown): McpValidationResult {
  const message = err instanceof Error ? err.message : String(err);
  let errorType: McpValidationResult['errorType'] = 'failed';
  // 正则匹配 401/403/unauthorized/forbidden/authentication 等关键字，判断为认证问题。
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication/i.test(message)) {
    errorType = 'needs-auth';
  }
  return {
    success: false,
    error: message || 'Validation failed',
    errorType,
  };
}

/**
 * 校验 HTTP/SSE MCP 连接：用 CraftMcpClient 连接并列出工具。
 * 内部 connect() 本身就会做一次 listTools() 健康检查，所以 connect 成功即证明 server 可达且正常。
 */
export async function validateMcpConnection(
  config: McpValidationConfig
): Promise<McpValidationResult> {
  debug('Validating MCP connection to', config.mcpUrl);

  const mcpUrl = normalizeMcpUrl(config.mcpUrl);

  // 自定义头优先，认证头覆盖。
  const headers = {
    ...config.mcpHeaders,
    ...(config.mcpAccessToken ? { Authorization: `Bearer ${config.mcpAccessToken}` } : {}),
  };

  // CraftMcpClient 只支持 HTTP 传输；SSE server 会在连接时报明确的错误。
  // Streamable HTTP 是现代推荐传输方式。
  const mcpClient = new CraftMcpClient({
    transport: 'http',
    url: mcpUrl,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  try {
    await mcpClient.connect();
    const serverInfo = mcpClient.getServerInfo();

    const tools = await mcpClient.listTools();
    const toolNames = tools.map((t) => t.name);

    debug(`Validating schemas for ${tools.length} tools`);

    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      const toolsWithIssues = [
        ...new Set(allInvalidProperties.map((p) => p.toolName)),
      ];
      return {
        success: false,
        error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
        errorType: 'invalid-schema',
        serverInfo,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      serverInfo,
      tools: toolNames,
    };
  } catch (err) {
    debug('[mcp-validation] error:', err instanceof Error ? err.message : err);
    return classifyConnectionError(err);
  } finally {
    await mcpClient.close().catch(() => {});
  }
}

/**
 * stdio MCP 连接的校验配置。
 */
export interface StdioValidationConfig {
  /** 要启动的命令（如 'npx'、'node'） */
  command: string;
  /** 传给命令的参数 */
  args?: string[];
  /** 子进程环境变量 */
  env?: Record<string, string>;
  /** 超时时间，单位毫秒，默认 30000 */
  timeout?: number;
}

/**
 * 连接阶段看门狗，由两个协作的定时器组成：
 *
 *  - **Idle 定时器**：stderr 静默 idleMs 后触发。每次 `kick()`（通常来自 stderr data 回调）会重置。
 *    用于捕获“子进程突然安静、初始化卡住”的情况。
 *  - **Ceiling 定时器**：从创建开始无条件经过 ceilingMs 后触发。硬上限，防止 stderr 一直有输出
 *    但始终没完成 initialize  handshake 的 server 永远占着连接阶段。
 *
 * `outcome()` 返回哪个定时器先触发（如果 connect 先完成则返回 null）。
 */
interface ConnectWatchdog {
  promise: Promise<never>;
  kick: () => void;
  stop: () => void;
  outcome: () => 'idle' | 'ceiling' | null;
}

function createConnectWatchdog(
  idleMs: number,
  ceilingMs: number,
): ConnectWatchdog {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let outcome: 'idle' | 'ceiling' | null = null;
  let stopped = false;
  let rejectFn: ((err: Error) => void) | null = null;

  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });
  // 如果 connect 赢了 race，这个 promise 不会触发；捕获一下避免未处理 rejection 警告。
  promise.catch(() => {});

  const fire = (kind: 'idle' | 'ceiling') => {
    if (outcome || stopped) return;
    outcome = kind;
    if (idleTimer) clearTimeout(idleTimer);
    if (ceilingTimer) clearTimeout(ceilingTimer);
    idleTimer = null;
    ceilingTimer = null;
    rejectFn?.(
      new Error(
        kind === 'idle'
          ? `Timeout: MCP initialize did not complete within ${idleMs}ms of stderr silence`
          : `Timeout: MCP initialize did not complete within the ${ceilingMs}ms ceiling`,
      ),
    );
  };

  const arm = () => {
    if (outcome || stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire('idle'), idleMs);
  };

  ceilingTimer = setTimeout(() => fire('ceiling'), ceilingMs);
  arm();

  return {
    promise,
    kick: arm,
    stop: () => {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      idleTimer = null;
      ceilingTimer = null;
    },
    outcome: () => outcome,
  };
}

/**
 * 校验 stdio MCP 连接：启动子进程、通过 stdio transport 连接并列出工具。
 *
 * 和 HTTP 校验不同，这里真的会 spawning MCP server 进程，连接它并校验可用工具。
 *
 * 进程生命周期完全由 `StdioClientTransport` 拥有——我们不会再 spawning 第二份 server。
 * 早期版本会 spawning 两次，导致第一个子进程占着管道没人消费，从而出现
 * "Server startup timeout" 的症状（见 #787）。
 */
export async function validateStdioMcpConnection(
  config: StdioValidationConfig
): Promise<McpValidationResult> {
  const { command, args = [], env = {}, timeout = 30000 } = config;

  // 连接阶段使用双看门狗。大多数 "MCP 用不了" 的失败都是 initialize handshake 没完成；
  // 但合法的冷缓存安装（uv tool run / npx / pipx）可能一边输出 stderr 一边要花 20 多秒。
  // idle 定时器会在每次 stderr 输出时重置，所以冷安装不会被误杀；
  // ceiling 定时器则保证最坏情况下不会让验证无限拖下去。
  const connectIdleMs = Math.min(8000, Math.max(1000, Math.floor(timeout / 2)));
  const listToolsFloor = 2000;
  const connectCeilingMs = Math.max(connectIdleMs, timeout - listToolsFloor);
  let listToolsTimeoutResolved = listToolsFloor;

  debug(`[stdio-validation] Spawning: ${command} ${args.join(' ')}`);

  // 动态导入 SDK：在需要时才加载，避免启动时就把整个 client 包拉进来。
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  );

  // `InstanceType<typeof Client>` 是 TS 工具类型：获取类构造函数的实例类型，
  // 等价于 Go 里用接口持有具体对象指针。
  let client: InstanceType<typeof Client> | null = null;
  let transport: InstanceType<typeof StdioClientTransport> | null = null;
  let stderrOutput = '';
  // 记录失败发生在哪个阶段，方便给出更精确的诊断信息。
  let phase: 'connect' | 'list-tools' | 'unknown' = 'unknown';

  const cleanup = async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // 关闭错误忽略即可，尽力而为。
      }
      client = null;
    }
    if (transport) {
      try {
        await transport.close();
      } catch {
        // SDK 内部会杀掉子进程；关闭异常忽略。
      }
      transport = null;
    }
  };

  // 合并环境变量前先把 process.env 里的 undefined 过滤掉。
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      processEnv[key] = value;
    }
  }

  // 泛型工具函数：给任意 Promise 包一层超时。
  // `<T>` 类似 Go 的泛型 `func WithTimeout[T any](...) (T, error)`。
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(id);
          resolve(v);
        },
        (e) => {
          clearTimeout(id);
          reject(e);
        },
      );
    });
  };

  try {
    transport = new StdioClientTransport({
      command,
      args,
      env: { ...processEnv, ...env },
      stderr: 'pipe',
    });

    const watchdog = createConnectWatchdog(connectIdleMs, connectCeilingMs);

    // SDK 在 `start()` 之前就暴露了一个 PassThrough stderr，所以这个监听器能捕获早期启动输出。
    // 每次 stderr 输出都会重置 idle 看门狗，避免 uv/uvx/npx 等冷缓存安装因输出进度时静默超时被误判。
    transport.stderr?.on('data', (data: Buffer | string) => {
      stderrOutput += typeof data === 'string' ? data : data.toString();
      if (stderrOutput.length > 10000) {
        stderrOutput = stderrOutput.slice(-10000);
      }
      watchdog.kick();
    });

    client = new Client(
      { name: 'craft-agent-validator', version: '1.0.0' },
      { capabilities: {} }
    );

    phase = 'connect';
    const connectStart = Date.now();
    try {
      await Promise.race([client.connect(transport), watchdog.promise]);
    } finally {
      watchdog.stop();
    }
    const elapsedConnect = Date.now() - connectStart;
    listToolsTimeoutResolved = Math.max(listToolsFloor, timeout - elapsedConnect);

    phase = 'list-tools';
    const toolsResult = await withTimeout(
      client.listTools(),
      listToolsTimeoutResolved,
      'tools/list',
    );
    const tools = toolsResult.tools || [];
    const toolNames = tools.map((t: { name: string }) => t.name);

    debug(`[stdio-validation] Found ${tools.length} tools`);

    // 校验工具 schema 的属性命名。
    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      const toolsWithIssues = [
        ...new Set(allInvalidProperties.map((p) => p.toolName)),
      ];
      return {
        success: false,
        error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
        errorType: 'invalid-schema' as const,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      tools: toolNames,
      serverInfo: {
        name: command,
        version: args.join(' '),
      },
    };
  } catch (err) {
    const error = err as Error;
    debug(`[stdio-validation] Error in phase=${phase}: ${error.message}`);

    const stderrSnippet = stderrOutput.trim().slice(-500);
    const errorType: McpValidationResult['errorType'] = 'failed';
    let errorMessage: string;

    // 对 initialize handshake 期间的失败给出提示：
    // 很多从其他 RPC 习惯迁移过来的用户最容易犯的错误是 stdout 帧格式不对。
    // MCP stdio 规范要求换行分隔的 JSON-RPC；而 LSP 常用的 `Content-Length: …\r\n\r\n{json}`
    // 是典型误用，会根据缓冲区切分不同表现为 timeout 或 "Connection closed"。
    const framingHint =
      'Check that the server speaks newline-delimited JSON-RPC (MCP stdio spec) on stdout, not LSP-style Content-Length framing.';

    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      errorMessage = `Command not found: "${command}". Install the required dependency and try again.`;
    } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
      errorMessage = `Permission denied running "${command}". Check file permissions.`;
    } else if (error.message.includes('Timeout')) {
      // 按阶段细分：connect 阶段的 timeout 更有诊断价值，list-tools 阶段则不同。
      if (phase === 'connect') {
        // connect 阶段有两个看门狗来源：
        //   - "stderr silence"：stderr 静默后没完成 init，通常是帧格式错误或 handshake 卡住；
        //   - "ceiling"：stderr 一直在输出但始终没完成 init，可能是入口点不对或陷入安装循环。
        if (error.message.includes('stderr silence')) {
          errorMessage = stderrSnippet
            ? `MCP initialize not acknowledged within ${connectIdleMs}ms of stderr silence. ${framingHint}\nstderr (tail):\n${stderrSnippet}`
            : `MCP initialize not acknowledged within ${connectIdleMs}ms of stderr silence and the server produced no stderr output. ${framingHint}`;
        } else if (error.message.includes('ceiling')) {
          errorMessage = stderrSnippet
            ? `MCP server kept emitting startup output for ${connectCeilingMs}ms but never completed the \`initialize\` handshake. Check that the command actually launches an MCP server (not just a package installer or build step).\nstderr (tail):\n${stderrSnippet}`
            : `MCP server hit the ${connectCeilingMs}ms connect ceiling without completing the \`initialize\` handshake. Check that the command actually launches an MCP server (not just a package installer or build step).`;
        } else {
          // 防御性 fallback，防止其他 Timeout 消息形状漏进来。
          errorMessage = stderrSnippet
            ? `MCP initialize did not complete within ${connectCeilingMs}ms.\nstderr (tail):\n${stderrSnippet}`
            : `MCP initialize did not complete within ${connectCeilingMs}ms.`;
        }
      } else if (phase === 'list-tools') {
        errorMessage = stderrSnippet
          ? `tools/list did not respond within ${listToolsTimeoutResolved}ms.\nstderr (tail):\n${stderrSnippet}`
          : `tools/list did not respond within ${listToolsTimeoutResolved}ms.`;
      } else {
        errorMessage = stderrSnippet
          ? `Server did not respond within ${timeout}ms.\nstderr (tail):\n${stderrSnippet}`
          : `Server did not respond within ${timeout}ms.`;
      }
    } else if (phase === 'connect') {
      // connect 阶段其他错误（Connection closed、parse error 等）也归结为协议问题，优先提示帧格式。
      errorMessage = stderrSnippet
        ? `MCP initialize failed: ${error.message}. ${framingHint}\nstderr (tail):\n${stderrSnippet}`
        : `MCP initialize failed: ${error.message}. ${framingHint}`;
    } else if (stderrSnippet) {
      errorMessage = `${error.message}\nstderr (tail):\n${stderrSnippet}`;
    } else {
      errorMessage = error.message;
    }

    return {
      success: false,
      error: errorMessage,
      errorType,
    };
  } finally {
    await cleanup();
  }
}

/**
 * 根据校验结果生成用户友好的错误信息。
 * 可传入 transport 上下文来区分本地 stdio 与远程失败。
 */
export function getValidationErrorMessage(
  result: McpValidationResult,
  context?: { transport?: string }
): string {
  // 优先使用 result.error，它通常最具体。
  if (result.error) return result.error;

  switch (result.errorType) {
    case 'failed':
      // 区分本地 stdio server（进程崩溃/未启动）和远程 server（不可达）。
      if (context?.transport === 'stdio') {
        return 'Server process not running or failed to start.';
      }
      return 'Server unreachable - check the URL and your network.';
    case 'needs-auth':
      return 'Authentication expired or was revoked.';
    case 'pending':
      return 'Connection is still pending - try again.';
    case 'invalid-schema':
      return 'Server has tools with invalid property names.';
    case 'unknown':
    default:
      return 'Connection failed - check source configuration.';
  }
}

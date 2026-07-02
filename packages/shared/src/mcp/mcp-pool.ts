/**
 * 集中式 MCP 客户端连接池。
 *
 * 在 Electron 主进程中持有所有 MCP source 的连接。
 * 后端（Claude、Pi 等）拿到代理工具定义后，统一通过本池来调用工具，
 * 而不需要各自维护 MCP 连接。
 *
 * 这样做的好处：
 * - 所有后端共用一套 MCP 代码路径；
 * - 同一连接可在多个 session 间复用（例如共用同一个 Linear 连接）；
 * - 不需要凭证缓存文件，主进程可直接访问；
 * - 运行时切换 source 不需要重启 session。
 */

// 从 client.ts 导入实现类，并用 `type` 只导入类型；
// `type` 告诉 TS 这些符号仅在类型检查阶段使用，不会生成运行时 import。
import { CraftMcpClient, type McpClientConfig, type PoolClient } from './client.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

/**
 * 进程内 API source server 的配置。
 * sync() 用它来和远程 MCP source 一起管理连接。
 */
export interface ApiServerConfig {
  type: 'sdk';
  instance: McpServer;
}

/**
 * 代理工具定义：传给后端注册时用的格式。
 * 名字遵循 `mcp__{slug}__{toolName}` 的约定。
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * MCP 工具调用的结果，格式与外部子进程协议对齐。
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  /** 失败时用来标注是哪个 source 出的错 */
  sourceSlug?: string;
}

/**
 * 把后端使用的 SdkMcpServerConfig 转成 CraftMcpClient 能识别的 McpClientConfig。
 */
function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
  if (config.type === 'http' || config.type === 'sse') {
    return {
      transport: 'http',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }
  return null;
}

/**
 * 判断某个 MCP source 的配置是否发生了需要重新连接的变化。
 * 主要比较认证头（token 刷新）和 URL 变化；忽略 stdio source，因为它们不使用 OAuth token。
 */
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    if (oldConfig.url !== newConfig.url) return true;
    const oldAuth = oldConfig.headers?.['Authorization'];
    const newAuth = newConfig.headers?.['Authorization'];
    if (oldAuth !== newAuth) return true;
  }

  return false;
}

/**
 * MCP 客户端连接池：统一管理所有 source 的连、断、工具发现、调用。
 */
export class McpClientPool {
  /** 当前活跃的 MCP 客户端，按 source slug 索引。 */
  private clients = new Map<string, PoolClient>();

  /** 当前活跃连接使用的配置，sync() 时用来检测配置变化。 */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /** 每个 source 缓存的工具列表，按 slug 索引。 */
  private toolCache = new Map<string, Tool[]>();

  /** 代理工具名 → { slug, originalName }，例如 "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" } */
  private proxyTools = new Map<string, { slug: string; originalName: string }>();

  /** 可选的调试日志回调。 */
  private debugFn: ((msg: string) => void) | undefined;

  /** 当前 workspace 的根路径，用于过滤本地 MCP。 */
  private workspaceRootPath?: string;

  /** session 存储路径，用于保存大结果或二进制文件。 */
  private sessionPath?: string;

  /** 大结果摘要回调，收到超大响应时用来生成摘要。 */
  private summarizeCallback?: (prompt: string) => Promise<string | null>;

  /** sync() 连接/断开 source 后调用，通知外部工具列表已变。 */
  onToolsChanged?: () => void;

  constructor(options?: { debug?: (msg: string) => void; workspaceRootPath?: string; sessionPath?: string }) {
    // `options?.debug` 是可选链：options 可能为 undefined，有值才取字段。
    this.debugFn = options?.debug;
    this.workspaceRootPath = options?.workspaceRootPath;
    this.sessionPath = options?.sessionPath;
  }

  /**
   * 设置大结果摘要回调。
   * 通常在创建 agent 后调用：pool.setSummarizeCallback(agent.getSummarizeCallback())
   */
  setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
    this.summarizeCallback = fn;
  }

  // 私有调试方法，统一加前缀。
  private debug(msg: string): void {
    this.debugFn?.(`[McpClientPool] ${msg}`);
  }

  // ============================================================
  // 连接生命周期
  // ============================================================

  /**
   * 注册一个客户端：连上、缓存工具、建立代理映射。
   * 供远程 MCP 和进程内 API source 共用。
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() 内部会自动触发 connect()，CraftMcpClient 和 ApiSourcePoolClient 都是如此。
    const tools = await client.listTools();
    this.clients.set(slug, client);
    this.toolCache.set(slug, tools);

    for (const tool of tools) {
      const proxyName = `mcp__${slug}__${tool.name}`;
      this.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }

    this.debug(`Connected source ${slug}: ${tools.length} tools`);
  }

  /**
   * 连接一个远程 MCP source（HTTP / SSE / stdio）。
   * 如果已经连接，则什么都不做。
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (this.clients.has(slug)) return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      // `as { type: string }` 是类型断言：告诉 TS 把 config 当成有 type 字段的对象读取。
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    await this.registerClient(slug, new CraftMcpClient(clientConfig));
    this.activeConfigs.set(slug, config);
  }

  /**
   * 连接一个进程内的 MCP server（API source），通过内存 transport 通信。
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    if (this.clients.has(slug)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer));
  }

  /**
   * 断开某个 source 的连接，并清除它的工具映射。
   */
  async disconnect(slug: string): Promise<void> {
    const client = this.clients.get(slug);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(slug);
    }

    // 删除该 slug 对应的所有代理工具条目。
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName);
    }
    this.toolCache.delete(slug);
    this.activeConfigs.delete(slug);
    this.debug(`Disconnected source: ${slug}`);
  }

  /**
   * 断开所有 source 并清空所有状态。
   */
  async disconnectAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map(c => c.close().catch(() => {}));
    await Promise.all(closePromises);
    this.clients.clear();
    this.toolCache.clear();
    this.proxyTools.clear();
    this.activeConfigs.clear();
    this.debug('Disconnected all MCP clients');
  }

  // ============================================================
  // Sync：把实际连接对齐到期望的 source 集合
  // ============================================================

  /**
   * 让连接池和期望的 MCP + API source 集合保持一致。
   * 新 source 连上，移除不需要的 source，保留未变化的 source。
   *
   * @param mcpServers - 期望的 MCP source：slug → 配置
   * @param apiServers - 期望的 API source：slug → 配置
   * @returns 连接失败的 slug 列表
   */
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {}
  ): Promise<string[]> {
    // 如果当前 workspace 禁用了本地 MCP，则过滤掉 stdio 类型的 source。
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        continue;
      }
      filteredMcp[slug] = config;
    }

    // 从 API 配置中提取出真正的 McpServer 实例。
    const apiSlugs = new Map<string, McpServer>();
    for (const [slug, config] of Object.entries(apiServers)) {
      // `config?.type` 是可选链：config 可能为 undefined；只有 type 为 sdk 且有 instance 才加入。
      if (config?.type === 'sdk' && config.instance) {
        apiSlugs.set(slug, config.instance);
      }
    }

    const desiredSlugs = new Set([...Object.keys(filteredMcp), ...apiSlugs.keys()]);
    const currentSlugs = new Set(this.clients.keys());
    const failures: string[] = [];

    // 断开那些不再需要的 source。
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
      }
    }

    // 连接新的 MCP source；如果配置变化（例如 token 刷新）则先断开再重连。
    for (const [slug, config] of Object.entries(filteredMcp)) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connect(slug, config);
        } catch (err) {
          this.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      } else {
        const oldConfig = this.activeConfigs.get(slug);
        if (oldConfig && mcpConfigChanged(oldConfig, config)) {
          this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
          await this.disconnect(slug);
          try {
            await this.connect(slug, config);
          } catch (err) {
            this.debug(`Failed to reconnect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
            failures.push(slug);
          }
        }
      }
    }

    // 连接新的 API source。
    for (const [slug, server] of apiSlugs) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connectInProcess(slug, server);
        } catch (err) {
          this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
    }

    // 通知外部工具列表已变化（如果外部设置了回调）。
    this.onToolsChanged?.();
    return failures;
  }

  // ============================================================
  // 工具发现
  // ============================================================

  /**
   * 获取某个 source 缓存的工具列表；未连接返回空数组。
   */
  getTools(slug: string): Tool[] {
    return this.toolCache.get(slug) || [];
  }

  /**
   * 获取所有已连接的 source slug。
   */
  getConnectedSlugs(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * 判断某个 source 是否已连接。
   */
  isConnected(slug: string): boolean {
    return this.clients.has(slug);
  }

  /**
   * 生成所有已连接 source（或指定 subset）的代理工具定义，传给后端注册。
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys());
    const defs: ProxyToolDef[] = [];

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || [];
      for (const tool of tools) {
        // 去掉 $schema：AJV（Pi agent）遇到未注册的 meta-schema URI 会报错。
        // 和 tool-defs.ts 里的 getToolDefsAsJsonSchema() 用同一套模式。
        const { $schema, ...cleanSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        defs.push({
          name: `mcp__${slug}__${tool.name}`,
          description: tool.description || `Tool from ${slug}`,
          inputSchema: Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} },
        });
      }
    }

    return defs;
  }

  // ============================================================
  // 工具执行
  // ============================================================

  /**
   * 通过代理工具名（mcp__{slug}__{toolName}）执行 MCP 工具。
   * 返回符合外部子进程协议格式的结果。
   */
  async callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    // 解构：从映射信息中取出 source slug 和原始工具名。
    const { slug, originalName } = info;

    const client = this.clients.get(slug);
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    try {
      // `as {...}` 是类型断言：把 SDK 返回的未知结果限定为我们后续处理的形状。
      const result = await client.callTool(originalName, args) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>;
        isError?: boolean;
      };

      const contentBlocks = result.content || [];
      const parts: string[] = [];

      // 1. 逐个处理 content block：文本直接拼接，图片/音频 base64 数据保存到本地。
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // 兼容非标准 server：text 字段可能不是字符串，对象则 JSON 化。
          if (typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2));
          }
        } else if ((block.type === 'image' || block.type === 'audio') && block.data && this.sessionPath) {
          // 解码 base64 二进制内容并保存到 downloads/。
          try {
            const buffer = Buffer.from(block.data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(this.sessionPath, filename, buffer, block.mimeType ?? null);
            if (saved.type === 'file_download') {
              parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
            }
          } catch {
            // Base64 解码失败就跳过这个 block。
          }
        }
      }

      // 2. 把文本片段拼起来；如果完全没提取出内容，就 fallback 为整个 result 的 JSON。
      const text = parts.join('\n') || JSON.stringify(result);

      // 3. 统一的大结果处理：非错误且 sessionPath 存在时，超大结果会被摘要或转存。
      if (!result.isError && this.sessionPath) {
        const guarded = await guardLargeResult(text, {
          sessionPath: this.sessionPath,
          toolName: proxyName,
          input: args,
          summarize: this.summarizeCallback,
        });
        if (guarded) {
          return { content: guarded, isError: false };
        }
      }

      return {
        content: text,
        isError: !!result.isError,
      };
    } catch (err) {
      return {
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug,
      };
    }
  }

  /**
   * 判断一个工具名是否属于本池管理的 MCP 代理工具。
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName);
  }
}

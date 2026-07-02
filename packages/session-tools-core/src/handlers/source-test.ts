/**
 * Source Test Handler（Source 综合测试处理器）
 *
 * 对一个 source 做全方位检测：
 * 配置结构校验、完整性检查、图标处理、连接测试、认证状态校验、元数据更新。
 */

import { basename, join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult, SourceConfig, ConnectionStatus } from '../types.ts';
import { errorResponse } from '../response.ts';
import {
  validateJsonFileHasFields,
  validateSourceConfigBasic,
} from '../validation.ts';
import {
  sourceExists,
  getSourceConfigPath,
  getSourceGuidePath,
  getSourcePath,
} from '../source-helpers.ts';

// source_test 参数
export interface SourceTestArgs {
  sourceSlug: string;
  /**
   * 测试成功后是否自动启用该 source（把 enabled 设为 true 并在当前会话激活）。
   * 默认为 true；传 false 只做纯校验。
   */
  autoEnable?: boolean;
}

/**
 * API/MCP 连接测试的内部结果结构。
 * 这里的 success 表示探针认为连接健康，needsAuth 表示需要认证。
 */
interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  needsAuth?: boolean;
  error?: string;
}

/**
 * 处理 source_test tool 调用。
 *
 * 执行步骤：
 * 1. 校验 source 是否存在；
 * 2. 结构校验 config.json；
 * 3. 加载并基础校验 source 配置；
 * 4. 图标处理（检查本地/下载/自动获取）；
 * 5. 完整性检查（guide.md、tagline 等）；
 * 6. 连接测试（API/MCP/Local）；
 * 7. 认证状态检查；
 * 8. 自动启用与元数据更新（lastTestedAt、connectionStatus）。
 */
export async function handleSourceTest(
  ctx: SessionToolContext,
  args: SourceTestArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;
  const lines: string[] = [];
  let hasErrors = false;
  let hasWarnings = false;
  let connectionStatus: ConnectionStatus = 'unknown';
  let connectionError: string | undefined;

  // 1. 检查 source 是否存在
  if (!sourceExists(ctx.workspacePath, sourceSlug)) {
    return errorResponse(`Source '${sourceSlug}' not found in workspace.`);
  }

  // 2. 结构校验
  lines.push('## Schema Validation');
  const configPath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
  const schemaResult = validateJsonFileHasFields(configPath, ['slug', 'name', 'type']);

  if (schemaResult.valid) {
    lines.push('✓ Config schema valid');
  } else {
    hasErrors = true;
    lines.push('✗ Config schema invalid:');
    for (const error of schemaResult.errors) {
      lines.push(`  - ${error.message}`);
    }
  }

  // 3. 加载 source 配置供后续检查使用
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Failed to load source config for '${sourceSlug}'.`);
  }

  // 用基础校验器检查加载后的配置
  const configValidation = validateSourceConfigBasic(source);
  if (!configValidation.valid) {
    hasErrors = true;
    for (const error of configValidation.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
    }
  }

  // 4. 图标处理
  lines.push('\n## Icon Status');
  const sourcePath = getSourcePath(ctx.workspacePath, sourceSlug);
  const iconResult = await handleIconCheck(ctx, sourcePath, sourceSlug, source);
  lines.push(...iconResult.lines);
  if (iconResult.hasWarning) hasWarnings = true;

  // 5. 完整性检查
  lines.push('\n## Completeness Check');
  const completenessResult = checkCompleteness(ctx, sourcePath, source);
  lines.push(...completenessResult.lines);
  if (completenessResult.hasWarning) hasWarnings = true;

  // 6. 连接测试
  lines.push('\n## Connection Test');
  const connectionResult = await testConnection(ctx, source, sourceSlug);
  lines.push(...connectionResult.lines);
  if (connectionResult.hasError) {
    hasErrors = true;
    connectionStatus = 'error';
    connectionError = connectionResult.error;
  } else if (connectionResult.success) {
    connectionStatus = 'connected';
  } else {
    // 软失败（如 404/5xx 等）：探针连通了服务端但状态不健康。
    // 降级为 warning，并拒绝自动激活，避免把坏 source 推入可用工具列表。
    connectionStatus = 'disconnected';
    hasWarnings = true;
  }

  // 7. 认证状态
  lines.push('\n## Authentication');
  const authResult = await checkAuthStatus(ctx, source, sourceSlug);
  lines.push(...authResult.lines);
  if (authResult.hasWarning) hasWarnings = true;

  // 8. 自动启用 + 元数据更新
  // 默认启用；autoEnable=false 时只做校验。
  // 以 connectionStatus === 'connected' 为门槛，防止 5xx/404 的 source 被自动激活。
  // 401/403 会被探针映射为 connected，后续 checkAuthStatus 会引导刷新 token。
  const autoEnable = args.autoEnable !== false;
  const shouldAutoEnable = autoEnable && !hasErrors && connectionStatus === 'connected';
  const willFlipEnabled = shouldAutoEnable && source.enabled === false;

  if (ctx.saveSourceConfig) {
    const updatedSource: SourceConfig = {
      ...source,
      lastTestedAt: Date.now(),
      connectionStatus,
      connectionError,
      // 把 enabled 翻转合并到同一次保存，避免写两次
      ...(willFlipEnabled ? { enabled: true } : {}),
    };
    try {
      ctx.saveSourceConfig(updatedSource);
      lines.push('\n_Config updated with test results._');
      if (willFlipEnabled) {
        lines.push('✓ Source auto-enabled in config');
      }
    } catch {
      // 静默忽略保存错误
    }
  }

  // 尝试在当前运行会话中激活 source（后端可能不支持）
  if (shouldAutoEnable) {
    if (ctx.activateSourceInSession) {
      try {
        const result = await ctx.activateSourceInSession(sourceSlug);
        if (result.ok) {
          // 激活成功后，后端会在 tool result 落地后中断当前 turn，
          // 渲染器自动重发原始用户消息并带上 "[{slug} activated]" 后缀。
          // 对模型来说，下一 turn 就是工具可用的新会话。
          lines.push('✓ Source activated — the current turn will auto-restart with tools available');
        } else {
          lines.push(`⚠ Config updated, but session activation failed: ${result.reason ?? 'unknown error'}. Restart session to load tools.`);
          hasWarnings = true;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        lines.push(`⚠ Config updated, but session activation threw: ${msg}. Restart session to load tools.`);
        hasWarnings = true;
      }
    } else if (willFlipEnabled) {
      // 只有真正修改了 enabled 标志时才提示重启
      lines.push('ℹ Config updated. Restart session to load tools (mid-session activation not available in this backend).');
    }
  } else if (autoEnable && !hasErrors && connectionStatus !== 'connected') {
    // 用户希望自动启用但连接探针未通过，说明原因以便排查
    lines.push(`ℹ Skipping activation because connection test did not succeed (status: ${connectionStatus}). Re-run source_test once the endpoint is reachable.`);
  }

  // 汇总结果
  lines.push('\n---');
  if (hasErrors) {
    lines.push('**Result: ✗ Validation failed with errors**');
  } else if (hasWarnings) {
    lines.push('**Result: ⚠ Validation passed with warnings**');
  } else {
    lines.push('**Result: ✓ Validation passed**');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: hasErrors,
  };
}

// ============================================================
// 图标处理
// ============================================================

async function handleIconCheck(
  ctx: SessionToolContext,
  sourcePath: string,
  sourceSlug: string,
  source: SourceConfig
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  // 1. 检查本地图标文件
  const iconPngPath = join(sourcePath, 'icon.png');
  const iconSvgPath = join(sourcePath, 'icon.svg');
  const iconJpgPath = join(sourcePath, 'icon.jpg');

  const hasLocalIcon =
    ctx.fs.exists(iconPngPath) ||
    ctx.fs.exists(iconSvgPath) ||
    ctx.fs.exists(iconJpgPath);

  if (hasLocalIcon) {
    const format = ctx.fs.exists(iconPngPath) ? 'PNG' : ctx.fs.exists(iconSvgPath) ? 'SVG' : 'JPG';
    lines.push(`✓ Icon file exists (${format})`);
    return { lines, hasWarning };
  }

  // 2. 检查 icon 字段是否是可下载 URL
  if (source.icon && ctx.isIconUrl && ctx.isIconUrl(source.icon)) {
    if (ctx.downloadSourceIcon) {
      lines.push(`ℹ Icon URL detected: ${source.icon}`);
      try {
        const cachedPath = await ctx.downloadSourceIcon(sourceSlug, source.icon);
        if (cachedPath) {
          lines.push(`✓ Icon downloaded and cached`);
          return { lines, hasWarning };
        }
      } catch (e) {
        lines.push(`⚠ Failed to download icon: ${e instanceof Error ? e.message : 'Unknown error'}`);
        hasWarning = true;
      }
    } else {
      lines.push(`ℹ Icon URL configured but download not available: ${source.icon}`);
    }
  }

  // 3. 检查 icon 字段是否是 emoji
  if (source.icon && isEmoji(source.icon)) {
    lines.push(`✓ Emoji icon configured: ${source.icon}`);
    return { lines, hasWarning };
  }

  // 4. 尝试根据 service URL 自动获取高清 logo
  if (!source.icon && ctx.deriveServiceUrl && ctx.getHighQualityLogoUrl && ctx.downloadIcon) {
    const serviceUrl = ctx.deriveServiceUrl(source);
    if (serviceUrl) {
      lines.push(`ℹ Attempting to auto-fetch icon from service URL...`);
      try {
        const logoUrl = await ctx.getHighQualityLogoUrl(serviceUrl, sourceSlug);
        if (logoUrl) {
          const destPath = join(sourcePath, 'icon.png');
          const downloaded = await ctx.downloadIcon(destPath, logoUrl, sourceSlug);
          if (downloaded) {
            lines.push(`✓ Icon auto-fetched and saved`);
            return { lines, hasWarning };
          }
        }
      } catch {
        // 自动获取失败时静默继续
      }
    }
  }

  // 5. 完全找不到图标
  hasWarning = true;
  lines.push('⚠ No icon configured');
  lines.push('  Options:');
  lines.push('  - Add icon.png or icon.svg to source folder');
  lines.push('  - Set "icon" field to a URL or emoji in config.json');
  if (source.type === 'api' && source.api?.baseUrl) {
    lines.push(`  - Icon may be auto-fetched from ${new URL(source.api.baseUrl).hostname}`);
  }

  return { lines, hasWarning };
}

/**
 * 简易 emoji 检测（启发式）。
 */
function isEmoji(str: string): boolean {
  const emojiRegex = /^[\p{Emoji}]$/u;
  return emojiRegex.test(str) || (str.length >= 2 && str.length <= 8 && /[\u{1F300}-\u{1FAD6}]/u.test(str));
}

// ============================================================
// 完整性检查
// ============================================================

function checkCompleteness(
  ctx: SessionToolContext,
  sourcePath: string,
  source: SourceConfig
): { lines: string[]; hasWarning: boolean } {
  const lines: string[] = [];
  let hasWarning = false;

  // 检查 guide.md（给 agent 看的用法说明）
  const guidePath = getSourceGuidePath(ctx.workspacePath, source.slug);
  if (!ctx.fs.exists(guidePath)) {
    hasWarning = true;
    lines.push('⚠ No guide.md file');
    lines.push('  Recommended: Add guide.md with usage instructions for the agent');
  } else {
    try {
      const guideContent = ctx.fs.readFile(guidePath);
      const guideSize = guideContent.length;
      const wordCount = guideContent.split(/\s+/).filter(Boolean).length;
      lines.push(`✓ guide.md exists (${wordCount} words, ${formatBytes(guideSize)})`);

      if (wordCount < 50) {
        lines.push('  ℹ Guide is short - consider adding more context');
      }
    } catch {
      lines.push('✓ guide.md exists');
    }
  }

  // 检查 tagline 字段
  if (!source.tagline) {
    // 常见错误：把 tagline 写成了 description
    if ((source as unknown as Record<string, unknown>)['description']) {
      hasWarning = true;
      lines.push('⚠ Found "description" field instead of "tagline"');
      lines.push('  Rename "description" to "tagline" in config.json');
    } else {
      hasWarning = true;
      lines.push('⚠ No tagline configured');
      lines.push('  Add "tagline": "Brief description" to config.json');
    }
  } else {
    lines.push(`✓ Tagline: "${source.tagline}"`);
    if (source.tagline.length > 100) {
      lines.push('  ℹ Tagline is long - consider shortening to < 100 chars');
    }
  }

  // 检查 name 字段
  if (source.name) {
    lines.push(`✓ Name: "${source.name}"`);
  }

  return { lines, hasWarning };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================
// 连接测试
// ============================================================

async function testConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  // 按 source 类型分发到不同测试函数
  if (source.type === 'api') {
    const result = await testApiConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'mcp') {
    const result = await testMcpConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'local') {
    const result = testLocalConnection(ctx, source);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else {
    lines.push('ℹ No connection test available for this source type');
    success = true;
  }

  return { lines, success, hasError, error };
}

async function testApiConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.api?.baseUrl) {
    lines.push('✗ No API base URL configured');
    hasError = true;
    error = 'No base URL';
    return { lines, success, hasError, error };
  }

  // 如果上下文提供了高级 testApiSource，优先使用它
  if (ctx.testApiSource) {
    try {
      const result = await ctx.testApiSource(source);
      if (result.success) {
        success = true;
        lines.push(`✓ API endpoint reachable`);
        if (result.status) {
          lines.push(`  Status: ${result.status}`);
        }
      } else {
        hasError = true;
        error = result.error || 'Connection failed';
        lines.push(`✗ ${result.error || 'Connection failed'}`);
        if (result.hint) {
          lines.push(`  ${result.hint}`);
        }
      }
      return { lines, success, hasError, error };
    } catch (e) {
      // 异常时降级到内置测试
    }
  }

  // 构造测试 URL：优先用 testEndpoint.path，否则直接用 baseUrl
  const testUrl = source.api.testEndpoint
    ? `${source.api.baseUrl}${source.api.testEndpoint.path}`
    : source.api.baseUrl;

  // 如果有凭证，先尝试带认证请求
  if (source.isAuthenticated && ctx.credentialManager && source.api.authType !== 'none') {
    const authResult = await testApiConnectionWithAuth(ctx, source, sourceSlug, testUrl);
    if (authResult.attempted) {
      return authResult;
    }
    // 若拿不到 token，降级到无认证测试
  }

  // 无认证基础连接测试
  return testApiConnectionBasic(source, testUrl);
}

/**
 * 带认证的 API 连接测试。
 * 如果拿不到凭证，返回 attempted=false，让上层降级到无认证测试。
 */
async function testApiConnectionWithAuth(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string; attempted: boolean }> {
  const lines: string[] = [];

  // 构造 credential manager 需要的 LoadedSource 对象
  const workspaceId = basename(ctx.workspacePath) || '';
  const loadedSource = {
    config: source,
    folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
    workspaceRootPath: ctx.workspacePath,
    workspaceId,
  };

  // 从 credential manager 取 token
  let token: string | null = null;
  try {
    token = await ctx.credentialManager!.getToken(loadedSource);
  } catch {
    // 拿不到 token，后续降级到无认证测试
  }

  if (!token) {
    return { lines: [], success: false, hasError: false, attempted: false };
  }

  // 根据 authType 构造认证头或 URL 参数
  const headers: Record<string, string> = {};
  let urlWithAuth = testUrl;

  switch (source.api!.authType) {
    case 'bearer':
    case 'oauth':
      // 通用 OAuth token 以 Bearer 方式发送
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'basic': {
      // source_basic 在凭据库里的值是 JSON `{"username","password"}`（由 source_credential_prompt / WebUI 写入）。
      // 这里解析并 base64 编码，以和运行时 api-tools.ts 的 buildHeaders 保持一致。
      // 如果是非 JSON 字符串（旧版或手动编辑），则直接透传。
      try {
        const parsed = JSON.parse(token);
        if (parsed && typeof parsed === 'object' && parsed.username && parsed.password) {
          const encoded = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
          break;
        }
      } catch {
        // 不是 JSON，直接透传
      }
      headers['Authorization'] = `Basic ${token}`;
      break;
    }
    case 'header':
      // 自定义 header 名
      if (source.api!.headerName) {
        headers[source.api!.headerName] = token;
      } else if (source.api!.headerNames && source.api!.headerNames.length > 0) {
        // 多 header 认证：token 是 JSON，key 为 header 名
        const headerNames = source.api!.headerNames;
        try {
          const headerValues = JSON.parse(token) as Record<string, string>;
          for (const headerName of headerNames) {
            if (headerValues[headerName]) {
              headers[headerName] = headerValues[headerName];
            }
          }
        } catch {
          // token 不是合法 JSON，对多 header 认证来说是配置错误
          const firstHeader = headerNames[0] || 'Header';
          return {
            lines: [`✗ Multi-header auth requires JSON token with header values`],
            success: false,
            hasError: true,
            error: `Expected JSON token like {"${firstHeader}": "value"} but got non-JSON string`,
            attempted: true,
          };
        }
      } else {
        // 未指定 header 名时回退到 X-API-Key
        headers['X-API-Key'] = token;
      }
      break;
    case 'query':
      // 把 token 作为 URL 查询参数
      const paramName = source.api!.queryParam || 'api_key';
      const separator = testUrl.includes('?') ? '&' : '?';
      urlWithAuth = `${testUrl}${separator}${paramName}=${encodeURIComponent(token)}`;
      break;
  }

  // 发起带认证的请求
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const method = source.api!.testEndpoint?.method || 'GET';
    const body = source.api!.testEndpoint?.body;
    const extraHeaders = source.api!.testEndpoint?.headers;

    // 合并 testEndpoint 里配置的 header；认证 header 优先级更高，防止旧配置覆盖 live token
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (!(k in headers)) headers[k] = v;
      }
    }

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined && method !== 'GET') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      // 只有 testEndpoint.headers 没提供 Content-Type 时才默认 application/json
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasContentType) headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(urlWithAuth, init);

    clearTimeout(timeoutId);

    if (response.ok) {
      lines.push(`✓ API connection successful (authenticated)`);
      lines.push(`  Status: ${response.status}`);
      return { lines, success: true, hasError: false, attempted: true };
    } else if (response.status === 401 || response.status === 403) {
      lines.push(`✗ API returned ${response.status} (credentials invalid or expired)`);
      lines.push('  Re-authenticate the source to refresh credentials');
      return { lines, success: false, hasError: true, error: `Auth failed: ${response.status}`, attempted: true };
    } else if (response.status === 404) {
      lines.push(`⚠ API returned 404 (endpoint not found)`);
      if (source.api!.testEndpoint) {
        lines.push(`  Check if testEndpoint.path is correct: ${source.api!.testEndpoint.path}`);
      }
      return { lines, success: false, hasError: false, attempted: true };
    } else {
      lines.push(`⚠ API returned ${response.status}`);
      return { lines, success: false, hasError: false, attempted: true };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${errorMsg}`);
    if (errorMsg.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
    return { lines, success: false, hasError: true, error: errorMsg, attempted: true };
  }
}

/**
 * 无认证的 API 基础连接测试。
 * 在没有凭证或拿不到 token 时使用。
 */
async function testApiConnectionBasic(
  source: SourceConfig,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // 如果配置了 testEndpoint.method，直接按配置方法请求。
    // 默认的 HEAD→GET 探针无法验证仅支持 POST 的端点（会 405，降级 GET 后又 405，
    // 基础探针会把它当成软失败）。
    // 另外，无认证探针不携带 testEndpoint.body，因为没凭证时 body 里的敏感内容可能泄露；
    // 等认证配置好后再由带认证探针携带 body。
    const configuredMethod = source.api?.testEndpoint?.method;
    let response: Response | null;
    if (configuredMethod) {
      response = await fetch(testUrl, {
        method: configuredMethod,
        signal: controller.signal,
      }).catch(() => null);
    } else {
      // 先尝试 HEAD，开销最小
      response = await fetch(testUrl, {
        method: 'HEAD',
        signal: controller.signal,
      }).catch(() => null);

      // HEAD 返回 405 时降级 GET
      if (response && response.status === 405) {
        response = await fetch(testUrl, {
          method: 'GET',
          signal: controller.signal,
        }).catch(() => null);
      }
    }

    clearTimeout(timeoutId);

    if (response) {
      if (response.ok) {
        success = true;
        lines.push(`✓ API endpoint reachable (${testUrl})`);
      } else if (response.status === 401 || response.status === 403) {
        // 需要认证：服务端可达，只是缺凭证
        success = true;
        lines.push(`⚠ API returned ${response.status} (authentication required)`);
        if (!source.isAuthenticated) {
          lines.push('  Authenticate the source to test with credentials');
        } else {
          lines.push('  Source is marked authenticated but credentials could not be retrieved');
        }
      } else if (response.status === 404) {
        lines.push(`⚠ API returned 404 (endpoint not found)`);
        if (source.api?.testEndpoint) {
          lines.push(`  Check if testEndpoint.path is correct: ${source.api.testEndpoint.path}`);
        } else {
          lines.push('  Consider adding testEndpoint configuration');
        }
      } else {
        lines.push(`⚠ API returned ${response.status}`);
      }
    } else {
      hasError = true;
      error = 'Connection failed';
      lines.push(`✗ Cannot reach API endpoint (${source.api?.baseUrl})`);
      lines.push('  Check if the URL is correct and the service is running');
    }
  } catch (e) {
    hasError = true;
    error = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${error}`);
    if (error.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
  }

  return { lines, success, hasError, error };
}

async function testMcpConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.mcp?.transport === 'stdio') {
    // Stdio MCP：如果上下文支持 validateStdioMcpConnection，就做完整测试
    if (ctx.validateStdioMcpConnection && source.mcp.command) {
      lines.push(`ℹ Testing stdio MCP: ${source.mcp.command}`);
      try {
        const result = await ctx.validateStdioMcpConnection({
          command: source.mcp.command,
          args: source.mcp.args || [],
          env: source.mcp.env,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server started successfully`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
            if (result.toolNames && result.toolNames.length > 0) {
              const preview = result.toolNames.slice(0, 5).join(', ');
              if (result.toolNames.length > 5) {
                lines.push(`  Examples: ${preview}, ...`);
              } else {
                lines.push(`  Tools: ${preview}`);
              }
            }
          }
          if (result.serverName) {
            lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
          }
        } else {
          hasError = true;
          error = result.error || 'MCP validation failed';
          lines.push(`✗ ${error}`);
        }
      } catch (e) {
        hasError = true;
        error = e instanceof Error ? e.message : 'Unknown error';
        lines.push(`✗ Failed to test MCP server: ${error}`);
      }
    } else if (source.mcp?.command) {
      // 只做配置展示，无法真正测试
      lines.push(`ℹ Stdio MCP source: ${source.mcp.command}`);
      if (source.mcp.args?.length) {
        lines.push(`  Args: ${source.mcp.args.join(' ')}`);
      }
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // 配置看起来没问题
    } else {
      hasError = true;
      error = 'No command configured';
      lines.push('✗ No command configured for stdio MCP source');
    }
  } else if (source.mcp?.url) {
    // HTTP/SSE MCP
    if (ctx.validateMcpConnection) {
      lines.push(`ℹ Testing MCP server: ${source.mcp.url}`);
      try {
        // 合并静态 header 和凭据库 header（如果配置了 headerNames）
        let headers = source.mcp.headers ? { ...source.mcp.headers } : undefined;
        let accessToken: string | undefined;
        if (ctx.credentialManager) {
          const workspaceId = basename(ctx.workspacePath) || '';
          const loadedSource = {
            config: source,
            folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
            workspaceRootPath: ctx.workspacePath,
            workspaceId,
          };

          if (source.mcp.headerNames?.length) {
            // 多 header 认证：凭据值是按 header 名 key 的 JSON
            try {
              const rawCred = await ctx.credentialManager.getToken(loadedSource);
              if (rawCred) {
                const parsed = JSON.parse(rawCred) as Record<string, string>;
                headers = { ...headers, ...parsed };
              }
            } catch {
              // 不是 JSON 或没有凭据：继续不带凭据 header
            }
          } else if (source.mcp.authType === 'oauth' || source.mcp.authType === 'bearer') {
            // OAuth / bearer 单 token 路径：和运行时保持一致，探针会发 Authorization header。
            // 先用缓存 token，拿不到再刷新（与 checkAuthStatus 和 TokenRefreshManager 一致）。
            try {
              accessToken =
                (await ctx.credentialManager.getToken(loadedSource)) ??
                (await ctx.credentialManager.refresh(loadedSource)) ??
                undefined;
            } catch {
              // token 解析失败：继续往下，探针会按 needsAuth / 401 原样返回
            }
          }
        }
        const result = await ctx.validateMcpConnection({
          url: source.mcp.url,
          transport: source.mcp.transport,
          authType: source.mcp.authType,
          headers,
          accessToken,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server connected`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
          }
          if (result.serverName) {
            lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
          }
        } else if (result.needsAuth) {
          lines.push(`⚠ MCP server requires authentication`);
          if (source.mcp.authType === 'oauth') {
            lines.push('  Use source_oauth_trigger to authenticate');
          }
          success = true; // 服务端可达，只是需要认证
        } else {
          hasError = true;
          error = result.error || 'MCP connection failed';
          lines.push(`✗ ${error}`);
        }
      } catch (e) {
        hasError = true;
        error = e instanceof Error ? e.message : 'Unknown error';
        lines.push(`✗ Failed to connect to MCP server: ${error}`);
      }
    } else {
      // 基础 URL 检查
      lines.push(`ℹ MCP source URL: ${source.mcp.url}`);
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // 配置看起来没问题
    }
  } else {
    hasError = true;
    error = 'No MCP URL or command configured';
    lines.push('✗ No MCP URL or command configured');
  }

  return { lines, success, hasError, error };
}

function testLocalConnection(
  ctx: SessionToolContext,
  source: SourceConfig
): { lines: string[]; success: boolean; hasError: boolean; error?: string } {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.local?.path) {
    hasError = true;
    error = 'No local path configured';
    lines.push('✗ No local path configured');
    return { lines, success, hasError, error };
  }

  if (ctx.fs.exists(source.local.path)) {
    success = true;
    const isDir = ctx.fs.isDirectory(source.local.path);
    lines.push(`✓ Local path exists: ${source.local.path}`);
    lines.push(`  Type: ${isDir ? 'Directory' : 'File'}`);
  } else {
    hasError = true;
    error = 'Path not found';
    lines.push(`✗ Local path not found: ${source.local.path}`);
    lines.push('  Verify the path exists and is accessible');
  }

  return { lines, success, hasError, error };
}

// ============================================================
// 认证状态检查
// ============================================================

async function checkAuthStatus(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  if (source.isAuthenticated) {
    // Codex 环境下 MCP source 的凭据通过 config.toml header 下发，不走凭据缓存。
    // 跳过 token 校验，避免文件缓存报 "token missing" 的假阳性 warning。
    if (source.type === 'mcp' && !ctx.validateMcpConnection) {
      lines.push('✓ Source is authenticated');
    } else if (ctx.credentialManager) {
      const workspaceId = basename(ctx.workspacePath) || '';
      const loadedSource = {
        config: source,
        folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
        workspaceRootPath: ctx.workspacePath,
        workspaceId,
      };

      try {
        const token = await ctx.credentialManager.getToken(loadedSource);
        if (token) {
          lines.push('✓ Source is authenticated (token valid)');
        } else {
          // token 缺失或过期：先尝试刷新再报错。
          // OAuth token 通常只有 1 小时有效期，凭据库里经常过期；
          // 正常连接管道会主动刷新，source_test 也应如此。
          const refreshed = await ctx.credentialManager.refresh(loadedSource);
          if (refreshed) {
            lines.push('✓ Source is authenticated (token refreshed)');
          } else {
            hasWarning = true;
            lines.push('⚠ Source marked authenticated but token missing or refresh failed');
            lines.push('  Re-authenticate to refresh credentials');
          }
        }
      } catch {
        lines.push('✓ Source is authenticated');
      }
    } else {
      lines.push('✓ Source is authenticated');
    }
  } else {
    // 根据 source 类型推断需要的认证方式并给出提示
    if (source.type === 'mcp' && source.mcp?.authType === 'oauth') {
      hasWarning = true;
      lines.push('⚠ Source not authenticated');
      lines.push('  Use source_oauth_trigger to authenticate');
    } else if (source.type === 'api') {
      if (source.provider === 'google') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_google_oauth_trigger to authenticate');
      } else if (source.provider === 'slack') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_slack_oauth_trigger to authenticate');
      } else if (source.provider === 'microsoft') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_microsoft_oauth_trigger to authenticate');
      } else if (source.api?.authType && source.api.authType !== 'none') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_credential_prompt to enter credentials');
      } else {
        lines.push('ℹ Source does not require authentication');
      }
    } else {
      lines.push('ℹ Source does not require authentication');
    }
  }

  return { lines, hasWarning };
}

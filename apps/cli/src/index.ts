#!/usr/bin/env bun
/**
 * craft-cli —— Craft Agent 服务端的终端客户端。
 *
 * 通过 WebSocket（ws:// 或 wss://）连接到运行中的 Craft Agent 服务端，
 * 提供资源列举、会话管理、消息发送与实时流式输出、服务端健康检查等命令。
 */

import { resolve } from 'path'
import { CliRpcClient } from './client.ts'

// ---------------------------------------------------------------------------
// 命令行参数解析
// ---------------------------------------------------------------------------

/** CLI 参数结构体。对应命令行上能出现的所有选项和开关。 */
export interface CliArgs {
  url: string
  token: string
  workspace?: string
  timeout: number
  json: boolean
  tlsCa?: string
  sendTimeout: number
  command: string
  rest: string[]
  // run 命令专用参数
  sources: string[]
  mode: string
  outputFormat: string
  noCleanup: boolean
  noSpinner: boolean
  verbose: boolean
  serverEntry?: string
  workspaceDir?: string
  // LLM 配置
  provider: string
  model: string
  apiKey: string
  baseUrl: string
}

/** 解析命令行参数，返回结构化的 CliArgs。 */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // 跳过 bun 路径和脚本路径
  let url = ''
  let token = ''
  let workspace: string | undefined
  let timeout = 10_000
  let json = false
  let tlsCa: string | undefined
  let sendTimeout = 300_000 // 默认 5 分钟
  const rest: string[] = []
  let command = ''
  const sources: string[] = []
  let mode = ''
  let outputFormat = 'text'
  let noCleanup = false
  let noSpinner = false
  let verbose = false
  let serverEntry: string | undefined
  let workspaceDir: string | undefined
  let provider = ''
  let model = ''
  let apiKey = ''
  let baseUrl = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--url':
        url = args[++i] ?? ''
        break
      case '--token':
        token = args[++i] ?? ''
        break
      case '--workspace':
        workspace = args[++i]
        break
      case '--timeout':
        timeout = parseInt(args[++i] ?? '10000', 10)
        break
      case '--json':
        json = true
        break
      case '--tls-ca':
        tlsCa = args[++i]
        break
      case '--send-timeout':
        sendTimeout = parseInt(args[++i] ?? '300000', 10)
        break
      case '--source':
        sources.push(args[++i] ?? '')
        break
      case '--mode':
        mode = args[++i] ?? ''
        break
      case '--output-format':
        outputFormat = args[++i] ?? 'text'
        break
      case '--no-cleanup':
        noCleanup = true
        break
      case '--disable-spinner':
      case '--no-spinner':
        noSpinner = true
        break
      case '--verbose':
      case '-v':
        verbose = true
        break
      case '--server-entry':
        serverEntry = args[++i]
        break
      case '--workspace-dir':
        workspaceDir = args[++i]
        break
      case '--provider':
        provider = args[++i] ?? ''
        break
      case '--model':
        model = args[++i] ?? ''
        break
      case '--api-key':
        apiKey = args[++i] ?? ''
        break
      case '--base-url':
        baseUrl = args[++i] ?? ''
        break
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--version':
        command = 'version'
        break
      case '--validate-server':
        command = 'validate'
        break
      default:
        if (!command && !arg.startsWith('-')) {
          command = arg
        } else {
          rest.push(arg)
        }
    }
  }

  // 环境变量兜底：命令行没传时读取对应环境变量
  if (!url) url = process.env.CRAFT_SERVER_URL ?? ''
  if (!token) token = process.env.CRAFT_SERVER_TOKEN ?? ''
  if (!tlsCa) tlsCa = process.env.CRAFT_TLS_CA
  if (!provider) provider = process.env.LLM_PROVIDER ?? 'anthropic'
  if (!model) model = process.env.LLM_MODEL ?? ''
  if (!apiKey) apiKey = process.env.LLM_API_KEY ?? ''
  if (!baseUrl) baseUrl = process.env.LLM_BASE_URL ?? ''

  return { url, token, workspace, timeout, json, tlsCa, sendTimeout, command, rest, sources, mode, outputFormat, noCleanup, noSpinner, verbose, serverEntry, workspaceDir, provider, model, apiKey, baseUrl }
}

// ---------------------------------------------------------------------------
// 自动解析 workspace
// ---------------------------------------------------------------------------

/**
 * 解析用户显式指定的 workspace，或在服务端上自动选择第一个可用 workspace。
 * workspace 类似 Go 里的“上下文命名空间”：session、source、label 等都挂在它下面。
 */
async function resolveWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    // 把客户端绑定到该 workspace，这样服务端推送的事件才能发到本连接
    await client.invoke('window:switchWorkspace', explicit).catch(() => {})
    return explicit
  }
  try {
    const workspaces = (await client.invoke('workspaces:get')) as any[]
    if (workspaces?.length > 0) {
      const id = workspaces[0].id
      await client.invoke('window:switchWorkspace', id).catch(() => {})
      return id
    }
  } catch {
    // 继续向下走 —— 某些命令可能根本不需要 workspace
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 输出辅助函数
// ---------------------------------------------------------------------------

/** 统一输出：JSON 模式打印 JSON，否则字符串直接打印，其他类型也打印成 JSON。 */
function out(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n')
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}

/** 错误输出。 */
function err(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`)
}

// ---------------------------------------------------------------------------
// ANSI 颜色（NO_COLOR 或非 TTY 时自动关闭）
// ---------------------------------------------------------------------------

const _useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false
const c = {
  dim: (s: string) => _useColor ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => _useColor ? `\x1b[32m${s}\x1b[39m` : s,
  red: (s: string) => _useColor ? `\x1b[31m${s}\x1b[39m` : s,
  cyan: (s: string) => _useColor ? `\x1b[36m${s}\x1b[39m` : s,
  bold: (s: string) => _useColor ? `\x1b[1m${s}\x1b[22m` : s,
  yellow: (s: string) => _useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s: string) => _useColor ? `\x1b[34m${s}\x1b[39m` : s,
}

// ---------------------------------------------------------------------------
// Spinner（仅在 TTY 且未设置 NO_COLOR 时显示）
// ---------------------------------------------------------------------------

const _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** 创建一个终端转圈动画，返回 stop() 函数。 */
function createSpinner(text: string): { stop(): void } {
  let i = 0
  let stopped = false
  // 立即渲染第一帧，避免 setInterval 第一次触发前的空档
  process.stdout.write(`${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  }, 80)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
    },
  }
}

// ---------------------------------------------------------------------------
// 各命令的实现
// ---------------------------------------------------------------------------

/** ping：测量与服务端的握手延迟。 */
async function cmdPing(client: CliRpcClient, args: CliArgs): Promise<void> {
  const start = performance.now()
  const clientId = await client.connect()
  const latency = Math.round(performance.now() - start)
  out(
    args.json
      ? { clientId, latencyMs: latency }
      : `Connected: clientId=${clientId} latency=${latency}ms`,
    args.json,
  )
}

/** health：检查服务端凭证存储健康状态。 */
async function cmdHealth(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('credentials:healthCheck')
  out(result, args.json)
}

/** versions：获取服务端运行时版本信息。 */
async function cmdVersions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('system:versions')
  out(result, args.json)
}

/** workspaces：列出所有 workspace。 */
async function cmdWorkspaces(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = (await client.invoke('workspaces:get')) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No workspaces found', false)
      return
    }
    for (const ws of result) {
      out(`${ws.id}  ${ws.name ?? '(unnamed)'}  ${ws.path ?? ''}`, false)
    }
  }
}

/** sessions：列出当前 workspace 下的所有会话。 */
async function cmdSessions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = (await client.invoke('sessions:get', workspaceId)) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No sessions found', false)
      return
    }
    for (const s of result) {
      const name = s.name ?? '(unnamed)'
      const preview = s.preview ? `  ${s.preview.slice(0, 60)}` : ''
      const status = s.isProcessing ? ' [processing]' : ''
      out(`${s.id}  ${name}${preview}${status}`, false)
    }
  }
}

/** connections：列出已配置的 LLM 连接。 */
async function cmdConnections(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('LLM_Connection:list')
  out(result, args.json)
}

/** sources：列出当前 workspace 下已配置的数据源。 */
async function cmdSources(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = await client.invoke('sources:get', workspaceId)
  out(result, args.json)
}

/** session create：创建一个新会话。 */
async function cmdSessionCreate(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }

  // 解析子参数：--name <n>
  let name: string | undefined
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') name = args.rest[++i]
  }

  const opts: Record<string, unknown> = {}
  if (name) opts.name = name
  if (args.mode) opts.permissionMode = args.mode

  const result = await client.invoke('sessions:create', workspaceId, opts)
  out(result, args.json)
}

/** session messages：打印某个会话的历史消息。 */
async function cmdSessionMessages(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session messages <session-id>')
    process.exit(1)
  }
  await client.connect()
  const result = await client.invoke('sessions:getMessages', sessionId)
  out(result, args.json)
}

/** session delete：删除指定会话。 */
async function cmdSessionDelete(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session delete <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:delete', sessionId)
  out(args.json ? { deleted: sessionId } : `Deleted session: ${sessionId}`, args.json)
}

/**
 * 读取 prompt 文本：从位置参数和 stdin 拼接。
 * 如果有位置参数，它们作为基础消息；当出现 --stdin 标志，或没有位置参数且 stdin 不是 TTY 时，读取 stdin。
 */
async function readPrompt(words: string[], restArgs?: string[]): Promise<string> {
  let message = words.join(' ')

  const wantsStdin = restArgs?.includes('--stdin')
  const isTTY = typeof process.stdin.isTTY === 'boolean' ? process.stdin.isTTY : false
  if (wantsStdin || (!message && !isTTY)) {
    const chunks: string[] = []
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    const stdinText = chunks.join('')
    message = message ? `${message}\n${stdinText}` : stdinText
  }

  return message
}

/**
 * 订阅会话事件，发送消息，流式输出，等待完成。
 * 返回退出码：0 成功，1 出错，130 被中断。
 */
async function sendAndStream(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  args: CliArgs,
): Promise<number> {
  let exitCode = 0
  let finished = false
  const streamJson = args.outputFormat === 'stream-json'

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    if (streamJson) {
      process.stdout.write(JSON.stringify(ev) + '\n')
    }

    switch (ev.type) {
      case 'text_delta':
        if (!streamJson) process.stdout.write(ev.delta as string)
        break
      case 'tool_start':
        if (!streamJson) process.stdout.write(`\n[tool: ${ev.toolName}${ev.toolIntent ? ` — ${ev.toolIntent}` : ''}]\n`)
        break
      case 'tool_result': {
        if (!streamJson) {
          const result = String(ev.result ?? '')
          if (result.length > 200) {
            process.stdout.write(`${result.slice(0, 200)}...\n`)
          } else if (result) {
            process.stdout.write(`${result}\n`)
          }
        }
        break
      }
      case 'error':
        if (!streamJson) err(String(ev.error))
        exitCode = 1
        finished = true
        break
      case 'complete':
        if (!streamJson) process.stdout.write('\n')
        finished = true
        break
      case 'interrupted':
        if (!streamJson) process.stdout.write('\n[interrupted]\n')
        exitCode = 130
        finished = true
        break
    }
  })

  await client.invoke('sessions:sendMessage', sessionId, message)

  const deadline = Date.now() + args.sendTimeout
  while (!finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  unsub()

  if (!finished) {
    err('Send timeout — no completion event received')
    exitCode = 1
  }

  return exitCode
}

/** send：向指定会话发送消息并流式输出 AI 回复。 */
async function cmdSend(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: send <session-id> <message>')
    process.exit(1)
  }

  const message = await readPrompt(args.rest.slice(1), args.rest)
  if (!message.trim()) {
    err('No message provided')
    process.exit(1)
  }

  await client.connect()
  const exitCode = await sendAndStream(client, sessionId, message, args)
  client.destroy()
  process.exit(exitCode)
}

/** 本地启动的服务实例封装。 */
interface LocalServer {
  client: CliRpcClient
  stop: () => Promise<void>
}

/** 本地启动 Craft Agent 服务端并构造一个已连接的 CliRpcClient。 */
async function spawnLocalServer(args: CliArgs, opts?: { quiet?: boolean }): Promise<LocalServer> {
  const { spawnServer } = await import('./server-spawner.ts')
  process.stderr.write('Starting server...\n')
  const server = await spawnServer({
    serverEntry: args.serverEntry,
    startupTimeout: args.timeout > 30_000 ? args.timeout : 30_000,
    quiet: opts?.quiet,
  })
  process.stderr.write(`Server ready: ${server.url}\n`)
  const client = new CliRpcClient(server.url, {
    token: server.token,
    requestTimeout: args.timeout,
  })
  return { client, stop: server.stop }
}

// ---------------------------------------------------------------------------
// LLM 连接辅助函数
// ---------------------------------------------------------------------------

/** 各 provider 对应的环境变量名。 */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
}

/** 各 provider 的显示名称。 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  'amazon-bedrock': 'Amazon Bedrock',
}

/** 获取 provider 的友好显示名。 */
function getProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** 解析 API key：优先显式传入，其次环境变量，最后抛出错误。 */
export function resolveApiKey(provider: string, explicit: string): string {
  if (explicit) return explicit
  if (provider === 'amazon-bedrock') return '' // Bedrock 用 IAM 凭证，不走单条 API key
  const envKey = PROVIDER_ENV_KEYS[provider]
  if (envKey && process.env[envKey]) return process.env[envKey]!
  throw new Error(
    `No API key found. Use --api-key, set $LLM_API_KEY, or set $${envKey ?? `${provider.toUpperCase()}_API_KEY`}`,
  )
}

/** 判断是否需要为该 provider 新建 LLM 连接。 */
export function shouldSetupLlmConnection(existingConnectionCount: number, args: Pick<CliArgs, 'provider' | 'baseUrl'>): boolean {
  return existingConnectionCount === 0 || !!args.baseUrl || args.provider !== 'anthropic'
}

/**
 * 根据命令行参数/环境变量配置 LLM 连接。
 * 支持普通 API key、自定义 baseUrl、Amazon Bedrock IAM 三种模式。
 */
async function setupLlmConnection(
  client: CliRpcClient,
  args: CliArgs,
): Promise<{ connectionSlug: string }> {
  const { provider, baseUrl } = args
  const key = resolveApiKey(provider, args.apiKey)
  const connectionSlug = `${provider}-cli`

  let providerType: string
  let authType: string
  const setupPayload: Record<string, unknown> = { slug: connectionSlug, credential: key }

  if (baseUrl) {
    // 自定义 endpoint：payload 形状与桌面 UI 保持一致。
    // 服务端 llm-connections.ts 通过 customEndpoint + baseUrl 识别并设置 providerType='pi_compat' 等。
    providerType = 'pi_compat'
    authType = 'api_key_with_endpoint'
    setupPayload.baseUrl = baseUrl
    setupPayload.customEndpoint = {
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    }
    setupPayload.defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o'
  } else if (provider === 'anthropic') {
    providerType = 'anthropic'
    authType = 'api_key'
  } else if (provider === 'amazon-bedrock') {
    // Bedrock 使用 IAM 凭证而不是单一 API key
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const region = process.env.AWS_REGION || 'us-east-1'
    const sessionToken = process.env.AWS_SESSION_TOKEN
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'Amazon Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables',
      )
    }
    providerType = 'pi'
    authType = 'iam_credentials'
    setupPayload.piAuthProvider = 'amazon-bedrock'
    setupPayload.bedrockAuthMethod = 'iam_credentials'
    setupPayload.iamCredentials = { accessKeyId, secretAccessKey, sessionToken }
    setupPayload.awsRegion = region
    delete setupPayload.credential // IAM 凭证通过 iamCredentials 字段传递，删掉普通 credential
  } else {
    providerType = 'pi'
    authType = 'api_key'
    setupPayload.piAuthProvider = provider
  }

  await client.invoke('LLM_Connection:save', {
    slug: connectionSlug,
    name: getProviderDisplayName(provider),
    providerType,
    authType,
    createdAt: Date.now(),
  })
  const setupResult = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
  if (!setupResult?.success) {
    throw new Error(`LLM connection setup failed: ${setupResult?.error ?? 'unknown error'}`)
  }
  await client.invoke('LLM_Connection:setDefault', connectionSlug)
  process.stderr.write(`LLM connection configured: ${provider}${baseUrl ? ` (${baseUrl})` : ''}\n`)

  return { connectionSlug }
}

/** run：本地启动服务，创建会话，发送消息并流式输出，最后清理退出。 */
async function cmdRun(args: CliArgs): Promise<void> {
  // prompt 是全部位置参数（不需要 session ID，这点和 send 不同）
  const message = await readPrompt(args.rest, args.rest)
  if (!message.trim()) {
    err('No prompt provided. Usage: run <message>')
    process.exit(1)
  }

  const server = await spawnLocalServer(args)

  let client: CliRpcClient | undefined = server.client
  let sessionId: string | undefined

  /** 清理函数：删除会话、断开客户端、停止服务端。 */
  const cleanup = async () => {
    if (sessionId && client?.isConnected && !args.noCleanup) {
      await client.invoke('sessions:delete', sessionId).catch(() => {})
    }
    client?.destroy()
    await server.stop()
  }

  // 信号处理：收到 SIGINT/SIGTERM 时先取消再清理
  const onSignal = async () => {
    if (sessionId && client?.isConnected) {
      await client.invoke('sessions:cancel', sessionId).catch(() => {})
    }
    await cleanup()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await client.connect()

    // 如果指定了 --workspace-dir，先从目录创建/注册 workspace
    let bootstrappedWorkspaceId: string | undefined
    if (args.workspaceDir) {
      const absPath = resolve(args.workspaceDir)
      const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
      bootstrappedWorkspaceId = ws.id
      process.stderr.write(`Workspace registered: ${absPath}\n`)
    }

    // 根据参数/环境变量自动配置 LLM 连接。
    // 若传了 --base-url，即使已有其他连接也新建一条自定义 endpoint，确保会话走该连接。
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    let connectionSlug: string | undefined
    if (shouldSetupLlmConnection(connections?.length ?? 0, args)) {
      const result = await setupLlmConnection(client, args)
      connectionSlug = result.connectionSlug
    }

    const workspaceId = bootstrappedWorkspaceId
      ?? await resolveWorkspace(client, args.workspace)
    if (bootstrappedWorkspaceId) {
      await client.invoke('window:switchWorkspace', bootstrappedWorkspaceId).catch(() => {})
    }
    if (!workspaceId) {
      err('No workspace found on server')
      process.exit(1)
    }

    const session = (await client.invoke('sessions:create', workspaceId, {
      permissionMode: args.mode || 'allow-all',
      enabledSourceSlugs: args.sources.length > 0 ? args.sources : undefined,
    })) as { id: string }
    sessionId = session.id

    if (args.model) {
      await client.invoke('session:setModel', sessionId, workspaceId, args.model, connectionSlug)
    }

    const exitCode = await sendAndStream(client, sessionId, message, args)
    await cleanup()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    await cleanup()
    process.exit(1)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

/** validate：执行多步骤服务端集成测试。 */
async function cmdValidate(args: CliArgs): Promise<void> {
  let server: LocalServer | undefined
  let client: CliRpcClient

  // 验证步骤涉及 source 创建和 MCP 服务启动，Windows 上可能较慢，因此用更宽裕的超时。
  const validateArgs = { ...args, timeout: Math.max(args.timeout, 30_000) }

  if (args.url) {
    client = new CliRpcClient(args.url, {
      token: args.token || undefined,
      requestTimeout: validateArgs.timeout,
      connectTimeout: validateArgs.timeout,
    })
  } else {
    server = await spawnLocalServer(validateArgs, { quiet: !args.verbose })
    client = server.client
  }

  try {
    const exitCode = await runValidation(client, args.json, args.noSpinner, args.workspaceDir, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      provider: args.provider,
    })
    client.destroy()
    if (server) await server.stop()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    client.destroy()
    if (server) await server.stop()
    process.exit(1)
  }
}

/** cancel：取消指定会话正在进行的 AI 处理。 */
async function cmdCancel(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: cancel <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:cancel', sessionId)
  out(args.json ? { cancelled: sessionId } : `Cancelled: ${sessionId}`, args.json)
}

/** invoke：原始 RPC 调用，剩余参数会尝试按 JSON 解析。 */
async function cmdInvoke(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: invoke <channel> [json-args...]')
    process.exit(1)
  }
  await client.connect()

  // 把剩下的参数逐个尝试 JSON.parse，失败就作为纯字符串传过去
  const invokeArgs: unknown[] = []
  for (let i = 1; i < args.rest.length; i++) {
    try {
      invokeArgs.push(JSON.parse(args.rest[i]))
    } catch {
      invokeArgs.push(args.rest[i])
    }
  }

  const result = await client.invoke(channel, ...invokeArgs)
  out(result, args.json)
}

/** listen：订阅某个频道并持续打印推送事件。 */
async function cmdListen(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: listen <channel>')
    process.exit(1)
  }
  await client.connect()

  client.on(channel, (...eventArgs: unknown[]) => {
    out({ channel, args: eventArgs, timestamp: new Date().toISOString() }, true)
  })

  process.stdout.write(`Listening on ${channel} (Ctrl+C to stop)\n`)

  // 保持进程运行
  await new Promise(() => {
    // 永远不会 resolve，按 Ctrl+C 退出
  })
}

// ---------------------------------------------------------------------------
// 服务端验证
// ---------------------------------------------------------------------------

/** 单个验证步骤。 */
export interface ValidateStep {
  name: string
  fn: (client: CliRpcClient, ctx: ValidateContext) => Promise<string>
}

/** 验证上下文：各步骤之间共享状态。 */
export interface ValidateContext {
  /** 通过 --workspace-dir 传入的已有 workspace 目录 */
  workspaceDir?: string
  /** 通过 --base-url 传入的自定义 endpoint */
  baseUrl?: string
  /** 通过 --api-key 传入的 API key */
  apiKey?: string
  /** provider 提示（来自 --provider，默认 'anthropic'） */
  provider?: string
  workspaceId?: string
  workspaceRootPath?: string
  createdWorkspace?: boolean
  createdSessionId?: string
  createdSourceSlug?: string
  createdSkillSlug?: string
  createdAutomation?: boolean
  automationTestSessionId?: string
  /** 如果 bug 出现，该 session 是被失败条件阻塞的 automation 创建的 */
  automationBlockedSessionId?: string
  automationName?: string
  automationBlockedName?: string
  createdLabelId?: string
  /** 覆盖前 automations.json 的备份（undefined 表示文件不存在） */
  automationsJsonBackup?: string | null
  /** 覆盖前 automations-history.jsonl 的备份（undefined 表示文件不存在） */
  automationsHistoryBackup?: string | null
  branchedSessionId?: string
  /** 用于 session tool 验证的 e2e-test label ID */
  e2eTestLabelId?: string
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void
}

/** 验证步骤中用到的 RPC 响应最小形状。 */
interface ValidateStatus {
  id?: string
  label?: string
}

interface ValidateSession {
  id: string
  name?: string
  labels?: string[]
}

interface ValidateLabel {
  id?: string
  name?: string
}

interface ValidateMessageBlock {
  type: string
  text?: string
}

interface ValidateMessage {
  role: string
  content: string | ValidateMessageBlock[]
}

interface ValidateMessagesResponse {
  messages?: ValidateMessage[]
  conversation?: ValidateMessage[]
}

/**
 * 向会话发送消息并等待流式事件。
 * 返回收到的事件类型摘要。
 * 若 expectTool 为 true，会校验是否收到了 tool_start + tool_result。
 */
async function waitForSendEvents(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  timeoutMs: number,
  expectTool: boolean,
  sendOptions?: Record<string, unknown>,
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void,
  expectToolName?: string,
): Promise<string> {
  const seen = new Set<string>()
  let textChunks = 0
  let toolName = ''
  let finished = false

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    seen.add(ev.type)
    if (ev.type === 'text_delta') textChunks++
    if (ev.type === 'tool_start') toolName = String(ev.toolName ?? '')
    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'interrupted') {
      finished = true
    }
    onEvent?.(ev)
  })

  try {
    await client.invoke('sessions:sendMessage', sessionId, message,
      undefined, undefined, sendOptions)

    const deadline = Date.now() + timeoutMs
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!finished) throw new Error('Timed out waiting for completion')

    // 只有当最终事件是 error 且没有出现 complete 时才视为失败
    if (seen.has('error') && !seen.has('complete')) throw new Error('Session returned an error event')

    if (expectTool) {
      if (!seen.has('tool_start')) throw new Error('No tool_start event received')
      if (!seen.has('tool_result')) throw new Error('No tool_result event received')
      if (expectToolName && !toolName.includes(expectToolName)) {
        throw new Error(`Expected tool containing "${expectToolName}", got "${toolName}"`)
      }
      return `tool=${toolName}, ${textChunks} text deltas, events: ${[...seen].join(', ')}`
    }

    if (!seen.has('text_delta')) throw new Error('No text_delta events received')
    return `${textChunks} text deltas, events: ${[...seen].join(', ')}`
  } finally {
    unsub()
  }
}

/**
 * 清理自动化测试产物（配置文件、会话、label）。
 * 供 automation:cleanup 验证步骤和 runValidation 的错误恢复共用。
 */
async function cleanupAutomationArtifacts(
  client: CliRpcClient,
  ctx: ValidateContext,
): Promise<string[]> {
  const cleaned: string[] = []

  // 恢复或删除 automation 配置文件
  if (ctx.workspaceRootPath && ctx.createdAutomation) {
    try {
      const { writeFile, unlink } = await import('fs/promises')
      const configPath = `${ctx.workspaceRootPath}/automations.json`
      const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
      if (ctx.automationsJsonBackup != null) {
        await writeFile(configPath, ctx.automationsJsonBackup).catch(() => {})
        cleaned.push('automations.json (restored)')
      } else {
        await unlink(configPath).catch(() => {})
        cleaned.push('automations.json (removed)')
      }
      if (ctx.automationsHistoryBackup != null) {
        await writeFile(historyPath, ctx.automationsHistoryBackup).catch(() => {})
      } else {
        await unlink(historyPath).catch(() => {})
      }
      ctx.createdAutomation = false
    } catch { /* 尽力而为 */ }
  }

  // 删除 automation 触发的测试会话
  for (const key of ['automationTestSessionId', 'automationBlockedSessionId'] as const) {
    const id = ctx[key]
    if (!id || !client.isConnected) continue
    try {
      await client.invoke('sessions:delete', id)
      cleaned.push(`session ${id}`)
      ctx[key] = undefined
    } catch { /* 尽力而为 */ }
  }

  // 删除测试 label
  if (ctx.workspaceId && ctx.createdLabelId && client.isConnected) {
    try {
      await client.invoke('labels:delete', ctx.workspaceId, ctx.createdLabelId)
      cleaned.push(`label ${ctx.createdLabelId}`)
      ctx.createdLabelId = undefined
    } catch { /* 尽力而为 */ }
  }

  return cleaned
}

/** 返回所有验证步骤。 */
export function getValidateSteps(): ValidateStep[] {
  return [
    {
      name: 'Connect + handshake',
      fn: async (client) => {
        const start = performance.now()
        const clientId = await client.connect()
        const ms = Math.round(performance.now() - start)
        return `clientId: ${clientId}, ${ms}ms`
      },
    },
    {
      name: 'credentials:healthCheck',
      fn: async (client) => {
        const r = (await client.invoke('credentials:healthCheck')) as any
        return JSON.stringify(r)
      },
    },
    {
      name: 'system:versions',
      fn: async (client) => {
        const r = (await client.invoke('system:versions')) as any
        return r?.node ? `node=${r.node}` : JSON.stringify(r)
      },
    },
    {
      name: 'system:homeDir',
      fn: async (client) => {
        const r = await client.invoke('system:homeDir')
        return String(r)
      },
    },
    {
      name: 'workspaces:get',
      fn: async (client, ctx) => {
        // 如果传了 --workspace-dir，就从该目录注册 workspace
        if (ctx.workspaceDir) {
          const { resolve } = await import('path')
          const absPath = resolve(ctx.workspaceDir)
          const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
          ctx.workspaceId = ws.id
          ctx.workspaceRootPath = absPath
          await client.invoke('window:switchWorkspace', ws.id)
          return `registered: ${absPath}`
        }
        const r = (await client.invoke('workspaces:get')) as any[]
        if (r?.length > 0) {
          ctx.workspaceId = r[0].id
          ctx.workspaceRootPath = r[0].rootPath ?? r[0].path
          // 把当前客户端绑定到该 workspace，这样推送事件（如 session:event）
          // 路由到 workspace 时才能到达本连接。
          await client.invoke('window:switchWorkspace', r[0].id)
          return `${r.length} workspaces`
        }
        // CI 环境下自动创建一个临时 workspace
        const { mkdtemp } = await import('fs/promises')
        const { tmpdir } = await import('os')
        const tmpDir = await mkdtemp(`${tmpdir()}/craft-validate-`)
        const ws = (await client.invoke('workspaces:create', tmpDir, 'validate-workspace')) as { id: string }
        ctx.workspaceId = ws.id
        ctx.workspaceRootPath = tmpDir
        ctx.createdWorkspace = true
        await client.invoke('window:switchWorkspace', ws.id)
        return `0 found → created temp workspace`
      },
    },
    {
      name: 'sessions:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sessions`
      },
    },
    {
      name: 'LLM_Connection:list',
      fn: async (client, ctx) => {
        const r = (await client.invoke('LLM_Connection:list')) as any[]

        // 自定义 endpoint：只要传了 --base-url 就总是新建/更新连接
        if (ctx.baseUrl) {
          const provider = ctx.provider || 'anthropic'
          let key = ''
          try {
            key = resolveApiKey(provider, ctx.apiKey || '')
          } catch (error) {
            return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
          }
          const slug = `${provider}-cli`
          const isAnthropicApi = provider === 'anthropic'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: `${getProviderDisplayName(provider)} (Custom Endpoint)`,
            providerType: 'pi_compat',
            authType: 'api_key_with_endpoint',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            credential: key,
            baseUrl: ctx.baseUrl,
            customEndpoint: { api: isAnthropicApi ? 'anthropic-messages' : 'openai-completions' },
            defaultModel: isAnthropicApi ? 'claude-sonnet-4-6' : 'gpt-4o',
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + custom endpoint via ${ctx.baseUrl}`
        }

        // Amazon Bedrock：使用 IAM 凭证设置连接
        if (ctx.provider === 'amazon-bedrock') {
          const accessKeyId = process.env.AWS_ACCESS_KEY_ID
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
          const region = process.env.AWS_REGION || 'us-east-1'
          const sessionToken = process.env.AWS_SESSION_TOKEN
          if (!accessKeyId || !secretAccessKey) {
            return '0 connections (missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
          }
          const slug = 'amazon-bedrock-cli'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: 'Amazon Bedrock',
            providerType: 'pi',
            authType: 'iam_credentials',
            piAuthProvider: 'amazon-bedrock',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            piAuthProvider: 'amazon-bedrock',
            bedrockAuthMethod: 'iam_credentials',
            iamCredentials: { accessKeyId, secretAccessKey, sessionToken },
            awsRegion: region,
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + Bedrock IAM (${region})`
        }

        const provider = ctx.provider || 'anthropic'
        if (!shouldSetupLlmConnection(r?.length ?? 0, { provider, baseUrl: ctx.baseUrl ?? '' })) {
          return `${r.length} connections`
        }
        // 根据环境/参数自动为指定 provider 创建连接
        let key = ''
        try {
          key = resolveApiKey(provider, ctx.apiKey || '')
        } catch (error) {
          return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
        }
        const slug = `${provider}-cli`
        const providerType = provider === 'anthropic' ? 'anthropic' : 'pi'
        const authType = 'api_key'
        await client.invoke('LLM_Connection:save', {
          slug,
          name: getProviderDisplayName(provider),
          providerType,
          authType,
          createdAt: Date.now(),
        })
        const setupPayload = provider === 'anthropic'
          ? { slug, credential: key }
          : { slug, credential: key, piAuthProvider: provider }
        const result = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
        if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
        await client.invoke('LLM_Connection:setDefault', slug)
        return `0 found → created ${provider} connection`
      },
    },
    {
      name: 'sources:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sources`
      },
    },
    {
      name: 'sessions:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const name = `__cli-validate-${Date.now()}`
        const r = (await client.invoke('sessions:create', ctx.workspaceId, {
          name,
          permissionMode: 'allow-all',
        })) as any
        ctx.createdSessionId = r?.id
        return ctx.createdSessionId ?? 'created'
      },
    },
    {
      name: 'sessions:getMessages',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:getMessages', ctx.createdSessionId)
        return 'session readable'
      },
    },
    {
      name: 'send message + stream',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Reply with exactly: VALIDATION_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'send message + tool use',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the Bash tool to run: echo TOOL_VALIDATION_OK', 90_000, true, undefined, ctx.onEvent)
      },
    },
    // ----- Session tool 验证（防止 #511 回归）-----
    {
      name: 'labels:create (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('labels:create', ctx.workspaceId, {
          name: 'e2e-test',
          color: 'gray',
        })) as any
        ctx.e2eTestLabelId = r?.id
        return `label created: ${r?.id}`
      },
    },
    {
      name: 'session-tools:set_session_labels',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        if (!ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        const result = await waitForSendEvents(client, ctx.createdSessionId,
          'Use the set_session_labels tool to set labels: ["e2e-test"] on the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'set_session_labels')
        // 校验 label 真的被应用到了 session 上
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        const session = sessions?.find((s: any) => s.id === ctx.createdSessionId)
        const labels = session?.labels ?? session?.labelIds ?? []
        if (!labels.length) throw new Error('Labels not applied to session')
        return `${result} — labels verified: ${JSON.stringify(labels)}`
      },
    },
    {
      name: 'session-tools:get_session_info',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the get_session_info tool to get info about the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'get_session_info')
      },
    },
    {
      name: 'session-tools:list_sessions',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the list_sessions tool to list all sessions. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'list_sessions')
      },
    },
    // ----- Session 分支 -----
    {
      name: 'sessions:branch',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session)'
        const r = (await client.invoke('sessions:getMessages', ctx.createdSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const firstAssistant = messages.find((m) => m.role === 'assistant') as any
        if (!firstAssistant?.id) throw new Error('No assistant message found to branch from')
        const branch = (await client.invoke('sessions:create', ctx.workspaceId, {
          name: `__cli-validate-branch-${Date.now()}`,
          permissionMode: 'allow-all',
          branchFromSessionId: ctx.createdSessionId,
          branchFromMessageId: firstAssistant.id,
        })) as any
        ctx.branchedSessionId = branch?.id
        return `branched at message ${firstAssistant.id} → session ${branch?.id}`
      },
    },
    {
      name: 'sessions:branch verify',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        const r = (await client.invoke('sessions:getMessages', ctx.branchedSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const hasAssistant = messages.some((m) => m.role === 'assistant')
        if (!hasAssistant) throw new Error('Branch missing assistant message')
        const origR = (await client.invoke('sessions:getMessages', ctx.createdSessionId!)) as ValidateMessagesResponse
        const origMessages = origR?.messages ?? origR?.conversation ?? []
        if (messages.length >= origMessages.length) {
          throw new Error(`Branch has ${messages.length} messages, expected fewer than original (${origMessages.length})`)
        }
        return `branch has ${messages.length} messages (original has ${origMessages.length})`
      },
    },
    {
      name: 'sessions:branch send',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        return await waitForSendEvents(client, ctx.branchedSessionId,
          'Reply with exactly: BRANCH_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Source 生命周期 -----
    {
      name: 'sources:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:create', ctx.workspaceId, {
          name: 'Cat Facts',
          provider: 'catfact',
          type: 'api',
          api: { baseUrl: 'https://catfact.ninja', authType: 'none' },
          icon: '🐱',
        })) as any
        ctx.createdSourceSlug = r?.slug
        return ctx.createdSourceSlug ? `slug=${ctx.createdSourceSlug}` : JSON.stringify(r)
      },
    },
    {
      name: 'send + source mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSourceSlug) return 'skipped (no session or source)'
        // 在会话上启用该 source
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: [ctx.createdSourceSlug],
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:${ctx.createdSourceSlug}] Get me a cat fact`, 90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- MCP source 验证（源文件已预置在 .github/agents/sources/）-----
    {
      name: 'mcp:craft-public (auth:none)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        // 在会话上启用预置的 craft-public MCP source
        const enableSlugs = [ctx.createdSourceSlug, 'craft-public'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:craft-public] List the documents under the "CraftAgents E2E Test" folder inside the "CraftAgents" folder. Just list their names.`,
          180_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'mcp:stitch-mcp (header-auth)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        const apiKey = process.env.STITCH_API_KEY
        if (!apiKey) return 'skipped (no STITCH_API_KEY)'
        // 以多 header JSON 格式把凭证写入 store，与 API headerNames 格式一致
        await client.invoke('sources:saveCredentials', ctx.workspaceId, 'stitch-mcp', JSON.stringify({ 'X-Goog-Api-Key': apiKey }))
        // 在会话上启用 stitch-mcp 和已有 source
        const enableSlugs = [ctx.createdSourceSlug, 'craft-public', 'stitch-mcp'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the source_test tool to test the stitch-mcp source. Report the result.`,
          90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Skill 生命周期 -----
    {
      name: 'send + skill create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        ctx.createdSkillSlug = '__cli-validate-skill'
        const sourceSlug = ctx.createdSourceSlug ?? 'cat-facts'
        const skillDir = `${ctx.workspaceRootPath}/skills/${ctx.createdSkillSlug}`
        // 用 Bash 工具在 workspace 下确定性创建 skill 文件
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the Bash tool to run this exact command:\nmkdir -p "${skillDir}" && cat > "${skillDir}/SKILL.md" << 'SKILLEOF'\n---\nname: "CLI Validate Skill"\ndescription: "Validation skill created by craft-cli"\nrequiredSources:\n  - "${sourceSlug}"\n---\n\nThis skill does two things:\n1. Check the current water temperature of Lake Balaton (search the web or estimate based on the season)\n2. Use the Cat Facts source to get a random cat fact\n\nAlways perform both steps when this skill is invoked.\nSKILLEOF`, 90_000, true, undefined, ctx.onEvent)
      },
    },
    {
      name: 'skills:get (verify)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        const r = (await client.invoke('skills:get', ctx.workspaceId)) as any[]
        const found = r?.find((s: any) => s.slug === ctx.createdSkillSlug)
        if (!found) throw new Error(`Skill '${ctx.createdSkillSlug}' not found in skills list`)
        return `found: ${found.name ?? found.slug}`
      },
    },
    {
      name: 'send + skill mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSkillSlug) return 'skipped (no session or skill)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[skill:${ctx.createdSkillSlug}] Run the skill`, 120_000, false,
          { skillSlugs: [ctx.createdSkillSlug] }, ctx.onEvent)
      },
    },
    {
      name: 'skills:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        await client.invoke('skills:delete', ctx.workspaceId, ctx.createdSkillSlug)
        return `deleted skill: ${ctx.createdSkillSlug}`
      },
    },
    // ----- Automation 生命周期 -----
    {
      name: 'automation:create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        const configPath = `${ctx.workspaceRootPath}/automations.json`
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`
        const { readFile, writeFile } = await import('fs/promises')

        // 先备份原配置，测试结束后再恢复；这样不会破坏用户已有的 automation 配置
        const existingConfig = await readFile(configPath, 'utf-8').catch(() => null)
        ctx.automationsJsonBackup = existingConfig
        ctx.automationsHistoryBackup = await readFile(historyPath, 'utf-8').catch(() => null)

        const templatePath = `${process.cwd()}/.github/agents/automations.json`
        const templateConfig = await readFile(templatePath, 'utf-8').catch(() => null)
        if (!templateConfig) {
          throw new Error(`Missing automation template at ${templatePath}`)
        }

        const parsed = JSON.parse(templateConfig) as {
          automations?: { SessionStatusChange?: Array<{ name?: string }> }
        }
        const entries = parsed?.automations?.SessionStatusChange
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new Error('Automation template missing automations.SessionStatusChange entries')
        }

        const blocked = entries.find((e) => e.name === 'CLI Validate Condition Blocked')
        const pass = entries.find((e) => e.name === 'CLI Validate Condition Pass')
        if (!blocked?.name || !pass?.name) {
          throw new Error('Automation template must define both "CLI Validate Condition Blocked" and "CLI Validate Condition Pass"')
        }

        ctx.automationBlockedName = blocked.name
        ctx.automationName = pass.name

        await writeFile(configPath, templateConfig)
        ctx.createdAutomation = true
        // ConfigWatcher 会自动检测 automations.json 变更（有防抖），稍等片刻让它加载
        await new Promise((r) => setTimeout(r, 2000))
        return `wrote config from template (blocked=${ctx.automationBlockedName}, pass=${ctx.automationName})`
      },
    },
    {
      name: 'automation:trigger (status change)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session or workspace)'
        // 找到包含 "in-progress" 的状态
        const statuses = (await client.invoke('statuses:list', ctx.workspaceId)) as ValidateStatus[]
        const inProgress = statuses?.find((s) =>
          (s.id ?? '').toLowerCase().includes('in-progress') ||
          (s.label ?? '').toLowerCase().includes('in progress')
        )
        const statusValue = inProgress?.id ?? 'in-progress'

        // 修改会话状态以触发 automation
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSessionStatus',
          state: statusValue,
        })

        // 轮询预期行为：
        // - pass automation 必须创建 session
        // - blocked automation 必须不能创建 session
        let delay = 1000
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
          const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]

          const blockedSession = sessions?.find((s) =>
            s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
          )
          if (blockedSession) {
            ctx.automationBlockedSessionId = blockedSession.id
            throw new Error(`Blocked automation unexpectedly triggered (session=${blockedSession.id})`)
          }

          const passSession = sessions?.find((s) =>
            s.name === ctx.automationName && s.id !== ctx.createdSessionId
          )
          if (passSession) {
            ctx.automationTestSessionId = passSession.id

            // 再稍等一会，确认 blocked automation 没有延迟触发
            await new Promise((r) => setTimeout(r, 2000))
            const sessionsAfter = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
            const blockedAfter = sessionsAfter?.find((s) =>
              s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
            )
            if (blockedAfter) {
              ctx.automationBlockedSessionId = blockedAfter.id
              throw new Error(`Blocked automation unexpectedly triggered after delay (session=${blockedAfter.id})`)
            }

            return `pass triggered → session ${passSession.id}; blocked automation did not trigger (status=${statusValue})`
          }
        }
        throw new Error('Passing automation-created session not found within 60s')
      },
    },
    {
      name: 'automation:verify session',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId) return 'skipped (no automation session)'
        // 等待 automation 创建的会话完成
        let delay = 1000
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const session = (await client.invoke('sessions:getMessages', ctx.automationTestSessionId)) as ValidateMessagesResponse
          const messages = session?.messages ?? session?.conversation ?? []
          const hasAssistant = messages.some((m) => m.role === 'assistant')
          if (hasAssistant) {
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
            const text = typeof lastAssistant?.content === 'string'
              ? lastAssistant.content
              : Array.isArray(lastAssistant?.content)
                ? lastAssistant.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
                : ''
            return `session has assistant response (${text.slice(0, 80).trim()})`
          }
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
        }
        throw new Error('Automation session did not complete within 90s')
      },
    },
    {
      name: 'automation:verify labels',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId || !ctx.workspaceId) return 'skipped (no automation session)'
        // 校验 label 被自动创建
        const labels = (await client.invoke('labels:list', ctx.workspaceId)) as ValidateLabel[]
        const found = labels?.find((l) => (l.id ?? l.name ?? '') === 'cli-validate-label')
        if (!found) throw new Error('Label cli-validate-label was not auto-created')
        ctx.createdLabelId = found.id ?? 'cli-validate-label'

        // 校验 automation session 带有该 label
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        const automationSession = sessions?.find((s) => s.id === ctx.automationTestSessionId)
        const sessionLabels: string[] = automationSession?.labels ?? []
        const hasLabel = sessionLabels.some((l: string) => l.includes('cli-validate-label'))
        if (!hasLabel) throw new Error(`Automation session missing label (has: ${sessionLabels.join(', ')})`)
        return `label created and assigned: ${ctx.createdLabelId}`
      },
    },
    {
      name: 'automations:getLastExecuted',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const history = (await client.invoke('automations:getLastExecuted', ctx.workspaceId)) as Record<string, number>
        const entries = Object.entries(history)
        if (entries.length === 0) throw new Error('No automation execution history found')
        // 校验至少有一次最近两分钟内的执行记录
        const recentThreshold = Date.now() - 120_000
        const recent = entries.find(([, ts]) => ts > recentThreshold)
        if (!recent) throw new Error(`No recent automation execution (latest: ${Math.max(...entries.map(([, ts]) => ts))})`)
        return `${entries.length} automation(s), latest ran ${Math.round((Date.now() - recent[1]) / 1000)}s ago`
      },
    },
    // ----- Webhook 验证 -----
    {
      name: 'webhook:test (RPC)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('automations:test', {
          workspaceId: ctx.workspaceId,
          actions: [{
            type: 'webhook',
            url: 'http://127.0.0.1:19999/validate-test',
            method: 'GET',
          }],
        })) as any
        const result = r?.actions?.[0]
        if (result?.success) throw new Error('Expected webhook to fail (nothing listening)')
        if (!result?.error && result?.statusCode !== 0) throw new Error('Expected error or statusCode 0 in result')
        return `correctly failed: ${(result.error ?? `statusCode=${result.statusCode}`).slice(0, 80)}`
      },
    },
    {
      name: 'webhook:verify failure',
      fn: async (client, ctx) => {
        if (!ctx.workspaceRootPath) return 'skipped (no workspace root)'
        const { readFile } = await import('fs/promises')
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`

        const start = Date.now()
        const deadline = start + 15_000
        let delay = 200

        let lastLineCount = 0
        let lastWebhookCount = 0
        let lastSummary = 'no entries'

        while (Date.now() < deadline) {
          const content = await readFile(historyPath, 'utf-8').catch(() => '')
          const lines = content.trim().split('\n').filter(Boolean)
          lastLineCount = lines.length

          const entries = lines
            .map((l) => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(Boolean) as Array<Record<string, unknown>>

          const webhookEntries = entries.filter((e) => !!e.webhook)
          lastWebhookCount = webhookEntries.length

          if (webhookEntries.length > 0) {
            const recentThreshold = Date.now() - 120_000
            const recentFailed = webhookEntries.find((e: any) =>
              !e.ok && e.ts > recentThreshold && e.webhook?.method === 'POST'
            ) as any
            if (recentFailed) {
              return `webhook failure recorded: method=${recentFailed.webhook.method}, url=${recentFailed.webhook.url?.slice(0, 50)}`
            }

            const latest = webhookEntries[webhookEntries.length - 1] as any
            lastSummary = `latest: ok=${String(latest?.ok)} method=${String(latest?.webhook?.method ?? 'n/a')} ts=${String(latest?.ts ?? 'n/a')}`
          }

          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }

        const waitedMs = Date.now() - start
        throw new Error(
          `No recent failed POST webhook history entry after ${waitedMs}ms (lines=${lastLineCount}, webhookEntries=${lastWebhookCount}, ${lastSummary})`,
        )
      },
    },
    {
      name: 'automation:cleanup',
      fn: async (client, ctx) => {
        const cleaned = await cleanupAutomationArtifacts(client, ctx)
        return cleaned.length > 0 ? `cleaned: ${cleaned.join(', ')}` : 'nothing to clean'
      },
    },
    {
      name: 'sessions:branch delete',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        await client.invoke('sessions:delete', ctx.branchedSessionId)
        const id = ctx.branchedSessionId
        ctx.branchedSessionId = undefined
        return `deleted branch session: ${id}`
      },
    },
    {
      name: 'sources:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSourceSlug) return 'skipped (no source)'
        await client.invoke('sources:delete', ctx.workspaceId, ctx.createdSourceSlug)
        return `deleted source: ${ctx.createdSourceSlug}`
      },
    },
    {
      name: 'labels:delete (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        await client.invoke('labels:delete', ctx.workspaceId, ctx.e2eTestLabelId)
        return `deleted label: ${ctx.e2eTestLabelId}`
      },
    },
    {
      name: 'sessions:delete',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:delete', ctx.createdSessionId)
        return `deleted session: ${ctx.createdSessionId}`
      },
    },
    {
      name: 'Disconnect',
      fn: async (client) => {
        client.destroy()
        return 'OK'
      },
    },
  ]
}

/** 按顺序执行所有验证步骤，汇总结果并返回退出码。 */
export async function runValidation(
  client: CliRpcClient,
  jsonMode: boolean,
  noSpinner?: boolean,
  workspaceDir?: string,
  validateOptions?: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<number> {
  const steps = getValidateSteps()
  const total = steps.length
  const ctx: ValidateContext = {
    workspaceDir,
    baseUrl: validateOptions?.baseUrl,
    apiKey: validateOptions?.apiKey,
    provider: validateOptions?.provider,
  }
  let passed = 0
  let failed = 0
  const results: Array<{ step: string; status: string; detail: string; elapsed: number }> = []
  const totalStart = performance.now()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const num = `[${i + 1}/${total}]`
    const plainLen = num.length + 1 + step.name.length

    // 转圈动画 + 实时事件打印
    // 转圈持续到 AI 产生真实输出（text_delta/tool_start）为止。
    // 早期内部事件（user_message、connection_changed、usage_update）会被缓冲或忽略，
    // 让转圈在 AI 思考期间保持可见。
    let spinner: { stop(): void } | undefined
    if (!jsonMode) {
      let headerPrinted = false
      let accText = ''
      let textFlushed = false
      let bufferedPrompt = ''

      if (_useColor && !noSpinner) {
        spinner = createSpinner(`${c.cyan(num)} ${step.name}`)
      }

      const flushText = () => {
        if (textFlushed || !accText) return
        const clean = accText.replace(/\n/g, ' ').trim()
        if (!clean) return
        const display = clean.length > 120 ? clean.slice(0, 120) + '…' : clean
        process.stdout.write(`    ${c.dim('↳')} ${c.yellow(display)}\n`)
        textFlushed = true
      }

      const ensureHeader = () => {
        if (headerPrinted) return
        spinner?.stop()
        process.stdout.write(`${c.cyan(num)} ${step.name}\n`)
        if (bufferedPrompt) {
          process.stdout.write(`    ${c.dim('→')} ${c.blue(`"${bufferedPrompt}"`)}\n`)
        }
        headerPrinted = true
      }

      ctx.onEvent = (ev) => {
        switch (ev.type) {
          // 缓冲用户提示词，等 AI 开始回复时一起显示
          case 'user_message': {
            const msg = ev.message as any
            let text = ''
            if (typeof msg?.content === 'string') {
              text = msg.content
            } else if (Array.isArray(msg?.content)) {
              text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            }
            const clean = text.replace(/\n/g, ' ').trim()
            bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
            break
          }
          // AI 文本：停止转圈，显示标题 + 提示词 + 文本
          case 'text_delta':
            ensureHeader()
            accText += String(ev.delta ?? '')
            if (!textFlushed && accText.length > 40) flushText()
            break
          case 'text_complete':
            ensureHeader()
            flushText()
            break
          // 工具调用：停止转圈，显示标题 + 提示词 + 工具名
          case 'tool_start': {
            ensureHeader()
            flushText()
            const name = String(ev.toolName ?? '?')
            const intent = ev.toolIntent ? ` — "${ev.toolIntent}"` : ''
            process.stdout.write(`    ${c.dim('↳')} ${c.dim(`tool: ${name}${intent}`)}\n`)
            accText = ''
            textFlushed = false
            break
          }
          // 忽略内部事件（connection_changed、usage_update 等）
        }
      }
    } else {
      ctx.onEvent = undefined
    }

    const stepStart = performance.now()
    try {
      const detail = await step.fn(client, ctx)
      const elapsed = (performance.now() - stepStart) / 1000
      passed++
      results.push({ step: step.name, status: 'OK', detail, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stdout.write(`${c.cyan(num)} ${step.name} ${dots} ${c.green('✓')}  ${detail}  ${time}\n`)
      }
    } catch (e) {
      const elapsed = (performance.now() - stepStart) / 1000
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ step: step.name, status: 'FAIL', detail: msg, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stderr.write(`${c.cyan(num)} ${step.name} ${dots} ${c.red('✗')}  ${msg}  ${time}\n`)
      }
    }
  }

  // 清理：分支会话
  if (ctx.branchedSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.branchedSessionId)
    } catch {
      // 尽力而为
    }
  }

  // 清理：如果创建了主会话但删除步骤未运行或失败
  if (ctx.createdSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.createdSessionId)
    } catch {
      // 尽力而为
    }
  }

  // 清理：automation 产物
  await cleanupAutomationArtifacts(client, ctx)

  // 清理：如果自动创建了临时 workspace，则删除
  if (ctx.createdWorkspace && ctx.workspaceId && client.isConnected) {
    try {
      await client.invoke('workspaces:delete', ctx.workspaceId)
    } catch {
      // 尽力而为
    }
    if (ctx.workspaceRootPath) {
      try {
        const { rm } = await import('fs/promises')
        await rm(ctx.workspaceRootPath, { recursive: true, force: true })
      } catch {
        // 尽力而为
      }
    }
  }

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1)

  if (jsonMode) {
    out({ total, passed, failed, results, elapsedSeconds: parseFloat(totalSec) }, true)
  } else {
    if (failed === 0) {
      process.stdout.write(`\n${c.green(`✓ ${passed}/${total} passed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    } else {
      process.stdout.write(`\n${c.red(`✗ ${passed}/${total} passed, ${failed} failed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    }
  }

  return failed > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------
// 帮助信息
// ---------------------------------------------------------------------------

/** 打印命令行帮助信息。 */
function printHelp(): void {
  process.stdout.write(`craft-cli — Terminal client for Craft Agent server

Usage: craft-cli [options] <command> [args...]

Connection:
  --url <ws[s]://...>    Server URL (default: $CRAFT_SERVER_URL)
  --token <secret>       Auth token (default: $CRAFT_SERVER_TOKEN)
  --workspace <id>       Workspace ID (auto-detected if omitted)
  --timeout <ms>         Request timeout (default: 10000)
  --tls-ca <path>        Custom CA cert for self-signed TLS
  --json                 Raw JSON output for scripting

LLM Configuration (for 'run' command):
  --provider <name>      LLM provider (default: anthropic, or $LLM_PROVIDER)
                         Supported: anthropic, openai, google, openrouter, groq, mistral, deepseek, xai, ...
  --model <id>           Model to use (or $LLM_MODEL)
  --api-key <key>        API key (or $LLM_API_KEY, or provider-specific e.g. $OPENAI_API_KEY)
  --base-url <url>       Custom API endpoint (or $LLM_BASE_URL)

Commands:
  run <message>          Spawn server, send message, stream response, exit
                         --workspace-dir <path>  Use directory as workspace (creates if needed)
                         --source <slug>     Enable source (repeatable)
                         --mode <mode>       Permission mode (default: allow-all)
                         --output-format     text or stream-json (default: text)
                         --no-cleanup        Keep session after completion
                         --server-entry      Path to server/index.ts
  ping                   Verify connectivity (clientId + latency)
  health                 Check credential store health
  versions               Show server runtime versions
  workspaces             List workspaces
  sessions               List sessions in workspace
  connections            List LLM connections
  sources                List configured sources
  session create         Create a session (--name, --mode)
  session messages <id>  Print session message history
  session delete <id>    Delete a session
  send <id> <message>    Send message and stream AI response
  cancel <id>            Cancel in-progress processing
  invoke <channel> [...] Raw RPC call with JSON args
  listen <channel>       Subscribe to push events (Ctrl+C to stop)
  --validate-server      Multi-step server integration test
                         --verbose, -v       Show server stderr output

Examples:
  craft-cli run "What files are in the current directory?"
  craft-cli run --source craft-kb "Summarize today's daily note"
  craft-cli run --workspace-dir .github/agents --source craft-public "Read the doc"
  craft-cli run --provider openai --model gpt-4o "Summarize this repo"
  OPENAI_API_KEY=sk-... craft-cli run --provider openai "Hello"
  GOOGLE_API_KEY=... craft-cli run --provider google --model gemini-2.0-flash "Hello"
  DEEPSEEK_API_KEY=sk-... craft-cli run --provider deepseek --model deepseek-v4-flash "Hello"
  echo "Analyze this code" | craft-cli run
  craft-cli ping
  craft-cli sessions
  craft-cli send abc-123 "What files are in the current directory?"
  echo "Summarize this" | craft-cli send abc-123
  craft-cli --validate-server
  craft-cli invoke system:homeDir
  craft-cli --json workspaces | jq '.[].name'
`)
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 主函数：解析参数并分发到各命令。 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  // 在任何 WebSocket 连接前设置自定义 CA
  if (args.tlsCa) {
    process.env.NODE_EXTRA_CA_CERTS = args.tlsCa
  }

  if (args.command === 'help' || args.command === '') {
    printHelp()
    return
  }

  if (args.command === 'version') {
    const pkg = await import('../package.json')
    out(pkg.version ?? pkg.default?.version ?? 'unknown', false)
    return
  }

  // run 是自包含命令：自己启动服务
  if (args.command === 'run') {
    await cmdRun(args)
    return
  }

  // validate 可以自己启动服务，也可以用 --url 指定外部服务
  if (args.command === 'validate') {
    await cmdValidate(args)
    return
  }

  // 其他所有命令都需要显式服务端 URL
  if (!args.url) {
    err('No server URL. Use --url <ws://...> or set $CRAFT_SERVER_URL')
    process.exit(1)
  }

  const client = new CliRpcClient(args.url, {
    token: args.token || undefined,
    workspaceId: args.workspace,
    requestTimeout: args.timeout,
    connectTimeout: args.timeout,
  })

  try {
    switch (args.command) {
      case 'ping':
        await cmdPing(client, args)
        break
      case 'health':
        await cmdHealth(client, args)
        break
      case 'versions':
        await cmdVersions(client, args)
        break
      case 'workspaces':
        await cmdWorkspaces(client, args)
        break
      case 'sessions':
        await cmdSessions(client, args)
        break
      case 'connections':
        await cmdConnections(client, args)
        break
      case 'sources':
        await cmdSources(client, args)
        break
      case 'session': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'create':
            await cmdSessionCreate(client, args)
            break
          case 'messages':
            await cmdSessionMessages(client, args)
            break
          case 'delete':
            await cmdSessionDelete(client, args)
            break
          default:
            err(`Unknown session subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'send':
        await cmdSend(client, args)
        break // cmdSend 内部会调用 process.exit
      case 'cancel':
        await cmdCancel(client, args)
        break
      case 'invoke':
        await cmdInvoke(client, args)
        break
      case 'listen':
        await cmdListen(client, args)
        break // 永远不会返回
      default:
        err(`Unknown command: ${args.command}`)
        printHelp()
        process.exit(1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    process.exit(1)
  } finally {
    client.destroy()
  }
}

// 直接执行脚本时启动（被测试导入时不执行）
if (import.meta.main) {
  main()
}

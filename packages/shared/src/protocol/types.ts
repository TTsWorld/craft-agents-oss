/**
 * 基于 WebSocket 的 RPC 层底层协议类型。
 *
 * 服务端（主进程 / headless）与客户端（渲染进程 / Node）共用。
 * 这些类型只描述“线上格式”，不涉具体业务。
 */

// ---------------------------------------------------------------------------
// 消息信封（message envelope）：所有 WS 消息都套在这个结构里发送
// ---------------------------------------------------------------------------

// MessageType：消息在协议层面的角色，类似一个小的消息 opcode。
export type MessageType =
  | 'handshake'          // 握手：客户端发起连接
  | 'handshake_ack'      // 握手确认：服务端回应
  | 'request'            // 请求：客户端调用某个 channel
  | 'response'           // 响应：服务端返回结果
  | 'event'              // 事件：服务端主动推送
  | 'error'              // 错误：调用失败
  | 'sequence_ack'       // 可靠投递确认

// MessageEnvelope：RPC 消息的最外层结构，类比 Go 中一个统一协议头 + body 的 struct。
export interface MessageEnvelope {
  /** 关联 ID。请求用 UUIDv4；响应/事件会原样带回，用于匹配一次往返。 */
  id: string
  type: MessageType
  /** request / response / event / error 必须携带的频道名，对应 RPC_CHANNELS 里的字符串。 */
  channel?: string
  /** 请求参数或事件负载。unknown[] 表示未做业务校验，上层 handler 会再 narrow。 */
  args?: unknown[]
  /** 响应返回的数据。 */
  result?: unknown
  /** 结构化错误信息。 */
  error?: WireError
  /** 握手/握手确认时携带的协议版本号。 */
  protocolVersion?: string
  /** 握手时由客户端上报的 workspaceId，用于确定请求应路由到哪个服务端。 */
  workspaceId?: string
  /** 握手时携带的远程认证 token。 */
  token?: string
  /** 服务端在 handshake_ack 中分配的客户端唯一标识。 */
  clientId?: string
  /** 服务端身份戳，用于多客户端场景下区分事件来源。 */
  serverId?: string
  /** 本地 Electron 客户端握手时上报的 webContents.id。 */
  webContentsId?: number
  /** 握手时客户端宣告自己支持的能力列表。 */
  clientCapabilities?: string[]
  /** 握手确认中返回服务端已注册的 channel 列表，客户端可据此跳过未支持的调用。 */
  registeredChannels?: string[]

  // -- 可靠投递相关字段 --

  /** 每个客户端单调递增的投递序号，服务端给该客户端的每个目标事件分配。 */
  seq?: number
  /** 客户端已处理的最新 seq，出现在 sequence_ack 和重连握手。 */
  lastSeq?: number
  /** 重连时客户端上报的上一次 clientId，服务端用来找旧缓冲区。 */
  reconnectClientId?: string
  /** true 表示 handshake_ack 是因为重连，而非新建连接。 */
  reconnected?: boolean
  /** true 表示服务端缓冲区已被驱逐，客户端需要做一次全量状态刷新。 */
  stale?: boolean
  /** 服务端版本号，出现在 handshake_ack，客户端可用作兼容性判断。 */
  serverVersion?: string
}

// WireError：跨进程/跨网络传输的结构化错误。
export interface WireError {
  code: ErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

// ErrorCode：协议层所有已知错误码的联合类型。
export type ErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'

// KNOWN_ERROR_CODES：运行时可校验的合法错误码集合。
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
])

// isErrorCode：类型保护（type predicate）。
// 返回 true 时，TypeScript 会把 value 缩窄为 ErrorCode。
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

/**
 * 发送方抛出带 code 的传输错误的辅助类。
 *
 * 注意：类身份在跨 wire 传输时会丢失——对端收到的是普通 Error + .code。
 * 因此接收方必须按 err.code === 'X' 判断，不要 instanceof CodedError。
 */
export class CodedError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CodedError'
  }
}

// ---------------------------------------------------------------------------
// 推送目标（服务端 → 客户端）：决定事件推送给谁
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }                       // 所有客户端，可排除某个 clientId
  | { to: 'workspace'; workspaceId: string; exclude?: string } // 某个 workspace 下的客户端
  | { to: 'client'; clientId: string }                   // 单个客户端

// ---------------------------------------------------------------------------
// 协议常量
// ---------------------------------------------------------------------------

// 协议版本号，握手时用于兼容性校验。
export const PROTOCOL_VERSION = '1.0'

/** 心跳间隔（毫秒）。服务端每 30 秒 ping 一次。 */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** 连续丢失多少次 pong 后，服务端会断开该客户端。 */
export const HEARTBEAT_MAX_MISSED = 2

/** 默认请求超时时间（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 30_000

// -- 可靠投递常量 --

/** 每个客户端环形缓冲区最多保留多少条事件。 */
export const EVENT_BUFFER_MAX_SIZE = 500

/** 缓冲区中事件的最大存活时间（毫秒），超过即被驱逐。 */
export const EVENT_BUFFER_TTL_MS = 30_000

/** 断线客户端的缓冲区保留多久（毫秒），供潜在重连恢复。 */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** 客户端每隔多少毫秒发送一次 sequence_ack。 */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000

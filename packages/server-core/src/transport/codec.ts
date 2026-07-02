/**
 * RPC 消息编解码器。
 *
 * WebSocket 上传输的是 JSON 文本，但消息里可能包含 Uint8Array/Buffer（如截图）。
 * JSON 不能直接序列化二进制，所以这里把二进制字段自动转 base64，反序列化时再恢复。
 */

import type { MessageEnvelope } from '@craft-agent/shared/protocol'

/** 线类型标识字段名：用来标记 base64 占位对象 */
const WIRE_TYPE_KEY = '__craftRpcType'
/** base64 参数字段名 */
const WIRE_BASE64_KEY = 'base64'
/** Uint8Array 在线上的类型标识 */
const UINT8_WIRE_TYPE = 'u8'

/** MessageEnvelope 允许的消息类型集合（用于基础校验） */
const MESSAGE_TYPES = new Set([
  'handshake',
  'handshake_ack',
  'request',
  'response',
  'event',
  'error',
  'sequence_ack',
])

/**
 * 编码后的 Uint8Array 在 JSON 中的占位对象。
 */
type EncodedUint8Array = {
  [WIRE_TYPE_KEY]: typeof UINT8_WIRE_TYPE
  [WIRE_BASE64_KEY]: string
}

/**
 * Uint8Array → base64。
 *
 * 优先用 Node Buffer（如果在 Node/Bun 环境），否则用浏览器 API。
 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/**
 * base64 → Uint8Array。
 */
function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'))
  }

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 把未知值统一转成 Uint8Array，支持 Uint8Array/ArrayBuffer/ArrayBufferView。
 */
function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return null
}

/** 判断值是否为普通对象（非 null）。TypeScript 类型谓词，类似 Golang 的类型断言。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 编码线值：递归遍历对象/数组，把遇到的二进制字段替换为 base64 占位对象。
 */
function encodeWireValue(value: unknown): unknown {
  const bytes = toUint8Array(value)
  if (bytes) {
    const encoded: EncodedUint8Array = {
      [WIRE_TYPE_KEY]: UINT8_WIRE_TYPE,
      [WIRE_BASE64_KEY]: bytesToBase64(bytes),
    }
    return encoded
  }

  if (Array.isArray(value)) {
    return value.map(encodeWireValue)
  }

  if (isRecord(value)) {
    const encoded: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      encoded[key] = encodeWireValue(val)
    }
    return encoded
  }

  return value
}

/**
 * 解码线值：递归恢复 base64 占位对象为 Uint8Array。
 */
function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeWireValue)
  }

  if (isRecord(value)) {
    if (
      value[WIRE_TYPE_KEY] === UINT8_WIRE_TYPE &&
      typeof value[WIRE_BASE64_KEY] === 'string'
    ) {
      return base64ToBytes(value[WIRE_BASE64_KEY])
    }

    const decoded: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      decoded[key] = decodeWireValue(val)
    }
    return decoded
  }

  return value
}

/** 判断对象是否符合线错误格式（有 code 和 message）。 */
function isWireError(value: unknown): boolean {
  return isRecord(value)
    && value.code != null
    && typeof value.message === 'string'
}

/**
 * 校验反序列化后的消息是否符合 MessageEnvelope 基本形状。
 */
export function validateEnvelopeShape(value: unknown): value is MessageEnvelope {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.type !== 'string' || !MESSAGE_TYPES.has(value.type)) return false

  if (value.type === 'handshake_ack' && (typeof value.clientId !== 'string' || value.clientId.length === 0)) {
    return false
  }

  if ((value.type === 'request' || value.type === 'event') && typeof value.channel !== 'string') {
    return false
  }

  if (value.type === 'response' && value.error !== undefined && !isWireError(value.error)) {
    return false
  }

  if (value.type === 'error' && !isWireError(value.error)) {
    return false
  }

  return true
}

/**
 * 序列化：把 MessageEnvelope 转成可发送的 JSON 字符串。
 */
export function serializeEnvelope(envelope: MessageEnvelope): string {
  return JSON.stringify(encodeWireValue(envelope))
}

/**
 * 反序列化：把 JSON 字符串转回 MessageEnvelope，并校验形状。
 */
export function deserializeEnvelope(raw: string): MessageEnvelope {
  const parsed = decodeWireValue(JSON.parse(raw))
  if (!validateEnvelopeShape(parsed)) {
    throw new Error('Invalid envelope shape')
  }
  return parsed
}

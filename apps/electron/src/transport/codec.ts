/**
 * 从 @craft-agent/server-core 重新导出传输层编解码函数。
 *
 * envelope（信封）是 RPC 消息的最外层包装，包含消息类型、id、payload 等元数据。
 * 这三个函数分别负责：序列化、反序列化、校验 envelope 形状。
 */
export {
  serializeEnvelope,
  deserializeEnvelope,
  validateEnvelopeShape,
} from '@craft-agent/server-core/transport'

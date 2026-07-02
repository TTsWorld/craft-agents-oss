/**
 * runtime-config.ts
 *
 * 会话运行时的“配置指纹”工具模块。
 *
 * 在 Agent 系统里，一个会话通常对应一个长期运行的 SDK 子进程。
 * 当用户修改模型、baseUrl、自定义 endpoint 等字段时，我们通过比较签名决定：
 * - 热更新：改动只影响运行时，可通过 IPC 通知现有子进程；
 * - 重建：改动涉及 provider / authType / slug / piAuthProvider 等 credential 路由，
 *   必须 dispose 旧子进程并重新创建。
 *
 * 此外，`filterAttachmentsForModelInput` 在发送前过滤图片附件，避免把图片传给
 * 不支持 vision 的模型。
 */

import type { AgentProvider, LlmAuthType } from '@craft-agent/shared/agent/backend'
import { isCompatProvider, modelSupportsImages, type LlmConnection } from '@craft-agent/shared/config'
import type { FileAttachment } from '@craft-agent/shared/protocol'

/** 构建后端运行时签名的输入参数。 */
export interface BackendRuntimeSignatureInput {
  connection: LlmConnection | null
  provider: AgentProvider
  authType?: LlmAuthType
  resolvedModel: string
}

/** 模型输入附件过滤结果。 */
export interface ModelAttachmentFilterResult {
  /** 可安全传递给模型的附件，若无剩余则返回 undefined。 */
  attachments?: FileAttachment[]
  /** 有意从模型负载中省略的图像附件。 */
  omittedImages: FileAttachment[]
}

function definedObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))
}

function normalizeCustomModels(connection: LlmConnection): Array<Record<string, unknown>> {
  return (connection.models ?? [])
    .map(model => {
      if (typeof model === 'string') return { id: model }
      return definedObject({
        id: model.id,
        contextWindow: model.contextWindow,
        supportsImages: typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined,
      })
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * 对 `update_runtime_config` IPC 信封无法安全传播到实时子进程的字段构建稳定签名。
 * 当此签名发生变化时，必须跳过原地刷新路径，转而执行干净的 dispose + recreate，
 * 以使新的认证/提供者路由实际生效。
 *
 * 具体来说，`update_runtime_config`（参见 `pi-agent.ts:requestRuntimeConfigUpdate`
 * 及 `pi-agent-server/src/index.ts:handleUpdateRuntimeConfig` 中的对应处理程序）
 * 携带 `model, providerType, authType, baseUrl, customEndpoint, customModels`——
 * 但不包含 `piAuthProvider`，并且在生命周期中途切换 `slug`/`providerType`/`authType`
 * 会引入凭据路由和提供者注册表状态，而子进程在运行时更新时不会完全重置这些状态。
 */
export function buildRestartRequiredSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType } = input
  return JSON.stringify(definedObject({
    provider,
    authType,
    slug: connection?.slug,
    providerType: connection?.providerType,
    piAuthProvider: connection?.piAuthProvider,
  }))
}

/**
 * 对影响已创建后端运行时的配置字段构建稳定签名。
 * 有意省略 `lastUsedAt` 等元数据。
 */
export function buildBackendRuntimeSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType, resolvedModel } = input

  const connectionShape = connection
    ? definedObject({
        slug: connection.slug,
        providerType: connection.providerType,
        authType: connection.authType,
        defaultModel: connection.defaultModel,
        ...(isCompatProvider(connection.providerType)
          ? {
              baseUrl: connection.baseUrl,
              piAuthProvider: connection.piAuthProvider,
              customEndpoint: connection.customEndpoint
                ? definedObject({
                    api: connection.customEndpoint.api,
                    supportsImages: typeof connection.customEndpoint.supportsImages === 'boolean'
                      ? connection.customEndpoint.supportsImages
                      : undefined,
                  })
                : undefined,
              models: normalizeCustomModels(connection),
            }
          : {}),
      })
    : null

  return JSON.stringify(definedObject({
    provider,
    authType,
    resolvedModel,
    connection: connectionShape,
  }))
}

/** 判断一个附件是否为图片（按 type 或 mimeType 判定）。 */
export function isImageAttachment(attachment: Pick<FileAttachment, 'type' | 'mimeType'>): boolean {
  return attachment.type === 'image' || attachment.mimeType?.startsWith('image/') === true
}

/**
 * 在发送时强制使用已保存的自定义端点图像能力。会话仍可持久化/显示图像附件，
 * 但即使旧子进程具有过时的视觉能力注册表状态，这些附件也不会传递给纯文本模型。
 */
export function filterAttachmentsForModelInput(
  attachments: FileAttachment[] | undefined,
  connection: LlmConnection | null,
  modelId: string,
): ModelAttachmentFilterResult {
  if (!attachments?.length) return { attachments, omittedImages: [] }
  if (!connection || !isCompatProvider(connection.providerType)) return { attachments, omittedImages: [] }
  if (modelSupportsImages(connection, modelId)) return { attachments, omittedImages: [] }

  const modelAttachments: FileAttachment[] = []
  const omittedImages: FileAttachment[] = []

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      omittedImages.push(attachment)
    } else {
      modelAttachments.push(attachment)
    }
  }

  return {
    attachments: modelAttachments.length > 0 ? modelAttachments : undefined,
    omittedImages,
  }
}

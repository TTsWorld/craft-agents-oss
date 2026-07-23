/**
 * card.ts — Lark 交互卡片构建器 + 错误辅助函数。
 *
 * Lark 的 `interactive` 消息类型是一个固定 schema 的 JSON 卡片。我们使用
 * schema 2.0，它支持富元素（`div`、`action`、`markdown` 等）。
 * Phase 2 只输出最小子集：一个文本正文元素加一行按钮 action。
 * 每个按钮的 `value` 携带我们的关联 ID，使网关能把点击事件路由回正确的 session。
 *
 * 这里强制的限制：
 *   - 每张卡片最多 10 个按钮（与 Telegram 的上限一致）
 *   - 按钮文案截断为 30 字符（Lark 的显示阈值）
 */

import type { InlineButton } from '../../types'

const MAX_BUTTONS = 10
const MAX_LABEL_LENGTH = 30

/**
 * Lark schema 2.0 信封结构。相比旧版 1.0 卡片有两处形状变化：
 *  - elements 放在 `body` 下，不再在顶层（否则报错码 200621 ——
 *    「unknown property, property: elements」）。
 *  - 包裹按钮的 `tag: 'action'` 容器没了；按钮直接作为
 *    `body.elements` 子元素（否则报错码 200861 ——
 *    「unsupported tag action; cards of schema V2 no longer support this capability」）。
 *  - 按钮点击载荷使用 `behaviors: [{ type: 'callback', value }]`，
 *    而非 schema 1.0 里使用的裸 `value` 字段。
 */
export interface LarkCardSchema {
  schema: '2.0'
  config: { wide_screen_mode: boolean }
  body: {
    direction?: 'vertical' | 'horizontal'
    elements: Array<
      | { tag: 'div'; text: { tag: 'plain_text'; content: string } }
      | {
          tag: 'button'
          text: { tag: 'plain_text'; content: string }
          type: 'primary' | 'default'
          behaviors: Array<{
            type: 'callback'
            value: { buttonId: string; messageId: string; data?: string }
          }>
        }
    >
  }
}

export interface BuildCardOptions {
  /** 写入按钮 `value.messageId` 的标识符，用于把点击事件关联回原消息。 */
  messageId: string
}

export function buildLarkCard(
  text: string,
  buttons: InlineButton[],
  opts: BuildCardOptions,
): LarkCardSchema {
  const capped = buttons.slice(0, MAX_BUTTONS)

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: text } },
        // Schema 2.0：按钮直接放在 `body.elements` 里（没有 `action` 包裹），
        // 点击载荷移到了 `behaviors[].value`。
        ...capped.map((btn, idx) => ({
          tag: 'button' as const,
          text: { tag: 'plain_text' as const, content: truncateLabel(btn.label) },
          // 第一个按钮为「primary」（视觉强调）——与 Telegram 首个按钮加样式的约定一致。
          type: idx === 0 ? ('primary' as const) : ('default' as const),
          behaviors: [
            {
              type: 'callback' as const,
              value: {
                buttonId: btn.id,
                messageId: opts.messageId,
                ...(btn.data !== undefined ? { data: btn.data } : {}),
              },
            },
          ],
        })),
      ],
    },
  }
}

function truncateLabel(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label
  return label.slice(0, MAX_LABEL_LENGTH - 1) + '…'
}

/**
 * 「移除按钮」补丁——在点击被处理后由 `clearButtons` 使用。
 * 丢弃 `action` 元素，保留原始文本正文。
 */
export function buildClearedCard(text: string): LarkCardSchema {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }],
    },
  }
}

// ---------------------------------------------------------------------------
// 错误辅助函数
// ---------------------------------------------------------------------------

/**
 * 当 `update`/`patch` 调用超出可编辑时间窗口（当前对机器人是 24h），
 * 或消息因其他原因无法编辑（已删除、类型不匹配等）时，Lark 返回结构化错误。
 *
 * grammY 风格的 HttpError 形状在这里不适用；SDK 抛出的 Error 带有 `code` 属性。
 * 我们按 code 值匹配而非消息字符串，避免 Lark 做 i18n 变更后导致判断失效。
 */
const LARK_EDIT_EXPIRED_CODES = new Set<number>([
  230003, // 通用：「message can't be edited」
  234001, // im 专用：超出可编辑时间
])

export function isLarkEditExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'number' && LARK_EDIT_EXPIRED_CODES.has(code)) return true
  // 兜底：SDK 有时把 code 包在 `response.code` 下
  const respCode = (err as { response?: { code?: unknown } }).response?.code
  if (typeof respCode === 'number' && LARK_EDIT_EXPIRED_CODES.has(respCode)) return true
  return false
}

/** 暴露给测试 + 适配器侧日志的上限，用于卡片按钮过多时的记录。 */
export const LARK_MAX_BUTTONS = MAX_BUTTONS
export const LARK_MAX_LABEL_LENGTH = MAX_LABEL_LENGTH

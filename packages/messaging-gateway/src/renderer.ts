/**
 * Renderer —— 把 SessionManager 事件转换成聊天消息。
 *
 * 通过每个 binding 的 `BindingConfig.responseMode` 选择三种模式：
 *
 *   - `streaming`（legacy）：在 Telegram 上，首个 `text_delta` 时发消息，
 *     之后每 ~editIntervalMs 随 token 到达编辑一次；每次 `text_complete`
 *     终结当前消息，所以一次有多个 turn 的 agent 运行会产出多条消息。
 *     在不支持编辑的平台上，按 turn 累积并在每次 `text_complete` 时发送。
 *
 *   - `progress`（默认）：每次运行一条不断演进的消息。首次活动时发
 *     「💭 thinking…」，每次 `tool_start` 编辑为「🔧 <tool>…」，
 *     `tool_result` 时回到「💭 thinking…」，`complete` 时用最终文本替换
 *     整个气泡。中间态的 assistant 文本（`isIntermediate` 的 `text_complete`）
 *     被丢弃。在没有 `messageEditing` 的 adapter 上，退化为
 *     complete 时单次发送（与 `final_only` 相同）。
 *
 *   - `final_only`：直到 `complete` 才发声，然后发送一条带累积最终文本的消息。
 *     空完成不发任何东西。
 *
 * 权限和错误与模式正交：当 session 请求权限或触发错误时，renderer 会
 * 冲刷当前模式状态，无论处于哪种模式都把提示/错误作为独立消息发出。
 */

import type {
  PlatformAdapter,
  ChannelBinding,
  SendOptions,
  SentMessage,
  InlineButton,
  ResponseMode,
} from './types'

/**
 * 从 binding 构造每次调用的 options 包。目前只有 `threadId`
 *（Telegram 超级群论坛话题）会透传。WhatsApp 和 DM 让 `threadId` 保持 undefined，
 * adapter 的 `threadParams()` helper 会把它变成一个 no-op 展开。
 */
function bindingOpts(binding: ChannelBinding): SendOptions {
  return binding.threadId !== undefined ? { threadId: binding.threadId } : {}
}
import type { PlanTokenRegistry } from './plan-tokens'

/** Session 事件形状（server-core 完整 SessionEvent 的子集）。 */
export interface SessionEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

/** 来自 @craft-agent/core 的 PermissionRequest 形状。 */
interface PermissionRequest {
  requestId: string
  toolName: string
  command?: string
  description: string
  type?: string
}

interface RenderState {
  // --- streaming 模式 ---------------------------------------------------
  /** 当前响应累积的文本（streaming 模式）。 */
  textBuffer: string
  /** agent 是否正在处理。 */
  processing: boolean
  /** streaming：正在编辑的消息 id（仅 Telegram）。 */
  streamingMessageId: string | null
  /** streaming：下次编辑的定时器。 */
  editTimer: ReturnType<typeof setTimeout> | null
  /** streaming：上次编辑时的文本长度（用于检测新内容）。 */
  lastEditedLength: number
  /** 当前生效的编辑间隔（遇到 429 时会增大）。 */
  currentEditIntervalMs: number

  // --- progress / final_only 模式 -------------------------------------
  /** progress/final_only：本次运行累积的非中间态 assistant 文本。 */
  finalBuffer: string
  /**
   * progress/final_only：本次运行见到的最近一条非空 assistant 文本，
   * 不论 `isIntermediate`。用作 `complete` 时的兜底 —— 当本次运行从未产出
   * 干净的非中间态最终 turn（常见于最后动作是工具调用的 automation），
   * 我们仍要交付 agent 的消息，而不是把用户晾在「thinking…」上。
   */
  lastAssistantText: string
  /** progress：本次运行那条不断演进消息的 id（首次活动前为 null）。 */
  progressMessageId: string | null
  /** progress：上次写入气泡的状态标签，避免冗余编辑。 */
  progressStatus: string | null
}

const DEFAULT_EDIT_INTERVAL_MS = 3500
const BACKOFF_RESET_MS = 30_000

const THINKING_LABEL = '💭 thinking…'

/**
 * 与按钮一起内联渲染的最大字符数，超过就把完整计划溢出到附件文件。
 * Telegram 硬上限是 4096 —— 为头部、按钮和格式留出余量。
 */
const PLAN_INLINE_LIMIT = 3500

/**
 * renderer 想记住 plan 消息 id 时调用的 hook。
 * 传入完整的 `ChannelBinding`，让调用方能把消息归因到渲染它的确切聊天 ——
 * 而不只是 session（一个 session 可能有多个 Telegram binding）。
 */
export type PlanMessageRecorder = (
  binding: ChannelBinding,
  token: string,
  messageId: string,
) => void

/**
 * renderer 在发出一个带内联按钮的权限提示后调用的 hook。
 * 与 {@link PlanMessageRecorder} 对称；gateway 用它跟踪存活中的提示，
 * 以便 (a) 在点击时幂等地认领提示，(b) 当 agent 已越过该权限
 *（无论从哪个渠道解决 —— desktop、MCP 等）时清掉 inline keyboard。
 */
export type PermissionMessageRecorder = (
  binding: ChannelBinding,
  requestId: string,
  messageId: string,
) => void

export class Renderer {
  /** 每个 binding 的 render 状态。以 binding.id 为键。 */
  private states = new Map<string, RenderState>()
  private readonly planTokens: PlanTokenRegistry | undefined
  private readonly recordPlanMessage: PlanMessageRecorder | undefined
  private readonly recordPermissionMessage: PermissionMessageRecorder | undefined

  constructor(deps?: {
    planTokens?: PlanTokenRegistry
    recordPlanMessage?: PlanMessageRecorder
    recordPermissionMessage?: PermissionMessageRecorder
  }) {
    this.planTokens = deps?.planTokens
    this.recordPlanMessage = deps?.recordPlanMessage
    this.recordPermissionMessage = deps?.recordPermissionMessage
  }

  private getState(bindingId: string): RenderState {
    let state = this.states.get(bindingId)
    if (!state) {
      state = {
        textBuffer: '',
        processing: false,
        streamingMessageId: null,
        editTimer: null,
        lastEditedLength: 0,
        currentEditIntervalMs: DEFAULT_EDIT_INTERVAL_MS,
        finalBuffer: '',
        lastAssistantText: '',
        progressMessageId: null,
        progressStatus: null,
      }
      this.states.set(bindingId, state)
    }
    return state
  }

  /** 处理某个 binding 的出站 session 事件。 */
  async handle(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    // 权限/错误提示与模式无关 —— 先处理，避免被模式状态吞掉。
    if (event.type === 'permission_request') {
      await this.handlePermissionRequest(event, binding, adapter, this.getState(binding.id))
      return
    }
    if (event.type === 'credential_request') {
      await this.handleCredentialRequest(binding, adapter)
      return
    }
    if (event.type === 'plan_submitted') {
      await this.handlePlanSubmitted(event, binding, adapter)
      return
    }
    if (event.type === 'error' || event.type === 'typed_error') {
      await this.handleError(event, binding, adapter, this.getState(binding.id))
      return
    }

    const mode = resolveResponseMode(binding.config.responseMode, binding.config.streamResponses)
    switch (mode) {
      case 'streaming':
        return this.handleStreaming(event, binding, adapter)
      case 'progress':
        return this.handleProgress(event, binding, adapter)
      case 'final_only':
        return this.handleFinalOnly(event, binding, adapter)
    }
  }

  // ---------------------------------------------------------------------------
  // 模式：streaming（legacy 行为 —— 保持不变）
  // ---------------------------------------------------------------------------

  private async handleStreaming(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.getState(binding.id)

    switch (event.type) {
      case 'text_delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (!delta) break
        state.textBuffer += delta
        state.processing = true

        if (adapter.capabilities.messageEditing) {
          await this.handleStreamingDelta(state, binding, adapter)
        }
        break
      }

      case 'text_complete': {
        const text = typeof event.text === 'string' ? event.text : state.textBuffer
        this.cancelEditTimer(state)

        if (state.streamingMessageId && adapter.capabilities.messageEditing) {
          if (text.trim()) {
            await this.tryEditMessage(adapter, binding, state.streamingMessageId, text.trim(), state)
          }
        } else if (text.trim()) {
          await this.sendText(adapter, binding, text.trim())
        }

        state.textBuffer = ''
        state.streamingMessageId = null
        state.lastEditedLength = 0
        break
      }

      case 'complete': {
        this.cancelEditTimer(state)
        if (state.textBuffer.trim() && !state.streamingMessageId) {
          await this.sendText(adapter, binding, state.textBuffer.trim())
        }
        this.resetRun(state)
        break
      }

      case 'tool_start': {
        if (binding.config.showToolActivity) {
          const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
          const displayName =
            typeof event.toolDisplayName === 'string' ? event.toolDisplayName : toolName
          if (state.streamingMessageId && state.textBuffer.trim()) {
            this.cancelEditTimer(state)
            await this.tryEditMessage(
              adapter,
              binding,
              state.streamingMessageId,
              state.textBuffer.trim(),
              state,
            )
            state.streamingMessageId = null
            state.textBuffer = ''
            state.lastEditedLength = 0
          }
          await adapter.sendText(binding.channelId, `🔧 ${displayName}...`, bindingOpts(binding))
        } else {
          await adapter.sendTyping(binding.channelId, bindingOpts(binding)).catch(() => {})
        }
        break
      }
    }
  }

  private async handleStreamingDelta(
    state: RenderState,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    if (!state.streamingMessageId && state.textBuffer.length > 0) {
      try {
        const sent = await adapter.sendText(binding.channelId, state.textBuffer, bindingOpts(binding))
        state.streamingMessageId = sent.messageId
        state.lastEditedLength = state.textBuffer.length
        this.scheduleEdit(state, binding, adapter)
      } catch {
        // 发送失败就继续累积，等 complete 再试
      }
      return
    }
    // 后续片段：由编辑定时器处理批量更新
  }

  private scheduleEdit(
    state: RenderState,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): void {
    if (state.editTimer) return

    const intervalMs = Math.max(binding.config.editIntervalMs, state.currentEditIntervalMs)

    state.editTimer = setTimeout(async () => {
      state.editTimer = null
      if (!state.streamingMessageId) return
      if (state.textBuffer.length <= state.lastEditedLength) return
      const text = state.textBuffer.trim()
      if (!text) return

      await this.tryEditMessage(adapter, binding, state.streamingMessageId, text, state)
      state.lastEditedLength = state.textBuffer.length

      if (state.processing) {
        this.scheduleEdit(state, binding, adapter)
      }
    }, intervalMs)
  }

  // ---------------------------------------------------------------------------
  // 模式：progress（新默认 —— 每次运行一条不断演进的消息）
  // ---------------------------------------------------------------------------

  private async handleProgress(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.getState(binding.id)

    switch (event.type) {
      case 'text_delta':
        // progress 模式下不展示 token —— 我们等 text_complete。
        return

      case 'text_complete': {
        const isIntermediate = Boolean(event.isIntermediate)
        const text = typeof event.text === 'string' ? event.text : ''
        if (text.trim()) {
          if (!isIntermediate) {
            // 本次运行最后一条 assistant 文本 —— 留给最终编辑用。
            state.finalBuffer = appendFinal(state.finalBuffer, text)
          }
          // 始终记住最新的 assistant 文本，这样 `complete` 在本次运行
          // 从未产出非中间态最终 turn 时可以回退到它。
          state.lastAssistantText = text
        }
        // 中间态文本从气泡里丢弃。确保气泡存在并显示 thinking 状态，
        // 让用户知道本次运行还活着。
        await this.ensureProgressBubble(state, binding, adapter, THINKING_LABEL)
        return
      }

      case 'tool_start': {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
        const displayName =
          typeof event.toolDisplayName === 'string' && event.toolDisplayName.length > 0
            ? event.toolDisplayName
            : toolName
        await this.ensureProgressBubble(state, binding, adapter, `🔧 ${displayName}…`)
        return
      }

      case 'tool_result': {
        // 工具结束 —— 把指示器恢复为 thinking，直到下一个 tool_start
        // 或 text_complete。还没发过气泡就跳过（不太可能）。
        if (state.progressMessageId) {
          await this.ensureProgressBubble(state, binding, adapter, THINKING_LABEL)
        }
        return
      }

      case 'complete': {
        // 优先用干净的非中间态最终文本；否则回退到最后一条 assistant 文本，
        // 这样以工具调用收尾的运行仍能交付消息，而不是把气泡冻在「thinking…」上。
        const finalText = (state.finalBuffer.trim() || state.lastAssistantText.trim())
        if (state.progressMessageId && adapter.capabilities.messageEditing) {
          if (finalText) {
            await this.tryEditMessage(
              adapter,
              binding,
              state.progressMessageId,
              truncateForAdapter(finalText, adapter),
              state,
            )
          }
          // 如果本次运行一条 assistant 文本都没产出，就保留最后的状态，
          // 而不是编辑成空字符串 —— 避免 Telegram「message is not modified」
          // 错误，也留下痕迹。
        } else if (finalText) {
          // adapter 不能编辑（WhatsApp）—— 在结尾发一条消息。
          await this.sendText(adapter, binding, finalText)
        }
        this.resetRun(state)
        return
      }
    }
  }

  /**
   * 按需发送 progress 气泡，并在状态自上次写入后变化时编辑为 `status`。
   * 合并冗余编辑，保持在 Telegram 每聊天编辑预算之内。
   */
  private async ensureProgressBubble(
    state: RenderState,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
    status: string,
  ): Promise<void> {
    if (!state.progressMessageId) {
      try {
        const sent = await adapter.sendText(binding.channelId, status, bindingOpts(binding))
        state.progressMessageId = sent.messageId
        state.progressStatus = status
      } catch {
        // 发送失败的话，会在下一个事件时再试。
      }
      return
    }
    if (!adapter.capabilities.messageEditing) return
    if (state.progressStatus === status) return
    await this.tryEditMessage(adapter, binding, state.progressMessageId, status, state)
    state.progressStatus = status
  }

  // ---------------------------------------------------------------------------
  // 模式：final_only（静默 → complete 时单次发送）
  // ---------------------------------------------------------------------------

  private async handleFinalOnly(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    const state = this.getState(binding.id)

    switch (event.type) {
      case 'text_complete': {
        // 只保留非中间态文本。`isIntermediate` 是个提示；缺失时
        //（旧事件或非 Claude 后端），我们把文本也算进去，
        // 因为那可能是我们唯一能见到的东西。
        const isIntermediate = Boolean(event.isIntermediate)
        const text = typeof event.text === 'string' ? event.text : ''
        if (text.trim()) {
          if (!isIntermediate) {
            state.finalBuffer = appendFinal(state.finalBuffer, text)
          }
          // 为从未产出非中间态最终 turn 的运行做兜底。
          state.lastAssistantText = text
        }
        return
      }

      case 'complete': {
        // 优先用干净的非中间态最终文本；否则回退到最后一条 assistant 文本，
        // 这样 final_only 在运行以工具调用收尾时仍能交付点什么，而不是保持静默。
        const finalText = (state.finalBuffer.trim() || state.lastAssistantText.trim())
        if (finalText) {
          await this.sendText(adapter, binding, finalText)
        }
        this.resetRun(state)
        return
      }
    }
    // text_delta、tool_start、tool_result —— 全部有意忽略。
  }

  // ---------------------------------------------------------------------------
  // 权限 / 错误（各模式共用）
  // ---------------------------------------------------------------------------

  private async handlePermissionRequest(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
    state: RenderState,
  ): Promise<void> {
    const request = event.request as PermissionRequest | undefined
    if (!request?.requestId) return

    // 先冲刷任何 streaming 状态，让提示作为独立消息落地
    //（progress 模式的气泡作为单独消息保留）。
    if (state.streamingMessageId && state.textBuffer.trim()) {
      this.cancelEditTimer(state)
      await this.tryEditMessage(
        adapter,
        binding,
        state.streamingMessageId,
        state.textBuffer.trim(),
        state,
      )
      state.streamingMessageId = null
      state.textBuffer = ''
      state.lastEditedLength = 0
    }

    if (binding.platform === 'whatsapp') {
      await adapter.sendText(
        binding.channelId,
        `⏸ Permission required: ${request.description}
Approve it in the desktop app to continue.`,
        bindingOpts(binding),
      )
      return
    }

    if (binding.config.approvalChannel === 'chat' && adapter.capabilities.inlineButtons) {
      const text = formatPermissionText(request)
      const buttons: InlineButton[] = [
        { id: `perm:allow:${request.requestId}`, label: '✅ Allow' },
        { id: `perm:deny:${request.requestId}`, label: '❌ Deny' },
      ]
      const sent = await adapter.sendButtons(binding.channelId, text, buttons, bindingOpts(binding))
      this.recordPermissionMessage?.(binding, request.requestId, sent.messageId)
    } else {
      await adapter.sendText(
        binding.channelId,
        `⏸ Permission required: ${request.description}
Approve in the desktop app to continue.`,
        bindingOpts(binding),
      )
    }
  }

  private async handleCredentialRequest(
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    if (binding.platform !== 'whatsapp') return
    await adapter.sendText(
      binding.channelId,
      '🔐 Credentials are required to continue. Open the desktop app to review and submit them securely.',
      bindingOpts(binding),
    )
  }

  private async handlePlanSubmitted(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
  ): Promise<void> {
    // WhatsApp：还没有交互按钮 —— 保留通用指引。
    if (binding.platform === 'whatsapp') {
      await adapter.sendText(
        binding.channelId,
        '📝 A plan is ready for review. Open the desktop app to inspect and approve it.',
        bindingOpts(binding),
      )
      return
    }

    // Telegram + Lark 都通过相同的 `sendButtons` 契约支持内联按钮；
    // 两者都能拿到富计划卡片。其他平台按上面 WhatsApp 的方式处理，更早就被挡住了。
    if (binding.platform !== 'telegram' && binding.platform !== 'lark') return

    // token registry 为向后兼容是可选的；没有它就退化为通用指引，
    // 这样 bot 至少能看到*点什么*。
    if (!this.planTokens) {
      await adapter.sendText(
        binding.channelId,
        '📝 A plan is ready for review. Open the desktop app to inspect and approve it.',
        bindingOpts(binding),
      )
      return
    }

    const planMessage = event.message as
      | { planPath?: string; content?: string }
      | undefined
    const planPath = planMessage?.planPath ?? ''
    const planContent = planMessage?.content ?? ''

    const token = this.planTokens.issue(binding.id, binding.sessionId, planPath)
    const buttons: InlineButton[] = [
      { id: `plan:accept:${token}`, label: '✅ Accept plan' },
      { id: `plan:compact:${token}`, label: '♻️ Accept & compact' },
    ]

    const header = '📝 *Plan ready for review*'
    const fitsInline = planContent.length > 0 && planContent.length <= PLAN_INLINE_LIMIT

    const bodyText = fitsInline
      ? `${header}\n\n${planContent}`
      : planContent.length === 0
        ? `${header}\n\nOpen the desktop app to see the plan, or use the buttons below to accept.`
        : `${header}\n\n${firstLines(planContent, 15)}\n\n…full plan attached below.`

    try {
      const sent = await adapter.sendButtons(binding.channelId, bodyText, buttons, bindingOpts(binding))
      this.recordPlanMessage?.(binding, token, sent.messageId)

      if (!fitsInline && planContent.length > 0) {
        await adapter.sendFile(
          binding.channelId,
          Buffer.from(planContent, 'utf-8'),
          'plan.md',
          'Full plan',
          bindingOpts(binding),
        )
      }
    } catch (err) {
      // 回退到一条纯文本通知，让用户至少知道有事。
      await adapter.sendText(
        binding.channelId,
        `📝 A plan is ready for review (couldn't render inline: ${
          err instanceof Error ? err.message : 'unknown error'
        }). Open the desktop app to approve it.`,
        bindingOpts(binding),
      )
    }
  }

  private async handleError(
    event: SessionEvent,
    binding: ChannelBinding,
    adapter: PlatformAdapter,
    state: RenderState,
  ): Promise<void> {
    const errorMsg = extractErrorMessage(event.error)
    this.cancelEditTimer(state)
    await adapter.sendText(binding.channelId, `❌ ${errorMsg}`, bindingOpts(binding))
    this.resetRun(state)
  }

  // ---------------------------------------------------------------------------
  // adapter 辅助函数
  // ---------------------------------------------------------------------------

  private async tryEditMessage(
    adapter: PlatformAdapter,
    binding: ChannelBinding,
    messageId: string,
    text: string,
    state: RenderState,
  ): Promise<void> {
    const truncated = truncateForAdapter(text, adapter)

    try {
      // Telegram 的 editMessage 以 (chat_id, message_id) 为键，忽略
      // message_thread_id，但为调用方统一性我们仍然传它。
      await adapter.editMessage(binding.channelId, messageId, truncated, bindingOpts(binding))
      state.currentEditIntervalMs = DEFAULT_EDIT_INTERVAL_MS
    } catch (err: unknown) {
      const is429 =
        err instanceof Error &&
        (err.message.includes('429') || err.message.includes('Too Many Requests'))
      if (is429) {
        state.currentEditIntervalMs = Math.min(state.currentEditIntervalMs * 2, 15_000)
        setTimeout(() => {
          state.currentEditIntervalMs = DEFAULT_EDIT_INTERVAL_MS
        }, BACKOFF_RESET_MS)
      }
      // 其他错误：静默跳过 —— text_complete / complete 会重试。
    }
  }

  private cancelEditTimer(state: RenderState): void {
    if (state.editTimer) {
      clearTimeout(state.editTimer)
      state.editTimer = null
    }
  }

  /** 重置本次运行的状态（`complete`、`error` 等时调用）。 */
  private resetRun(state: RenderState): void {
    this.cancelEditTimer(state)
    state.textBuffer = ''
    state.streamingMessageId = null
    state.lastEditedLength = 0
    state.processing = false
    state.finalBuffer = ''
    state.lastAssistantText = ''
    state.progressMessageId = null
    state.progressStatus = null
  }

  /** 发送文本，超过平台限制时拆分。 */
  private async sendText(
    adapter: PlatformAdapter,
    binding: ChannelBinding,
    text: string,
  ): Promise<SentMessage | undefined> {
    const maxLen = adapter.capabilities.maxMessageLength
    const opts = bindingOpts(binding)
    if (text.length <= maxLen) {
      return adapter.sendText(binding.channelId, text, opts)
    }

    const chunks = splitText(text, maxLen)
    let last: SentMessage | undefined
    for (const chunk of chunks) {
      last = await adapter.sendText(binding.channelId, chunk, opts)
    }
    return last
  }

  /** 清理已移除 binding 的状态。 */
  removeBinding(bindingId: string): void {
    const state = this.states.get(bindingId)
    if (state) {
      this.cancelEditTimer(state)
      this.states.delete(bindingId)
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function resolveResponseMode(
  responseMode: ResponseMode | undefined,
  streamResponses: boolean | undefined,
): ResponseMode {
  if (responseMode) return responseMode
  // 旧配置（responseMode 字段出现之前）：遵从显式的 streamResponses。
  return streamResponses === false ? 'final_only' : 'streaming'
}

function appendFinal(existing: string, next: string): string {
  if (!existing) return next
  return existing.endsWith('\n') ? existing + next : existing + '\n\n' + next
}

function truncateForAdapter(text: string, adapter: PlatformAdapter): string {
  const maxLen = adapter.capabilities.maxMessageLength
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 4) + ' ...'
}

function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen)
    if (splitAt <= 0) splitAt = maxLen

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim())
  }

  return chunks
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return 'An error occurred'
}

function formatPermissionText(request: PermissionRequest): string {
  const lines = ['⚡ Permission required']
  lines.push(`Tool: ${request.toolName}`)
  if (request.command) lines.push(`Command: ${request.command}`)
  if (request.description) lines.push(request.description)
  return lines.join('\n')
}

function firstLines(text: string, n: number): string {
  const lines = text.split('\n')
  if (lines.length <= n) return text
  return lines.slice(0, n).join('\n')
}

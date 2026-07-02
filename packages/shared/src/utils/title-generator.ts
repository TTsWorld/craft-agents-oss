/**
 * 会话标题生成工具
 *
 * 构建标题生成 prompt 与校验结果的共享辅助函数。
 * 实际标题生成由 Agent 类使用各自 SDK 完成：
 * - ClaudeAgent：使用 Claude SDK 的 query()
 * - PiAgent：使用 Pi SDK 的 queryLlm()
 */

/**
 * 在 `max` 字符内的最后一个单词边界处截断文本。
 */
export function sliceAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastSpace = text.lastIndexOf(' ', max);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max);
}

/**
 * 检查冒号前的文本是否像 LLM 的前言（preamble）。
 * 匹配："Title"、"Topic"、"Sure"、"Sure, the title is"、"Here's the topic" 等。
 */
function isPreamblePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // 单个词前言
  if (/^(?:title|topic|sure|okay|ok)$/.test(lower)) return true;
  // 以常见开口词开头，并可能提及 title/topic
  if (/^(?:sure|okay|ok|here(?:'s| is))\b/.test(lower)) return true;
  // "the title/topic is" 等
  if (/^the\s+(?:title|topic)\b/.test(lower)) return true;
  return false;
}

/**
 * 在把语言偏好插进 prompt 前先做清理。
 * 非法/可疑输入返回 undefined，让调用方回退到自动检测。
 */
export function sanitizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  // 允许字母（任意文字）、Unicode 组合标记、空格、连字符
  if (!/^[\p{L}\p{M}\s\-]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * 构建标题 prompt 中的语言指令。
 * 显式偏好优先；否则根据消息内容自动检测。
 */
function buildLanguageInstruction(language?: string): string {
  const safe = sanitizeLanguage(language);
  if (safe) {
    return `Reply in ${safe}.`;
  }
  return 'Reply in the same language as the user\'s messages.';
}

/**
 * 根据用户消息构建生成会话标题的 prompt。
 *
 * @param message - 要生成标题的用户消息
 * @param options.language - 标题偏好语言
 * @returns 格式化后的 prompt 字符串
 */
export function buildTitlePrompt(message: string, options?: { language?: string }): string {
  const snippet = sliceAtWord(message, 500);
  return [
    'What topic or area is the user exploring? Reply with ONLY a short descriptive title (2-5 words).',
    'Use a short descriptive label. Use plain text only - no markdown.',
    buildLanguageInstruction(options?.language),
    'Examples: "Auto Title Generation", "Dark Mode Support", "Fix API Authentication", "Database Schema Design", "React Performance"',
    '',
    'User: ' + snippet,
    '',
    'Topic:',
  ].join('\n');
}

/** 消息被视为“低信息”的最大字符数。 */
const LOW_SIGNAL_MAX_CHARS = 12;
/** 消息被视为“低信息”的最大词数。 */
const LOW_SIGNAL_MAX_WORDS = 2;

/**
 * 判断消息是否可能是低信息（简短确认/命令）。
 * 与语言无关：仅用长度 + 词数判断。
 */
export function isLowSignal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > LOW_SIGNAL_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).length > LOW_SIGNAL_MAX_WORDS) return false;
  // 包含问号通常是真正的问题
  if (trimmed.includes('?')) return false;
  return true;
}

/**
 * 选取一组能代表会话意图的用户消息：
 * 第一条（原始意图）、偏向最近的中间条、最后一条（当前状态）。
 *
 * 选取前会先去掉尾部低信息消息（如 "ok"、"thanks"），让选取聚焦在实质性内容上。
 * 如果所有消息都是低信息，则回退到不过滤。
 *
 * 4 条以上消息时，取索引 0、约 66%、最后一条——偏向会话最终走向，而非正中间。
 */
export function selectSpreadMessages(allUserMessages: string[]): string[] {
  const count = allUserMessages.length;
  if (count === 0) return [];

  // 去掉尾部低信息消息
  let filtered = allUserMessages;
  let trimEnd = allUserMessages.length;
  while (trimEnd > 0 && isLowSignal(allUserMessages[trimEnd - 1]!)) {
    trimEnd--;
  }
  if (trimEnd > 0) {
    filtered = allUserMessages.slice(0, trimEnd);
  }
  // 否则：所有消息都是低信息，保留原数组

  const n = filtered.length;
  if (n === 1) return [filtered[0]!];
  if (n === 2) return [filtered[0]!, filtered[1]!];
  if (n === 3) return [filtered[0]!, filtered[1]!, filtered[2]!];

  const midIndex = Math.floor(n * 2 / 3);
  return [filtered[0]!, filtered[midIndex]!, filtered[n - 1]!];
}

/** 根据选中的消息数量构建“用户消息”段标签。 */
function messagesSectionLabel(count: number): string {
  if (count === 1) return 'User message:';
  if (count === 2) return 'User messages (first, last):';
  return 'Selected user messages:';
}

/**
 * 根据近期消息构建重新生成会话标题的 prompt。
 *
 * @param recentUserMessages - 选取的用户消息（首、中、尾）
 * @param lastAssistantResponse - 最近一次助手回复
 * @param options.language - 标题偏好语言
 * @returns 格式化后的 prompt 字符串
 */
export function buildRegenerateTitlePrompt(
  recentUserMessages: string[],
  lastAssistantResponse: string,
  options?: { language?: string }
): string {
  const userContext = recentUserMessages
    .map((msg) => sliceAtWord(msg, 500))
    .join('\n\n');
  const assistantSnippet = sliceAtWord(lastAssistantResponse, 500);

  const lines: string[] = [
    'Based on these messages, what is this conversation about?',
    'Reply with ONLY a short descriptive title (2-5 words).',
    'Use a short descriptive label. Use plain text only - no markdown.',
    'Ignore short acknowledgement messages (like "ok", "thanks", "do it") that don\'t carry topic information.',
    buildLanguageInstruction(options?.language),
    'Examples: "Auto Title Generation", "Dark Mode Support", "Fix API Authentication", "Database Schema Design"',
  ];

  lines.push(
    '',
    messagesSectionLabel(recentUserMessages.length),
    userContext,
    '',
    'Latest assistant response:',
    assistantSnippet,
    '',
    'Topic:',
  );

  return lines.join('\n');
}

/** 有效标题的最大词数。超过通常意味着前言泄漏。 */
const MAX_TITLE_WORDS = 10;

/**
 * 校验并清理模型生成的标题。
 *
 * 迭代剥离已知的 LLM 前言伪影（如开头的 "Title:"、"Sure:" 等），
 * 然后去掉引号和 markdown 格式，并检查长度/词数边界。
 *
 * @param title - 模型返回的原始标题
 * @returns 清理后的标题；非法则返回 null
 */
export function validateTitle(title: string | null | undefined): string | null {
  if (!title) return null;

  let cleaned = title.trim();

  // 迭代剥离前言：可处理链式前言如 "Sure: Title: Foo"
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    const colonIndex = cleaned.indexOf(':');
    if (colonIndex > 0 && colonIndex < 40) {
      const beforeColon = cleaned.slice(0, colonIndex);
      if (isPreamblePrefix(beforeColon)) {
        cleaned = cleaned.slice(colonIndex + 1).trim();
      }
    }
  }

  // 去掉首尾引号
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // 去掉首尾粗体标记 **title**
  if (cleaned.startsWith('**') && cleaned.endsWith('**')) {
    cleaned = cleaned.slice(2, -2);
  }

  // 去掉开头的 markdown 标题标记（一个或多个 #、-、*）
  cleaned = cleaned.replace(/^[#\-*]+\s+/, '');

  cleaned = cleaned.trim();

  // 拒绝空、过长或词数过多（可能是前言泄漏）
  if (cleaned.length === 0 || cleaned.length >= 100) return null;
  if (cleaned.split(/\s+/).length > MAX_TITLE_WORDS) return null;

  return cleaned;
}

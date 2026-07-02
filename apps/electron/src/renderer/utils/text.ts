/**
 * text.ts — 文本处理工具
 *
 * 所属目录：renderer/utils
 * 运行环境：Electron 的 renderer（渲染）进程，即前端界面层。
 * 作用：提供 Markdown/Emoji 清理等纯文本处理函数，供 renderer 进程复用。
 */
import { remark } from 'remark'
import strip from 'strip-markdown'

// 预配置的 remark 处理器，可复用，避免每次调用都重新创建实例
const processor = remark().use(strip)

// 匹配 Emoji 字符的正则；Unicode 属性转义在支持 ES2018 的环境中可用
const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu

/**
 * 去除 Markdown 格式与 Emoji，返回纯文本。
 * 内部使用 remark AST 解析器 + strip-markdown 插件完成转换。
 */
export function stripMarkdown(text: string): string {
  if (!text) return ''

  // strip-markdown 是同步插件，因此使用 processSync
  const result = processor.processSync(text)

  // 移除 Emoji，并把连续空白折叠成单个空格
  return String(result)
    .replace(EMOJI_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim()
}

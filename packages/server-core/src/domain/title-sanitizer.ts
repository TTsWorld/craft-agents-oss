/**
 * 文件：title-sanitizer.ts
 * 位置：packages/server-core/src/domain
 * 职责：把用户消息内容清理成适合作为会话标题的字符串。
 *
 * 架构角色：
 *   - domain 层纯函数，不依赖 Electron 主进程模块。
 *   - 方便单元测试：只需要传入 string，不需要 mock 任何 electron 依赖。
 *
 * Agent 开发关注点：
 *   - Session 标题通常从用户第一条消息自动生成。
 *   - 消息里常包含 XML 块（如 <edit_request>）、mention（如 [skill:...]）等技术标记，
 *     这些不应该出现在标题里。
 */

import { WS_ID_CHARS } from '@craft-agent/shared/mentions'

/**
 * 清理消息内容，使其适合作为会话标题。
 *
 * 处理步骤：
 *   1. 去掉 <edit_request>...</edit_request> 块。
 *   2. 去掉剩余 XML/HTML 标签。
 *   3. 去掉 [skill:...]、[source:...]、[file:...]、[folder:...] 等 mention。
 *   4. 合并空白字符并 trim。
 *
 * TS 特性：
 *   - `content.replace(/.../g, '')` 中 `/g` 表示全局替换，类似 Go 的 regexp.ReplaceAllString。
 *   - `[\s\S]` 是“匹配任意字符”的写法，因为 `.` 默认不匹配换行；
 *     Go 里可用 `(?s)` 单行模式达到同样效果。
 *   - `new RegExp(...)` 用字符串构造正则，适合需要嵌入变量的场景（如 WS_ID_CHARS）。
 *   - 链式调用返回新字符串，原字符串不会被修改（JS/TS 字符串不可变）。
 */
export function sanitizeForTitle(content: string): string {
  return content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // 去掉整个 edit_request 块
    .replace(/<[^>]+>/g, '')     // 去掉剩余的 XML/HTML 标签
    .replace(new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?[\\w-]+\\]`, 'g'), '')   // 去掉 [skill:...] mention
    .replace(/\[source:[\w-]+\]/g, '')                // 去掉 [source:...] mention
    .replace(/\[file:[^\]]+\]/g, '')                  // 去掉 [file:...] mention
    .replace(/\[folder:[^\]]+\]/g, '')                // 去掉 [folder:...] mention
    .replace(/\s+/g, ' ')        // 合并空白字符
    .trim()
}

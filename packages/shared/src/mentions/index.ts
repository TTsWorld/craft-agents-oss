/**
 * Mention（@/提及）解析工具
 *
 * 这里只提供纯字符串解析函数，用来识别聊天消息里的 [方括号提及] 语法。
 * 不依赖渲染层/浏览器，可以在 Node、浏览器、Worker 等任何环境使用。
 *
 * 支持的提及类型：
 * - Skill:   [skill:slug] 或 [skill:workspaceId:slug]
 * - Source:  [source:slug]
 * - File:    [file:path]
 * - Folder:  [folder:path]
 *
 * 什么是 skill/source？
 * - skill：Agent 的能力单元，类似一个可调用的“工具函数”或 API。
 * - source：Agent 可以读取的外部数据源（如 GitHub、Linear、Notion 等）。
 */

// 简易路径拼接，兼容 Node 和浏览器。
// 不能用 node:path，因为这个模块会被 Vite 渲染进程引入。
function joinPath(base: string, relative: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return base.endsWith(sep) ? base + relative : base + sep + relative
}

// ============================================================================
// 常量（Constants）
// ============================================================================

// Workspace ID 可用的字符集合，用于正则表达式：
// 单词字符、空格（不含换行）、连字符、点号。
// 这里用字面量空格而不是 \s，避免误匹配换行导致解析出错。
export const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// 类型（Types）
// ============================================================================

// interface 类似 Golang 的 interface：只描述对象“长什么样”，不实现。
// 这里定义从消息中解析出的各类 mentions 结果。
export interface ParsedMentions {
  /** 通过 [skill:slug] 提到的有效 skill 标识符列表 */
  skills: string[]
  /** 消息里提到、但未在可用 skill 列表中找到的无效 skill */
  invalidSkills: string[]
  /** 通过 [source:slug] 提到的 source 标识符列表 */
  sources: string[]
  /** 通过 [file:path] 提到的文件路径列表 */
  files: string[]
  /** 通过 [folder:path] 提到的文件夹路径列表 */
  folders: string[]
}

// ============================================================================
// 解析函数
// ============================================================================

/**
 * 从消息文本中解析出所有 mentions。
 *
 * @param text - 要解析的消息文本
 * @param availableSkillSlugs - 当前可用的 skill slug 白名单
 * @param availableSourceSlugs - 当前可用的 source slug 白名单
 * @returns 按类型分类的解析结果
 *
 * @example
 * parseMentions('[skill:commit] [source:linear]', ['commit'], ['linear'])
 * // 返回: { skills: ['commit'], sources: ['linear'], files: [], folders: [], invalidSkills: [] }
 */
export function parseMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): ParsedMentions {
  const result: ParsedMentions = {
    skills: [],
    invalidSkills: [],
    sources: [],
    files: [],
    folders: [],
  }

  // 匹配 source 提及：[source:slug]
  const sourcePattern = /\[source:([\w-]+)\]/g
  let match: RegExpExecArray | null
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[1]!
    if (availableSourceSlugs.includes(slug) && !result.sources.includes(slug)) {
      result.sources.push(slug)
    }
  }

  // 匹配 skill 提及：[skill:slug] 或 [skill:workspaceId:slug]
  // 正则只捕获最后一个冒号后的 slug 部分。
  // workspaceId 可以包含空格、连字符、下划线和点号。
  const skillPattern = new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\]`, 'g')
  while ((match = skillPattern.exec(text)) !== null) {
    const slug = match[1]!
    if (availableSkillSlugs.includes(slug)) {
      if (!result.skills.includes(slug)) {
        result.skills.push(slug)
      }
    } else {
      if (!result.invalidSkills.includes(slug)) {
        result.invalidSkills.push(slug)
      }
    }
  }

  // 匹配 file 提及：[file:path]，path 可以是除 ] 以外的任意字符
  const filePattern = /\[file:([^\]]+)\]/g
  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1]!
    if (!result.files.includes(filePath)) {
      result.files.push(filePath)
    }
  }

  // 匹配 folder 提及：[folder:path]
  const folderPattern = /\[folder:([^\]]+)\]/g
  while ((match = folderPattern.exec(text)) !== null) {
    const folderPath = match[1]!
    if (!result.folders.includes(folderPath)) {
      result.folders.push(folderPath)
    }
  }

  return result
}

/**
 * 移除文本中的 mentions，只把 skill/source 的 slug 保留下来。
 *
 * @param text - 包含 mentions 的消息文本
 * @returns 替换后的文本
 *
 * @deprecated 建议用 resolveSkillMentions + resolveSourceMentions 替代，语义更丰富。
 */
export function stripAllMentions(text: string): string {
  return text
    // 把 [source:slug] 替换为 slug
    .replace(/\[source:([\w-]+)\]/g, '$1')
    // 把 [skill:slug] 或 [skill:workspaceId:slug] 替换为 slug
    .replace(new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\]`, 'g'), '$1')
    // 注意：[file:...] 和 [folder:...] 不会被移除，
    // 它们属于需要被 resolveFileMentions() 解析为绝对路径的内容。
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把 skill mentions 替换为带显示名的语义化标记。
 *
 * [skill:datadog-api]           → [Mentioned skill: Datadog API (slug: datadog-api)]
 * [skill:My Workspace:commit]   → [Mentioned skill: Git Commit (slug: commit)]
 *
 * 如果 skillNames 映射里找不到对应名字，就回退显示 slug。
 *
 * @param text - 包含 skill mentions 的消息文本
 * @param skillNames - slug → 显示名称 的映射（从已加载的 skill 元数据得来）
 */
export function resolveSkillMentions(
  text: string,
  skillNames: Map<string, string>
): string {
  return text.replace(
    new RegExp(`\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\]`, 'g'),
    (_match, slug: string) => {
      const name = skillNames.get(slug) || slug
      return `[Mentioned skill: ${name} (slug: ${slug})]`
    }
  )
}

/**
 * 把 source mentions 替换为语义化标记。
 *
 * [source:github] → [Mentioned source: github]
 *
 * @param text - 包含 source mentions 的消息文本
 */
export function resolveSourceMentions(text: string): string {
  return text.replace(
    /\[source:([\w-]+)\]/g,
    (_match, slug: string) => `[Mentioned source: ${slug}]`
  )
}

/**
 * 把 file/folder mentions 替换为带绝对路径的语义化标记。
 *
 * [file:src/index.ts]       → [Mentioned file: index.ts (at /Users/me/project/src/index.ts)]
 * [folder:src/components]   → [Mentioned folder: components (at /Users/me/project/src/components)]
 * [file:/tmp/test.txt]      → [Mentioned file: test.txt (at /tmp/test.txt)]
 *
 * 这样包装后，Agent 能明确知道用户显式引用了某个文件/文件夹，
 * 应该主动去读取。这和拖拽附件时生成的 [Attached file: ...] 格式保持一致。
 *
 * 其他类型的 mentions（[skill:...]、[source:...]）会原样保留。
 *
 * @param text - 包含文件/文件夹 mentions 的消息文本
 * @param workingDirectory - 当前工作目录，用于把相对路径解析为绝对路径
 */
export function resolveFileMentions(text: string, workingDirectory: string): string {
  return text
    .replace(/\[file:([^\]]+)\]/g, (_match, filePath: string) => {
      // 如果是绝对路径（/ 开头）或家目录路径（~ 开头），直接使用；
      // 否则和 workingDirectory 拼接成绝对路径。
      const resolved = filePath.startsWith('/') || filePath.startsWith('~')
        ? filePath
        : joinPath(workingDirectory, filePath)
      // 取路径最后一段作为文件名；如果取不到就回退显示完整路径。
      const name = filePath.split('/').pop() || filePath
      return `[Mentioned file: ${name} (at ${resolved})]`
    })
    .replace(/\[folder:([^\]]+)\]/g, (_match, folderPath: string) => {
      const resolved = folderPath.startsWith('/') || folderPath.startsWith('~')
        ? folderPath
        : joinPath(workingDirectory, folderPath)
      const name = folderPath.split('/').pop() || folderPath
      return `[Mentioned folder: ${name} (at ${resolved})]`
    })
}

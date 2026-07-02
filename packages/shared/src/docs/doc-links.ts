/**
 * 文档链接与摘要：用于在 UI 各处的“帮助”气泡里提供上下文说明。
 * 摘要提供一句话简介；“了解更多”会跳转到完整文档。
 */

// 文档站点的基础 URL，所有 feature 的 path 都会拼接在它后面。
const DOC_BASE_URL = 'https://agents.craft.do/docs'

// 受支持的文档特性（功能主题）联合类型。
// 类似 Go 里的 type DocFeature string + const 枚举，TS 用联合类型限定可取值。
export type DocFeature =
  | 'sources'
  | 'sources-api'
  | 'sources-mcp'
  | 'sources-local'
  | 'skills'
  | 'statuses'
  | 'permissions'
  | 'labels'
  | 'workspaces'
  | 'themes'
  | 'app-settings'
  | 'preferences'
  | 'automations'
  | 'messaging'

// 单个功能对应的文档信息结构。
// 类似 Go 的 struct：interface 描述对象形状，字段可附带文档注释。
export interface DocInfo {
  /** 相对于 DOC_BASE_URL 的文档路径 */
  path: string
  /** 帮助气泡里显示的标题 */
  title: string
  /** 1-2 句话的简介，用于快速了解该功能 */
  summary: string
}

// 特性 -> 文档信息的映射表。
// Record<DocFeature, DocInfo> 表示“键必须是 DocFeature，值必须是 DocInfo”，类似 Go 的 map[DocFeature]DocInfo。
export const DOCS: Record<DocFeature, DocInfo> = {
  sources: {
    path: '/sources/overview',
    title: 'Sources',
    summary:
      'Connect external data like MCP servers, REST APIs, and local filesystems. Sources give your agent tools to access services like GitHub, Linear, or your Obsidian vault.',
  },
  'sources-api': {
    path: '/sources/apis/overview',
    title: 'APIs',
    summary:
      'Connect to any REST API with flexible authentication. Make HTTP requests to external services directly from your conversations.',
  },
  'sources-mcp': {
    path: '/sources/mcp-servers/overview',
    title: 'MCP Servers',
    summary:
      'Connect to Model Context Protocol servers for rich tool integrations. MCP servers provide structured access to services like GitHub, Linear, and Notion.',
  },
  'sources-local': {
    path: '/sources/local-filesystems',
    title: 'Local Folders',
    summary:
      'Give your agent access to local directories like Obsidian vaults, code repositories, or data folders on your machine.',
  },
  skills: {
    path: '/skills/overview',
    title: 'Skills',
    summary:
      'Reusable instruction sets that teach your agent specialized behaviors. Create a SKILL.md file and invoke it with @mention in your messages.',
  },
  statuses: {
    path: '/statuses/overview',
    title: 'Statuses',
    summary:
      'Organize conversations into workflow states like Todo, In Progress, and Done. Open statuses appear in your inbox; closed ones move to the archive.',
  },
  permissions: {
    path: '/core-concepts/permissions',
    title: 'Permissions',
    summary:
      'Control how much autonomy your agent has. Explore mode is read-only, Ask to Edit prompts before changes, and Execute mode runs without prompts.',
  },
  labels: {
    path: '/labels/overview',
    title: 'Labels',
    summary:
      'Tag sessions with colored labels for organization and filtering. Labels support hierarchical nesting, typed values, and auto-apply rules that extract data from messages using regex patterns.',
  },
  workspaces: {
    path: '/go-further/workspaces',
    title: 'Workspaces',
    summary:
      'Separate configurations for different contexts like personal projects or work. Each workspace has its own sources, skills, statuses, and session history.',
  },
  themes: {
    path: '/go-further/themes',
    title: 'Themes',
    summary:
      'Customize the visual appearance with a 6-color system. Override specific colors in theme.json or install preset themes for complete visual styles.',
  },
  'app-settings': {
    path: '/reference/config/config-file',
    title: 'App Settings',
    summary:
      'Configure global app settings like your default model, authentication method, and workspace list. Settings are stored in ~/.craft-agent/config.json.',
  },
  preferences: {
    path: '/reference/config/preferences',
    title: 'Preferences',
    summary:
      'Personal preferences like your name, timezone, and language that help the agent personalize responses. Stored in ~/.craft-agent/preferences.json.',
  },
  automations: {
    path: '/automations/overview',
    title: 'Automations',
    summary:
      'Automate actions when events occur — run commands on schedules, react to label changes, or trigger prompts. Configured in automations.json.',
  },
  messaging: {
    path: '/messaging/overview',
    title: 'Messaging',
    summary:
      'Connect a session to a chat platform — Telegram, WhatsApp, or Lark / Feishu — and reach your agent from anywhere. Pair workspace supergroups, route automations to forum topics, and send rich replies natively.',
  },
}

/**
 * 根据特性名拼接完整的文档 URL。
 * 模板字符串 `${a}${b}` 类似 Go 的 fmt.Sprintf("%s%s", a, b)。
 */
export function getDocUrl(feature: DocFeature): string {
  return `${DOC_BASE_URL}${DOCS[feature].path}`
}

/**
 * 根据特性名获取对应的文档信息（标题、摘要、路径）。
 */
export function getDocInfo(feature: DocFeature): DocInfo {
  return DOCS[feature]
}

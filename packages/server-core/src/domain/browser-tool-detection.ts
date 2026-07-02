/**
 * 文件：browser-tool-detection.ts
 * 位置：packages/server-core/src/domain
 * 职责：判断调用 browser_tool 时是否需要激活浏览器浮层/可视化界面。
 *
 * 架构角色：
 *   - domain 层是纯函数集合，不依赖 Electron 主进程、不依赖 IPC，方便单元测试。
 *   - 类似 Go 里一个无状态的工具包（internal/util/browser_tool.go），只接收输入、返回布尔。
 *
 * Agent 开发关注点：
 *   - browser_tool 是 Agent 操控浏览器的统一入口（等价于 MCP 里的一个 tool）。
 *   - 某些命令（如 help、open、release、close、hide）只需要后台执行，不需要弹窗；
 *     其余命令（如 navigate、click）需要把浏览器浮层展示给用户看。
 *   - toolName 可能是直接形式 `browser_tool`，也可能是 MCP 命名空间形式 `mcp__session__browser_tool`。
 */

import { normalizeCanonicalBrowserToolName } from '@craft-agent/shared/agent'

/**
 * 不需要激活浏览器浮层的命令白名单。
 *
 * TypeScript 提示：
 *   - `Set<string>` 是 TS 内置的泛型容器，类似 Go 的 map[string]struct{} 集合。
 *   - 这里用 const + 大写命名表示“编译期常量”的语义约定。
 */
const BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS = new Set([
  '--help',
  '-h',
  'help',
  'open',
  'release',
  'close',
  'hide',
])

/**
 * 把 toolName 归一化成标准名；无法识别时返回 null。
 *
 * 类比 Go：相当于 strings.TrimSpace + switch-case 归一化。
 * TS 特性：`| null` 是“联合类型”，明确告诉调用方结果可能为空。
 */
export function normalizeBrowserToolName(toolName: string): string | null {
  return normalizeCanonicalBrowserToolName(toolName)
}

/**
 * 从 toolInput 中提取浏览器命令的“动词”（第一个空格前的单词）。
 *
 * TS 特性讲解：
 *   - `toolInput: unknown` 比 `any` 更安全，强制我们在使用前做类型收窄。
 *   - `(toolInput as { command?: unknown }).command` 是“类型断言”，
 *     类似 Go 的类型断言 `v.(T)`，但只是编译期行为，运行时不检查。
 *   - `typeof command !== 'string'` 是“类型保护”，收窄后 TS 知道 command 是 string。
 *   - `?.` 是可选链；`|| ''` 是空值合并的简写。
 */
export function getBrowserToolCommandVerb(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return ''

  const command = (toolInput as { command?: unknown }).command
  if (typeof command !== 'string') return ''

  return command.trim().toLowerCase().split(/\s+/)[0] || ''
}

/**
 * 判断本次 tool 调用是否需要激活浏览器浮层。
 *
 * 逻辑：
 *   1. 必须是 browser_tool（或 MCP 命名空间形式）。
 *   2. 必须能解析出命令动词。
 *   3. 动词不在白名单里。
 *
 * Agent 权限提示：
 *   - 是否弹窗不决定 Agent 能不能执行命令，只决定 UI 反馈；
 *   - 真正的权限校验在 SessionManager / Agent 层完成。
 */
export function shouldActivateBrowserOverlay(toolName: string, toolInput: unknown): boolean {
  const normalizedToolName = normalizeBrowserToolName(toolName)
  if (normalizedToolName !== 'browser_tool') return false

  const verb = getBrowserToolCommandVerb(toolInput)
  if (!verb) return false

  return !BROWSER_TOOL_OVERLAY_EXCLUDED_COMMANDS.has(verb)
}

/**
 * 工具显示名称映射
 *
 * 内部工具名是面向开发者的，可能比较晦涩。
 * 本模块为 UI 提供更友好的显示名称。
 */

/**
 * 需要自定义显示名称的特定工具映射表。
 * Record<string, string> 表示“字符串到字符串的字典”，类似 Go 的 map[string]string。
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // 内置工具
  'Glob': 'Finding Files',
  'Grep': 'Searching Files',
  'Read': 'Reading File',
  'Write': 'Writing File',
  'Edit': 'Editing File',
  'Bash': 'Running Command',
  'Task': 'Running Agent',
  'Agent': 'Running Agent',
  'WebFetch': 'Fetching URL',
  'WebSearch': 'Searching Web',
  'TodoWrite': 'Updating Tasks',
  'NotebookEdit': 'Editing Notebook',

  // 文档工具
  'SearchCraftAgents': 'Search Documentation',
};

/**
 * 表示父任务工具的集合（启动子 Agent 的工具）。
 * SDK 在 v0.2.72 把 'Task' 重命名为 'Agent'——两者都要识别。
 * 以后有重命名统一加到这里，避免代码里散落判断。
 */
export const PARENT_TASK_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** 判断工具名是否是父任务工具（Task 或 Agent）。 */
export const isParentTaskTool = (name: string): boolean => PARENT_TASK_TOOLS.has(name);

/**
 * 应从 UI 中隐藏的工具（纯内部状态变更）。
 */
export const HIDDEN_TOOLS = new Set<string>([
  // 当前为空 - 安全模式通过 UI 切换，而不是工具
]);

/**
 * 将工具名格式化为显示名称（snake_case 转 Title Case）。
 * 没有显式映射时的通用回退处理。
 */
function formatToolName(name: string): string {
  // 处理 MCP 工具（mcp__server__tool）
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const tool = parts[2] || parts[1] || name;
    return tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // 处理 api_* 工具
  if (name.startsWith('api_')) {
    const apiName = name.slice(4); // 去掉 'api_' 前缀
    return `API: ${apiName.charAt(0).toUpperCase() + apiName.slice(1)}`;
  }

  // 默认：转标题大小写
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * 获取工具的友好显示名称。
 *
 * @param toolName - 内部工具名，例如 "mcp__linear__list_issues"
 * @returns 面向用户的显示名称
 */
export function getToolDisplayName(toolName: string): string {
  // 优先查完整名映射
  if (TOOL_DISPLAY_NAMES[toolName]) {
    return TOOL_DISPLAY_NAMES[toolName];
  }

  // MCP 工具还尝试用基础工具名查映射
  // 例如 "mcp__linear__list_issues" -> 查 "list_issues"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || toolName;
    if (baseName && TOOL_DISPLAY_NAMES[baseName]) {
      return TOOL_DISPLAY_NAMES[baseName];
    }
  }

  // 回退到通用格式化
  return formatToolName(toolName);
}

/**
 * 判断工具是否应在 UI 中隐藏。
 */
export function shouldHideTool(toolName: string): boolean {
  // 先检查完整名
  if (HIDDEN_TOOLS.has(toolName)) {
    return true;
  }

  // MCP 工具再检查基础名
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const baseName = parts[parts.length - 1] || '';
    return HIDDEN_TOOLS.has(baseName);
  }

  return false;
}

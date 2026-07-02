/**
 * model-picker-helpers.ts
 *
 * 模型选择器的纯展示/分组工具函数。
 * 桌面端下拉菜单和紧凑抽屉共用这些函数，保证两种界面显示一致。
 */

import {
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'

/**
 * 把 token 数量格式化为人类可读字符串。
 * 例如 1500 -> "1.5k"，200000 -> "200k"。
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * 去掉模型 ID / 显示名中的 "pi/" 前缀，让用户看到与提供商无关的标签。
 * 例如 "pi/claude-opus" → "claude-opus"。
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/** 连接分组类型：[分组名称, 该分组下的连接列表] */
export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * 按提供商类型把 LLM 连接分组，用于层级选择器渲染。
 *
 * 每组可包含多个连接（如 API Key、OAuth 等）。
 * UI 上的顺序有意义：Anthropic → Local → Craft Agents Backend。
 * 空分组会被丢弃。
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'Local': [],
    'Craft Agents Backend': [],
  }
  for (const conn of connections) {
    const provider = conn.providerType || 'anthropic'
    if (provider === 'anthropic') {
      groups['Anthropic'].push(conn)
    } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (provider === 'pi' || provider === 'pi_compat') {
      groups['Craft Agents Backend'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}

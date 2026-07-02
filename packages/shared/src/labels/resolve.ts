/**
 * 会话标签解析器
 *
 * 纯函数解析器，供 set_session_labels（以及任何需要把用户输入的标签字符串
 * 与 workspace 配置标签树做校验的地方）使用。
 *
 * 接受纯 ID（"bug"）、显示名（"Bug"）和带值条目（"priority::3"、"due::2026-01-30"）。
 * 保留原始值部分，下游存储可以用 parseLabelEntry() 再解析。
 *
 * 校验规则：
 *   1. 基础 ID 必须按 ID 或大小写不敏感名称匹配到某个已配置标签。
 *   2. 带值输入（id::value）只在匹配标签配置了 valueType 时才被接受；
 *      布尔标签直接拒绝值。
 *   3. 若设置了 valueType，原始值要通过 validateLabelValue() 的严格检查
 *     （例如 valueType: number 时 "priority::high" 会失败）。
 *
 * 被拒绝的条目会附带 reason 字符串，方便 handler 向调用方返回清晰错误。
 */

import type { LabelConfig } from './types.ts';
import { flattenLabels } from './tree.ts';
import { parseLabelEntry, validateLabelValue } from './values.ts';

/**
 * resolveSessionLabels 的返回结果。
 * resolved 是已规范化、可入库的条目；unknown 是未识别的输入；
 * available 列出所有有效标签 ID；reasons 给每个失败输入一个原因。
 */
export interface ResolveLabelsResult {
  /** 已规范化、可入库的标签条目（ID 形式，保留 ::value） */
  resolved: string[];
  /** 无法解析的输入 */
  unknown: string[];
  /** 所有有效标签 ID，用于错误提示 */
  available: string[];
  /** 以原始输入为键的逐条说明 */
  reasons: Record<string, string>;
}

/**
 * 解析并校验用户输入的会话标签。
 *
 * @param inputs - 用户提供的标签字符串数组
 * @param labels - workspace 配置的标签树
 * @returns 解析结果，包含成功项、未知项和失败原因
 */
export function resolveSessionLabels(
  inputs: string[],
  labels: LabelConfig[],
): ResolveLabelsResult {
  // 先把树打平，方便按 ID/名称查找
  const flat = flattenLabels(labels);
  const available = flat.map(l => l.id);
  const resolved: string[] = [];
  const unknown: string[] = [];
  const reasons: Record<string, string> = {};

  for (const input of inputs) {
    // 解析出基础 ID 和可选的原始值
    const { id: baseId, rawValue } = parseLabelEntry(input);
    const hasValue = rawValue !== undefined;

    // 先按 ID 匹配，再按名称（不区分大小写）匹配
    const match =
      flat.find(l => l.id === baseId) ??
      flat.find(l => l.name.toLowerCase() === baseId.toLowerCase());

    if (!match) {
      unknown.push(input);
      reasons[input] = hasValue
        ? `label "${baseId}" is not configured`
        : `unknown label`;
      continue;
    }

    // 布尔标签不接受值
    if (hasValue && !match.valueType) {
      unknown.push(input);
      reasons[input] = `label "${match.id}" doesn't accept a value (no valueType configured)`;
      continue;
    }

    // 带值标签要做类型严格校验
    if (hasValue && match.valueType && !validateLabelValue(rawValue!, match.valueType)) {
      unknown.push(input);
      reasons[input] = `label "${match.id}" expects a ${match.valueType} value, got "${rawValue}"`;
      continue;
    }

    // 保存为规范形式：有值就保留 ::value，否则只存 ID
    resolved.push(hasValue ? `${match.id}::${rawValue}` : match.id);
  }

  return { resolved, unknown, available, reasons };
}

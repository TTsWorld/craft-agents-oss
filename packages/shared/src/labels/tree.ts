/**
 * 标签树工具
 *
 * 标签配置本身就是嵌套 JSON 树，不需要从扁平列表转换。
 * 这些工具提供递归操作：
 * - flattenLabels：把所有标签收集成扁平数组（用于 ID 查找、校验）
 * - sortLabelsForDisplay：递归按字母排序副本，供 UI 展示
 * - flattenLabelsWithParentPath：扁平化同时保留父级面包屑
 * - findLabelById：在树中定位标签节点
 * - getDescendantIds：获取所有子/孙 ID（用于层级过滤）
 * - findParent：查找某标签的父标签
 *
 * 会话通过简单 slug ID 引用标签（如 ["react", "bug"]）。
 * 按父标签过滤时，会包含所有后代。
 */

import type { LabelConfig } from './types.ts';

// Intl.Collator 用于按 locale 不区分大小写比较名称，类似 Go 的 strings.EqualFold，但还能排序
const labelNameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * 统一按显示名称比较，供 UI 排序使用。
 * 使用基于 locale、不区分大小写的比较，避免各处混用 toLowerCase 和 localeCompare。
 */
export function compareLabelNamesForDisplay(a: Pick<LabelConfig, 'name'>, b: Pick<LabelConfig, 'name'>): number {
  return labelNameCollator.compare(a.name, b.name);
}

/**
 * 把整棵标签树打平成一维数组。
 * 适用于 ID 查找、唯一性校验、会话标签检查。
 * 按深度优先遍历（父节点在子节点之前）。
 */
export function flattenLabels(labels: LabelConfig[]): LabelConfig[] {
  const result: LabelConfig[] = [];

  function walk(nodes: LabelConfig[]): void {
    for (const node of nodes) {
      result.push(node);
      if (node.children && node.children.length > 0) {
        walk(node.children);
      }
    }
  }

  walk(labels);
  return result;
}

/**
 * 返回递归排序后的标签树副本，用于面向用户的展示。
 * 不会修改原始配置树。
 */
export function sortLabelsForDisplay(labels: LabelConfig[]): LabelConfig[] {
  return [...labels]
    .map((label) => ({
      ...label,
      children: label.children && label.children.length > 0
        ? sortLabelsForDisplay(label.children)
        : label.children,
    }))
    .sort(compareLabelNamesForDisplay);
}

/**
 * 带父级路径的扁平标签项。
 * label 是标签配置，parentNames 是父级名称链，parentPath 是可直接展示的 "A / B / " 前缀。
 */
export interface FlattenedLabelWithParentPath {
  label: LabelConfig;
  parentNames: string[];
  parentPath?: string;
}

/**
 * 扁平化标签，同时保留父级面包屑名称，供展示/搜索 UI 使用。
 * 顺序跟随传入的树顺序，调用方可选择传入原始配置顺序或递归排序后的树。
 */
export function flattenLabelsWithParentPath(labels: LabelConfig[]): FlattenedLabelWithParentPath[] {
  const result: FlattenedLabelWithParentPath[] = [];

  function walk(nodes: LabelConfig[], parentNames: string[]): void {
    for (const node of nodes) {
      result.push({
        label: node,
        parentNames,
        parentPath: parentNames.length > 0 ? `${parentNames.join(' / ')} / ` : undefined,
      });
      if (node.children && node.children.length > 0) {
        walk(node.children, [...parentNames, node.name]);
      }
    }
  }

  walk(labels, []);
  return result;
}

/**
 * 根据 ID 在整棵树中查找标签。
 * 返回标签配置，找不到返回 undefined。
 */
export function findLabelById(labels: LabelConfig[], id: string): LabelConfig | undefined {
  for (const node of labels) {
    if (node.id === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findLabelById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 获取某标签的所有后代标签 ID。
 * 用于层级过滤 —— 点击父标签时，显示打上该标签或其任意后代的 session。
 * 不包含标签自身，只包含子/孙节点。
 */
export function getDescendantIds(labels: LabelConfig[], parentId: string): string[] {
  // 先在树里找到父节点
  const parent = findLabelById(labels, parentId);
  if (!parent || !parent.children || parent.children.length === 0) {
    return [];
  }

  // 递归收集所有后代 ID
  const result: string[] = [];
  function collectIds(nodes: LabelConfig[]): void {
    for (const node of nodes) {
      result.push(node.id);
      if (node.children && node.children.length > 0) {
        collectIds(node.children);
      }
    }
  }

  collectIds(parent.children);
  return result;
}

/**
 * 查找给定标签 ID 在树中的父标签。
 * 返回父标签配置；如果标签在根级则返回 undefined。
 */
export function findParent(labels: LabelConfig[], targetId: string): LabelConfig | undefined {
  for (const node of labels) {
    if (node.children) {
      // 检查直接子节点是否有匹配
      if (node.children.some(child => child.id === targetId)) {
        return node;
      }
      // 递归进入子树
      const found = findParent(node.children, targetId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 收集树中所有存在的 ID。
 * 是 flattenLabels 的便捷包装，用于快速成员检查。
 */
export function collectAllIds(labels: LabelConfig[]): Set<string> {
  return new Set(flattenLabels(labels).map(l => l.id));
}

/**
 * 面向 UI 的树节点，包装 LabelConfig。
 * 侧边栏用它来渲染层级标签导航。
 */
export interface LabelTreeNode {
  /** 完整唯一标识（基于树的配置中与 label.id 相同） */
  fullId: string;
  /** 该节点的 slug 段 */
  segment: string;
  /** 关联的 LabelConfig（基于树的配置中始终存在） */
  label: LabelConfig;
  /** 子树节点 */
  children: LabelTreeNode[];
}

/**
 * 把 LabelConfig[] 树转换成 LabelTreeNode[] 供 UI 使用。
 * 由于配置本身已是嵌套树，这里只是映射为带 fullId/segment 的 UI 形态。
 */
export function buildLabelTree(labels: LabelConfig[]): LabelTreeNode[] {
  return labels.map(label => ({
    fullId: label.id,
    segment: label.id,
    label,
    children: label.children ? buildLabelTree(label.children) : [],
  }));
}

/**
 * 根据 ID 获取标签的显示名称。
 * 如果树中找不到，则回退到把 slug 转为首字母大写的可读形式。
 */
export function getLabelDisplayName(labels: LabelConfig[], labelId: string): string {
  const label = findLabelById(labels, labelId);
  if (label) return label.name;
  return labelId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

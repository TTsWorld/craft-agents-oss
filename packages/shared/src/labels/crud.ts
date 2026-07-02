/**
 * 标签 CRUD 操作
 *
 * 对标签树进行增删改查、移动、排序。
 * 所有操作都直接作用于嵌套 JSON 树。
 * 删除会级联移除该标签及其后代，并从所有引用它们的 session 中剥离。
 */

import { loadLabelConfig, saveLabelConfig, isValidLabelId, isValidLabelIdFormat } from './storage.ts';
import { findLabelById, collectAllIds, getDescendantIds, getLabelDisplayName } from './tree.ts';
import { extractLabelId, parseLabelEntry, formatLabelEntry } from './values.ts';
import { findTaskLabel } from './filter.ts';
import type { LabelConfig, CreateLabelInput, UpdateLabelInput } from './types.ts';

/**
 * 从名称生成 URL 安全的 slug。
 */
function generateLabelSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

/**
 * 创建新标签。
 * 插入到指定父标签的 children 数组中，或放到根级。
 * 会在整棵树范围内生成全局唯一的 slug。
 */
export function createLabel(
  workspaceRootPath: string,
  input: CreateLabelInput
): LabelConfig {
  const config = loadLabelConfig(workspaceRootPath);

  // 在整棵树中生成唯一 ID
  const existingIds = collectAllIds(config.labels);
  let id = generateLabelSlug(input.name);
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${generateLabelSlug(input.name)}-${suffix}`;
    suffix++;
  }

  const label: LabelConfig = {
    id,
    name: input.name,
    color: input.color,
    ...(input.valueType && { valueType: input.valueType }),
  };

  if (input.parentId) {
    // 作为指定父标签的子节点插入
    const parent = findLabelById(config.labels, input.parentId);
    if (!parent) {
      throw new Error(`Parent label '${input.parentId}' not found`);
    }
    if (!parent.children) parent.children = [];
    parent.children.push(label);
  } else {
    // 插入到根级
    config.labels.push(label);
  }

  saveLabelConfig(workspaceRootPath, config);
  return label;
}

/**
 * 解析保留的 "Task" 根标签（一个普通布尔标签），不存在时创建它。
 * 按 id 'task' 或大小写不敏感的名称匹配根标签——用户自有的根 "Task" 标签会被采纳为
 * 任务项标签的父标签（其子标签和已打标的 session 不受影响）。只有 `valueType: 'number'`
 * 的根标签（早期编号方案创建的形态）会被收敛为普通标签；其他 valueType 是用户自定义的，
 * 原样保留（带值根下的子项嵌套完全没问题）。解析出的 slug 可能与字面量 'task' 不同，
 * 因此调用方必须使用返回的 id。
 */
export function ensureTaskLabel(workspaceRootPath: string): string {
  const config = loadLabelConfig(workspaceRootPath);
  const existing = findTaskLabel(config.labels);
  if (existing) {
    if (existing.valueType === 'number') {
      existing.valueType = undefined;
      saveLabelConfig(workspaceRootPath, config);
    }
    return existing.id;
  }
  return createLabel(workspaceRootPath, { name: 'Task', color: 'accent' }).id;
}

/**
 * 为新任务创建每个任务专属的 ITEM 标签：作为保留 Task 根标签的子标签，
 * 命名为 `TASK-<short-title-slug>-<N>`，其中 N 是该根标签下已有 TASK 命名子标签的
 * 下一个计数器（最大尾部数字 + 1，因此删除操作永远不会复用 id）。只有我们的
 * `TASK-…-<N>` 名称格式会喂给计数器——被采纳的用户根标签可能带有无关子标签（如
 * "Sprint-2026"），绝不能让它们膨胀计数器。一个 item 标签标记整个任务家族
 *（编排器 + 所有子任务），使得单次点击就能精确过滤该任务。该标签生成的 slug id
 * 可能因碰撞而偏移，因此调用方必须使用返回的 id。
 */
export function ensureTaskItemLabel(
  workspaceRootPath: string,
  title: string
): { rootId: string; itemId: string; name: string } {
  const rootId = ensureTaskLabel(workspaceRootPath);
  const config = loadLabelConfig(workspaceRootPath);
  const root = findLabelById(config.labels, rootId);
  const next =
    1 +
    (root?.children ?? []).reduce((max, child) => {
      const m = /^TASK-.*-(\d+)\s*$/i.exec(child.name.trim());
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
  // "带短横线的短名称"：标题做 slug 化处理，截取前几个单词。
  const slug = generateLabelSlug(title).split('-').slice(0, 4).join('-') || 'task';
  const name = `TASK-${slug}-${next}`;
  const item = createLabel(workspaceRootPath, { name, parentId: rootId, color: 'accent' });
  return { rootId, itemId: item.id, name };
}

/**
 * 确保所有标签条目引用的标签都存在于 workspace 配置中。
 * 对于每个条目，如果标签 ID 不存在，会自动创建一个名称由 slug 转为首字母大写的标签。
 * 返回解析后的条目，使用实际创建的 ID（处理 createLabel 可能带来的 slug 不一致）。
 *
 * ID 格式非法的条目会原样保留。
 */
export function ensureLabelsExist(
  workspaceRootPath: string,
  labels: string[]
): string[] {
  return labels.map(label => {
    const { id: labelId, rawValue } = parseLabelEntry(label)

    if (isValidLabelId(workspaceRootPath, labelId)) return label
    if (!isValidLabelIdFormat(labelId)) return label

    // getLabelDisplayName 在空树时会回退到首字母大写的 slug
    const name = getLabelDisplayName([], labelId)

    const created = createLabel(workspaceRootPath, {
      name,
      color: 'foreground/50',
    })

    // 返回使用实际创建 ID 的条目（处理 slug 不一致）
    return formatLabelEntry(created.id, rawValue)
  })
}

/**
 * 更新已有标签（name、color、valueType）。
 * 不能修改 ID 和层级位置。
 * @throws Error 如果标签不存在
 */
export function updateLabel(
  workspaceRootPath: string,
  labelId: string,
  updates: UpdateLabelInput
): LabelConfig {
  const config = loadLabelConfig(workspaceRootPath);
  const label = findLabelById(config.labels, labelId);

  if (!label) {
    throw new Error(`Label '${labelId}' not found`);
  }

  if (updates.name !== undefined) label.name = updates.name;
  if (updates.color !== undefined) label.color = updates.color;
  // valueType：设置新值，或删除以恢复为布尔标签
  if (updates.valueType !== undefined) label.valueType = updates.valueType || undefined;

  saveLabelConfig(workspaceRootPath, config);
  return label;
}

/**
 * 删除标签及其所有后代。
 * 从所有引用它们的 session 中剥离被删除的标签。
 * @returns 被剥离的 session 数量
 */
export function deleteLabel(
  workspaceRootPath: string,
  labelId: string
): { stripped: number } {
  const config = loadLabelConfig(workspaceRootPath);

  // 收集将要移除的所有 ID（标签自身 + 所有后代）
  const descendantIds = getDescendantIds(config.labels, labelId);
  const removedIds = [labelId, ...descendantIds];

  // 从父标签的 children 数组（或根数组）中移除该节点
  const removed = removeNodeFromTree(config.labels, labelId);
  if (!removed) {
    throw new Error(`Label '${labelId}' not found`);
  }

  saveLabelConfig(workspaceRootPath, config);

  // 从所有 session 中剥离被移除的 ID
  let stripped = 0;
  for (const id of removedIds) {
    stripped += stripLabelFromSessions(workspaceRootPath, id);
  }

  return { stripped };
}

/**
 * 在父标签 children（或根级）内对标签重新排序。
 * 传入该层完整的兄弟 ID 有序列表即可。
 * @param parentId - null 表示根级，否则为父标签 ID
 * @param orderedIds - 该层兄弟标签的新顺序
 */
export function reorderLabels(
  workspaceRootPath: string,
  parentId: string | null,
  orderedIds: string[]
): void {
  const config = loadLabelConfig(workspaceRootPath);

  // 获取目标数组（根标签或某个父标签的 children）
  let siblings: LabelConfig[];
  if (parentId) {
    const parent = findLabelById(config.labels, parentId);
    if (!parent) throw new Error(`Parent label '${parentId}' not found`);
    if (!parent.children) throw new Error(`Parent label '${parentId}' has no children`);
    siblings = parent.children;
  } else {
    siblings = config.labels;
  }

  // 校验 orderedIds 与当前兄弟列表一致
  const siblingIds = new Set(siblings.map(l => l.id));
  for (const id of orderedIds) {
    if (!siblingIds.has(id)) {
      throw new Error(`Invalid label ID for reorder: '${id}'`);
    }
  }

  // 用 Map 做快速查找，然后原地重排数组
  const map = new Map(siblings.map(l => [l.id, l]));
  const reordered = orderedIds.map(id => map.get(id)!);

  // 替换数组内容（根级保持同一引用）
  if (parentId) {
    const parent = findLabelById(config.labels, parentId)!;
    parent.children = reordered;
  } else {
    config.labels.length = 0;
    config.labels.push(...reordered);
  }

  saveLabelConfig(workspaceRootPath, config);
}

/**
 * 把标签移动到另一个父标签下（或移动到根级）。
 * 标签保持其 ID 和子树不变。
 * @param newParentId - null 表示移到根级，否则为目标父标签 ID
 */
export function moveLabel(
  workspaceRootPath: string,
  labelId: string,
  newParentId: string | null
): void {
  const config = loadLabelConfig(workspaceRootPath);

  // 防止把标签移到它自己的后代下（会形成环）
  if (newParentId) {
    const descendants = getDescendantIds(config.labels, labelId);
    if (descendants.includes(newParentId)) {
      throw new Error(`Cannot move label '${labelId}' into its own descendant '${newParentId}'`);
    }
  }

  // 从当前位置移除（保留节点引用）
  const node = removeNodeFromTree(config.labels, labelId);
  if (!node) {
    throw new Error(`Label '${labelId}' not found`);
  }

  // 插入到新位置
  if (newParentId) {
    const newParent = findLabelById(config.labels, newParentId);
    if (!newParent) throw new Error(`Target parent '${newParentId}' not found`);
    if (!newParent.children) newParent.children = [];
    newParent.children.push(node);
  } else {
    config.labels.push(node);
  }

  saveLabelConfig(workspaceRootPath, config);
}

// ============================================================
// 内部辅助函数
// ============================================================

/**
 * 按 ID 从树中移除一个节点。返回被移除的节点，找不到返回 null。
 * 会原地修改树（从父标签 children 或根数组中移除）。
 */
function removeNodeFromTree(labels: LabelConfig[], targetId: string): LabelConfig | null {
  // 先看根级
  const rootIndex = labels.findIndex(l => l.id === targetId);
  if (rootIndex !== -1) {
    return labels.splice(rootIndex, 1)[0]!;
  }

  // 递归查找 children
  for (const node of labels) {
    if (node.children) {
      const childIndex = node.children.findIndex(c => c.id === targetId);
      if (childIndex !== -1) {
        return node.children.splice(childIndex, 1)[0]!;
      }
      const found = removeNodeFromTree(node.children, targetId);
      if (found) return found;
    }
  }

  return null;
}

/**
 * 从所有 session 中剥离已删除的标签。
 * 移除匹配该标签 ID 的条目，包括带值条目（如 "priority::3"）。
 * 用 extractLabelId 来同时匹配 "bug" 和 "priority::3" 风格条目。
 */
function stripLabelFromSessions(
  workspaceRootPath: string,
  deletedLabelId: string
): number {
  // 动态 import（这里用 Node 的 require）避免与 sessions 模块产生循环依赖
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');

  const sessions = listSessions(workspaceRootPath);
  let strippedCount = 0;

  for (const session of sessions) {
    // 检查是否有任何条目匹配被删除的标签 ID（同时处理布尔标签和带值标签）
    if (session.labels && session.labels.some((entry: string) => extractLabelId(entry) === deletedLabelId)) {
      const updatedLabels = session.labels.filter((entry: string) => extractLabelId(entry) !== deletedLabelId);
      updateSessionMetadata(workspaceRootPath, session.id, { labels: updatedLabels });
      strippedCount++;
    }
  }

  return strippedCount;
}

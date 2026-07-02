import type { ActivityItem, FileChange } from '@craft-agent/ui'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getFilePath(input: Record<string, unknown>): string {
  return asString(input.file_path) || asString(input.path) || 'unknown'
}

function getEditChangeId(activityId: string, editIndex: number, editCount: number): string {
  return editCount <= 1 ? activityId : `${activityId}:${editIndex}`
}

/**
 * 从活动（activity）列表中提取文件变更记录。
 * 支持多种工具调用格式：Codex 批量变更、Pi SDK 编辑格式、Claude/legacy 字段。
 */
export function collectFileChangesFromActivities(activities: ActivityItem[]): FileChange[] {
  const changes: FileChange[] = []

  for (const activity of activities) {
    const input = activity.toolInput as Record<string, unknown> | undefined
    if (!input) continue

    if (activity.toolName === 'Edit') {
      // Codex 格式：{ changes: Array<{ path, kind, diff }> }
      if (Array.isArray(input.changes)) {
        for (const codexChange of input.changes as Array<{ path?: string; diff?: string }>) {
          changes.push({
            id: `${activity.id}-${codexChange.path || 'unknown'}`,
            filePath: codexChange.path || 'unknown',
            toolType: 'Edit',
            original: '',
            modified: '',
            unifiedDiff: codexChange.diff,
            error: activity.error || undefined,
          })
        }
        continue
      }

      // Pi SDK >= 0.63.2 编辑格式：{ path, edits: [{ oldText, newText }] }
      if (Array.isArray(input.edits) && input.edits.length > 0) {
        const filePath = getFilePath(input)
        for (const [index, edit] of input.edits.entries()) {
          const currentEdit = (edit ?? {}) as { oldText?: unknown; newText?: unknown }
          changes.push({
            id: getEditChangeId(activity.id, index, input.edits.length),
            filePath,
            toolType: 'Edit',
            original: asString(currentEdit.oldText) || '',
            modified: asString(currentEdit.newText) || '',
            error: activity.error || undefined,
          })
        }
        continue
      }

      // Claude 字段优先；Pi legacy 字段作为兜底。
      changes.push({
        id: activity.id,
        filePath: getFilePath(input),
        toolType: 'Edit',
        original: asString(input.old_string) || asString(input.oldText) || '',
        modified: asString(input.new_string) || asString(input.newText) || '',
        error: activity.error || undefined,
      })
      continue
    }

    if (activity.toolName === 'Write') {
      changes.push({
        id: activity.id,
        filePath: getFilePath(input),
        toolType: 'Write',
        original: '',
        modified: asString(input.content) || '',
        error: activity.error || undefined,
      })
    }
  }

  return changes
}

/**
 * 给定一个 activityId，找出文件变更列表中对应的第一条变更 id。
 */
export function getFirstFileChangeIdForActivity(activityId: string, changes: FileChange[]): string | undefined {
  const exact = changes.find((change) => change.id === activityId)
  if (exact) return exact.id

  return changes.find((change) =>
    change.id.startsWith(`${activityId}:`) ||
    change.id.startsWith(`${activityId}-`),
  )?.id
}

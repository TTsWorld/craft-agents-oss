/**
 * MarkdownDocBlock 的纯辅助函数。
 *
 * 抽取出来以便在不启动 React 的情况下对 JSON-spec → 预览项的归一化
 * 进行单元测试。组件 DOM 行为由 Electron 手动冒烟测试覆盖（见计划）。
 */

export interface MarkdownPreviewItem {
  src: string
  label?: string
}

export interface MarkdownPreviewSpec {
  src?: string
  title?: string
  items?: MarkdownPreviewItem[]
}

/**
 * 解析 `markdown-preview` JSON 规范字符串。
 *
 * 对于无效 JSON 或同时缺少 `src` 和非空 `items` 数组的规范，返回 `null`。
 * 与 `MarkdownHtmlBlock`/`MarkdownPdfBlock` 保持一致，使相同的规范结构
 * 可跨预览块类型使用。
 */
export function parseMarkdownPreviewSpec(code: string): MarkdownPreviewSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(code)
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object') return null
  const spec = raw as Record<string, unknown>

  const itemsField = spec.items
  if (Array.isArray(itemsField) && itemsField.length > 0) {
    const items = itemsField.filter(
      (item): item is MarkdownPreviewItem =>
        !!item && typeof item === 'object' && typeof (item as { src?: unknown }).src === 'string' && (item as { src: string }).src.length > 0
    )
    if (items.length === 0) return null
    return {
      src: typeof spec.src === 'string' ? spec.src : undefined,
      title: typeof spec.title === 'string' ? spec.title : undefined,
      items,
    }
  }

  if (typeof spec.src === 'string' && spec.src.length > 0) {
    return {
      src: spec.src,
      title: typeof spec.title === 'string' ? spec.title : undefined,
    }
  }

  return null
}

/**
 * 将规范归一化为扁平的项数组。
 *
 * 单项规范（仅有 `src`）会被包装为单元素数组，使组件其余部分可以统一迭代。
 * 若两个字段同时存在，`items` 优先（与同级预览块一致）。
 */
export function normalizePreviewItems(spec: MarkdownPreviewSpec | null): MarkdownPreviewItem[] {
  if (!spec) return []
  if (spec.items && spec.items.length > 0) return spec.items
  if (spec.src) return [{ src: spec.src }]
  return []
}

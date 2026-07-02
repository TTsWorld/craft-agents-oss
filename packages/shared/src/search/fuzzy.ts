/**
 * 集中式模糊搜索工具，基于 uFuzzy 库实现
 *
 * 核心能力：
 * - 按单词边界匹配（例如输入 "proj" 可以命中 "My Project"）
 * - 通过 Unicode 模式完整支持 CJK（中文、日文、韩文）
 * - 提供可用于相关度排序的透明评分
 * - 返回匹配区间，方便前端高亮展示
 */

import uFuzzy from '@leeoniya/ufuzzy'

// 开启 Unicode 模式以支持 CJK（中日韩文字）
// 该模式比纯 ASCII 模式慢 50%-75%，但对于小列表（<1000 条）可忽略不计
const uf = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+", // 在非字母/数字字符处切分（如空格、标点）
  intraSplit: '\\p{Ll}\\p{Lu}', // 在大小写变化处切分（如 camelCase 中的驼峰边界）
})

// FuzzyResult：单条模糊搜索结果的类型定义
// 类似 Golang 中带泛型的 struct；<T> 表示这条结果可以携带任意类型的原始对象
export interface FuzzyResult<T> {
  item: T // 原始数据项
  /** 匹配得分，数值越高表示匹配越好 */
  score: number
  /** 可高亮字符的索引区间（来自 uFuzzy 的扁平数组） */
  ranges?: number[]
}

/**
 * 对一组数据项执行模糊过滤并排序
 * 返回按匹配质量从高到低排列的结果
 *
 * @param items - 待搜索的数据数组
 * @param query - 用户输入的搜索关键字
 * @param getText - 从数据项中提取可搜索文本的回调函数（类似 Golang 的 func(item T) string）
 * @returns 过滤并排序后的结果数组，包含得分信息
 *
 * @example
 * const results = fuzzyFilter(commands, 'cmt', cmd => cmd.label)
 * // 返回与 "cmt" 相关的命令，例如 "commit"，按相关度排序
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string
): FuzzyResult<T>[] {
  // trim() 去除首尾空白；如果查询为空，直接返回原数组，得分为 0
  if (!query.trim()) {
    return items.map((item) => ({ item, score: 0 }))
  }

  // 把每条数据通过 getText 映射为可搜索字符串，构成“干草堆”
  const haystack = items.map(getText)

  // uf.filter 返回所有匹配项在原数组中的下标
  const idxs = uf.filter(haystack, query)

  // 没有匹配时直接返回空数组
  if (!idxs || idxs.length === 0) return []

  // info 包含匹配区间等额外信息；sort 返回按相关度排序后的下标顺序
  const info = uf.info(idxs, haystack, query)
  const order = uf.sort(info, haystack, query)

  // 用排序位置作为得分：越靠前（orderIndex 越小）得分越高
  // uFuzzy 的 sort() 按相关度排序，但不直接暴露分数，因此我们用这种方式近似
  // 注意：order 里的下标指向 idxs，idxs 里的下标指向原始 items，按 uFuzzy API 约定都是有效的
  return order.map((i, orderIndex) => ({
    item: items[idxs[i]!]!, // ! 是非空断言，告诉 TS 此处下标一定有效（类似 Golang 中确定索引存在）
    score: order.length - orderIndex, // 排名越靠前，得分越高
    ranges: info.ranges?.[i], // ?. 是可选链：如果 ranges 不存在则返回 undefined，不会报错
  }))
}

/**
 * 为单个文本字符串计算模糊匹配得分
 * 适用于只做排序/优先级判断，而不需要完整过滤的场景
 *
 * @param text - 被匹配的文本
 * @param query - 用户查询
 * @returns 得分（越高越好），未匹配时返回 0
 *
 * @example
 * const score = fuzzyScore("My Project", "proj")
 * // 命中单词边界时返回正数得分
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query.trim()) return 0

  const idxs = uf.filter([text], query)
  if (!idxs || idxs.length === 0) return 0

  // 只要有匹配就返回 1；单文本快速评分只关心是否命中
  return 1
}

/**
 * 判断文本是否与查询关键字模糊匹配
 * 简单的布尔检查，比 fuzzyScore 更快
 *
 * @param text - 被匹配的文本
 * @param query - 用户查询
 * @returns 匹配成功返回 true
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (!query.trim()) return true

  const idxs = uf.filter([text], query)
  return idxs !== null && idxs.length > 0
}

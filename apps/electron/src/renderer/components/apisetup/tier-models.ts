/**
 * Pi 模型分档（tier）相关工具。
 * 用于在 Pi API key 流程中，从模型列表里按成本自动挑选“最佳/默认/最快”三档模型。
 */

/** Pi 返回的单个模型信息。 */
export interface PiModelInfo {
  /** 模型 ID，提交时会用到。 */
  id: string
  /** 展示名称。 */
  name: string
  /** 输入 token 成本（用于排序）。 */
  costInput: number
  /** 输出 token 成本（用于排序）。 */
  costOutput: number
  /** 上下文窗口大小。 */
  contextWindow: number
  /** 是否为推理模型。 */
  reasoning: boolean
}

/**
 * 从已按成本降序排列的模型列表中，为三档（best/default_/cheap）挑选默认模型。
 * 列表按“贵→便宜”排序，越靠前能力越强、价格越高。
 */
export function pickTierDefaults(models: PiModelInfo[]): { best: string; default_: string; cheap: string } {
  if (models.length === 0) return { best: '', default_: '', cheap: '' }
  if (models.length === 1) return { best: models[0].id, default_: models[0].id, cheap: models[0].id }
  const best = models[0].id
  const cheap = models[models.length - 1].id
  // 从顶部往下约 40% 的位置取一档中庸模型（列表通常是前 10 贵 + 后 10 便宜）。
  const defaultIdx = Math.min(Math.floor(models.length * 0.4), models.length - 2)
  const default_ = models[defaultIdx].id
  return { best, default_, cheap }
}

/**
 * 结合用户已保存的三档模型与当前可用模型列表，给出最终三档选择。
 * 若保存的模型已失效，则回退到自动挑选的默认值。
 */
export function resolveTierModels(models: PiModelInfo[], savedModels?: string[]): { best: string; default_: string; cheap: string } {
  const defaults = pickTierDefaults(models)
  const saved = (savedModels ?? []).filter(Boolean)
  if (saved.length === 0) return defaults

  const valid = new Set(models.map(m => m.id))
  const best = saved[0] && valid.has(saved[0]) ? saved[0] : defaults.best
  const default_ = saved[1] && valid.has(saved[1]) ? saved[1] : defaults.default_
  const cheap = saved[2] && valid.has(saved[2]) ? saved[2] : defaults.cheap

  return { best, default_, cheap }
}

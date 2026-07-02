/**
 * Thinking Level Configuration（思考等级配置）
 *
 * 面向 Agent 扩展思考（extended thinking）的六级配置体系：
 * - OFF：关闭扩展思考
 * - Low：轻度推理，响应更快
 * - Medium：速度与推理平衡（默认值）
 * - High：面向复杂任务的深度推理
 * - XHigh：超高档——Anthropic 官方推荐用于 Opus 的 agentic/编码场景
 * - Max：最大投入的推理档位
 *
 * 该配置是 session（会话）级设置，未设置时回落到 workspace（工作区）默认值。
 *
 * 各 Provider（模型提供方）映射关系：
 * - Anthropic：使用 adaptive thinking + effort levels（当前 Opus 模型适用）。
 *   对于不接受 `xhigh` 的模型，Anthropic SDK 会静默回落到 `high`。
 * - Pi/OpenAI：通过 Pi SDK 的 reasoning_effort 等级映射，最高到 `max` 原样透传。
 *   Pi 会在内部按模型做钳制，因此没有原生 `max` 支持的模型（除 GPT-5.6 和
 *   adaptive Claude 外的所有模型）会降级到它们自己的上限。
 */

/**
 * 有序的合法思考等级 ID 列表（单一来源的真相）。
 * `ThinkingLevel` 类型、`THINKING_LEVELS` 元数据、`validators.ts` 中的 Zod schema，
 * 以及运行时校验/错误消息，全部从这里派生。
 *
 * 顺序有意义：决定了 UI 中的排序（low → max）。
 *
 * TS 小知识：`as const` 让数组成为只读字面量元组，配合下方 `(typeof X)[number]`
 * 可派生出联合字面量类型，类似 Go 中用 iota + 显式类型来约束枚举值。
 */
export const THINKING_LEVEL_IDS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * 思考等级的联合类型，等价于 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'。
 * 类比 Go：相当于一个基于常量数组的枚举类型。
 */
export type ThinkingLevel = (typeof THINKING_LEVEL_IDS)[number];

/**
 * 单个思考等级的元信息定义。
 */
export interface ThinkingLevelDefinition {
  id: ThinkingLevel;
  /** 显示名称的 i18n key（在渲染处用 t() 解析为本地化文本） */
  nameKey: string;
  /** 描述文案的 i18n key（在渲染处用 t() 解析为本地化文本） */
  descriptionKey: string;
}

/**
 * 可选的思考等级及其展示元数据。
 * 用于 UI 下拉选择以及运行时校验。
 *
 * 字段都是翻译 key——组件中通过 t(level.nameKey) 解析为实际显示文本。
 */
export const THINKING_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'off', nameKey: 'thinking.off', descriptionKey: 'thinking.offDesc' },
  { id: 'low', nameKey: 'thinking.low', descriptionKey: 'thinking.lowDesc' },
  { id: 'medium', nameKey: 'thinking.medium', descriptionKey: 'thinking.mediumDesc' },
  { id: 'high', nameKey: 'thinking.high', descriptionKey: 'thinking.highDesc' },
  { id: 'xhigh', nameKey: 'thinking.xhigh', descriptionKey: 'thinking.xhighDesc' },
  { id: 'max', nameKey: 'thinking.max', descriptionKey: 'thinking.maxDesc' },
] as const;

/** 新建 session 时，若 workspace 未配置默认值，则使用此等级 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * 将 ThinkingLevel 映射为 Anthropic SDK 的 effort 参数。
 * 与 adaptive thinking（thinking: { type: 'adaptive' }）配合使用。
 * 'off' 返回 null（表示应完全关闭思考）。
 *
 * Record<K, V> 类似 Go 中 map[K]V 的强类型版本，这里要求每个 ThinkingLevel 都有对应值。
 */
export const THINKING_TO_EFFORT: Record<ThinkingLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * 按模型族划分的 token 预算表。
 * 用于不支持 adaptive thinking 的模型（例如通过 OpenRouter/Ollama 接入的非 Claude 模型）的回退方案。
 *
 * Haiku 上限为 8k（见 Anthropic 文档）。
 * Sonnet/Opus 最高可到 128k，但 Anthropic 建议实时场景不超过 32k
 * （超过 32k 推荐走批处理以避免超时）。
 */
const TOKEN_BUDGETS = {
  haiku: {
    off: 0,
    low: 2_000,
    medium: 4_000,
    high: 6_000,
    xhigh: 7_000,
    max: 8_000,
  },
  default: {
    off: 0,
    low: 4_000,
    medium: 10_000,
    high: 20_000,
    xhigh: 26_000,
    max: 32_000,
  },
} as const;

/**
 * 根据思考等级和模型 ID 获取对应的思考 token 预算。
 * 仅在不支持 adaptive thinking 的模型上用作回退。
 *
 * @param level - 思考等级
 * @param modelId - 模型 ID（如 'claude-haiku-4-5-20251001'）
 * @returns 应分配的思考 token 数量
 */
export function getThinkingTokens(level: ThinkingLevel, modelId: string): number {
  // 通过模型名中是否包含 'haiku' 来判定是否走 Haiku 预算
  const isHaiku = modelId.toLowerCase().includes('haiku');
  const budgets = isHaiku ? TOKEN_BUDGETS.haiku : TOKEN_BUDGETS.default;
  return budgets[level];
}

/**
 * 获取某个思考等级对应显示名称的 i18n key。
 * 在调用处用 t() 或 i18n.t() 解析为本地化文本。
 */
export function getThinkingLevelNameKey(level: ThinkingLevel): string {
  const def = THINKING_LEVELS.find((l) => l.id === level);
  // 找不到定义时退回到 `thinking.<level>` 的命名约定
  return def?.nameKey ?? `thinking.${level}`;
}

/**
 * 校验某个值是否为合法的 ThinkingLevel。
 *
 * 返回值 `value is ThinkingLevel` 是 TS 的类型守卫（type predicate），
 * 类似 Go 中先校验再把 interface{} 断言为具体类型；调用方在此之后可安全当成 ThinkingLevel 使用。
 */
export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVEL_IDS as readonly string[]).includes(value);
}

/**
 * 将持久化存储中读到的思考等级值做归一化，兼容历史遗留取值。
 * 例如旧值 'think' 会被映射为 'medium'，以保证向后兼容。
 *
 * TODO: 待旧版本持久化的 session/workspace 数据在用户升级中自然淘汰后，
 * 可移除对遗留值 'think' 的兼容分支。
 *
 * @returns 归一化后的 ThinkingLevel；若值非法则返回 undefined
 */
export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  // 兼容历史值 'think' -> 'medium'
  if (value === 'think') return 'medium';
  if (isValidThinkingLevel(value)) return value;
  return undefined;
}

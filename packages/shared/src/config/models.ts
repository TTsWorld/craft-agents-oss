/**
 * 集中式模型注册表。
 *
 * 这里是整个应用所有模型定义的唯一事实来源：模型元数据、能力、成本都在这里声明。
 * 新增模型或提供商时：
 * 1. 把模型加到 MODEL_REGISTRY；
 * 2. 便捷导出（ANTHROPIC_MODELS 等）会自动更新；
 * 3. 如果是新的内置连接，记得同步更新 llm-connections.ts。
 */

// Bedrock 原生 ID → 裸 Anthropic ID 的反向映射。
// 这里复制了一份 llm-connections.ts 里的映射，避免循环依赖（llm-connections 会导入 models）。
// 必须与 llm-connections.ts 里的 BEDROCK_MODEL_MAP 保持同步。
const BEDROCK_TO_BARE: Record<string, string> = {
  // US inference profile IDs（主要）
  'us.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'us.anthropic.claude-fable-5': 'claude-fable-5',
  'us.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  // 早期错误的 4.7 映射的兼容别名
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profile IDs
  'eu.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'eu.anthropic.claude-fable-5': 'claude-fable-5',
  'eu.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profile IDs
  'global.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'global.anthropic.claude-fable-5': 'claude-fable-5',
  'global.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  // 无 region 前缀的基础 ID
  'anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'anthropic.claude-fable-5': 'claude-fable-5',
  'anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-5': 'claude-sonnet-5',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
};

/** 把 Bedrock 原生模型 ID 反向映射为裸 Anthropic ID；找不到则原样返回 */
function bedrockToBareId(modelId: string): string {
  return BEDROCK_TO_BARE[modelId] ?? modelId;
}

/** 已弃用模型 ID → 当前推荐替换 ID 的映射 */
const DEPRECATED_MODEL_REPLACEMENTS: Record<string, string> = {
  'claude-opus-4-5-20251101': 'claude-opus-4-8',
  'claude-opus-4-6': 'claude-opus-4-8',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7-v1': 'anthropic.claude-opus-4-7',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-6-v1': 'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7-v1': 'us.anthropic.claude-opus-4-7',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'eu.anthropic.claude-opus-4-8',
  'eu.anthropic.claude-opus-4-6-v1': 'eu.anthropic.claude-opus-4-8',
  'eu.anthropic.claude-opus-4-7-v1': 'eu.anthropic.claude-opus-4-7',
  'global.anthropic.claude-opus-4-6-v1': 'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-7-v1': 'global.anthropic.claude-opus-4-7',
};

/** 把已弃用的内置模型 ID 规范化为当前支持的替换 ID */
export function normalizeDeprecatedModelId(modelId: string): string {
  if (modelId.startsWith('pi/')) {
    const normalized = normalizeDeprecatedModelId(modelId.slice(3));
    return normalized === modelId.slice(3) ? modelId : `pi/${normalized}`;
  }
  return DEPRECATED_MODEL_REPLACEMENTS[modelId] ?? modelId;
}

// ============================================
// 类型定义
// ============================================

/** LLM 提供商标识 */
export type ModelProvider = 'anthropic' | 'pi';

/**
 * 完整模型定义，包含能力与成本信息。
 * 应用里选模型、展示模型都用这个结构。
 */
export interface ModelDefinition {
  /** 模型 ID，如 'claude-sonnet-4-6' */
  id: string;
  /** 人类可读全称，如 'Sonnet 4.6' */
  name: string;
  /** 紧凑展示名，如 'Sonnet' */
  shortName: string;
  /** 模型优势简介 */
  description: string;
  /**
   * 描述对应的 i18n key（仅内置静态模型使用）。
   * UI 优先用 t(descriptionKey) 解析，没有 key 时回退到 description。
   */
  descriptionKey?: string;
  /** 提供该模型的厂商 */
  provider: ModelProvider;
  /** 最大上下文窗口（token 数） */
  contextWindow: number;
  /** 是否支持 thinking / reasoning effort；undefined 时默认 true */
  supportsThinking?: boolean;
  /** 针对自定义端点的显式图片输入能力提示 */
  supportsImages?: boolean;
}

// ============================================
// 模型注册表（唯一事实来源）
// ============================================

/**
 * 所有可用模型列表。
 * 这是权威列表，其他模型数组都从这里派生。
 */
export const MODEL_REGISTRY: ModelDefinition[] = [
  // ----------------------------------------
  // Anthropic Claude 模型
  // ----------------------------------------
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    shortName: 'Opus',
    description: 'Most capable for complex work',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    shortName: 'Opus',
    description: 'Previous Opus generation',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    shortName: 'Sonnet',
    description: 'Best combination of speed and intelligence',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    shortName: 'Sonnet',
    description: 'Previous Sonnet generation',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Haiku 4.5',
    shortName: 'Haiku',
    description: 'Fastest for quick answers',
    descriptionKey: 'model.haikuDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    shortName: 'Fable',
    description: 'Next-generation model for complex work',
    descriptionKey: 'model.fableDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },

  // ----------------------------------------
  // Pi 模型
  // 没有硬编码条目，全部动态发现：
  //   - Pi: 通过 @earendil-works/pi-ai SDK 的 getModels(provider)
  // 详见 apps/electron/src/main/model-fetchers/ 下的 ModelRefreshService
  // ----------------------------------------
];

// ============================================
// 按提供商过滤的导出
// ============================================

/** 按 provider 过滤模型列表 */
export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return MODEL_REGISTRY.filter(m => m.provider === provider);
}

/** 所有 Anthropic Claude 模型 */
export const ANTHROPIC_MODELS = getModelsByProvider('anthropic');


/**
 * 旧版兼容导出。
 * 现有代码导入 MODELS 时仍期望只拿到 Claude 模型。
 * @deprecated 优先使用 ANTHROPIC_MODELS 或 MODEL_REGISTRY
 */
export const MODELS = ANTHROPIC_MODELS;

// ============================================
// 模型 ID 辅助函数（从注册表派生）
// ============================================

/** 按 shortName 查找第一个匹配的模型 ID，找不到返回 undefined */
function findModelIdByShortName(shortName: string): string | undefined {
  return MODEL_REGISTRY.find(m => m.shortName === shortName)?.id;
}

/** 按 shortName 查找模型 ID，找不到则抛错 */
export function getModelIdByShortName(shortName: string): string {
  const id = findModelIdByShortName(shortName);
  if (!id) throw new Error(`Model not found: ${shortName}`);
  return id;
}

// ============================================
// 连接默认值
// 仅用于写入 LLM 连接默认配置，不作为运行时回退。
// ============================================

/** Anthropic 连接的默认模型（创建/回填连接时使用） */
export const DEFAULT_MODEL = getModelIdByShortName('Opus');


// ============================================
// 工具模型
// ============================================

/**
 * 获取默认的摘要/轻量模型 ID（Haiku）。
 * 在没有连接上下文时作为回退使用，例如 url-validator、mcp/validation、
 * summarize.ts 没有 modelOverride 时。
 *
 * 如果能拿到连接上下文，应改用 llm-connections.ts 里的 getSummarizationModel(connection)。
 */
export function getDefaultSummarizationModel(): string {
  return findModelIdByShortName('Haiku') ?? DEFAULT_MODEL;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 从注册表按 ID 获取模型定义。
 * 同时处理 Bedrock 原生 ID（如 "anthropic.claude-opus-4-8"），
 * 会先反向映射为裸 Anthropic ID 再查找。
 */
export function getModelById(modelId: string): ModelDefinition | undefined {
  const normalized = normalizeDeprecatedModelId(modelId);
  return MODEL_REGISTRY.find(m => m.id === normalized)
    ?? MODEL_REGISTRY.find(m => m.id === bedrockToBareId(normalized));
}

/**
 * 获取模型 ID 的展示全称（带版本）。
 */
export function getModelDisplayName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.name;
  // 兜底：先规范化弃用/Bedrock ID，再去掉前缀和日期后缀
  // 例如 "claude-opus-4-5-20251101" → "Opus 4.8"
  const normalized = bedrockToBareId(normalizeDeprecatedModelId(modelId));
  const stripped = normalized
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');  // 移除日期后缀
  // 按短横线分割，首部分首字母大写，版本号用点连接
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * 获取模型 ID 的短展示名（不含版本号）。
 */
export function getModelShortName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.shortName;
  // 对带 provider 前缀的 ID（如 "openai/gpt-5"）只显示模型部分
  if (modelId.includes('/')) {
    return modelId.split('/').pop() || modelId;
  }
  // 兜底：与 getModelDisplayName 类似的人名化逻辑
  const normalized = bedrockToBareId(normalizeDeprecatedModelId(modelId));
  const stripped = normalized.replace('claude-', '').replace(/-\d{8}$/, '');
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * 获取模型 ID 对应的已知上下文窗口大小。
 */
export function getModelContextWindow(modelId: string): number | undefined {
  return getModelById(modelId)?.contextWindow;
}

/**
 * 判断模型是否属于 Opus 系列（用于 prompt cache TTL 决策）。
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes('opus');
}

/**
 * 判断模型 ID 是否指向 Claude 模型。
 * 支持直接 Anthropic ID（如 "claude-sonnet-4-6"）、
 * provider 前缀 ID（如 OpenRouter 的 "anthropic/claude-sonnet-4"）、
 * 以及 Bedrock 原生 ID（如 "anthropic.claude-opus-4-8"）。
 */
export function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude-') || lower.includes('/claude') || lower.includes('.claude');
}

/**
 * Mythos 类模型（Claude Fable 5 / Mythos 5 / Mythos Preview）的 adaptive thinking 始终开启，
 * Messages API 会拒绝 `thinking: { type: 'disabled' }`。
 * 调用方必须对这类模型使用 adaptive thinking + effort 参数控制深度，无法关闭思考。
 * 匹配裸 ID、pi/ 前缀、Bedrock 原生等多种形式。
 */
export function isAdaptiveThinkingAlwaysOnModel(modelId: string): boolean {
  return /claude-(fable|mythos)/i.test(modelId);
}


/**
 * 获取模型 ID 对应的提供商。
 */
export function getModelProvider(modelId: string): ModelProvider | undefined {
  return getModelById(modelId)?.provider;
}

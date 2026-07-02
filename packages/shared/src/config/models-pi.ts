/**
 * Pi 模型与提供商发现（来自 SDK）。
 *
 * 单独拆出这个文件，是因为 @earendil-works/pi-ai 会间接引入
 * @aws-sdk/client-bedrock-runtime → @smithy/node-http-handler → Node.js `stream` 模块，
 * 在 Vite 渲染进程（浏览器环境，没有 Node.js 模块）构建时会报错。
 *
 * 因此本文件只能从以下场景导入：
 *   - Electron 主进程 / IPC handler
 *   - 服务端代码（build 脚本、CLI）
 *   - 注册调用（如 registerPiModelResolver）
 *
 * 严禁从渲染组件或渲染进程会导入的文件引入本文件。
 */

import { getProviders, getModels } from '@earendil-works/pi-ai/compat';
import type { KnownProvider, Model, Api } from '@earendil-works/pi-ai';
import type { ModelDefinition } from './models.ts';

// ============================================
// Pi 模型发现
// ============================================

/**
 * 把 Pi SDK 的 Model 对象转成我们自己的 ModelDefinition 格式。
 */
function piModelToDefinition(m: Model<Api>): ModelDefinition {
  const lastPart = m.name.split(/[\s-]/).pop() ?? m.name;
  const shortName = m.name.length > 20 ? lastPart : m.name;

  return {
    id: `pi/${m.id}`,
    name: m.name,
    shortName,
    description: `${m.provider} model via Craft Agents Backend`,
    provider: 'pi',
    contextWindow: m.contextWindow,
    supportsThinking: m.reasoning,
  };
}

/**
 * 需要从 Pi 模型列表中排除的模型。
 * 当前 Pi SDK 版本里这些模型有运行时问题，临时绕过。
 * 例如 gemini-1.5-flash 会报 "not found for API version v1beta"。
 */
const PI_EXCLUDED_MODELS: Set<string> = new Set([
  // 不支持的 1.5 系列
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',

  // 不支持的 2.0 系列
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',

  // 部分 SDK catalog 暴露的陈旧别名，在 OpenAI API key 流程中会运行失败
  'codex-mini-latest',
]);

/**
 * 需要按前缀排除的 Pi 模型。
 * 保持列表精简且有意图明确。
 */
const PI_EXCLUDED_MODEL_PREFIXES: string[] = [
  // 清理旧版 GPT-4 家族变体（gpt-4、gpt-4.1、gpt-4o 等）
  'gpt-4',
];

/**
 * 判断是否为已弃用的 Claude Opus 4.6 模型。
 * 处理多种 ID 写法（pi/ 前缀、anthropic/ 前缀、Bedrock 原生等）。
 */
export function isDeprecatedClaudeOpus46Model(modelId: string): boolean {
  const lower = modelId.toLowerCase().replace(/^pi\//, '');
  return lower === 'claude-opus-4-6'
    || lower === 'claude-opus-4.6'
    || lower === 'anthropic/claude-opus-4-6'
    || lower === 'anthropic/claude-opus-4.6'
    || lower.endsWith('.anthropic.claude-opus-4-6-v1')
    || lower === 'anthropic.claude-opus-4-6-v1';
}

/** 判断某个 Pi 模型 ID 是否应被排除 */
function isExcludedPiModel(modelId: string): boolean {
  if (PI_EXCLUDED_MODELS.has(modelId)) return true;
  if (isDeprecatedClaudeOpus46Model(modelId)) return true;
  return PI_EXCLUDED_MODEL_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

/**
 * 判断 Bedrock 模型 ID 是否为没有 region 前缀的裸 Claude ID。
 * 裸 ID 如 `anthropic.claude-opus-4-8` 会被 Bedrock 拒绝，
 * Bedrock 要求带 region 前缀的 inference profile ID（us./eu./global.）。
 * Pi SDK catalog 里已有正确的 regional 变体，因此过滤裸 ID 不会丢失可用条目。
 */
function isBareBedrockClaudeModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.claude-');
}

/**
 * 从 Pi SDK 直接获取指定 auth provider 的模型列表。
 */
export function getPiModelsForAuthProvider(piAuthProvider: string): ModelDefinition[] {
  try {
    const models = getModels(piAuthProvider as KnownProvider);
    if (models.length > 0) {
      return models
        .filter(m => !isExcludedPiModel(m.id))
        // Bedrock：排除无 region 前缀的裸 Claude ID（一定会被 Bedrock 拒绝）。
        // 同一 catalog 里的 regional 变体会保留。
        .filter(m => piAuthProvider !== 'amazon-bedrock' || !isBareBedrockClaudeModel(m.id))
        .map(piModelToDefinition);
    }
  } catch {
    // SDK 不识别该 provider 时静默 fallback
  }
  return [];
}

/**
 * 从 Pi SDK 获取所有提供商的全部模型。
 */
export function getAllPiModels(): ModelDefinition[] {
  const allModels: ModelDefinition[] = [];
  for (const provider of getProviders()) {
    try {
      const models = getModels(provider);
      allModels.push(...models
        .filter(m => !isExcludedPiModel(m.id))
        .map(piModelToDefinition)
      );
    } catch {
      // 跳过失败的 provider
    }
  }
  return allModels;
}

// ============================================
// Pi 提供商发现
// ============================================

/**
 * Pi SDK 各提供商在 API key 流程中的展示元数据。
 *
 * 这里用 string 作为 key，而不是 KnownProvider，这样 UI 元数据可以
 * 领先或落后于 SDK 的 provider 联合类型，避免上游增删 provider 时阻塞提交。
 */
const PI_PROVIDER_DISPLAY: Partial<Record<string, { label: string; placeholder: string }>> = {
  'anthropic':              { label: 'Anthropic',          placeholder: 'sk-ant-...' },
  'google':                 { label: 'Google AI Studio',   placeholder: 'AIza...' },
  'openai':                 { label: 'OpenAI',             placeholder: 'sk-...' },
  'openrouter':             { label: 'OpenRouter',         placeholder: 'sk-or-...' },
  'groq':                   { label: 'Groq',               placeholder: 'gsk_...' },
  'mistral':                { label: 'Mistral',            placeholder: 'Paste your key here...' },
  'deepseek':               { label: 'DeepSeek',           placeholder: 'sk-...' },
  'xai':                    { label: 'xAI (Grok)',         placeholder: 'xai-...' },
  'cerebras':               { label: 'Cerebras',           placeholder: 'csk-...' },
  'amazon-bedrock':         { label: 'Amazon Bedrock',     placeholder: 'AKIA...' },
  'azure-openai-responses': { label: 'Azure OpenAI',       placeholder: 'Paste your key here...' },
  'vercel-ai-gateway':      { label: 'Vercel AI Gateway',  placeholder: 'Paste your key here...' },
  'huggingface':            { label: 'Hugging Face',       placeholder: 'hf_...' },
  'minimax':                { label: 'Minimax',            placeholder: 'Paste your key here...' },
  'kimi-coding':            { label: 'Kimi (Coding)',      placeholder: 'sk-kimi-...' },
  'zai':                    { label: 'z.ai (GLM)',         placeholder: 'Paste your key here...' },
};

/**
 * 需要从 Pi API key 下拉列表中排除的提供商。
 */
const PI_EXCLUDED_PROVIDERS: Set<string> = new Set([
  'github-copilot',
  'openai-codex',
  'google-vertex',
]);

/** API key 流程中可用的 Pi 提供商信息 */
export interface PiProviderInfo {
  key: string;
  label: string;
  placeholder: string;
}

/** 把 provider key 格式化为展示名，例如 'vercel-ai-gateway' → 'Vercel Ai Gateway' */
function formatProviderName(key: string): string {
  return key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * 获取所有支持 API key 认证的 Pi 提供商列表。
 */
export function getPiApiKeyProviders(): PiProviderInfo[] {
  return getProviders()
    .filter(p => !PI_EXCLUDED_PROVIDERS.has(p))
    .map(p => {
      const display = PI_PROVIDER_DISPLAY[p];
      return {
        key: p,
        label: display?.label ?? formatProviderName(p),
        placeholder: display?.placeholder ?? 'sk-...',
      };
    })
    .sort((a, b) => {
      const priority = ['anthropic', 'google', 'openai'];
      const ai = priority.indexOf(a.key);
      const bi = priority.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * 获取 Pi SDK 提供商的基础 URL（如 'anthropic' → 'https://api.anthropic.com'）。
 */
export function getPiProviderBaseUrl(provider: string): string | undefined {
  try {
    const models = getModels(provider as Parameters<typeof getModels>[0]);
    return models[0]?.baseUrl || undefined;
  } catch {
    return undefined;
  }
}

import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';

// 从 shared 重新导出，让鉴权感知的 mini-model 黑名单有唯一真相源
// （`getMiniModel()` 在选择时也用到它）。
export { isDeniedMiniModelId } from '../../shared/src/config/llm-connections.ts';

// 重新导出调用方使用的 PiModel 类型
type PiModel<T = any> = ReturnType<PiModelRegistry['find']>;

/**
 * 从注册表中解析 Pi SDK 模型，可选地让自定义 endpoint 优先。
 *
 * 解析顺序：
 * 1. 若 `preferCustomEndpoint` 为 true，先尝试 `'custom-endpoint'` provider
 * 2. 通过 `piAuthProvider` 做精确 provider+model 查找
 * 3. 对 `getAll()` 结果按 id/name 全量扫描
 * 4. 常用 provider 兜底列表（含 'custom-endpoint'）
 */
export function resolvePiModel(
  modelRegistry: PiModelRegistry,
  modelId: string,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
): PiModel | undefined {
  // 剥离 Craft 的 pi/ 前缀——Pi SDK 使用纯 model ID（例如 "claude-sonnet-4-6"）
  const bareId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;

  // 已配置时自定义 endpoint 优先
  if (preferCustomEndpoint) {
    const custom = modelRegistry.find('custom-endpoint', bareId);
    if (custom) return custom;
  }

  // 已知鉴权 provider 时，先做精确 provider+model 查找。
  // 这样能避免 getAll() 的歧义——同一 model ID 可能同时存在于多个 provider 下
  // （例如 "gpt-5.2" 同时在 "openai" 和 "azure-openai-responses" 下），
  // 否则可能先匹配到错误的那个。
  if (piAuthProvider) {
    const exact = modelRegistry.find(piAuthProvider, bareId);
    if (exact) {
      // MiniMax CN API 会拒绝带 'MiniMax-' 前缀的 model ID（例如对
      // 'MiniMax-M2.5-highspeed' 返回 500），但接受纯名字（'M2.5-highspeed'）。
      if (piAuthProvider === 'minimax-cn' && exact.id.startsWith('MiniMax-')) {
        return { ...exact, id: exact.id.slice('MiniMax-'.length) };
      }
      return exact;
    }
  }

  // 兜底：扫描所有可用模型。
  // 当 piAuthProvider 已设置时，只返回同一 provider（或 'custom-endpoint'）的模型。
  // 没有这层保护，属于不同 provider 的模型（例如以 "github-copilot" 鉴权时
  // "gpt-5.4" 却挂在 "azure-openai-responses" 下）也会被返回，导致 Pi SDK 报
  // "No API key found for <wrong-provider>"。
  const allModels = modelRegistry.getAll();
  const match = allModels.find(m =>
    (m.id === bareId || m.name === bareId) &&
    (!piAuthProvider || (m as any).provider === piAuthProvider || (m as any).provider === 'custom-endpoint'),
  );
  if (match) return match;

  // 用 model ID 在常用 provider 中逐一尝试
  const providers = ['custom-endpoint', 'anthropic', 'openai', 'google'];
  for (const provider of providers) {
    // 跳过与当前鉴权 provider 不兼容的 provider
    if (piAuthProvider && provider !== piAuthProvider && provider !== 'custom-endpoint') continue;
    const model = modelRegistry.find(provider, bareId);
    if (model) return model;
  }

  return undefined;
}

/**
 * 当错误信息表明请求的模型不可用、应换一个模型重试时返回 true。
 * 同时匹配标准 OpenAI 的 "model not found" 形式和 ChatGPT 账号 Codex 的
 * "… is not supported" 拒绝。
 */
export function isModelNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('model_not_found') ||
    normalized.includes('does not exist') ||
    normalized.includes('no such model') ||
    normalized.includes('is not supported') ||
    (normalized.includes('requested model') && normalized.includes('not') && normalized.includes('exist'))
  );
}

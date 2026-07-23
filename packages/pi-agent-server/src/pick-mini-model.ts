import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';
import { resolvePiModel, isDeniedMiniModelId } from './model-resolution.ts';
import { PI_PREFERRED_DEFAULTS } from '../../shared/src/config/llm-connections.ts';

/**
 * 挑选一个与当前鉴权 provider 匹配的默认 mini 模型。
 *
 * `getDefaultSummarizationModel()` 返回 `claude-haiku-4-5`，它只有在 `anthropic`
 * 鉴权下才能解析。对于 `openai` / `openai-codex` / `google` /
 * `github-copilot` / `amazon-bedrock`，我们需要从该 provider 的偏好列表里取一个模型——
 * 否则临时会话没有显式模型，会落到 Pi SDK 的内部默认（0.70.0 之后是 openai 模型），
 * 在用户以其他 provider 鉴权时会报出误导性的 "No API key found for openai"。
 *
 * 遍历 `PI_PREFERRED_DEFAULTS[authProvider]`，返回第一个未被 `isDeniedMiniModelId`
 * 拒绝、且能通过 `resolvePiModel` 解析的候选。
 *
 * 没有可解析候选时返回 `undefined`；调用方应回退到 `getDefaultSummarizationModel()`。
 */
export function pickProviderAppropriateMiniModel(
  authProvider: string,
  modelRegistry: PiModelRegistry,
  preferCustomEndpoint: boolean,
): string | undefined {
  const preferred = PI_PREFERRED_DEFAULTS[authProvider];
  if (!preferred || preferred.length === 0) return undefined;
  for (const candidate of preferred) {
    if (isDeniedMiniModelId(candidate, authProvider)) continue;
    const resolved = resolvePiModel(modelRegistry, candidate, authProvider, preferCustomEndpoint);
    if (resolved) return candidate;
  }
  return undefined;
}

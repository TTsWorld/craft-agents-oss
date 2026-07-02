/**
 * 摘要生成工具 - 已弃用（DEPRECATED）
 *
 * 常量、类型和摘要逻辑已迁移到 large-response.ts。
 * 本文件仅保留 resetSummarizationClient()（空操作，被 sessions.ts 使用）。
 *
 * 新代码请从 './large-response.ts' 导入。
 */

import { debug } from './debug.ts';

/**
 * 重置缓存的摘要化客户端。
 * @deprecated 空操作。摘要现在通过 agent.runMiniCompletion() 完成。
 */
export function resetSummarizationClient(): void {
  debug('[summarize] resetSummarizationClient called (no-op)');
}

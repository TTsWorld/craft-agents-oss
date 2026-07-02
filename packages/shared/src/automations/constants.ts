/** 自动化配置的标准文件名 */
export const AUTOMATIONS_CONFIG_FILE = 'automations.json';

/** 自动化运行历史日志文件名（JSON Lines 格式，每行一条 JSON） */
export const AUTOMATIONS_HISTORY_FILE = 'automations-history.jsonl';

/** 持久化重试队列文件名 */
export const AUTOMATIONS_RETRY_QUEUE_FILE = 'automations-retry-queue.jsonl';

/** Webhook 动作的默认 HTTP 方法 */
export const DEFAULT_WEBHOOK_METHOD = 'POST';

/** 写入历史文件时，字符串字段（如错误、响应体、提示词）的最大长度 */
export const HISTORY_FIELD_MAX_LENGTH = 2000;

/** 每个 automation ID 最多保留的历史条目数 */
export const AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER = 20;

/** 所有 automation 全局历史条目数上限 */
export const AUTOMATION_HISTORY_MAX_ENTRIES = 1000;

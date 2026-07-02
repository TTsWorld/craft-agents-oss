/**
 * 条件树复杂度的共享限制。
 *
 * 顶层条件的深度从 0 开始。
 * 允许的深度下标为 0..(MAX_CONDITION_DEPTH_EXCLUSIVE - 1)。
 */
export const MAX_CONDITION_DEPTH_EXCLUSIVE = 8;

/** 当条件深度超过此阈值时，发出简化建议的警告 */
export const CONDITION_DEPTH_WARNING_THRESHOLD = 4;

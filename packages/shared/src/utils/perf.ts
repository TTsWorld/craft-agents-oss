/**
 * 性能埋点工具
 *
 * 轻量级性能追踪，用于定位瓶颈。
 * 将聚合后的统计信息输出到 stderr。
 *
 * 重要：默认禁用。仅在以下情况激活：
 * - CLI：传递 --debug 标志（调用 enableDebug()）
 * - Electron：从源码运行（!app.isPackaged）
 *
 * 用法：
 *   const end = perf.start('session.load')
 *   // ... 执行工作 ...
 *   end() // 记录耗时
 *
 *   // 或用于异步操作：
 *   const result = await perf.measure('mcp.connect', async () => {
 *     return connectToServer()
 *   })
 *
 *   // 嵌套 span，用于更细粒度拆解：
 *   const span = perf.span('agent.init')
 *   span.mark('config.loaded')
 *   span.mark('mcp.connected')
 *   span.end() // 记录总耗时 + 各阶段拆解
 */

import { isDebugEnabled } from './debug.ts';

// 性能指标存储
interface PerfMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  marks: Array<{ name: string; time: number; elapsed: number }>;
  metadata?: Record<string, unknown>;
}

interface PerfConfig {
  enabled: boolean;
  logToFile: boolean;
  logFilePath: string;
  minDurationMs: number; // 仅记录超过此阈值的操作
  onMetric?: (metric: PerfMetric) => void; // 自定义处理器（如用于 IPC）
}

const config: PerfConfig = {
  enabled: false, // 默认禁用，可通过 setPerfEnabled(true) 开启，或依赖 isDebugEnabled()
  logToFile: false, // 禁用文件日志，使用 stderr
  logFilePath: '', // 未使用
  minDurationMs: 0, // 默认记录所有操作
};

// 保存最近指标用于分析
const recentMetrics: PerfMetric[] = [];
const MAX_RECENT_METRICS = 1000;

// 每个操作名的聚合统计
const aggregatedStats = new Map<
  string,
  {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    durations: number[];
  }
>();

/**
 * 配置性能追踪
 */
export function configurePerfTracking(options: Partial<PerfConfig>): void {
  Object.assign(config, options);
}

/**
 * 在运行时启用/禁用性能追踪
 */
export function setPerfEnabled(enabled: boolean): void {
  config.enabled = enabled;
}

/**
 * 检查性能追踪是否已启用。
 * 显式启用或 debug 模式激活时都返回 true。
 */
export function isPerfEnabled(): boolean {
  return config.enabled || isDebugEnabled();
}

/**
 * 格式化指标以便输出
 */
function formatMetric(metric: PerfMetric): string {
  const timestamp = new Date().toISOString();
  const duration = metric.duration?.toFixed(2) ?? 'N/A';

  let line = `${timestamp} [PERF] ${metric.name}: ${duration}ms`;

  // 如有 checkpoint，追加各阶段耗时
  if (metric.marks.length > 0) {
    const markStr = metric.marks
      .map((m) => `${m.name}:${m.elapsed.toFixed(1)}ms`)
      .join(' → ');
    line += ` (${markStr})`;
  }

  // 如有元数据，追加
  if (metric.metadata && Object.keys(metric.metadata).length > 0) {
    line += ` ${JSON.stringify(metric.metadata)}`;
  }

  return line;
}

/**
 * 记录已完成的指标
 */
function logMetric(metric: PerfMetric): void {
  if (!isPerfEnabled()) return;
  if (metric.duration !== undefined && metric.duration < config.minDurationMs)
    return;

  // 存入最近指标
  recentMetrics.push(metric);
  if (recentMetrics.length > MAX_RECENT_METRICS) {
    recentMetrics.shift();
  }

  // 更新聚合统计
  updateAggregatedStats(metric);

  // 如有自定义处理器则调用
  if (config.onMetric) {
    config.onMetric(metric);
  }

  // 输出到 stderr（避免干扰 stdout）
  if (metric.duration !== undefined) {
    const line = formatMetric(metric);
    process.stderr.write(line + '\n');
  }
}

/**
 * 更新某个操作的聚合统计
 */
function updateAggregatedStats(metric: PerfMetric): void {
  if (metric.duration === undefined) return;

  let stats = aggregatedStats.get(metric.name);
  if (!stats) {
    stats = {
      count: 0,
      totalMs: 0,
      minMs: Infinity,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      durations: [],
    };
    aggregatedStats.set(metric.name, stats);
  }

  stats.count++;
  stats.totalMs += metric.duration;
  stats.minMs = Math.min(stats.minMs, metric.duration);
  stats.maxMs = Math.max(stats.maxMs, metric.duration);
  stats.avgMs = stats.totalMs / stats.count;

  // 保留耗时用于分位值计算（最多最近 100 次）
  stats.durations.push(metric.duration);
  if (stats.durations.length > 100) {
    stats.durations.shift();
  }

  // 计算分位值
  const sorted = [...stats.durations].sort((a, b) => a - b);
  stats.p50Ms = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  stats.p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}

/**
 * 开始简单计时
 * 返回一个函数，调用后完成操作并记录耗时
 */
export function start(
  name: string,
  metadata?: Record<string, unknown>
): () => number {
  const startTime = performance.now();

  return () => {
    const endTime = performance.now();
    const duration = endTime - startTime;

    const metric: PerfMetric = {
      name,
      startTime,
      endTime,
      duration,
      marks: [],
      metadata,
    };

    logMetric(metric);
    return duration;
  };
}

/**
 * 测量异步操作
 */
export async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const end = start(name, metadata);
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * 测量同步操作
 */
export function measureSync<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>
): T {
  const end = start(name, metadata);
  try {
    return fn();
  } finally {
    end();
  }
}

/**
 * 创建 PerfSpan，用于带中间 checkpoint 的测量。
 */
export interface PerfSpan {
  /** 添加一个 checkpoint */
  mark(name: string): void;
  /** 添加元数据 */
  setMetadata(key: string, value: unknown): void;
  /** 结束 span 并记录结果 */
  end(): number;
  /** 不结束 span，获取已耗时 */
  elapsed(): number;
}

export function span(name: string, metadata?: Record<string, unknown>): PerfSpan {
  const startTime = performance.now();
  const marks: Array<{ name: string; time: number; elapsed: number }> = [];
  const spanMetadata: Record<string, unknown> = { ...metadata };

  return {
    mark(markName: string): void {
      const time = performance.now();
      const elapsed = time - startTime;
      marks.push({ name: markName, time, elapsed });
    },

    setMetadata(key: string, value: unknown): void {
      spanMetadata[key] = value;
    },

    elapsed(): number {
      return performance.now() - startTime;
    },

    end(): number {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const metric: PerfMetric = {
        name,
        startTime,
        endTime,
        duration,
        marks,
        metadata:
          Object.keys(spanMetadata).length > 0 ? spanMetadata : undefined,
      };

      logMetric(metric);
      return duration;
    },
  };
}

/**
 * 获取所有操作的聚合统计
 */
export function getStats(): Map<
  string,
  {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  }
> {
  // 返回副本，去掉 durations 数组
  const result = new Map<
    string,
    {
      count: number;
      totalMs: number;
      minMs: number;
      maxMs: number;
      avgMs: number;
      p50Ms: number;
      p95Ms: number;
    }
  >();

  for (const [name, stats] of aggregatedStats) {
    result.set(name, {
      count: stats.count,
      totalMs: stats.totalMs,
      minMs: stats.minMs,
      maxMs: stats.maxMs,
      avgMs: stats.avgMs,
      p50Ms: stats.p50Ms,
      p95Ms: stats.p95Ms,
    });
  }

  return result;
}

/**
 * 获取最近指标（用于调试/分析）
 */
export function getRecentMetrics(): PerfMetric[] {
  return [...recentMetrics];
}

/**
 * 清空所有收集的指标和统计
 */
export function clearMetrics(): void {
  recentMetrics.length = 0;
  aggregatedStats.clear();
}

/**
 * 将统计格式化为摘要表格（用于控制台输出）
 */
export function formatStatsSummary(): string {
  const stats = getStats();
  if (stats.size === 0) {
    return 'No performance metrics collected';
  }

  const lines: string[] = [];
  lines.push('Performance Summary:');
  lines.push('─'.repeat(80));
  lines.push(
    'Operation'.padEnd(40) +
      'Count'.padStart(8) +
      'Avg'.padStart(10) +
      'P50'.padStart(10) +
      'P95'.padStart(10)
  );
  lines.push('─'.repeat(80));

  // 按总耗时降序排序
  const sorted = [...stats.entries()].sort(
    (a, b) => b[1].totalMs - a[1].totalMs
  );

  for (const [name, s] of sorted) {
    lines.push(
      name.padEnd(40) +
        s.count.toString().padStart(8) +
        `${s.avgMs.toFixed(1)}ms`.padStart(10) +
        `${s.p50Ms.toFixed(1)}ms`.padStart(10) +
        `${s.p95Ms.toFixed(1)}ms`.padStart(10)
    );
  }

  lines.push('─'.repeat(80));
  return lines.join('\n');
}

// 导出一个默认对象，方便命名空间式使用
export const perf = {
  start,
  measure,
  measureSync,
  span,
  getStats,
  getRecentMetrics,
  clearMetrics,
  formatStatsSummary,
  configure: configurePerfTracking,
  setEnabled: setPerfEnabled,
  isEnabled: isPerfEnabled,
};

export default perf;

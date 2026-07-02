/**
 * SchedulerService - 每分钟触发一次 SchedulerTick 事件
 *
 * 触发点会对齐到分钟边界，保证不同实例的触发时间一致。
 * 自动化流程可以在 automations.json 里用 cron 表达式订阅这个事件。
 */

/** 调度器触发一次时携带的数据结构；TS 的 interface 类似 Go 里定义的一组字段契约 */
export interface SchedulerTickPayload {
  /** ISO 8601 UTC 时间戳 */
  timestamp: string;
  /** 本地时间 HH:MM */
  localTime: string;
  /** 小时 (0-23) */
  hour: number;
  /** 分钟 (0-59) */
  minute: number;
  /** 星期几 (0-6, 周日 = 0) */
  dayOfWeek: number;
  /** 星期几英文缩写 (Sun/Mon/Tue 等) */
  dayName: string;
}

/** 调度器服务：负责按分钟周期触发外部回调 */
export class SchedulerService {
  /** NodeJS 周期定时器句柄；`NodeJS.Timeout | null` 表示“要么有值，要么为空”，类似 Go 里的 *Timer / nil */
  private timer: NodeJS.Timeout | null = null;
  /** 一次性对齐定时器句柄；先对齐到下一分钟，再启动周期性 timer */
  private alignmentTimer: NodeJS.Timeout | null = null;
  /** 防止上一个 tick 还没执行完就并发执行下一个 */
  private isTicking = false;
  /** 每分钟触发时会调用的异步回调；`(payload) => Promise<void>` 是函数类型签名 */
  private onTick: (payload: SchedulerTickPayload) => Promise<void>;

  /** 构造函数：接收一个异步回调，类似 Go 里传入一个 handler */
  constructor(onTick: (payload: SchedulerTickPayload) => Promise<void>) {
    this.onTick = onTick;
  }

  /** 启动调度器：先对齐到下一分钟边界，然后每 60 秒触发一次 */
  start(): void {
    if (this.timer || this.alignmentTimer) return;

    // 计算距离下一分钟边界还剩多少毫秒，保证每次 tick 都落在整分钟上
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    this.alignmentTimer = setTimeout(() => {
      this.alignmentTimer = null;
      this.tick();
      this.timer = setInterval(() => this.tick(), 60_000);
    }, msUntilNextMinute);
  }

  /** 停止调度器：清理对齐定时器和周期定时器 */
  stop(): void {
    if (this.alignmentTimer) {
      clearTimeout(this.alignmentTimer);
      this.alignmentTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 私有方法：构造 payload 并调用回调；`async` 表示返回一个 Promise */
  private async tick(): Promise<void> {
    if (this.isTicking) {
      console.warn('[SchedulerService] Previous tick still running, skipping');
      return;
    }
    this.isTicking = true;

    try {
      const now = new Date();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      // 构造触发载荷；`const payload: SchedulerTickPayload` 是显式类型标注，类似 Go 的变量类型声明
      const payload: SchedulerTickPayload = {
        timestamp: now.toISOString(),
        localTime: now.toTimeString().slice(0, 5), // 本地时间格式：HH:MM
        hour: now.getHours(),
        minute: now.getMinutes(),
        dayOfWeek: now.getDay(),
        // `days[now.getDay()]!` 中的 `!` 是 TS 的非空断言，告诉编译器这里的值一定存在；
        // 因为 getDay() 一定返回 0-6，所以不会越界
        dayName: days[now.getDay()]!,
      };

      console.log('[SchedulerService] TICK at', payload.localTime, 'UTC:', payload.timestamp);

      // `await` 等待异步回调完成；如果回调抛异常会进入下面的 catch
      await this.onTick(payload);
      console.log('[SchedulerService] TICK callback completed');
    } catch (error) {
      console.error('[SchedulerService] Tick failed:', error);
    } finally {
      this.isTicking = false;
    }
  }
}

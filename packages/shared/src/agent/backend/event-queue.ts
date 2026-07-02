/**
 * 【文件级注释】事件队列：把异步回调风格的事件流桥接成 AsyncGenerator
 *
 * 在 Agent 后端架构中的位置：
 *   - Claude 后端使用 Anthropic SDK 的同步 for-await 循环消费事件。
 *   - Pi 后端通过独立子进程（pi-agent-server）以 JSONL 流异步吐事件，
 *     子进程通过 eventEmitter.on('event', ...) 推送。
 *   - 为了让 Pi 后端也能向 SessionManager 提供统一的 AsyncGenerator<AgentEvent>，
 *     需要把 "回调式" 事件源转换成 "拉取式" 异步生成器。
 *
 * 类比 Golang：
 *   - 这就像把 callback/handler 模式包装成一个带缓冲的 channel，
 *     消费者用 `for event := range ch` 读取，生产者在另一端 `ch <- event`。
 *   - resolvers 数组相当于等待 channel 非空的 goroutine 列表，
 *     当有新事件时通过 Promise resolve 唤醒。
 *
 * TypeScript 特性速览：
 *   - `AsyncGenerator<AgentEvent>`：带类型的异步生成器，可用 `for await...of` 消费。
 *   - `Promise<boolean>` + resolve 回调：实现手动唤醒，类似 Go 的 `sync.Cond`。
 *   - `this.queue.shift()!`：非空断言运算符 `!`，告诉 TS "我确定这里不会返回 undefined"。
 */

import type { AgentEvent } from '@craft-agent/core/types';

export class EventQueue {
  private queue: AgentEvent[] = [];
  private resolvers: Array<(done: boolean) => void> = [];
  private done: boolean = false;

  /**
   * 把一个事件入队，并唤醒所有正在等待的消费者。
   */
  enqueue(event: AgentEvent): void {
    this.queue.push(event);
    this.signal(false);
  }

  /**
   * 标记本轮已完成 —— 不再会有新事件到达。
   * 以 done=true 唤醒所有等待中的消费者。
   */
  complete(): void {
    this.done = true;
    this.signal(true);
  }

  /**
   * 为新一轮 turn 重置队列状态。
   * 每次调用 chat() 之前必须先调用一次。
   */
  reset(): void {
    this.queue = [];
    this.resolvers = [];
    this.done = false;
  }

  /**
   * 异步生成器：按事件到达顺序逐个 yield。
   * 当 complete() 被调用且队列排空后，生成器结束。
   */
  async *drain(): AsyncGenerator<AgentEvent> {
    while (true) {
      const isDone = await this.waitForEvent();

      // 把当前队列里所有事件依次吐出
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }

      if (isDone) break;
    }
  }

  /**
   * 队列中是否还有未消费的事件。
   */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * 是否已被标记为完成（complete() 已调用）。
   */
  get isComplete(): boolean {
    return this.done;
  }

  // ============================================================
  // 内部实现（Internal）
  // ============================================================

  /**
   * 唤醒所有正在等待的消费者。
   * done 参数会传给每个等待者，告知本轮是否已结束。
   */
  private signal(done: boolean): void {
    // splice(0) 取出全部等待者并清空数组
    const pending = this.resolvers.splice(0);
    for (const resolve of pending) {
      resolve(done);
    }
  }

  /**
   * 等待队列有事件可消费，或收到完成信号。
   * @returns true 表示本轮已结束且队列为空；false 表示有事件可消费
   */
  private waitForEvent(): Promise<boolean> {
    // 快速路径：已有事件或已完成，直接返回
    if (this.queue.length > 0 || this.done) {
      return Promise.resolve(this.done && this.queue.length === 0);
    }
    // 慢速路径：暂无事件，挂起一个 Promise，等 signal() 来 resolve
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

/**
 * Cron 匹配工具
 *
 * 判断 cron 表达式是否匹配当前时间。
 * 供 SchedulerTick 自动化触发使用。
 */

import { Cron } from 'croner';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('cron-matcher');

/**
 * 检查 cron 表达式是否匹配当前分钟。
 *
 * @param cronExpr - 5 字段 cron 表达式：分 时 日 月 周几
 * @param timezone - 可选 IANA 时区，例如 "Europe/Budapest"
 * @returns 当前分钟匹配时返回 true
 *
 * @example
 * matchesCron('* * * * *')                    // 每分钟都匹配
 * matchesCron('0 9 * * *', 'Europe/Budapest') // 布达佩斯时间 9:00 匹配
 */
export function matchesCron(cronExpr: string, timezone?: string): boolean {
  try {
    const options = timezone ? { timezone } : {};
    const job = new Cron(cronExpr, options);
    const now = new Date();

    // 把当前时间截断到本分钟 :00 秒
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);

    // 从本分钟开始前 1 秒检查下一次执行时间
    const checkFrom = new Date(startOfMinute.getTime() - 1000);
    const nextRun = job.nextRun(checkFrom);

    log.debug(`[matchesCron] cron=${cronExpr}, tz=${timezone || 'default'}`);
    log.debug(`[matchesCron] now=${now.toISOString()}, startOfMinute=${startOfMinute.toISOString()}`);
    log.debug(`[matchesCron] checkFrom=${checkFrom.toISOString()}, nextRun=${nextRun?.toISOString() || 'null'}`);

    // 如果下一次执行落在当前这一分钟内，就算匹配
    if (!nextRun) {
      log.debug(`[matchesCron] No nextRun, returning false`);
      return false;
    }

    const matches = nextRun.getTime() >= startOfMinute.getTime() &&
           nextRun.getTime() < startOfMinute.getTime() + 60_000;
    log.debug(`[matchesCron] matches=${matches} (nextRun ${nextRun.getTime()} vs startOfMinute ${startOfMinute.getTime()} to ${startOfMinute.getTime() + 60_000})`);
    return matches;
  } catch (e) {
    console.error(`[matchesCron] Error:`, e);
    return false;
  }
}

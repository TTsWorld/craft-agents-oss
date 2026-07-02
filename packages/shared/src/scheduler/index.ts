/**
 * scheduler 模块入口：统一导出 SchedulerService 和相关类型。
 * 这里的 `export { ..., type ... }` 是 TS 的命名导出语法，类似 Go 包中导出的类型/函数。
 */
export { SchedulerService, type SchedulerTickPayload } from './scheduler-service.ts';

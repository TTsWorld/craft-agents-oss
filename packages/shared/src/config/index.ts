/**
 * config 模块统一导出入口。
 *
 * 这里把配置相关的类型、工具函数、验证器、监听器等集中暴露出去，
 * 其他模块只需 `import { ... } from '@shared/config'` 即可使用。
 */
export * from './types.ts';
export * from './llm-connections.ts';
export * from './llm-validation.ts';
export * from './models.ts';
export * from './models-pi.ts';
export * from './model-fetcher.ts';
export * from './preferences.ts';
export * from './storage.ts';
export * from './theme.ts';
export * from './validators.ts';
export * from './cli-domains.ts';
export {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from './watcher.ts';

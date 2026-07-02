// 版本号模块入口
// 统一从 package.json 读取版本号，并聚合 install / manifest / version 三个子模块的导出。

// 从当前包（packages/shared）的 package.json 导入完整包信息。
// import pkg from '...' 类似 Go 中 import 一个 module 后通过 pkg.Field 访问。
import pkg from '../../package.json';

// 应用版本号常量，类型显式标注为 string（类似 Go 的 const string）。
export const APP_VERSION: string = pkg.version;

// 获取当前应用版本号的工具函数。
export function getAppVersion(): string {
  return APP_VERSION;
}

// 将同目录下其他子模块的导出重新暴露出去，方便外部统一从 './version' 引入。
export * from './install.ts';
export * from './manifest.ts';
export * from './version.ts';

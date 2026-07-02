import { getLatestVersion } from "./manifest";

// declare const 表示这是一个由构建工具/运行时注入的全局常量。
// TypeScript 只在编译期知道它，实际值由打包时定义（类似 Go build -ldflags -X）。
declare const CRAFT_AGENT_CLI_VERSION: string | undefined;

// 获取当前运行版本号。
// 如果构建时注入了 CRAFT_AGENT_CLI_VERSION，则返回它；否则兜底为 "0.0.1"（本地开发版本）。
export function getCurrentVersion(): string {
  if (typeof CRAFT_AGENT_CLI_VERSION !== 'undefined' && CRAFT_AGENT_CLI_VERSION != null) {
    return CRAFT_AGENT_CLI_VERSION;
  }
  return "0.0.1";
}

// 检查当前版本是否已是最新版本。
// 如果无法获取远程最新版本，默认认为“已最新”，避免误触发升级。
export async function isUpToDate(): Promise<boolean> {
  const currentVersion = getCurrentVersion();
  const latestVersion = await getLatestVersion();
  if (latestVersion == null) {
    return true;
  }
  return currentVersion === latestVersion;
}

// 返回需要升级到的目标版本。
// 如果已经是最新，或无法获取最新版本，则返回 null（表示无需升级）。
export async function getUpdateToVersion(): Promise<string | null> {
  if (await isUpToDate()) {
    return null;
  }
  const version = await getLatestVersion();
  if (version == null) {
    return null;
  }
  return version;
}

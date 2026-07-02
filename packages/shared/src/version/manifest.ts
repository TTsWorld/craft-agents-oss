import { debug } from "../utils/debug";

// Craft Agents 版本发布服务器的基础地址。
// 该服务提供 /latest 接口以及各版本 manifest.json。
const VERSIONS_URL = 'https://agents.craft.do/electron';

// 从远程服务器获取最新版本号。
// 使用 fetch 发起 HTTP GET，类似 Go 的 http.Get。
// 通过 `as` 进行类型断言，告诉 TS 返回的 JSON 结构符合 `{ version?: string }`。
export async function getLatestVersion(): Promise<string | null> {
    try {
      const response = await fetch(`${VERSIONS_URL}/latest`);
      const data = await response.json();
      const version = (data as { version?: string }).version;
      if (typeof version !== 'string') {
        debug('[manifest] Latest version is not a valid string');
        return null;
      }
      return version ?? null;
    } catch (error) {
      debug(`[manifest] Failed to get latest version: ${error}`);
    }
    return null;
}

// 获取指定版本的 manifest（清单）文件。
// manifest 里描述了该版本针对不同平台（platform-arch）发布的二进制包信息。
export async function getManifest(version: string): Promise<VersionManifest | null> {
    try {
        const url = `${VERSIONS_URL}/${version}/manifest.json`;
        debug(`[manifest] Getting manifest for version: ${url}`);
        const response = await fetch(url);
        const data = await response.json();
        // `as VersionManifest` 是类型断言：我们相信返回数据符合 VersionManifest 接口。
        return data as VersionManifest;
    } catch (error) {
        debug(`[manifest] Failed to get manifest: ${error}`);
    }
    return null;
}


// 单个二进制包的信息。
// interface 类似 Go 的 interface：只描述对象“长什么样”，不实现。
export interface BinaryInfo {
  url: string;        // 下载地址
  sha256: string;     // 校验和
  size: number;       // 文件大小（字节）
  filename?: string;  // 可选文件名，`?` 表示该字段可缺失
}

// 版本清单结构。
// Record<string, BinaryInfo> 表示“键为 string、值为 BinaryInfo”的映射，类似 Go 的 map[string]BinaryInfo。
export interface VersionManifest {
  version: string;
  build_time: string;
  build_timestamp: number;
  binaries: Record<string, BinaryInfo>;
}

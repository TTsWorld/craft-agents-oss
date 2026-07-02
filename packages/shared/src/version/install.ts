import { mkdir, chmod, symlink, unlink, lstat, access } from "fs/promises";
import { PassThrough, pipeline } from "stream";
import { promisify } from "util";
import { getLatestVersion, getManifest } from "./manifest";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import * as tar from "tar";
import { debug } from "../utils/debug";
import { getUpdateToVersion, getCurrentVersion } from "./version";

// 把 stream.pipeline 包装成返回 Promise 的异步函数，方便用 async/await 调用。
const pipelineAsync = promisify(pipeline);

// 从指定 URL 下载归档包，并用 sha256 校验完整性。
// 校验失败返回 null，避免安装被篡改的文件。
export async function downloadArchive(params: { url: string, sha256: string }): Promise<ArrayBuffer | null> {
  const { url, sha256 } = params;
  const response = await fetch(url);
  debug(`[install] Fetching archive from: ${url}`);
  const data = await response.arrayBuffer();
  const buffer = Buffer.from(data);
  const hash = createHash('sha256').update(buffer).digest('hex');
  if (hash !== sha256) {
    debug(`[install] Checksum mismatch: ${hash} !== ${sha256}`);
    return null;
  }
  return data;
}

// 确保目标目录存在；不存在则递归创建（recursive: true 类似 mkdir -p）。
export async function ensureDirectory(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await mkdir(path, { recursive: true });
  }
}

// 将下载的 tar.gz 归档解压到指定目录。
async function extractArchive(params: { archiveData: ArrayBuffer, destination: string }): Promise<void> {
  const { archiveData, destination } = params;
  const buffer = Buffer.from(archiveData);
  const stream = new PassThrough();
  stream.end(buffer);

  // 通过管道把数据流交给 tar 解压模块。
  await pipelineAsync(
    stream,
    tar.x({ C: destination, gzip: true })
  );
}

// 将归档安装到本地版本目录，并创建/更新 ~/.local/bin/craft 符号链接。
export async function installArchive(params: { archiveData: ArrayBuffer, version: string }): Promise<void> {
  const { archiveData, version } = params;
  const versionDirectory = join(homedir(), '.local', 'share', 'craft', 'versions', version);
  const binaryPath = join(versionDirectory, 'craft');
  const symlinkDirectory = join(homedir(), '.local', 'bin');
  const symlinkPath = join(symlinkDirectory, 'craft');

  await ensureDirectory(versionDirectory);
  await ensureDirectory(symlinkDirectory);

  await extractArchive({ archiveData, destination: versionDirectory });
  await chmod(binaryPath, '755');

  // 使用 lstat 检查符号链接是否存在（即使指向不存在的目标也能检测到）。
  try {
    await lstat(symlinkPath);
    await unlink(symlinkPath);
  } catch {
    // 符号链接不存在也没关系，继续创建新的。
  }
  await symlink(binaryPath, symlinkPath);
}

// 安装指定版本；传入 'latest' 或 null 时会自动解析为最新版本。
export async function install(version: string | null): Promise<VersionInstallResult> {
  if (version === 'latest' || version == null) {
    version = await getLatestVersion();
  }
  if (version == null) {
    debug('[install] Failed to get the latest version');
    return { success: false, error: 'Failed to get the latest version' };
  }
  debug(`[install] Installing version: ${version}`);

  const manifest = await getManifest(version);
  if (manifest == null) {
    debug('[install] Failed to get the manifest');
    return { success: false, error: 'Failed to get the manifest' };
  }

  // process.platform / process.arch 类似 Go 的 runtime.GOOS / runtime.GOARCH。
  const platform = `${process.platform}-${process.arch}`;
  const binary = manifest.binaries[platform];
  if (binary == null) {
    debug(`[install] No binary found for platform: ${platform}`);
    return { success: false, error: `No binary found for platform: ${platform}` };
  }
  const binaryUrl = binary.url;
  const binarySha256 = binary.sha256;
  debug(`[install] Binary URL: ${binaryUrl}`);
  debug(`[install] Binary SHA256: ${binarySha256}`);
  debug(`[install] Binary size: ${binary.size}`);

  const archiveData = await downloadArchive({ url: binaryUrl, sha256: binarySha256 });
  if (archiveData == null) {
    debug('[install] Failed to download binary');
    return { success: false, error: 'Failed to download binary' };
  }
  await installArchive({ archiveData, version });

  return { success: true };
}

// 安装结果类型：一个可辨识联合（discriminated union）。
// 根据 success 字段判断是 success 分支还是失败分支，并读取对应的 error。
// 类似 Go 中定义一个 interface，然后用 struct + 类型断言区分。
type VersionInstallResult = {
  success: true;
} | {
  success: false;
  error: string;
};

// 检查更新并在有可用版本时在后台静默安装。
// 仅在非本地开发模式下执行（版本号为 0.0.1 时跳过）。
export async function checkAndUpdate(): Promise<void> {
  try {
    const currentVersion = getCurrentVersion();

    // 本地开发版本使用 0.0.1，这里跳过自动更新，避免开发环境被覆盖。
    if (currentVersion === '0.0.1') {
      debug('[auto-update] Skipping - running locally (version 0.0.1)');
      return;
    }

    debug('[auto-update] Checking for updates...');
    const updateVersion = await getUpdateToVersion();

    if (!updateVersion) {
      debug('[auto-update] Already up to date');
      return;
    }

    debug(`[auto-update] Update available: ${currentVersion} -> ${updateVersion}`);
    debug('[auto-update] Starting background update...');

    const result = await install(updateVersion);

    if (result.success) {
      debug(`[auto-update] Successfully updated to ${updateVersion}. Restart to use new version.`);
    } else {
      debug(`[auto-update] Update failed: ${result.error}`);
    }
  } catch (error) {
    debug(`[auto-update] Error during update check: ${error instanceof Error ? error.message : String(error)}`);
  }
}

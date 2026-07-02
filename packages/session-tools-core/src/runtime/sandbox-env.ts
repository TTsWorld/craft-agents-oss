/**
 * 脚本运行时环境变量清理（sandbox env）
 *
 * 在 script sandbox 中启动子进程前，需要对环境变量做两层处理：
 * 1. 过滤掉敏感密钥，避免 credentials 泄露给不可信脚本。
 * 2. 把缓存/临时目录重定向到当前 session 的可写目录，避免沙箱隔离后无法写入默认路径。
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ScriptRuntimeLanguage } from './resolve-script-runtime.ts';

/**
 * 需要剔除的环境变量列表。
 * 这些变量通常保存 API Key、OAuth Token、云凭证等敏感信息。
 * 注意：与 packages/shared/src/mcp/client.ts 的 BLOCKED_ENV_VARS 保持同步。
 */
export const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

/**
 * 创建一份“浅拷贝”的环境变量对象，并删除敏感字段。
 * “浅拷贝”指只复制对象本身，不递归复制其值；这里环境变量值都是 string，所以足够安全。
 */
export function createSanitizedEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of BLOCKED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/**
 * 构建脚本运行时环境所需的选项。
 */
export interface ScriptRuntimeEnvOptions {
  language: ScriptRuntimeLanguage;
  dataDir: string;
}

/**
 * 构造一个适合脚本沙箱使用的环境变量对象。
 *
 * 对 Python/uv，把缓存从默认的家目录位置（如 ~/.cache/uv）重定向到当前 session 目录，
 * 保证文件系统隔离后脚本仍能正常创建缓存和临时文件。
 */
export function createScriptRuntimeEnv(
  options: ScriptRuntimeEnvOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = createSanitizedEnv(baseEnv);
  const dataDir = resolve(options.dataDir);

  // 统一临时目录到 session 内，避免访问被隔离的宿主临时目录
  const tmpDir = join(dataDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;

  if (options.language === 'python3') {
    const uvCacheDir = join(dataDir, '.uv-cache');
    const xdgCacheHome = join(dataDir, '.cache');
    const pythonPyCachePrefix = join(dataDir, '.pycache');

    mkdirSync(uvCacheDir, { recursive: true });
    mkdirSync(xdgCacheHome, { recursive: true });
    mkdirSync(pythonPyCachePrefix, { recursive: true });

    env.UV_CACHE_DIR = uvCacheDir;
    env.XDG_CACHE_HOME = xdgCacheHome;
    env.PYTHONPYCACHEPREFIX = pythonPyCachePrefix;
  }

  return env;
}

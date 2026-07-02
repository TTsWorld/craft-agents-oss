/**
 * 【文件级】RTK 二进制探测器
 *
 * RTK = ReAct Tool Kit，一个外部 CLI（https://github.com/rtk-ai/rtk），能对
 * `git status`、`npm ls` 之类长输出命令做“压缩重写”，在不改变语义的前提下
 * 减少喂给 LLM 的 token 数。本模块负责：
 *   1. 在用户 PATH 上查找 `rtk` 可执行文件（跨平台用 `which` / `where`）。
 *   2. 校验版本是否 ≥ 0.23.0（`rtk rewrite` 子命令从这个版本开始可用）。
 *   3. 顺带提供 `rtk gain` 命令的统计聚合，给设置页显示“节省了多少 token”。
 *
 * 检测结果在单次进程内缓存（cachedStatus），升级/安装 rtk 后需重启 app 才生效。
 * 打包内置 rtk（apps/electron/resources/bin/）是另一条独立的工作线，见
 * plans/rtk-integration-path-a.md；本 MVP 只做“探测”，不做打包。
 */

import { execFileSync } from 'node:child_process';

// `as const` 让字面量类型收窄为只读元组类型，等价于 Go 里 const 结构体，编译期常量。
const REQUIRED_MIN_VERSION = { major: 0, minor: 23, patch: 0 } as const;

// 缓存内部用结构，注意 path/version 可能为 null（未安装 / 版本不达标）。
interface CachedStatus {
  path: string | null;
  version: string | null;
}

// 模块级可变变量；模块级 let 相当于 Go 的包级 var，整个进程共享。
let cachedStatus: CachedStatus | undefined = undefined;

/**
 * 给 UI 用的 rtk 安装状态。
 * 联合类型 `boolean | null` 之外的 string | null 表示“找到了但可能为空”。
 */
export interface RtkStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
}

/**
 * 获取 rtk 可执行文件的绝对路径；未安装或版本低于最小要求时返回 null。
 * 这是给 rtk-rewrite.ts 真正执行重写时使用的入口。
 */
export function getRtkPath(): string | null {
  return resolveStatus().path;
}

/**
 * 获取 rtk 的安装状态，供 Settings UI 决定是显示“安装”按钮还是“启用/禁用”开关。
 * opts.forceRecheck = true 会先清缓存再探测，适合用户刚装完 rtk 想立即验证。
 * `opts?.forceRecheck` 的 ?. 是可选链，opts 为 undefined 时短路返回 undefined，不会抛错。
 */
export function getRtkStatus(opts?: { forceRecheck?: boolean }): RtkStatus {
  if (opts?.forceRecheck) resetRtkPathCache();
  const { path, version } = resolveStatus();
  return { installed: path !== null, path, version };
}

/**
 * 来自 `rtk gain --format json` 的 token 节省统计。
 * 任一获取失败（rtk 未装 / spawn 失败 / JSON 无法解析）都返回 null。
 * Settings UI 用它绘制“效率仪表”。
 */
export interface RtkGainStats {
  totalCommands: number;
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  avgSavingsPct: number;
  totalTimeMs: number;
  avgTimeMs: number;
}

/**
 * 执行 `rtk gain --format json` 并把 snake_case 字段映射成 camelCase。
 * 通过环境变量 RTK_TELEMETRY_DISABLED=1 关闭 rtk 自己的遥测上报。
 */
export function getRtkGain(): RtkGainStats | null {
  const rtkPath = getRtkPath();
  if (!rtkPath) return null;

  try {
    const out = execFileSync(rtkPath, ['gain', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 2000,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
    });
    // `as { ... }` 是类型断言，告诉编译器“我确信 JSON 解析出来是这个形状”。
    // Partial<Record<...>> 表示“这些键可能存在也可能不存在”，等价于 Go 的指针字段。
    const parsed = JSON.parse(out) as { summary?: Partial<Record<keyof RtkGainStats | 'total_commands' | 'total_input' | 'total_output' | 'total_saved' | 'avg_savings_pct' | 'total_time_ms' | 'avg_time_ms', number>> };
    const s = parsed.summary;
    if (!s) return null;
    return {
      totalCommands: Number(s.total_commands ?? 0),
      totalInput: Number(s.total_input ?? 0),
      totalOutput: Number(s.total_output ?? 0),
      totalSaved: Number(s.total_saved ?? 0),
      avgSavingsPct: Number(s.avg_savings_pct ?? 0),
      totalTimeMs: Number(s.total_time_ms ?? 0),
      avgTimeMs: Number(s.avg_time_ms ?? 0),
    };
  } catch {
    // 空 catch：任何异常都视为“获取失败”，返回 null 让上层走降级路径。
    return null;
  }
}

/** 清掉缓存的检测结果，下次调用会重新探测 PATH。 */
export function resetRtkPathCache(): void {
  cachedStatus = undefined;
}

/** 主解析流程：先找路径，再读版本号，再校验最低版本；任一步失败都缓存为不可用。 */
function resolveStatus(): CachedStatus {
  // 已探测过直接返回缓存（含 null 结果也会缓存，避免重复 spawn）。
  if (cachedStatus !== undefined) return cachedStatus;

  const rtkPath = findRtkOnPath();
  if (!rtkPath) {
    cachedStatus = { path: null, version: null };
    return cachedStatus;
  }

  const version = readRtkVersion(rtkPath);
  if (!version || !meetsMinVersion(version)) {
    // 版本不达标时 version 仍保留（便于 UI 显示“你装的是 x.y.z，需要 ≥ 0.23.0”）。
    cachedStatus = { path: null, version };
    return cachedStatus;
  }

  cachedStatus = { path: rtkPath, version };
  return cachedStatus;
}

/** 用 `which`（Unix）/ `where`（Windows）在 PATH 上定位 rtk。 */
function findRtkOnPath(): string | null {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(whichCmd, ['rtk'], { encoding: 'utf-8', timeout: 2000 }).trim();
    // Windows 的 `where` 可能返回多行（多个匹配），只取第一个。
    return result.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** 执行 `rtk --version`，从输出里正则提取 x.y.z 版本号。 */
function readRtkVersion(rtkPath: string): string | null {
  try {
    const out = execFileSync(rtkPath, ['--version'], { encoding: 'utf-8', timeout: 2000 }).trim();
    // `match(...)?.[0]` 返回 string | undefined，再 `?? null` 统一为 string | null。
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** 版本号比较：major 不同比 major，其次比 minor，最后比 patch。 */
function meetsMinVersion(version: string): boolean {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major !== REQUIRED_MIN_VERSION.major) return major > REQUIRED_MIN_VERSION.major;
  if (minor !== REQUIRED_MIN_VERSION.minor) return minor > REQUIRED_MIN_VERSION.minor;
  return patch >= REQUIRED_MIN_VERSION.patch;
}

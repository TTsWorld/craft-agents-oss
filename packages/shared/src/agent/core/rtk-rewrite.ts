/**
 * 【文件级】RTK Bash 命令重写器
 *
 * 在 Agent 真正执行 LLM 提出的 Bash 命令前，先用 rtk 把它替换成“压缩版”。
 * 例如 LLM 想跑 `git status`，我们透明地改成跑 `rtk git status`，输出更短但语义不变。
 * LLM 在对话历史里仍然看到的是原始 `git status`，对它完全无感。
 *
 * 这里只处理“重写命令文本”，不处理权限判断（deny/ask 由独立的 permission 系统负责）。
 * 通过 spawn rtk 子进程拿重写结果。任何异常（超时 / spawn 失败 / 输出与原文相同）
 * 都视为“不重写，原样透传”，保证不会因 rtk 故障拖垮 Agent 主流程。
 * 所有 spawn 都强制 RTK_TELEMETRY_DISABLED=1，避免 rtk 端的遥测泄漏。
 *
 * rtk 退出码约定（来自 rtk 自带 hooks/claude/rtk-rewrite.sh）：
 *   exit 0 + stdout  找到重写，且无权限规则——直接放行
 *   exit 1           没有等价 rtk 命令——原样透传
 *   exit 2           命中 deny 规则——原样透传（由我们的 permission 系统处理）
 *   exit 3 + stdout  命中 ask 规则——执行重写，但调用方仍需弹窗询问
 */

import { spawnSync } from 'node:child_process';

// spawn 超时设得很短（200ms），因为重写发生在用户请求的关键路径上，不能让 rtk 卡住 Agent。
const SPAWN_TIMEOUT_MS = 200;

// rtk rewrite 的退出码语义（见文件头注释）。
const REWRITE_EXIT_OK = 0;
const REWRITE_EXIT_ASK = 3;

/**
 * 重写结果。
 * - modified: 是否实际改写了命令（false = 原样透传）。
 * - input: 工具调用的完整入参（Bash 工具的 input 是个对象，含 command 字段）。
 *          Record<string, unknown> 表示“键为 string、值类型未知”的对象，类似 Go 的 map[string]any。
 */
export interface RtkRewriteResult {
  modified: boolean;
  input: Record<string, unknown>;
}

/**
 * RTK 运行上下文，由调用方提供。
 * - enabled: 用户是否在 Settings 里打开了 RTK 总开关。
 * - path: rtk 可执行文件路径（来自 rtk-detector.ts）。
 * - exclude: 不希望被重写的命令白名单（例如 `cd`、`pwd` 这类纯命令）。
 */
export interface RtkContext {
  enabled: boolean;
  path: string | null;
  exclude: string[];
}

/**
 * 尝试用 rtk 重写 Bash 工具的 command 字段。
 *
 * @param toolName 工具名（只处理 'Bash'，其它工具直接透传）
 * @param input    工具入参对象，期望含 command: string 字段
 * @param rtkPath  rtk 可执行文件路径，null 时直接透传
 * @param excludeCommands 不重写的基础命令名（取 command 第一个 token）
 * @param onDebug  可选的调试日志回调，?. 调用以兼容 undefined
 * @returns 重写后的 input 与是否修改过的标记
 */
export function rewriteBashWithRtk(
  toolName: string,
  input: Record<string, unknown>,
  rtkPath: string | null,
  excludeCommands: string[],
  onDebug?: (msg: string) => void,
): RtkRewriteResult {
  // 非 Bash 工具或没有 rtk，直接原样返回。
  if (toolName !== 'Bash' || !rtkPath) {
    return { modified: false, input };
  }

  // 只有 string 类型的 command 才处理；其它形状（缺字段 / 非字符串）原样透传。
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return { modified: false, input };

  // 取命令第一个 token 作为 base command，与 excludeCommands 比对。
  // `?? ''` 兜底，避免 split 结果为空时 destructure 失败。
  const baseCommand = command.trim().split(/\s+/)[0] ?? '';
  if (baseCommand && excludeCommands.includes(baseCommand)) {
    return { modified: false, input };
  }

  try {
    const result = spawnSync(rtkPath, ['rewrite', command], {
      encoding: 'utf-8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
    });

    // spawn 本身失败（二进制不存在 / 权限问题等），降级透传。
    if (result.error) {
      onDebug?.(`[rtk] spawn failed: ${result.error.message}`);
      return { modified: false, input };
    }

    // 只有 exit 0（自动放行）和 exit 3（重写但需询问）才是“命中重写”的信号。
    // 其它退出码（1=无等价、2=deny、其它）一律原样透传。
    if (result.status !== REWRITE_EXIT_OK && result.status !== REWRITE_EXIT_ASK) {
      return { modified: false, input };
    }

    const rewritten = (result.stdout || '').trim();
    // 空输出或与原命令一致都视为未修改，避免无意义的对象重建。
    if (!rewritten || rewritten === command) {
      return { modified: false, input };
    }

    onDebug?.(`[rtk] "${command}" → "${rewritten}"`);
    // 展开原 input 后只覆盖 command 字段，保留其它键（如 timeout、description 等）。
    return { modified: true, input: { ...input, command: rewritten } };
  } catch (e) {
    // 兜底异常处理：把错误信息打到调试日志，命令原样透传，绝不让 rtk 异常打断 Agent。
    onDebug?.(`[rtk] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return { modified: false, input };
  }
}

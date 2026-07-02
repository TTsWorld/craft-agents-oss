import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';
import { applyNetworkIsolation } from '../runtime/network-isolation.ts';
import { applyFilesystemIsolation } from '../runtime/filesystem-isolation.ts';
import { isPathWithinDirectory } from '../runtime/path-security.ts';
import { resolveScriptRuntime } from '../runtime/resolve-script-runtime.ts';
import { createScriptRuntimeEnv } from '../runtime/sandbox-env.ts';

// script_sandbox 参数：语言、脚本内容、输入文件、stdin、超时时间
export interface ScriptSandboxArgs {
  language: 'python3' | 'node' | 'bun';
  script: string;
  inputFiles?: string[];
  stdin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 20_000;

// 截断超长输出，避免把过多内容塞进 tool result
function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, MAX_OUTPUT_CHARS),
    truncated: true,
  };
}

/**
 * 处理 script_sandbox tool 调用。
 *
 * 在隔离环境中执行用户脚本（Python/Node/Bun）。
 * 关键安全点：
 * - 输入文件必须位于会话目录内；
 * - 必须启用网络和文件系统隔离；
 * - 超时时会发送 SIGKILL；
 * - 敏感环境变量会被 createScriptRuntimeEnv 剥离。
 */
export async function handleScriptSandbox(
  ctx: SessionToolContext,
  args: ScriptSandboxArgs
): Promise<ToolResult> {
  if (!ctx.sessionPath || !ctx.dataPath) {
    return errorResponse('script_sandbox requires sessionPath and dataPath in context.');
  }

  const sessionDir = ctx.sessionPath;
  const dataDir = ctx.dataPath;

  // 解析并校验输入文件路径，防止目录穿越
  const inputFiles = args.inputFiles ?? [];
  const resolvedInputs: string[] = [];
  for (const inputFile of inputFiles) {
    const resolvedInput = resolve(sessionDir, inputFile);
    if (!isPathWithinDirectory(resolvedInput, sessionDir)) {
      return errorResponse(`inputFile must be within the session directory. Got: ${inputFile}`);
    }
    if (!existsSync(resolvedInput)) {
      return errorResponse(`input file not found: ${inputFile}`);
    }
    resolvedInputs.push(resolvedInput);
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 超时时间限制在 [1, MAX_TIMEOUT_MS] 毫秒之间
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const ext = args.language === 'python3' ? '.py' : '.js';
  const sandboxScriptDir = join(dataDir, '.sandbox-scripts');
  if (!existsSync(sandboxScriptDir)) {
    mkdirSync(sandboxScriptDir, { recursive: true });
  }
  const tempScript = join(sandboxScriptDir, `craft-sandbox-${ctx.sessionId}-${Date.now()}${ext}`);

  writeFileSync(tempScript, args.script, 'utf-8');

  try {
    // 解析实际运行时（例如系统 node、bun、python3）
    const runtime = resolveScriptRuntime(args.language);
    const runtimeArgs = [...runtime.argsPrefix, tempScript, ...resolvedInputs];

    let networkIsolation = applyNetworkIsolation(runtime.command, runtimeArgs);
    let filesystemIsolation = applyFilesystemIsolation(runtime.command, runtimeArgs, sessionDir);

    if (process.platform === 'darwin') {
      // macOS：把网络限制和文件系统限制合并到同一个 sandbox-exec profile 里，
      // 避免嵌套 sandbox-exec 导致失败。
      filesystemIsolation = applyFilesystemIsolation(runtime.command, runtimeArgs, sessionDir, {
        includeNetworkDeny: true,
      });
      networkIsolation = {
        status: filesystemIsolation.status,
        backend: filesystemIsolation.status === 'enforced' ? 'sandbox-exec' : 'none',
        command: runtime.command,
        args: runtimeArgs,
      };
    } else {
      networkIsolation = applyNetworkIsolation(runtime.command, runtimeArgs);
      if (networkIsolation.status !== 'enforced') {
        return errorResponse(
          'script_sandbox requires network isolation in all permission modes, but no supported isolation backend is available on this platform/runtime.'
        );
      }

      filesystemIsolation = applyFilesystemIsolation(
        networkIsolation.command,
        networkIsolation.args,
        sessionDir
      );
    }

    // 双重校验隔离是否生效
    if (networkIsolation.status !== 'enforced') {
      return errorResponse(
        'script_sandbox requires network isolation in all permission modes, but no supported isolation backend is available on this platform/runtime.'
      );
    }

    if (filesystemIsolation.status !== 'enforced') {
      return errorResponse(
        'script_sandbox requires filesystem isolation in all permission modes, but no supported isolation backend is available on this platform/runtime.'
      );
    }

    // 构造剥离敏感变量后的环境变量
    const env = createScriptRuntimeEnv({
      language: args.language,
      dataDir,
    });

    const startedAt = Date.now();
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolvePromise, reject) => {
      const child = spawn(filesystemIsolation.command, filesystemIsolation.args, {
        cwd: dataDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      if (typeof args.stdin === 'string') {
        child.stdin.write(args.stdin);
      }
      child.stdin.end();

      // 超时后强制杀进程
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolvePromise({ stdout, stderr, code, timedOut });
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });

    const durationMs = Date.now() - startedAt;
    const stdout = truncateOutput(result.stdout);
    const stderr = truncateOutput(result.stderr);

    const lines: string[] = [
      `exitCode: ${result.code ?? 'null'}`,
      `durationMs: ${durationMs}`,
      `timedOut: ${result.timedOut}`,
      'isolationPolicy: required-in-all-modes',
      `runtime: ${runtime.command} (source: ${runtime.source})`,
      `networkIsolation: ${networkIsolation.status}`,
      `networkBackend: ${networkIsolation.backend}`,
      `filesystemIsolation: ${filesystemIsolation.status}`,
      `filesystemBackend: ${filesystemIsolation.backend}`,
    ];

    if (stdout.text.length > 0) {
      lines.push('', 'stdout:', stdout.text);
      if (stdout.truncated) {
        lines.push(`\n[stdout truncated to ${MAX_OUTPUT_CHARS} characters]`);
      }
    }

    if (stderr.text.length > 0) {
      lines.push('', 'stderr:', stderr.text);
      if (stderr.truncated) {
        lines.push(`\n[stderr truncated to ${MAX_OUTPUT_CHARS} characters]`);
      }
    }

    if (result.code !== 0) {
      return errorResponse(lines.join('\n'));
    }

    return successResponse(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error running sandboxed script: ${msg}`);
  } finally {
    try {
      unlinkSync(tempScript);
    } catch {
      // 忽略清理失败
    }
  }
}

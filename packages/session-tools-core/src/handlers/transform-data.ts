/**
 * Transform Data Handler（数据转换处理器）
 *
 * 用 Python/Node/Bun 脚本转换数据文件，输出供 datatable、spreadsheet、html-preview 等块使用的文件。
 *
 * 在隔离子进程中运行脚本，并剥离敏感环境变量。
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createScriptRuntimeEnv } from '../runtime/sandbox-env.ts';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import { resolveScriptRuntime } from '../runtime/resolve-script-runtime.ts';

// transform_data 参数：脚本语言、脚本内容、输入文件列表、输出文件路径
export interface TransformDataArgs {
  language: 'python3' | 'node' | 'bun';
  script: string;
  inputFiles: string[];
  outputFile: string;
}

const TRANSFORM_DATA_TIMEOUT_MS = 30_000;

/**
 * 处理 transform_data tool 调用。
 *
 * 流程：
 * 1. 校验输入/输出路径不越界；
 * 2. 把脚本写入临时文件；
 * 3. 用剥离敏感环境变量的 env 启动子进程；
 * 4. 返回输出文件的绝对路径，供 datatable/html-preview 块引用。
 */
export async function handleTransformData(
  ctx: SessionToolContext,
  args: TransformDataArgs
): Promise<ToolResult> {
  if (!ctx.sessionPath || !ctx.dataPath) {
    return errorResponse('transform_data requires sessionPath and dataPath in context.');
  }

  const sessionDir = ctx.sessionPath;
  const dataDir = ctx.dataPath;

  // 校验输出文件不能逃出 data/ 目录
  const resolvedOutput = resolve(dataDir, args.outputFile);
  if (!isPathWithinDirectoryForCreation(resolvedOutput, dataDir)) {
    return errorResponse(
      `outputFile must be within the session data directory. Got: ${args.outputFile}`
    );
  }

  // 解析并校验输入文件路径。
  // 允许的目录：会话目录（tool 结果）和 skills 目录（skill 资产）。
  const allowedInputDirs = [sessionDir];
  if (ctx.skillsPath) {
    allowedInputDirs.push(resolve(ctx.skillsPath));
  }

  const resolvedInputs: string[] = [];
  for (const inputFile of args.inputFiles) {
    // 先按会话目录解析相对路径；如果是绝对路径，resolve() 会原样返回
    const resolvedInput = resolve(sessionDir, inputFile);
    const isAllowed = allowedInputDirs.some(dir => isPathWithinDirectory(resolvedInput, dir));
    if (!isAllowed) {
      return errorResponse(
        `inputFile must be within the session or skills directory. Got: ${inputFile}`
      );
    }
    if (!existsSync(resolvedInput)) {
      return errorResponse(`input file not found: ${inputFile}`);
    }
    resolvedInputs.push(resolvedInput);
  }

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 把脚本写入系统临时目录下的临时文件
  const ext = args.language === 'python3' ? '.py' : '.js';
  const tempScript = join(tmpdir(), `craft-transform-${ctx.sessionId}-${Date.now()}${ext}`);
  writeFileSync(tempScript, args.script, 'utf-8');

  try {
    // 用共享的运行时解析器确定实际命令
    const runtime = resolveScriptRuntime(args.language);
    const cmd = runtime.command;
    const spawnArgs = [...runtime.argsPrefix, tempScript, ...resolvedInputs, resolvedOutput];

    // 构造剥离敏感环境变量后的环境变量，并把运行时缓存/临时目录重定向到会话 data 目录
    const env = createScriptRuntimeEnv({
      language: args.language,
      dataDir,
    });

    // 启动子进程并手动实现超时升级为 SIGKILL。
    // spawn() 自带的 timeout 选项只发 SIGTERM，可能被捕获/忽略而导致 promise 永远挂起。
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, reject) => {
      const child = spawn(cmd, spawnArgs, {
        cwd: dataDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TRANSFORM_DATA_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (timedOut) {
          resolvePromise({ stdout, stderr: `Script timed out after ${TRANSFORM_DATA_TIMEOUT_MS / 1000}s and was killed`, code });
        } else {
          resolvePromise({ stdout, stderr, code });
        }
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });

    if (result.code !== 0) {
      const errorOutput = result.stderr || result.stdout || 'Script exited with non-zero code';
      return errorResponse(
        `Script failed (exit code ${result.code}):\n${errorOutput.slice(0, 2000)}`
      );
    }

    // 确认输出文件确实被脚本创建了
    if (!existsSync(resolvedOutput)) {
      return errorResponse(
        `Script completed but output file was not created: ${args.outputFile}\n\nStdout: ${result.stdout.slice(0, 500)}`
      );
    }

    // 返回绝对路径，供预览/表格块的 "src" 字段使用
    const lines = [`Output written to: ${resolvedOutput}`];
    lines.push(`Runtime: ${cmd} (source: ${runtime.source})`);
    lines.push(`\nUse this absolute path as the "src" value in your datatable, spreadsheet, html-preview, pdf-preview, or image-preview block.`);
    if (result.stdout.trim()) {
      lines.push(`\nStdout:\n${result.stdout.slice(0, 500)}`);
    }

    return successResponse(lines.join(''));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error running script: ${msg}`);
  } finally {
    // 清理临时脚本
    try { unlinkSync(tempScript); } catch { /* ignore */ }
  }
}

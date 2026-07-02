/**
 * 【文件级注释】事件适配器抽象基类。
 *
 * 职责：为各 provider（Claude / Pi）的事件适配器提供共享的状态管理与生命周期。
 * 子类（ClaudeEventAdapter / PiEventAdapter）实现 provider 特定的 adapt*() 事件分发，
 * 基类统一负责：
 *   - 拦截原因（block reason）追踪：当 PreToolUse / 权限检查拒绝某个工具调用时，
 *     记录拒绝原因，供后续 tool_result 事件使用。
 *   - 读命令归类：把 Bash 工具调用的 cat/sed/head/tail 识别为 "读文件"，
 *     在 UI 上以 Read 工具的形式展示（更直观）。
 *   - 命令输出累积：把流式到达的 output delta 拼接成最终 tool_result 文本。
 *   - 构造 tool_start / tool_result AgentEvent 的工具方法。
 *   - Turn（一轮对话）生命周期：新一轮开始时重置所有共享状态。
 *
 * Agent 概念速览：
 *   - event adapter（事件适配器）：把底层 SDK（Claude SDK / Pi SDK）的原始事件流
 *     翻译成统一的 AgentEvent 格式，相当于一个 "翻译层"。
 *   - turn（一轮）：用户发一条消息到 agent 完成本轮回复（含若干工具调用）之间的过程。
 *
 * 类比 Golang：
 *   - 抽象基类相当于 Go 里嵌入到具体实现中的基础 struct，protected 方法相当于
 *     小写（包内可见）方法，abstract 方法相当于要求子类必须实现的 interface 方法。
 *   - Map<string, T> 相当于 Go 的 map[string]T。
 *
 * TypeScript 特性速览：
 *   - `abstract class`：抽象类，不能直接 new，只能被子类继承。
 *   - `protected`：受保护成员，子类可见、外部不可见（类似 Go 中包内可见的字段）。
 *   - `Map<K, V>`：内置的有序键值表（Go 里通常用 map + 自行维护顺序）。
 */

import type { AgentEvent } from '@craft-agent/core/types';
import { parseReadCommand, type ReadCommandInfo } from './read-patterns.ts';
import { createLogger } from '../../utils/debug.ts';
/** pool server（资源池服务器）使用的 MCP server 名称，固定为 'sources' */
const POOL_SERVER_MCP_NAME = 'sources';

export { type ReadCommandInfo } from './read-patterns.ts';

/** 日志类型：由 createLogger 工厂函数返回的具体 logger 类型（用 typeof 推导） */
type Logger = ReturnType<typeof createLogger>;

/**
 * 事件适配器抽象基类。
 * 子类继承此类后只需实现 provider 特定的事件分发逻辑。
 */
export abstract class BaseEventAdapter {
  /** 调试日志器（按 scope 分组，便于排查） */
  protected log: Logger;
  /** 当前轮次序号（每轮自增，用于区分多次 turn） */
  protected turnIndex: number = 0;
  /** 当前 turn 的唯一 ID，会写入每个 AgentEvent，供 UI 关联同一轮事件 */
  protected currentTurnId: string | null = null;

  /** 会话目录路径：用于并发安全地查询 toolMetadataStore（避免多会话串扰） */
  protected sessionDir: string | undefined;

  // 以下三张 Map 是子类事件适配器共用的共享状态：
  /** toolUseId → 已累积的命令输出文本（用于把流式 delta 拼成最终结果） */
  protected commandOutput: Map<string, string> = new Map();
  /** toolUseId → 读命令解析结果（被识别为读文件的 bash 命令） */
  protected readCommands: Map<string, ReadCommandInfo> = new Map();
  /** toolUseId → 拦截原因（被权限检查拒绝的工具调用） */
  protected blockReasons: Map<string, string> = new Map();

  /**
   * @param logScope 日志分组名称，传入 provider 名（如 'claude-event-adapter'）
   */
  constructor(logScope: string) {
    this.log = createLogger(logScope);
  }

  /**
   * 设置当前会话目录，供并发安全地查询 toolMetadataStore。
   * 由 agent 在创建 adapter 之后调用。
   */
  setSessionDir(dir: string): void {
    this.sessionDir = dir;
  }

  // ============================================================
  // Turn 生命周期（Lifecycle）
  // ============================================================

  /**
   * 开启新一轮 turn：清空所有共享状态，并触发子类的 onTurnStart 钩子。
   *
   * @param turnId 本轮唯一标识，写入后续所有 AgentEvent
   */
  startTurn(turnId?: string): void {
    this.turnIndex++;
    this.commandOutput.clear();
    this.readCommands.clear();
    this.blockReasons.clear();
    this.currentTurnId = turnId || null;
    this.onTurnStart();
  }

  /**
   * 子类钩子：在 startTurn() 中被调用，用于重置 provider 特有的状态。
   * 子类必须实现（abstract）。
   */
  protected abstract onTurnStart(): void;

  // ============================================================
  // 拦截原因追踪（Block Reason Tracking）
  // ============================================================

  /**
   * 记录某个即将被拒绝的工具调用的拦截原因。
   * 由 agent 在 PreToolUse / 权限检查拒绝工具时调用。
   */
  setBlockReason(id: string, reason: string): void {
    this.log.warn('Block reason recorded', { id, reason });
    this.blockReasons.set(id, reason);
  }

  /**
   * 消费（读取并删除）拦截原因。传入多个候选 key，按顺序匹配第一个命中的。
   *
   * @param keys 候选 toolUseId 列表（不同 provider 可能用不同 id 维度）
   * @returns 命中的拦截原因；无则 undefined
   */
  protected consumeBlockReason(...keys: string[]): string | undefined {
    for (const key of keys) {
      const reason = this.blockReasons.get(key);
      if (reason !== undefined) {
        this.blockReasons.delete(key);
        return reason;
      }
    }
    return undefined;
  }

  // ============================================================
  // 读命令归类（Read Command Classification）
  // ============================================================

  /**
   * 尝试把一条 bash 命令识别为 "读文件" 操作。
   * 若识别成功，把 ReadCommandInfo 缓存起来，供后续 tool_result 映射使用。
   *
   * @returns 识别成功返回 ReadCommandInfo，否则 null
   */
  protected classifyReadCommand(id: string, command: string): ReadCommandInfo | null {
    const readInfo = parseReadCommand(command);
    if (readInfo) {
      this.readCommands.set(id, readInfo);
    }
    return readInfo;
  }

  /**
   * 消费（读取并删除）某个工具调用对应的读命令信息。
   */
  protected consumeReadCommand(id: string): ReadCommandInfo | undefined {
    const info = this.readCommands.get(id);
    if (info) {
      this.readCommands.delete(id);
    }
    return info;
  }

  // ============================================================
  // 命令输出累积（Command Output Accumulation）
  // ============================================================

  /**
   * 累积某个工具调用的流式输出增量（这些 delta 不直接作为事件吐出，
   * 而是拼接到最终 tool_result 中）。
   */
  accumulateOutput(id: string, delta: string): void {
    const current = this.commandOutput.get(id) || '';
    this.commandOutput.set(id, current + delta);
  }

  /**
   * 消费（读取并删除）已累积的命令输出。
   */
  protected consumeOutput(id: string): string | undefined {
    const output = this.commandOutput.get(id);
    if (output !== undefined) {
      this.commandOutput.delete(id);
    }
    return output;
  }

  // ============================================================
  // MCP 工具名辅助（MCP Tool Name Helpers）
  // ============================================================

  /**
   * 构造 MCP 工具调用的规范代理工具名。
   *
   * 背景：pool server（资源池服务器）会把 source slug 嵌进工具名
   * （如 "craft__search_spaces"），因为它在内部去掉了 `mcp__` 前缀。
   * 我们只需重新加上 `mcp__` 即可得到 "mcp__craft__search_spaces"。
   * 如果不加这一层处理，会得到 "mcp__sources__craft__search_spaces"，
   * 导致 resolveToolDisplayMeta() 里的 source 查找失败。
   *
   * MCP 概念：MCP（Model Context Protocol）是工具/资源的标准协议，
   * 工具名采用 `mcp__<server>__<tool>` 的三段式命名以便区分来源。
   */
  protected buildMcpToolName(serverName: string, toolName: string): string {
    if (serverName === POOL_SERVER_MCP_NAME && toolName.includes('__')) {
      return `mcp__${toolName}`;
    }
    return `mcp__${serverName}__${toolName}`;
  }

  // ============================================================
  // 事件构造辅助（Event Construction Helpers）
  // ============================================================

  /**
   * 构造一个 tool_start（工具开始）AgentEvent。
   */
  protected createToolStart(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): AgentEvent {
    return {
      type: 'tool_start',
      toolName,
      toolUseId: id,
      input,
      intent,
      displayName,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    };
  }

  /**
   * 构造一个 tool_result（工具结果）AgentEvent。
   */
  protected createToolResult(
    id: string,
    toolName: string,
    result: string,
    isError: boolean,
    parentToolUseId?: string,
  ): AgentEvent {
    return {
      type: 'tool_result',
      toolUseId: id,
      toolName,
      result,
      isError,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    };
  }

  /**
   * 根据读命令信息构造一个被归类为 Read 的 tool_start 事件。
   * 把 cat/sed/head/tail 命令伪装成 Read 工具，UI 上更友好。
   */
  protected createReadToolStart(
    id: string,
    readInfo: ReadCommandInfo,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): AgentEvent {
    return this.createToolStart(
      id,
      'Read',
      {
        file_path: readInfo.filePath,
        offset: readInfo.startLine,
        limit: readInfo.endLine
          ? readInfo.endLine - (readInfo.startLine || 1) + 1
          : undefined,
        _command: readInfo.originalCommand,
      },
      intent,
      displayName ?? 'Read File',
      parentToolUseId,
    );
  }
}

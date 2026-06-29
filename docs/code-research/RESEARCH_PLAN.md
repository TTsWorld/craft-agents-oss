# Craft Agents 代码研究计划

> 本文件是研究索引与汇总入口。各主题报告以独立 Markdown 文件存放在同目录下。

---

## 研究总览（Phase 3 汇总）

### 项目核心价值

Craft Agents 的差异化定位不在"又一个 Claude Code 复刻"，而在三层叠加：

1. **文档为中心（Document-Centric）**：所有会话以 JSONL 落盘，自带 `{{SESSION_PATH}}` 便携 token 与 atomic tmp→rename 写入；会话即文档，可分享、可回放、可跨形态加载。
2. **Agent 原生（Agent-Native）**：在 Claude Agent SDK + Pi SDK 双后端之上，强制用 `CraftAgent → ClaudeAgent / PiAgent` 三层抽象把 prompt 构造、权限、thinking、mid-stream 行为、tool 路由收敛到统一内核，而非让 UI 直接调 SDK。
3. **跨形态复用（Multi-Form Reuse）**：同一份 `server-core` 同时驱动 Electron 主窗口、Headless Server、CLI、WebUI、Mobile、远端 RPC Server，差异仅在 transport 层（IPC / WS / stdio）。

### 各主题索引

| # | 主题 | 文件 | 一句话要点 |
|---|------|------|-----------|
| 1 | 架构总览 | `01_architecture.md` | Bun monorepo + Electron 39 + React 18 + TipTap v3；六个 app 共享 `server-core` 内核；七进程拓扑（Electron 主 / Renderer / Pi subprocess / MCP subprocess / 本地 Server / 远端 RPC Server / messaging-gateway worker） |
| 2 | Agent 内核机制 | `02_mechanism_agent.md` | `base-agent.ts` 收敛生命周期，`claude-agent.ts` / `pi-agent.ts` 各自实现 backend；Volatile/Stable prompt split；`resolveMidStreamBehavior()` 决定 steer vs queue |
| 3 | Session 生命周期与传输协议 | `03_mechanism_session_transport.md` | SessionManager 单例管 JSONL；atomic 写入 + 8KB header；Electron IPC / WS RPC / stdio 三套 transport 共用同一组 method |
| 4 | Sources / Credentials / Skills | `04_mechanism_sources_credentials_skills.md` | 三类 Source（mcp/api/local）同契约；AES-256-GCM 凭证 `~/.craft-agent/credentials.enc`（PBKDF2 100k + v1/v2 双 key fallback）；技能三级（global/workspace/project） |
| 5 | 数据流与状态 | `05_data_flow.md` | 50ms delta batching + PushTarget 路由 + 30s/500 ring buffer；会话/配置/凭证/技能磁盘布局分层 |
| 6 | 依赖与技术栈选型 | `06_dependencies.md` | Bun + Electron + 双 SDK；trustedDependencies 锁定原生模块；WhatsApp worker 强制 Node（Baileys crypto 依赖） |
| 7 | 核心工作流 | `07_workflow.md` | 11 条端到端工作流（OAuth、golden path、新 Source、@mention、权限切换、自动化、远端连接、CLI run、会话分享、mid-stream 决策、边缘场景） |
| 8 | 学习路径 | `08_learning_path.md` | 新贡献者阅读路线、关键文件清单、调试入口 |
| 9 | 演化历史 | `09_evolution_history.md` | v0.2.30（2026-01 OSS 起点）→ v0.5.0（Pi SDK 接入）→ v0.7.0（架构大爆炸）→ v0.10.4（远端化主旋律） |
| 10 | 实现地图 | `10_implementation_map.md` | 把 9 的版本阶段映射到当前模块/接口/数据结构；`~/.craft-agent/` 地层叠加 |
| 11 | 第一性原理设计演化 | `11_design_evolution.md` | 12 设计决策链，北极星「文档为中心 + Agent 原生 + 跨形态复用」 |

### 设计亮点

- **会话 JSONL 即真理源**：`SessionManager.ts` 的 atomic tmp→unlink→rename 保证崩溃安全；`{{SESSION_PATH}}` 让 prompt 在本地/远端/CLI 之间无缝迁移。
- **Volatile/Stable prompt split**：每 turn 只算一次 volatile（时间、最近工具结果），stable（系统提示、技能、来源描述）跨 turn 复用，避免 N 次重复 tokenize。
- **MCP subprocess 隔离**：每个 MCP server 单独 subprocess，与 Pi subprocess、Electron 主进程之间通过 stdio/IPC/WS 通信，单点崩溃不影响主控。
- **远端 RPC Server = 同一份内核的 WS 投影**：`server-core` 暴露的 method 在 Electron 主进程里走 IPC，在远端 Server 里走 WS RPC，差异只是 transport——这让"本地会话即点即用、远端会话零迁移"成为可能。
- **Messaging Gateway 三协议共栈**：Telegram（grammy）/ WhatsApp（Baileys worker.cjs）/ Lark 共用 automation event-bus 与 cron 调度，外部协议被收敛为内部 matcher。

### 主演化路线（来自 09）

四个关键判断：

1. **后端经历两次大转向**：v0.5.0 接入 Pi SDK 把"只支持 Claude"改成"双 SDK 抽象"；v0.7.0 把内核从 Electron 中剥离成独立 `server-core` 包，使所有非桌面形态成为可能。
2. **v0.7.0 是架构大爆炸**：一次性拆出 `server-core` / `cli` / `headless` / WS-only server，奠定了今天所有跨形态复用的基础。
3. **SDK 升级冲突是反复出现的主线**：Claude SDK 0.2.111 → 0.2.113（native binary，无法 `--preload`）→ 0.3.x；Pi SDK 0.79.x patch 锁定 + scope 从 `@mariozechner/*` 迁到 `@earendil-works/*`。每次升级都会留下化石。
4. **远端化是 v0.9 → v0.10 的主旋律**：v0.9.0 native binary + Lark，v0.10.0 远端 browser bridge，v0.10.4 Pi scope 迁移——内核在不断被"外化"。

### 实现地图要点（来自 10）

- **化石层（Fossil Layer）**：`setClaudeOAuthCredentials` 的 `'native' | 'cli'` 旧参数、zod 双版本共存、Claude SDK native binary 无法 preload 的注释——这些是版本演化的物理证据。
- **数据结构同心圆**：SessionHeader（最内层，所有形态必须）→ SourceConfig / CredentialStore（中层）→ AutomationConfig / SkillMetadata（外层）；越外层越晚加入。
- **七进程拓扑**：Electron Main / Renderer / Pi subprocess / MCP subprocess / 本地 headless Server / 远端 RPC Server / messaging-gateway worker；每个进程都对应一个明确的版本阶段。
- **`~/.craft-agent/` 地层叠加**：`credentials.enc`（v1/v2 双 key）→ `sessions/` → `sources/` → `automations/` → `skills/`，目录创建顺序即功能上线顺序。
- **3 处明确的历史包袱**：zod 3.23 vs 4.x 双版本、Claude SDK native binary 限制、Pi SDK 0.79.9 patch 锁 + scope 迁移残留。

### 第一性原理设计路线（来自 11）

- **北极星**：「文档为中心、Agent 原生、跨形态复用」三位一体——任何一个设计决策若违反其中之一，就会被否决。
- **12 设计决策链**：从最小可用（单 SDK + 单会话 + 单形态）→ 暴露问题（多 Provider、跨设备、外部协议、远端访问）→ 引入新设计（双 backend 抽象、Session JSONL、Automation event-bus、远端 RPC、Messaging Gateway）→ 复杂度代价（双 SDK 维护、双 runtime 分裂、化石层累积）→ 当前代码锚点。
- **3 个未解决的设计张力**：
  1. Claude SDK native binary vs `--preload` 路径——目前以"放弃 preload"妥协。
  2. zod 双版本共存——等待上游 Pi SDK 升级到 zod 4。
  3. Bun 主 runtime vs Node 强制（WhatsApp worker）——Bun 的 Node 兼容边界仍未完全闭合。

---

## 项目一句话

**Craft Agents** 是一个以「文档为中心、多会话并行、Agent 原生」为产品理念的桌面 + 远端 Server 多形态 Agent 工作站，由 craft.do 团队开源（Apache 2.0）。它在 Claude Agent SDK 与 Pi SDK 之上做了一层强烈的工程化包装：把会话、来源、技能、权限、自动化、凭证、多 Provider 路由统一起来，并把同一个内核同时跑在 Electron、Headless Server、CLI、WebUI 多种前端形态之下。

## 核心研究问题

1. 它在解决什么问题？为什么不是又一个 Claude Code 复刻？
2. 双 SDK（Claude / Pi）如何在同一套 Session/Tool/Source 抽象下共存？
3. 进程拓扑：Electron 主进程 / 本地 Server / Pi subprocess / MCP subprocess / 远端 RPC Server 之间是如何编排的？
4. 数据落盘：会话、凭证、配置、来源、技能如何持久化与迁移？
5. Agent 内核：CraftAgent / ClaudeAgent / PiAgent 三层抽象的边界在哪里？
6. 来源（Sources）系统：MCP / REST API / Local FS 三种来源如何被同一套契约承载？
7. 权限与自动化：三级 Permission Mode 与事件驱动的 Automation 如何耦合到会话生命周期？
8. 演化路径：从 v0.2 到 v0.10，架构经历了哪些关键转折？

## 主题划分（独立子任务）

| # | 主题 | 输出文件 | 关注点 |
|---|------|----------|--------|
| 1 | 架构总览 | `01_architecture.md` | Monorepo 拓扑、应用形态、进程模型、跨端复用、tech stack |
| 2 | Agent 内核机制 | `02_mechanism_agent.md` | `base-agent.ts` / `claude-agent.ts` / `pi-agent.ts`、backend factory、prompt-builder、permission、thinking、mid-stream 行为 |
| 3 | Session 生命周期与传输协议 | `03_mechanism_session_transport.md` | SessionManager、JSONL 持久化、Electron IPC vs RPC vs WebSocket transport、push 通道 |
| 4 | Sources / Credentials / Skills 系统 | `04_mechanism_sources_credentials_skills.md` | source 三类型、credential AES-256-GCM、token-refresh、skill 存储、MCP subprocess 隔离 |
| 5 | 数据流与状态 | `05_data_flow.md` | 一条用户消息从 UI 到 LLM 的完整调用链、配置/凭证/会话/来源的磁盘布局、运行时状态机 |
| 6 | 依赖与技术栈选型 | `06_dependencies.md` | Bun / Electron / Claude SDK / Pi SDK / TipTap / Radix / MCP SDK 等关键依赖的角色与替代方案 |
| 7 | 核心工作流 | `07_workflow.md` | 发送消息、连接新 Source、技能/来源 `@` mention、自动化触发、远端 Server 连接等典型路径 |
| 8 | 学习路径 | `08_learning_path.md` | 给新贡献者的阅读路线、关键文件清单、调试入口 |
| 9 | 演化历史 | `09_evolution_history.md` | 基于 git 提交历史识别 v0.2 → v0.10 的关键转折点 |
| 10 | 实现地图 | `10_implementation_map.md` | 把演化阶段映射到当前代码模块、接口、数据结构 |
| 11 | 第一性原理设计演化 | `11_design_evolution.md` | 抛开提交顺序，从最小可用设计 → 暴露的问题 → 引入的新设计 → 复杂度代价 → 当前代码锚点 |

## 执行策略

- **Phase 2 并行**：主题 1–8 各派一个 Explore Agent，独立完成（互不依赖）。
- **Phase 3 串行**：主题 9 / 10 / 11 在前 8 份完成后再启动——它们需要交叉引用前述事实型报告，并依赖 git 历史 diff。主题 9 必须读真实 commit diff，主题 10 把 9 的阶段映射到当前代码，主题 11 从第一性原理重排设计取舍。

## 进度

- [x] 01 架构总览
- [x] 02 Agent 内核机制
- [x] 03 Session 生命周期与传输协议
- [x] 04 Sources / Credentials / Skills
- [x] 05 数据流与状态
- [x] 06 依赖与技术栈选型
- [x] 07 核心工作流
- [x] 08 学习路径
- [x] 09 演化历史
- [x] 10 实现地图
- [x] 11 第一性原理设计演化

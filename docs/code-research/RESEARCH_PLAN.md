# Craft Agents 代码研究计划

> 本文件是研究索引与汇总入口。各主题报告以独立 Markdown 文件存放在同目录下。
> 本次为 **v2.2.1 全量重做**（用户选择 Phase 0 选项 A：覆盖重做）。旧报告已从工作树移除（仍可通过 git `fe5acd4` 找回）。

---

## 研究总览（Phase 3 汇总）

### 项目核心价值

Craft Agents（craft.do 开源，Apache-2.0）的差异化不在「又一个 Claude Code 复刻」，而在三位一体的北极星——**文档为中心 + Agent 原生 + 跨形态复用**，三者互为因果闭环：

1. **文档为中心（Document-Centric）**：会话以 JSONL 落盘（首行 8KB `SessionHeader` 预计算），atomic `writeFile(.tmp)→unlink→rename` 保证崩溃安全；会话即文档，可分享、可回放、可跨机器/跨形态加载。
2. **Agent 原生（Agent-Native）**：在 Claude Agent SDK + Pi SDK 双后端之上，强制 `AgentBackend → BaseAgent → ClaudeAgent/PiAgent` 三层抽象，把 prompt 构造、权限、thinking、mid-stream 行为、tool 路由收敛到统一内核，而非让 UI 直接调 SDK。
3. **跨形态复用（Multi-Form Reuse）**：同一份 `server-core` 内核用泛型 `bootstrapServer<T>()` 同时驱动 Electron 桌面、Headless Server、CLI、WebUI——业务 RPC 统一走 WebSocket，差异仅在 transport 绑定参数与 platform 注入。

### 各主题索引

| # | 主题 | 文件 | 一句话要点 |
|---|------|------|-----------|
| 1 | 架构总览 | `01_architecture.md` | 4 app + 11 package；内核 `server-core` 用泛型 `bootstrapServer()` 驱动多形态；**业务 RPC 统一 WebSocket**（Electron 主进程内嵌同一 WS server，renderer 经 `WsRpcClient` 连 localhost）；双后端（Claude 原生二进制 in-process + Pi 子进程 JSONL/stdio）；单宿主最多 7 进程 |
| 2 | Agent 内核机制 | `02_mechanism_agent.md` | `AgentBackend→BaseAgent→ClaudeAgent/PiAgent`；`chat()` 模板方法收敛横切；**Volatile/Stable prompt split**（issue #862，volatile 每 turn 仅算一次）；权限三级集中求值；thinking 六档；`resolveMidStreamBehavior` 单一真源（anthropic 默认 queue / pi 默认 steer） |
| 3 | Session 生命周期与传输 | `03_mechanism_session_transport.md` | JSONL 真理源 + 8KB header；atomic 写 + 启动清残留 `.tmp` + 坏行容错；**重要修正**：所谓「三套 transport」实为同一 WS RPC 的部署变体（本地无 auth / 远端 bearer+TLS / CLI 精简客户端），stdio 仅用于 MCP 子进程；push = delta 批处理 + seq 可靠投递 + 60s TTL ring buffer replay |
| 4 | Sources / Credentials / Skills | `04_mechanism_sources_credentials_skills.md` | 三类 Source 收敛进 `FolderSourceConfig` → 凭证四槽（oauth/bearer/apikey/basic）；**AES-256-GCM + PBKDF2(10万轮)**，密钥由机器硬件 UUID 派生，v1(hostname)/v2(硬件UUID) 双 key fallback；技能三级 basename `.agents` 与 Claude Code 互通；MCP 子进程 spawn 前过滤敏感 env |
| 5 | 数据流与状态 | `05_data_flow.md` | `sendMessage→agent.chat()→processEvent→persistSession(500ms debounce+atomic)→eventSink.push`；delta 批 50ms；ring buffer 500 条/30s、断线 60s replay；PushTarget all/workspace/client；**大响应真实阈值是 token ≈12000（非 60KB）**，原文落 `long_responses/` 可恢复，`_intent` 为 Pi-only |
| 6 | 依赖与技术栈 | `06_dependencies.md` | Bun 主 runtime，但 **WhatsApp worker 强制 Node**（Baileys crypto 依赖）→ runtime 分裂；双 SDK（Pi scope v0.10.4 从 `@mariozechner` 迁至 `@earendil-works`）；esbuild（main/preload/worker，CJS+精确 external 规避 ESM `import.meta.url` 坑）vs Vite（renderer）；疑点：`scripts/build.ts` 缺失、`@github/copilot-sdk` 零引用、zod 3.23/4 双版本残留 |
| 7 | 核心工作流 | `07_workflow.md` | 12 条端到端流程；多处隐式跨进程复杂度——Claude OAuth「无 callback」反模式、ring buffer seq replay、agent 选型签名分两份、Claude 无原生 steer 靠 PreToolUse 注入模拟、`SourceActivationDrainController` 在 tool_result 边界优雅终止 |
| 8 | 学习路径 | `08_learning_path.md` | 「先 `packages/` 后 `apps/`（apps 只是同一内核的壳）」；四入口（headless / 桌面内嵌 server / `server-core` 导出 / CLI 瘦客户端）；12 步主线 types→protocol→transport→bootstrap→WsRpcServer→JSONL→base-agent→SessionManager→双后端→sources/credentials/skills→messaging-gateway；**易误解点**：业务 RPC 走 localhost WS 而非传统 Electron IPC |
| 9 | 演化历史 | `09_evolution_history.md` | OSS 起点 2026-01-19 v0.2.19；**修正**：Pi SDK(v0.5.0) 是取代 v0.4.0 独立 Codex/Copilot backend 的统一多 provider 抽象，而非「第二个 SDK」；三大转折 v0.7.0（server-core 剥离 + WS RPC 取代 IPC）、v0.9.0（native binary + Lark）、v0.10.4（Pi scope 迁移）；11/95 提交为「Sync from internal repository」（单次达 1.1 万行 → OSS 是内部镜像，commit 粒度远粗于真实开发） |
| 10 | 实现地图 | `10_implementation_map.md` | 8 处化石：`claudeCliPath` 命名、`bridge-mcp-server` 死引用、`session-mcp-server` 注释仍写 Codex、zod 双版本、credentials v1/v2 双 key；**修正**：workspace mkdir 顺序是 sources→sessions→skills；`'native'|'cli'` 参数不存在，实为 `providerType:'anthropic'|'pi'`；同心圆 SessionHeader→SourceConfig/CredentialStore→AutomationConfig/SkillMetadata |
| 11 | 第一性原理设计演化 | `11_design_evolution.md` | 北极星三角互为因果，三大锚点坐实（JSONL 即文档 / `bootstrapServer<T,T>` 泛型 / 双 backend 抽象）；11 个设计决策链；4 个未解张力：native binary 致 `--preload` 失效、zod v3/v4、Bun vs Node、双 SDK 长期并存 |
| 12 | Day 0 产品与技术方案复原 | `12_day0_product_technical_design.md` | 首个 commit 是**单 Claude SDK + 单 Electron 桌面单体**，服务 craft.do 自己；**纠正**：TipTap 非 Day 0（v0.6.0 才引入，Day 0 纯 Markdown 渲染）；Day 0 已有 JSONL/三级权限/MCP/凭证/skills/statuses/workspaces/14 主题；四股产品压力（多 provider / 远端 / IM 自动化 / 上游 SDK 变更）逼出演进 |
| 13 | 代码质量地图 | `13_quality_map.md` | 两大高风险：① `SessionManager.ts` **8090 行上帝类**（`getOrCreateAgent`~1200 行 / `processEvent`~676 / `sendMessage`~600）且无专属测试；② RPC 类型网缺失（`handle/push/invoke` 全 `string`+`any[]`，`channels` 注册表未传导到类型层）；中风险：zod 双版本、凭证 `tryDecrypt` 把「密钥错」与「JSON 损坏」合并吞成 null、网络拦截器 2265 行 |

### 设计亮点

- **会话 JSONL 即真理源**：8KB `SessionHeader` 让会话列表零消息解析；header 7 字段在「写之前」更新，防外部改动被陈旧快照覆盖、防自写 `fs.watch` 事件误判。
- **Volatile/Stable prompt split**：volatile（时间、session_state、源状态）每 turn 仅算一次（因消耗 mode-change 信号），stable（工作区能力、工作目录）跨 turn 复用——Claude 全放 user 尾保 system 缓存，Pi 折进 system 前缀。
- **业务 RPC 统一 WebSocket（非 Electron IPC）**：Electron 主进程在进程内启动同一个 `bootstrapServer()` 的 WsRpcServer，renderer/preload 经 `WsRpcClient` 连 `ws://127.0.0.1`；handler 只认 `RpcServer.handle` 接口，故 renderer/远端/CLI 共用同一组 `RPC_CHANNELS`。这是跨形态复用的物理基础。
- **凭证 v1/v2 双 key fallback**：v1 用 hostname、v2 用硬件 UUID 派生密钥，顺序 fallback 实现无感迁移与自动重加密——机器换名/重装也不丢凭证。
- **远端 Agent 反向驱动本地桌面**：`capabilities` 协商让远端 server 的 Agent 能经 `client:browser:invoke` 反向 RPC 调用本地桌面客户端的 OS 能力（远端算力 + 本地能力）。

### 整合要点（按 v2.2.1 要求交叉汇总）

**学习路径（来自 08）**：理解本项目需 9 个前置知识模块——Electron 三进程模型 + contextBridge、Bun & ESM/CJS 边界、WebSocket RPC 设计、Agent tool use/streaming/permission、MCP 协议、TipTap/ProseMirror、jotai、AES-256-GCM/PBKDF2、OAuth。推荐先读内核（`packages/server-core` + `packages/shared`）再读壳（`apps/*`）；首轮可跳过 `webui`/`viewer`/`ui`/`messaging-*`/`scripts`/renderer GUI。

**主演化路线（来自 09）**：四个关键判断——① OSS 起点（v0.2.19，2026-01-19）是单 Claude SDK + 单 Electron 桌面单体；② **Pi SDK（v0.5.0）不是「第二个 SDK」，而是取代 v0.4.0 独立 Codex/Copilot backend 的统一多 provider 抽象**，双 SDK 并存格局由此形成；③ v0.7.0 是架构大爆炸（server-core 剥离 + WS RPC 取代 Electron IPC，催生 CLI/Headless/WebUI）；④ v0.9→v0.10 远端化主旋律（native binary + Lark + 远端 browser bridge + Pi scope 迁移）。OSS 仓库是内部镜像（11/95 提交为「Sync」，单次上万行）。

**实现地图（来自 10）**：阶段→代码锚点可对照——`core/shared/ui` 骨架自阶段 0 延续；`backend/{claude,pi}/` 双驱动来自阶段 3；`claudeCliPath` 命名 / `--preload` 失效 / SDK 精确锁定是阶段 7 native binary 化石；`bridge-mcp-server` 死引用、`session-mcp-server` 写 Codex 的过时注释是 v0.5.0 删 Codex backend 的残留。最大长期包袱是双 SDK 同步成本（release notes 反复出现「prevent drift」）。

**第一性原理设计路线（来自 11）**：从最小可用（单 SDK + 单会话 + 单形态）→ 暴露问题（多 Provider、跨设备、外部协议、远端访问、崩溃恢复、接任意 API）→ 引入新设计（双 backend 抽象、JSONL+atomic 写、server-core+WS RPC、三类 Source 同契约、automation event-bus、capabilities 协商、subprocess 隔离）→ 复杂度代价（双 SDK 维护、双 runtime 分裂、化石层累积）→ 当前代码锚点。4 个未解张力贯穿至今。

**Day 0 复原（来自 12）**：作者 Day 0 蓝图 = 给 craft.do 自己用的「单 Claude SDK + 单 Electron + JSONL 文档流 + 三级权限」桌面 Agent；TipTap / Pi / server-core / 远端 / messaging 全是演进产物；推动演进的是四股产品压力——多 provider 需求、远端/多设备需求、IM 自动化需求、上游 SDK 变更（native binary、scope 迁移）。证据等级在 12 中逐条标注。

**质量风险（来自 13）**：最高优先级的两块——① `SessionManager.ts` 8090 行上帝类（三个 600~1200 行巨型方法）且 `sessions/__tests__/` 无其专属测试，改动回归面极大且无测试网；② RPC 类型网缺失，`channels` 注册表虽集中但未传导到 `handle/push/invoke` 的类型签名（全 `string`+`any[]`）。次要：凭证解密吞错（密钥错与 JSON 损坏合并）、zod 双版本、2265 行网络拦截器。**注**：任务中提及的两个 lint 脚本（`check-raw-sends.sh` / `check-task-tool-checks.sh`）在仓中疑似不存在，类型安全网实际缺失——待核实。

---

## 项目概述

**它是什么**：Craft Agents 是 craft.do 团队开源（Apache 2.0）的「文档为中心、Agent 原生」多形态 Agent 工作站。它在 Claude Agent SDK 与 Pi SDK 之上做了一层强工程化包装，把会话、来源、技能、权限、自动化、凭证、多 Provider 路由统一收敛，并把同一份内核同时跑在 Electron 桌面、Headless Server、CLI、WebUI 多种前端形态之下。

**解决什么问题**：作者想要一个比 CLI（如 Claude Code）更直觉、更可定制、更适合「多任务并行 + 文档为中心」工作流的 Agent 操作环境。没有它，用户要么受限于命令行的单会话/单 Provider 体验，要么得自己把 MCP、凭证、权限、多 Provider、远端访问、外部协议（Telegram/WhatsApp/Lark）这些横切关注点逐一缝起来。它的差异化在三层叠加：① 会话 JSONL 即文档（可分享/回放/跨形态加载）；② Agent 原生（强制 CraftAgent→ClaudeAgent/PiAgent 三层抽象，UI 不直接调 SDK）；③ 跨形态复用（同一 `server-core` 内核驱动多前端，差异仅在 transport 层）。

**谁在使用**：① craft.do 团队自身——他们「用 Craft Agents 开发 Craft Agents，不用任何代码编辑器」；② 想要非 CLI、可深度定制 Agent 工作流的高级用户；③ 需要把 Agent 跑在远端 VPS、用桌面/CLI 当瘦客户端的长会话/重算力场景；④ 想用自动化（cron、label 变更、tool 触发）把 Agent 接入外部系统（IM 协议）的集成者。

## 研究专题（13 个，机制拆为 3 篇）

> 默认模板为 11 篇（机制合并为 1 篇）。本项目体量大（10 packages + 4 apps、双 SDK、多进程），将「核心机制」拆为 3 篇独立子系统报告，并在末尾补 v2.2.1 新增的 Day 0 与质量地图两个维度，共 13 篇。

### 专题 A：架构全景
- 目标：理解 monorepo 由哪些模块/应用组成，每个是什么、为什么存在；进程拓扑（7 进程）；跨形态复用如何实现；技术栈选型
- 重点范围：`package.json`（workspaces/deps）、`apps/{cli,electron,viewer,webui}`、`packages/*` 概览、`README.md` 架构段、`scripts/build*`、`apps/electron/electron-builder.yml`、`packages/server-core/src/{bootstrap,runtime,webui}`
- 输出：`docs/code-research/01_architecture.md`

### 专题 B：核心机制 — Agent 内核
- 目标：CraftAgent / ClaudeAgent / PiAgent 三层抽象是什么、为什么这么分；生命周期收敛；prompt 构造（Volatile/Stable split）；权限三级；thinking；mid-stream 行为（steer vs queue）
- 重点范围：`packages/shared/src/agent/*`（base-agent、claude-agent、pi-agent、prompt-builder、permissions、mid-stream）、`packages/pi-agent-server/*`、`packages/session-tools-core/*`
- 输出：`docs/code-research/02_mechanism_agent.md`

### 专题 C：核心机制 — Session 生命周期与传输协议
- 目标：SessionManager 是什么、为什么以 JSONL 为真理源；atomic 写入与 header；`{{SESSION_PATH}}` 便携 token；Electron IPC / WS RPC / stdio 三套 transport 如何共用同一组 method；push 通道与 codec
- 重点范围：`packages/server-core/src/sessions/SessionManager.ts`、`packages/server-core/src/transport/*`、`packages/shared/src/{sessions,protocol}/*`、`apps/electron/src/main` IPC handlers、`apps/cli/src`
- 输出：`docs/code-research/03_mechanism_session_transport.md`

### 专题 D：核心机制 — Sources / Credentials / Skills
- 目标：三类 Source（mcp/api/local）同契约如何承载；AES-256-GCM 凭证存储（PBKDF2 + v1/v2 双 key fallback、token refresh）；技能三级存储（global/workspace/project）；MCP subprocess 隔离与敏感 env 过滤
- 重点范围：`packages/shared/src/{sources,credentials,auth,skills,mcp}/*`、`packages/session-mcp-server/*`、`~/.craft-agent/` 磁盘布局
- 输出：`docs/code-research/04_mechanism_sources_credentials_skills.md`

### 专题 E：数据流与状态
- 目标：一条用户消息从 UI 到 LLM 的完整调用链；配置/凭证/会话/来源的磁盘布局分层；运行时状态机；50ms delta batching + PushTarget 路由 + 30s/500 ring buffer
- 重点范围：`packages/server-core/src/sessions/*`（runtime-config、send-message 链路）、`packages/server-core/src/transport/push.ts`、`packages/shared/src/config/*`
- 输出：`docs/code-research/05_data_flow.md`

### 专题 F：依赖与技术栈选型
- 目标：Bun / Electron / Claude SDK / Pi SDK / TipTap / Radix / MCP SDK / beautiful-mermaid 等关键依赖各自角色与替代方案；trustedDependencies 锁定原生模块的原因；WhatsApp worker 为何强制 Node
- 重点范围：`package.json`（dependencies/devDependencies/optionalDependencies/trustedDependencies）、`bun.lock`、`packages/messaging-whatsapp-worker/*`
- 输出：`docs/code-research/06_dependencies.md`

### 专题 G：核心工作流
- 目标：追踪 10+ 条端到端业务流程（OAuth 登录、golden path 发消息、连接新 Source、@mention 技能/来源、权限切换、自动化触发、远端 Server 连接、CLI run、会话分享、mid-stream 决策、大响应 summarization）
- 重点范围：横切多个包，沿上述各机制的调用链串起来
- 输出：`docs/code-research/07_workflow.md`

### 专题 H：源码阅读路径（依赖 A–G，后执行）
- 目标：从前置知识、项目目录、代码结构出发，规划推荐阅读顺序；标注入口文件、核心模块、可先跳过的目录；适配不同背景读者
- 重点范围：全仓 + `README.md`
- 输出：`docs/code-research/08_learning_path.md`

### 专题 I：系统演进历史（基于 Git，后执行）
- 目标：基于真实 git commit/diff 梳理 v0.2.30（2026-01-19 OSS 起点）→ v0.10.4 的演进路线、阶段性问题与转折；区分「Sync from internal repository」与功能提交；不靠当前代码倒推历史
- 重点范围：`git log` / `git diff` 在关键目录上的 name-status，版本里程碑（v0.5.0 Pi SDK、v0.7.0 server-core 拆分、v0.9/v0.10 远端化）
- 输出：`docs/code-research/09_evolution_history.md`

### 专题 J：实现地图（依赖 I，后执行）
- 目标：把 I 的演进阶段映射到当前模块、接口、数据结构、运行时组件、存储/状态；识别「化石层」与历史包袱
- 重点范围：`~/.craft-agent/` 地层叠加、zod 双版本、Claude SDK native binary、Pi SDK scope 迁移残留
- 输出：`docs/code-research/10_implementation_map.md`

### 专题 K：从 0 设计这套系统（第一性原理，后执行）
- 目标：忽略提交顺序，按「最小设计 → 暴露问题 → 新增设计 → 复杂度代价 → 当前代码落点」推演；北极星=文档为中心 + Agent 原生 + 跨形态复用
- 输出：`docs/code-research/11_design_evolution.md`

### 专题 L：Day 0 产品与技术方案复原（后执行）
- 目标：从源码证据反推作者开工第一天会如何定义需求来源、目标用户、MVP 边界、初始技术方案，以及后续产品压力如何迫使技术演进；标注证据等级（明确 vs 推断）。是对既有项目的反向研究，不是新 RFC
- 输出：`docs/code-research/12_day0_product_technical_design.md`

### 专题 M：代码质量地图（直接读源码，后执行）
- 目标：直接读源码，基于文件/函数/类型/配置/调用链证据，识别模块边界、复杂度来源、修改风险、测试缺口、错误处理、一致性、可简化点；模块级 Low/Med/High 风险；不打总分、不做逐行 review/漏洞扫描/perf
- 重点范围：可参考前述报告定位文件，但结论必须以源码为证（高风险≥2 处证据，中低风险≥1 处）
- 输出：`docs/code-research/13_quality_map.md`

## 执行策略

- **Phase 2 第 1 波（并行，事实型，互不依赖）**：A 架构、B Agent 内核、C Session/传输、D Sources/Credentials/Skills、E 数据流、F 依赖、G 工作流 —— 共 7 个 Explore Agent 并行。
- **Phase 2 第 2 波（并行，综合型，依赖第 1 波）**：H 学习路径、I 演进历史（git）、J 实现地图、K 第一性原理、L Day 0、M 质量地图 —— 共 6 个 Agent 并行；可交叉引用第 1 波报告。
- **Phase 3（串行汇总）**：在本文件顶部补「研究总览」—— 项目核心价值、各主题索引、设计亮点，并整合 H/I/J/K/L/M 的要点。

## 待解决疑问（各专题汇总）

> 以下为研究过程中各 Agent 记录、需进一步核实的开放问题。

1. **`{{SESSION_PATH}}` 占位符的边界**：03 报告核实其在 JSONL 持久层做行级字符串替换（`jsonl.ts:23-50`），但 02 报告发现 `prompts/system.ts` 中并不存在该字面占位符（路径以普通文本拼入 `session_state`）。两处是否矛盾，还是占位符仅用于持久化层而非 prompt 层？需对照确认。
2. **`scripts/build.ts` 缺失**：`package.json` 的 `build` 脚本指向 `scripts/build.ts`，但 06 报告在仓中未找到该文件——是 OSS 同步遗漏还是确已删除？
3. **`@github/copilot-sdk` 零源码引用**：声明为依赖但 06 报告未在源码中找到 import；Copilot 实际是否完全经 Pi SDK/oauth 走？
4. **lint 脚本疑似不存在**：`package.json` 有 `lint:ipc-sends`（`check-raw-sends.sh`）与 `lint:tool-name-checks`（`check-task-tool-checks.sh`），但 13 报告未在仓中定位到这两个脚本。若确不存在，则 RPC/工具名的类型安全网实际缺失。
5. **`SessionManager.ts` 测试网**：13 报告指出该 8090 行核心文件在 `sessions/__tests__/` 无专属测试，回归风险高——是否依赖更高层（server smoke / send-message durability）间接覆盖？覆盖度需量化。
6. **凭证 `tryDecrypt` 错误语义**：13 报告指出解密把「密钥错误」与「JSON 损坏」合并吞成 `null`，可能掩盖真实的密钥不匹配场景——是否影响排障？

## 进度

- [x] 01 架构全景
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
- [x] 12 Day 0 产品与技术方案复原
- [x] 13 代码质量地图

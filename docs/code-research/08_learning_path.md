# 学习路径

为想贡献代码或深入理解 Craft Agents 的工程师准备的循序渐进的入口指南。目标：30 分钟建立全局认知，2 小时跑通本地，1 天改完第一个功能。

---

## 这个项目在解决什么

一句话：Craft Agents 是一个 Electron 桌面 + 远程服务器双形态的「Agent 原生」工作平台，把 Claude Agent SDK 与 Pi SDK 并排跑起来，让你能用对话方式连接任意 MCP / REST API / 本地源、管理多会话、并按工作流（status / mode / automation）组织 agent 任务。

---

## 30 分钟全局认知

### 一句话回答

> 它在解决「让非 CLI 用户也能流畅、安全、可定制地用上最强 agent」这件事——多会话 inbox、可插拔源、三级权限、文档/技能中心。

### 30 分钟必读（按顺序）

| 顺序 | 文件 | 一句话能看到什么 |
|------|------|------------------|
| 1 | `README.md` | 产品定位、功能矩阵、远程服务器/CLI 用法、支持的 LLM Provider、`~/.craft-agent/` 配置目录结构。 |
| 2 | `CONTRIBUTING.md` | 仓库分层（apps / packages）、分支命名约定、`bun run typecheck:all` 的硬要求、PR 模板。 |
| 3 | `packages/shared/CLAUDE.md` | **业务侧硬规则总集**：权限三级、源三类型、Pi-only interceptor、mid-stream resolver、i18n 规约、`queryLlm` 契约。 |
| 4 | `packages/shared/src/agent/base-agent.ts` | 所有 agent backend 的抽象基类：PermissionManager / SourceManager / PromptBuilder / UsageTracker 如何被组合在一起。 |
| 5 | `packages/server-core/src/sessions/SessionManager.ts` | 会话中枢：消息发送、backend 装配、source 激活、mid-stream 分支、automations 注入，全部在此汇合。 |
| 6 | `apps/electron/src/transport/index.ts` | Electron 端的 WS RPC 客户户端/服务端胶水：主进程与 renderer / 远程 server 之间的通道入口。 |

读完这 6 个文件（约 2500 行），你应该能回答：会话怎么发消息、agent 怎么被装配、源怎么挂、权限怎么切、IPC 怎么走。

---

## 本地启动路线

### 基础环境

- [Bun](https://bun.sh/)（必需，所有脚本基于它）
- Node.js 18+（部分工具链）
- macOS / Linux / Windows

### 标准三步

```bash
git clone https://github.com/lukilabs/craft-agents-oss.git
cd craft-agents-oss
cp .env.example .env          # 至少填 ANTHROPIC_API_KEY；Slack/Microsoft OAuth 按需填
bun install
```

`bun install` 会按 `package.json` 的 `trustedDependencies`（`electron`、`@vscode/ripgrep`、`sharp`、`koffi` 等）白名单安装需要原生编译的包——这是常见的「卡住点」之一。

### 三种启动模式怎么选

| 命令 | 适用场景 | 说明 |
|------|----------|------|
| `bun run electron:dev` | **日常 UI/主进程开发** | 跑 `scripts/electron-dev.ts`，esbuild 监听主进程 + Vite 监听 renderer，热重载。 |
| `bun run electron:start` | **验证一次完整构建产物** | 先 `electron:build` 全量打包，再 `electron apps/electron` 启动，较慢但贴近发布形态。 |
| `bun run server:dev` | **开发远程 server / CLI / 集成测试** | 启动 headless 服务器，自动注入 `CRAFT_DEBUG=true`，配合 `CRAFT_BUNDLED_ASSETS_ROOT` 指向 electron 资源目录。 |

其它常用：

```bash
bun run playground:dev          # 独立打开 Vite 的 /playground.html，调试 UI 组件
bun run print:system-prompt     # 打印带标注的系统提示词，定位 prompt 注入问题
bun run fresh-start             # 清空 ~/.craft-agent 重新开始（注意会丢会话）
```

### 常见坑

1. **`.env` 缺失**：`ANTHROPIC_API_KEY` 必填；Slack/Microsoft OAuth 凭据会在 electron 主进程 build 时通过 esbuild `--define` 烧进产物（见 `apps/electron/package.json` 的 `build:main`），改了要重 build。
2. **Google OAuth 不进 build**：Google 凭据**故意不打包**，需在源 `config.json` 里写 `googleOAuthClientId/Secret`（README 有详细步骤），别在 `.env` 里找。
3. **`trustedDependencies` 安装失败**：CI 或容器里若 `electron` / `sharp` / `koffi` 装不上，确认网络能访问 Electron mirror，必要时 `bun install --ignore-scripts` 后单独排查。
4. **平台特定构建脚本**：`electron:dev` 是跨平台 TS 实现（替代了旧的 `electron:dev:mac/win/linux`），但 `electron:dist:mac/win/linux` 仍各自独立；`server:build:{linux,darwin}-{x64,arm64}` 四元组按目标平台选。
5. **Pi 子进程 preload**：dev 模式下 Pi interceptor 直接读 `.ts` 源（无需 rebuild），打包后切到 `apps/electron/dist/interceptor.cjs`；见 `CLAUDE.md` 里 `resolveInterceptorBundlePath` 一段。

---

## 关键入口文件地图

按子系统分组，遇到对应问题就直奔这里。

| 子系统 | 入口路径 | 看什么 |
|--------|----------|--------|
| **Agent 内核** | `packages/shared/src/agent/base-agent.ts` | 抽象基类，串起 Permission/Source/Prompt/Usage 子管理器 |
| | `packages/shared/src/agent/claude-agent.ts` | Claude Agent SDK 适配（默认 backend） |
| | `packages/shared/src/agent/pi-agent.ts` | Pi SDK 适配（Google / Copilot / OpenAI 等） |
| | `packages/shared/src/agent/backend/` | `AgentBackend` 接口与各 provider 实现 |
| | `packages/shared/src/agent/core/prompt-builder.ts` | volatile/stable 上下文分块策略 |
| | `packages/shared/src/agent/mode-manager.ts` | 权限模式（safe/ask/allow-all）状态机 |
| **Session / 传输** | `packages/server-core/src/sessions/SessionManager.ts` | 会话中枢：发消息、装配 backend、源激活、mid-stream |
| | `packages/server-core/src/transport/{server,client,push}.ts` | WS RPC 服务端、客户端、推送通道 |
| | `apps/electron/src/transport/{server,client,build-api}.ts` | Electron 端 RPC 桥与 channel 映射 |
| | `apps/electron/src/main/index.ts` | Electron 主进程入口（i18n 持久化、IPC 处理） |
| **Sources / Credentials** | `packages/shared/src/sources/types.ts` | `mcp` / `api` / `local` 三类源定义、`isRefreshableSource` |
| | `packages/shared/src/sources/server-builder.ts` | 把 source 装成 SDK 可用的 server（含 token getter） |
| | `packages/shared/src/sources/credential-manager.ts` | 源凭据刷新（OAuth + renew endpoint） |
| | `packages/shared/src/sources/token-refresh-manager.ts` | token 过期前主动续 |
| | `packages/shared/src/credentials/manager.ts` | AES-256-GCM 加密存储总入口 |
| **Config** | `packages/shared/src/config/storage.ts` | `~/.craft-agent/config.json` 读写、连接迁移 |
| | `packages/shared/src/config/preferences.ts` | 用户偏好（含 `uiLanguage` 持久化） |
| | `packages/shared/src/config/models.ts` / `models-pi.ts` | 模型注册表 + Pi 自定义端点能力 |
| | `packages/shared/src/config/watcher.ts` | 配置热更新广播 |
| **Pi 子进程** | `packages/pi-agent-server/src/index.ts` | Pi SDK 隔离进程，JSONL over stdio |
| | `packages/session-mcp-server/src/index.ts` | 把 session-scoped 工具暴露给 Codex 的 MCP server |
| | `packages/session-tools-core/src/index.ts` | 跨后端共享的会话工具 handlers |
| | `packages/shared/src/agent/backend/internal/runtime-resolver.ts` | interceptor bundle 路径解析（dev vs 打包） |
| **UI** | `apps/electron/src/renderer/App.tsx` / `main.tsx` | React 根 |
| | `apps/electron/src/renderer/components/chat/` | 聊天、工具可视化、多文件 diff |
| | `packages/ui/src/components/` | 跨 app 复用组件（annotations / code-viewer / markdown 等） |
| | `apps/electron/src/renderer/playground.tsx` | UI 组件独立调试入口（`playground:dev` 打开） |

---

## 调试

### 日志位置

默认写到用户目录，开发模式自动开 debug：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Logs/@craft-agent/electron/main.log` |
| Windows | `%APPDATA%\@craft-agent\electron\logs\main.log` |
| Linux | `~/.config/@craft-agent/electron/logs/main.log` |

跟日志：

```bash
bun run electron:dev:logs    # macOS 上另开 Terminal 窗口 tail 日志
```

### 关键开关

```bash
CRAFT_DEBUG=true bun run electron:dev          # 强制开启详细日志
# 打包版启动加 -- --debug（注意双短横）
/Applications/Craft\ Agents.app/Contents/MacOS/Craft\ Agents -- --debug
```

### 诊断工具

```bash
bun run print:system-prompt     # 打印系统提示词与上下文块，验证 prompt 拼装
bun run playground:dev          # 隔离渲染 UI 组件，不依赖主进程
bun run validate:dev            # 本地预跑 CI：typecheck + 共享测试 + doc-tools
```

### 测试入口

```bash
bun test                                       # 全仓默认测试
bun run test:shared:all                        # 共享包：llm-connections / models-pi / config
bun run test:doc-tools                         # 文档工具冒烟（Python unittest）
bun run lint:i18n:parity                       # i18n key 对齐
bun run lint:i18n:coverage                     # t() 调用对 en.json 的覆盖
bun run lint                                   # 全量 lint（含自定义规则）
```

自定义 ESLint 规则在 `apps/electron/eslint-rules/` 下，包括 `no-direct-navigation-state`、`no-localstorage`、`no-direct-platform-check`、`no-hardcoded-path-separator` 等——改 renderer 时会被强制约束。

---

## 第一个贡献（按难度递增）

1. **i18n 翻译补全** — 在 `packages/shared/src/i18n/locales/` 找一个缺 key 的 locale（或补全新词），按字母序维护；`bun run lint:i18n:parity` + `coverage` 双过即可。最低风险。
2. **新增一个 status / mode 显示文案** — 在 `status.*` / `mode.*` 命名域下加 key，三处 locale 同步更新；同时改对应 React 组件。
3. **新增一个 source 小工具** — 在 `packages/shared/src/sources/` 加 helper（如新的 token 解析、新的 renew endpoint 解析），覆盖 `isRefreshableSource` 与 `token-refresh-manager`，写单元测试。
4. **修一个测试** — `bun test` 红的用例，多数在 `packages/shared/src/**/__tests__/`，理解 backend 契约后改动较小。
5. **跨平台构建脚本** — 进阶：维护 `scripts/electron-dev.ts` / `scripts/build-server.ts` 的平台分支，理解 `trustedDependencies` 与原生依赖。

每一步完成后跑 `bun run validate:dev`（PR 前再 `validate:ci`）。

---

## 项目约定（硬规则摘要）

来自两个 `CLAUDE.md`，违反会被 review 直接打回：

- **权限三级固定**：`safe` / `ask` / `allow-all`，不要新增第四种。
- **源三类型固定**：`mcp` / `api` / `local`，新 provider 走 Pi 路径而非新类型。
- **Pi-only interceptor**：网络拦截器仅对 Pi 子进程生效（`--preload`），Claude SDK 现在跑原生 `claude` 二进制，没有 preload；相关功能属 Phase-2。
- **mid-stream 必须用 resolver**：判断「插入消息还是排队」一律走 `resolveMidStreamBehavior(connection)`，不要直接 `if providerType === ...`。
- **i18n 不能在 module-level 调 `t()`**：存 `labelKey` 字符串，在组件/函数内解析；key 全部字母序；新 locale 在 `src/i18n/registry.ts` 单点登记。
- **凭据必须走 `credentials/` 通路**，禁止临时存放 secret。
- **`queryLlm` 契约**：必须尊重 `request.model` / `systemPrompt`，返回的 `model` 必须是实际使用的，不可伪造。
- **`@craft-agent/core` 保持轻**：类型优先，运行时工具除非跨包必需否则不加。
- **`buildVolatileContextParts` 每轮只调一次**：缓存哈希请对产出的字符串算，别再调一次 builder。

---

## 延伸阅读

- **MCP 协议规范**：<https://modelcontextprotocol.io/>（Sources 的 mcp 类型基础）
- **Claude Agent SDK**：<https://docs.claude.com/en/api/agent-sdk/overview>
- **Pi SDK**（`@earendil-works/pi-ai` / `pi-coding-agent`）：仓库内 `packages/pi-agent-server/` 是最佳实战参考
- **Electron 多进程模型**：<https://www.electronjs.org/docs/latest/tutorial/process-model>（理解 main / preload / renderer / 子进程边界）
- **Bun Runtime**：<https://bun.sh/docs>（脚本与测试运行的基础）
- **项目内文档**：`docs/code-research/` 下其它研究报告（架构、agent 内核、session、sources 等专题）

---

## 推荐节奏

| 时长 | 目标 | 做什么 |
|------|------|--------|
| 0–30 min | 全局认知 | 读「30 分钟必读」6 个文件 |
| 30–120 min | 跑通本地 | `bun install` → `electron:dev` → 在 UI 里发一条消息、加一个 source |
| 2–8 h | 读核心 | 顺着「关键入口文件地图」读 SessionManager + base-agent + 一个 backend |
| 1 天 | 提交 PR | 从「第一个贡献」阶梯里挑一个，跑 `validate:ci` 后开 PR |

祝你玩得开心。

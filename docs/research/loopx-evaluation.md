# LoopX：local-first 长程 Agent 控制面，以及它与本机 DSH 的结合成本

## 研究范围与固定版本

- 查阅日期：2026-09-13（`date -u +%Y-%m-%d`）。
- 研究对象：开源项目 [LoopX](https://github.com/huangruiteng/loopx)（作者 huangruiteng）。
- 固定版本：本机浅克隆 `/tmp/loopx`，commit [`7eb4b7bb1661bd5eff63a8725a33169792d5964b`](https://github.com/huangruiteng/loopx/tree/7eb4b7bb1661bd5eff63a8725a33169792d5964b)（2026-09-13 15:19:19 +0800）。本报告所有 `路径:行号` 引用均指该 commit，不引用漂移的 HEAD。
- PyPI 事实（已核实，直接引用）：包名 `loopx`，最新版本 `1.0.3`，`requires_python >=3.11`，summary「A lightweight Loop Engineering control plane for long-running agent goals」，项目地址 <https://huangruiteng.github.io/loopx/>，官方文档站 <https://huangruiteng.github.io/loopx/docs/>。这些与本地 `pyproject.toml:6-10`、`:17-18` 完全一致。
- 本机 DSH 基线：`/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh`，版本 **`0.1.5-rc.2`**（调研时为 `0.1.5-rc.1`，其后升级；§4 的 DSH 侧断言在 rc.1 上核实，rc.2 只改了客户端样式与 Settings 反馈对话框，未触及本文引用的服务面）。
- 本轮问题：LoopX 是什么、架构如何、怎么装怎么运维，以及在**本机这套 DSH** 上值不值得装。
- 全程只读：**我本人**未安装任何东西，未运行 `pip install` / `npm install` / `loopx` 命令，未修改 `$HOME/.dsh`、`$HOME/.agents` 或任何仓库文件。唯一落盘产物是本文件及其所在新目录。
- **重要说明（本机状态在会话期间被改动，非我所为）**：编排方在调研期间对这台机器做了一次真实安装与重启 —— 17:13:59 `dsh plugin --profile web add <release-tgz>`，17:14:54 预热 `initializeLoopX`，**17:16:23 重启 `dsh-web.service`（新 PID 1800211）**，17:16:35 打印 Web URL。**我全程未执行任何写操作**；我只是核实了它的结果，因此 §4.2、§4.5、§4.6、§4.7、§4.11 中标注「实测」的部分都来自这次已发生的安装与重启，而非我主动做的实验。**注意该安装拉取的是 PyPI `loopx 1.0.3`，其字节是否与固定 commit `7eb4b7b` 完全一致我无法证明**；源码层结论仍以固定 commit 为准。

第一方来源约定：本地克隆用 `路径:行号`；官方 URL 用绝对链接。凡属推断一律显式标注**「推断」**。

---

## 结论（先行）

1. **LoopX 不是 agent framework，也不是 agent runtime，而是一层跨 harness 的持久状态与治理层。** 它自己把边界写在 README 第一屏：「LoopX 是开放且 Provider-neutral 的轻量 state kernel，也是 local-first 的 Loop Engineering 控制面。它运行在不同 agent harness 之上，而不是替代它们」（`README.zh-CN.md:21-24`）。

2. **它最反直觉的一点是：LoopX 已经官方支持 DSH，而且支持方式不是"你写个适配器"，而是一个成品的 Cordis 插件。** `packages/dsh-loopx-plugin/`（`dsh-loopx-plugin@0.1.1-beta.5`）自带 `cordis.patch.yml`，插入 4 个 Loader row，并把 DSH 的 Web 启动改成依赖它自己的 `loopxBootstrap` 服务。它未发布到 npm（`registry.npmjs.org/dsh-loopx-plugin` 返回 404），只以 GitHub Release tarball 分发（该 asset 实测 HTTP 200）。

3. **本机 DSH `0.1.5-rc.1` 落在该插件的 peer 范围内**（`>=0.1.0-rc.7 <0.1.1 || >=0.1.1-rc.1 <0.2.0-0`），所以「装不装得上」不是问题；真正的问题是**代价与爆炸半径**。

4. **最大的代价是 Web 启动被当成 bootstrap 边界。** 插件的 init row 在 DSH 加载它的过程中同步跑一次 `pip install --target`，只有它 settle 之后才 `provide('loopxBootstrap')`，而 `webserver` 与 `web-runtime` 两行被 patch 成 `inject: [webStartup, loopxBootstrap]`。首次启动时这会把 HTTP 服务绑定推迟到最多约 2 分钟之后；更糟的是**如果 init row 本身没能激活（例如 `commands` 服务缺席），`loopxBootstrap` 永远不会被 provide，Web 服务就永远不绑定**。

5. **LoopX 确实自带 MCP server，但它不是控制面 API。** `loopx/goal_mode_mcp.py:280` 的 `create_fastmcp_server()` 只暴露 6 个 goal-mode 工具（`should_run` / `list_todos` / `claim_task` / `review_task_vision` / `complete_task` / `host_prompt`），而且它依赖的 `mcp<2` 与 pydantic **不在运行时依赖里**（`pyproject.toml:14` 的 `dependencies = []`；`mcp==1.28.1` 只在 `test` extra 里，`pyproject.toml:29`），需要单独的专用 venv。**没有 `loopx mcp` 子命令。**

6. **落点：插件已装并已在 17:16 重启后生效，`loopxBootstrap = ready`。** 收益（LoopX 的 gate/evidence/quota/handoff 状态机）主要来自 CLI 与技能；插件额外带来的只有 GoalBar UI 和自动续跑 Driver，代价是把 DSH 的 Web 启动可用性绑到 Python/pip/网络三件事上。**本次重启走快路径 12 秒完成、无故障**，但**冷装路径（CLI 缺失/网络不可达）仍是未测的分钟级风险**，且 GoalBar 的 Client 半边**未能验证**。详见 §4.11。

---

## 1. 它是什么

### 1.1 定位

**结论：LoopX 是"跨轮次控制状态"的所有者，harness 是"有界执行"的所有者。** 两者是分工关系，不是替代关系。

第一方证据：

- 首屏副标题：「**面向长程 Agent 的开放、有状态、Provider-neutral 控制面。** 在 Codex、Claude Code、Cursor 等 agent harness 之上，持久保存目标、gate、todo、证据、quota 与交接状态。LoopX 负责跨轮次的状态与执行边界，harness 负责有界执行。」（`README.zh-CN.md:7-9`）
- 正文定位：「LoopX 是开放且 Provider-neutral 的轻量 state kernel，也是 local-first 的 Loop Engineering 控制面。它运行在不同 agent harness 之上，而不是替代它们：LoopX 提供长程状态、语义决策、治理、恢复与人机协同」（`README.zh-CN.md:21-24`）。
- PyPI summary 与之一致：`A lightweight Loop Engineering control plane for long-running agent goals`（`pyproject.toml:8`）。

### 1.2 要解决的问题

**结论：问题不是"单次会话做不完"，而是"跨轮次、跨会话、跨 agent 的控制状态无处安放"。** LoopX 自己列了四个具体失效模式：目标会变化、用户决策会出现、证据会过期、scheduler 在已经没有有效状态迁移时继续消耗。

第一方证据：

- 「一个 agent 可以在单次会话里完成任务。长程工作更难：目标会变化，用户决策会出现，证据会过期，平级 agent 会交接，scheduler 也可能在已经没有有效状态迁移时继续消耗。聊天记忆和定时器不足以治理这些问题。」（`README.zh-CN.md:78-80`）
- 它给出的状态形状是 `objective + gate + todo + scope + evidence + quota`（`README.zh-CN.md:86`），并明确「Agent runtime 负责执行，LoopX 负责治理跨运行延续的控制状态」（`README.zh-CN.md:101-102`）。
- 它自称的边界是「它不是又一个 agent framework，也不是绑定某一 Provider 的编排 runtime。」（`README.zh-CN.md:102`）

### 1.3 核心概念（LoopX 自己的术语）

**结论：LoopX 的术语体系分成两组——"Kernel/Capability/Provider/Extension"是**职责边界**，"目标/下一步/人类判断/证据/能否继续"是**用户可见的五个问题**。混用这两组会读错文档。**

第一方证据——四类职责边界（`README.zh-CN.md:342-347`）：

| 边界 | LoopX 的定义 |
| --- | --- |
| **Kernel** | 持有持久化 goal、todo、gate、evidence、quota、恢复和调度事实 |
| **Capability** | 定义稳定、provider-neutral 的合同，从 LoopX 状态交付一个有界、可验证的调用者结果 |
| **Provider** | 调用外部系统或本地实现，返回有界 observation、effect result 和 readback |
| **Extension** | 通过显式安装、readiness、启用、升级、停用和回滚生命周期交付可选 Provider |

执行力路径是 `Agent -> Capability -> Provider`，控制结果沿 `Provider readback -> Capability transition -> Kernel` 返回（`README.zh-CN.md:411-413`）。

第一方证据——控制面核心承诺（五个问题，`README.zh-CN.md:353-363`）：

| 问题 | LoopX 保持可见的状态 |
| --- | --- |
| 当前目标是什么？ | Active goal、明确 scope 和当前 authority |
| 下一步是什么？ | 有序 user / agent todo、ownership、claim 和 lease |
| 哪一步需要人判断？ | 具体 user gate，而不是模糊的「等待 owner」 |
| 证据发生了什么变化？ | 紧凑 run history、验证、blocker 和已接受 writeback |
| Loop 是否可以继续？ | Quota、capability、安全侧路、scheduler hint 和停止条件 |

第一方证据——几个被问到、但定义和我预想不同的词：

- **`control plane` / `state kernel`**：这两个词在 README 首屏就被当作同位语使用（`README.zh-CN.md:21-22`）。`docs/architecture.md:3-17` 把控制面展开成**六个持久层**：Registry / Goal state / Run log / Run history / Status-attention queue / Compute quota，并额外声明一个「可选探针面，它不是第七层」。
- **`goal` / `task`**：`goal` 是一等身份（有稳定 `goal_id`、registry 条目、active state 文件）；**`task` 不是一等概念**——LoopX 用的是 `todo`（`loopx/cli_commands/todo.py`、`register_todo_command`，`loopx/cli.py:344`）与 `task-lease`（`loopx/cli_commands/task_lease.py`）。**「推断」：`task` 在本项目里更像口语，CLI 词汇表里没给它位置。**
- **`gate`**：是一等概念但是**复合词**——`operator-gate`（`loopx/cli_commands/project_lifecycle.py:476`）、`promotion-gate`（`loopx/cli_commands/support_control.py:121`）、`global-gates`（`loopx/cli_commands/summary_all.py:108`）、`notify-gate`（`loopx/cli_commands/goal_channel.py:187`）。**没有裸 `loopx gate` 命令。**
- **`evidence`**：同样是复合词 `evidence-log`（`loopx/cli_commands/evidence_log.py:73`）；**没有裸 `loopx evidence` 命令。**
- **`quota`**：是**计算配额**，不是存储配额——「local policy for how much automatic agent compute each goal may consume」（`docs/architecture.md:14-15`），由 `loopx quota should-run` 消费（`loopx/cli_commands/quota.py:102`）。
- **`handoff`**：存在，`loopx handoff`（`loopx/cli_commands/todo_continuation.py:115`）与 `loopx handoff-mode`（`loopx/cli_commands/handoff_mode.py:69`）。语义是「跨轮/跨 agent 接力时的证据化交接」，见 `loopx review-packet --handoff-only`（`skills/loopx-project/SKILL.md:692`）。

### 1.4 它明确「不做」什么

**结论：LoopX 的边界声明相当克制且四处重复，落点是"不做自动化控制者、不做 agent runtime、不碰权限与发布"。**

第一方证据（按强度排序）：

1. 「LoopX 不是生产自动化控制器。危险权限、生产写入、公开发布和最终 ownership 仍由人类负责。」（`README.zh-CN.md:125-127`）
2. 「LoopX 不是完整 agent platform，不是 agent runtime，也不是自治生产控制器。」（`README.zh-CN.md:661-662`）
3. 「LoopX 不会自行获得 credential，不会替用户批准 destructive / production action，不会在未授权时公开发布，也不会把未经验证的 run 当成成功证据。」（`README.zh-CN.md:670-672`）
4. 「它不是又一个 agent framework，也不是绑定某一 Provider 的编排 runtime。」（`README.zh-CN.md:102`）
5. 「The core repository intentionally avoids domain logic.（核心仓库刻意不含领域逻辑。）」（`docs/architecture.md:33`）——域名、数据实验、笔记维护、harness 自改进应当共用同一 runtime，但用不同 adapter。
6. `workflow-skills --install` 的能力边界：「it does not change project state or grant repository, network, or merge authority」（`docs/guides/installing-loopx.md:56-58`）。

---

## 2. 架构

### 2.1 仓库结构与运行时的关系

**结论：仓库里有两套运行时——Python CLI（`loopx/`）与一个被 Python 按需拉起的 TypeScript "Effect core" 子进程。但"TypeScript 在 `packages/`"这个直觉是错的**：Effect core 的 `.ts` 全部在 `loopx/control_plane/` 里面，`packages/` 放的是**独立可分发的邻接发行物**。

第一方证据：

- Python 包入口：`pyproject.toml:40-45` 声明 5 个 console script，主入口是 `loopx = "loopx.entrypoint:main"`，另有 `loopx-kunluncode` / `loopx-lark-provider` / `loopx-openviking-history-export` / `loopx-openviking-semantic-preference`。
- TypeScript 的实际位置：`loopx/` 下有 **119 个 `.ts` 文件**；`pyproject.toml:52-60` 明确要把 `loopx.control_plane` 各子包的 `*.ts`/`*.json` 一起打包。Effect core 的服务端是 `loopx/control_plane/effect_runtime_server.ts`（该文件直接用 `node:net` 的 `createServer`，`effect_runtime_server.ts:1`）。
- `packages/` 的真实定位：「This directory contains independently installable distributions developed next to LoopX. Each child owns its packaging metadata, dependencies, and release lifecycle; it is not included in the LoopX wheel merely because it is tracked in this repository.」（`packages/README.md:3-6`）。当前含 6 个：`dsh-loopx-plugin`、`loopx-codex-provider-routing`、`loopx-community-discussion`、`loopx-finance-value-discovery`、`loopx-obelisk`、`loopx-repo-health`。
- `apps/`：`apps/desktop/loopx-control-plane`（桌面壳）与 `apps/presentation/{dashboard,site}`（呈现层）。呈现层在 README 里被明确定性为**只读**：「Operator surface 呈现紧凑状态，但不让浏览器成为状态事实源」（`README.zh-CN.md:373`）。

**推断**：README 的产品叙事里「TypeScript 迁移」是真实存在的架构事实（`docs/architecture/typescript-migration-compatibility-notes.md` 即是为此而写），但迁移目标是 `loopx/control_plane/` 内部的 Effect Program，而不是把代码搬到顶层 `packages/`。

### 2.2 状态存到哪里（local-first 的具体落盘）

**结论：默认是"项目内 JSON/Markdown + 用户家目录共享 runtime root"的两级结构，格式是文件而非数据库。SQLite 存在但是 opt-in 实验通道，不是默认。**

第一方证据——路径常量集中在 `loopx/paths.py`：

| 常量 | 值 | 证据 |
| --- | --- | --- |
| `DEFAULT_RUNTIME_ROOT` | `~/.codex/loopx` | `loopx/paths.py:7` |
| `DEFAULT_PROJECT_REGISTRY` | `<project>/.loopx/registry.json` | `loopx/paths.py:8` |
| `GLOBAL_REGISTRY_FILENAME` | `registry.global.json`（位于 runtime root 下） | `loopx/paths.py:9`、`loopx/paths.py:25-26` |

- **注意：全局 runtime root 是 `~/.codex/loopx`，不是 `~/.loopx`。** 这是最容易猜错的一点。项目级 registry 才是 `.loopx/`（`loopx/paths.py:32-33` 的注释也明确 "Project registries conventionally live at `<project>/.loopx/registry.json`"）。
- 环境变量覆盖：`LOOPX_REGISTRY` 覆盖项目 registry 路径（`loopx/paths.py:19-22`）；`LOOPX_RUNTIME_ROOT` 覆盖 runtime root（`loopx/project_alias.py:67`）。
- registry 内也可以反向指定 runtime root：`common_runtime_root` 字段，相对路径按 registry 所在项目根解析（`loopx/paths.py:47-58`）。
- 项目内第二份状态是 goal 的 active state 文件：`.codex/goals/<goal-id>/ACTIVE_GOAL_STATE.md`（`skills/loopx-project/SKILL.md:747-749`），并且「Do not reuse one `state_file` for two goal ids」（`skills/loopx-project/SKILL.md:744-746`）。
- 文档还建议把这两处加进 `.gitignore`：「If the goal state or registry contains private evidence, add `.loopx/` and `.codex/goals/` to that project's `.gitignore`」（`skills/loopx-project/SKILL.md:753-755`）。README 也把「本地 runtime state 被 ignore，而不是提交」列为实践（`README.zh-CN.md:327`）。
- **SQLite 是 opt-in 的**：「SQLite is an **opt-in local conformance candidate**, behind the existing TypeScript `AuthorityStore` interface. File remains the default.」（`docs/reference/sqlite-authority-store.md:3-5`）。启用后每个 goal 一个库，落在 runtime 的 `authority/sqlite-v0` 目录下（同文件「Placement and persistence」段）。该文档还自陈两条硬限制：历史 receipts 与完整 projection **不裁剪**，所以「Fixed live state therefore produces linear database growth, not bounded total disk use」；以及不支持自动迁移、身份轮换、损坏修复或网络文件系统共享。

**运行时的第三个进程**：LoopX 的 Effect Program core 跑在一个托管的、会 idle 退出的 Node 侧车进程里。

- 「LoopX's Effect Program core runs in a managed, idle-exiting TypeScript runtime and requires Node.js 22.18.0 or later; Node.js 24 LTS is the recommended primary runtime. LoopX starts and reuses that local runtime automatically; users do not run a daemon manually. The runtime binds only to loopback, authenticates requests with a user-private token, rotates when the packaged Effect core changes, and exits after an idle period.」（`docs/guides/installing-loopx.md:30-35`）
- 代码侧的握手结构：运行时把 `host` / `port` / `token` / `pid` / `fingerprint` 写进一个 info 文件，Python 侧读回来，逐项校验 `payload.get("host") != "127.0.0.1"` 就拒绝（`loopx/control_plane/effect_runtime.py:296-303`）。请求体带 `token`，走 `socket.create_connection`（`loopx/control_plane/effect_runtime.py:325-337`）。
- 默认 idle 退出 5 分钟（`loopx/control_plane/effect_runtime_server.ts:21` `DEFAULT_IDLE_MS = 5 * 60 * 1_000`）。

**本机核对**：`node -v` = `v24.14.1`，满足 `>=22.18.0`。

### 2.3 `loopx` CLI 的主要子命令

**结论：CLI 面非常大（`loopx/cli.py:240-354` 里串联了 80 余个 `register_*` 注册函数），但被本次调研点名的若干命令并不存在。先看"不存在"清单，能省掉一轮试错。**

第一方证据——**不存在的顶层命令**（对 `/tmp/loopx/loopx` 下全部 `add_parser` 站点做 AST 抽取，并回溯 `loopx/cli.py:240-354` 的顶层注册）：

| 被点名的命令 | 实情 | 证据 |
| --- | --- | --- |
| `loopx init` | 不存在。`init` 只作为 `loopx extension init` 存在 | `loopx/cli_commands/extension.py:99` |
| `loopx watch` | 全仓不存在。"watch" 只作为严重度字符串出现 | `loopx/control_plane/work_items/attention_routing.py:141` |
| `loopx run` | 顶层不存在。只有 `loopx canary run`、`loopx extension run`、`loopx turn run-once` | `cli_commands/canary.py:377`、`cli_commands/extension.py:152`、`cli_commands/turn_registration.py:64` |
| `loopx task` | 不存在。最近的是 `loopx task-lease` | `loopx/cli_commands/task_lease.py:74` |
| `loopx gate` | 不存在。只有 `operator-gate` / `promotion-gate` / `global-gates` / `notify-gate` | `cli_commands/project_lifecycle.py:476` 等 |
| `loopx evidence` | 不存在。是 `loopx evidence-log` | `loopx/cli_commands/evidence_log.py:73` |
| `loopx mcp` | 不存在（见 §4.6） | — |

第一方证据——**存在且关键的顶层命令**：

| 命令 | 作用 | 证据 |
| --- | --- | --- |
| `workflow-skills` | 检查/安装/卸载随包分发的 workflow 技能 | `loopx/cli_commands/workflow_skills.py:24-53` |
| `doctor` | 安装与运行时体检；`--deep` 会启动托管运行时并跑 Effect 语义 | `loopx/cli_commands/doctor.py:21`；`docs/guides/installing-loopx.md:53-55` |
| `status` | 首屏状态 | `loopx/cli_commands/status_registration.py:33` |
| `quota should-run` | 是否允许再花一次自动计算 | `loopx/cli_commands/quota.py:102` |
| `turn run-once`/`plan`/`inspect-journal` | 一次受治理 Turn | `loopx/cli_commands/turn_registration.py:18,40,64` |
| `start-goal --guided` | 引导式起 goal（技能里的主入口） | `skills/loopx-project/SKILL.md:67` |
| `resolve-agent-thread` | host session ↔ goal/agent 绑定解析（DSH 插件强依赖） | `loopx/cli_commands/registry_admin_thread_resolution.py:19,48` |
| `dashboard` | 起本地 dashboard 服务 | `loopx/cli_commands/support_control.py:394` |
| `dash` | 起会话 dash 服务 | `loopx/cli_commands/dash.py:87,103` |
| `handoff` / `handoff-mode` | 证据化交接 | `cli_commands/todo_continuation.py:115`、`cli_commands/handoff_mode.py:69` |
| `task-lease` | 任务租约 | `loopx/cli_commands/task_lease.py:74` |
| `connect` / `refresh-state` / `sync-global` | 项目接入与状态刷新 | `skills/loopx-project/SKILL.md:724,822,998` |

`skills/loopx-project/SKILL.md`（1080 行）是 CLI 实际用法的第一方手册，可直接看它的调用序列：起 goal 用 `loopx start-goal --guided --project . --goal-text "<GOAL_TEXT>"`（`:67`）；花自动计算前先问 `loopx --format json --registry "$HOME/.codex/loopx/registry.global.json" quota should-run --goal-id <STABLE_GOAL_ID>`（`:319`）；多 agent goal 再加 `--agent-id`（`:325`）；日志/状态用 `loopx doctor` / `loopx status` / `loopx diagnose`（`:237,286,979`）；评审包用 `loopx review-packet --goal-id <STABLE_GOAL_ID>`（`:678`）。

### 2.4 它如何驱动不同 harness

**结论：LoopX 对 harness 的接入是**三条互不相同的通道**，不是一套统一协议：技能文件（skill）、hook、以及 CLI 子进程适配器。DSH 走的是"技能 + 官方 Cordis 插件"这条最新的一条。**

第一方证据：

- **技能文件通道**：`loopx workflow-skills --install` 把随 wheel 分发的技能复制进宿主的技能根（`loopx/workflow_skill_install.py:256`；`pyproject.toml:73-125` 用 `[tool.setuptools.data-files]` 把 8 个技能装到 `share/loopx/skills/...`）。默认目标是 Codex 的技能目录：`CODEX_HOME/skills`，否则 `~/.codex/skills`（`loopx/workflow_skill_install.py:151-156`）。
- **hook 通道（Claude Code）**：`loopx/claude_goal_mode/scripts/install.py:60-66` 直接往 Claude Code 的 `settings.json` 写 `hooks.PreToolUse`（指向 `hooks/goal_policy.py`）与 `statusLine`（指向 `statusline/goal_status.py`）。
- **CLI 子进程通道（generic host adapter）**：`loopx/dsh_goal_mode/` 是 headless 适配器，读 stdin 上一个 `loopx_turn_host_request_v0` JSON，往 stdout 写一个 `loopx_turn_result_v0`（`loopx/dsh_goal_mode/README.md:19-24`）。
- **DSH 的两条独立路径**：`loopx/dsh_goal_mode/README.md:8-11` 明确 `deepseek-harness`（别名 `dsh`）是 **external loop driver**；而 `docs/plans/2026-08-20-dsh-native-skill-driver.md:40-47` 定义了新的 **`deepseek-harness-native`**（别名 `dsh-native`），并明确要求「The new integration must not repurpose the existing `dsh` alias.」
- **Cursor**：走 MCP 注册（`loopx/slash_command_install.py:1076` 的 `"mechanism": "cursor_mcp_server"`）。

---

## 3. 安装与运维

本节区分**文档声明**与**源码核实**。

### 3.1 官方安装路径

**结论：PyPI 是默认通道，且 LoopX 声明了"单一安装 owner"原则。**

文档声明（`docs/guides/installing-loopx.md:3-25`）：

```bash
python3 -m pip install --upgrade loopx
loopx workflow-skills --install
loopx doctor
```

同文档给出四种 owner 及升级方式：普通发布用 pip（`loopx update apply`）、外部托管环境用 `pipx`、贡献者用 git checkout + `scripts/install-local.sh`、无克隆恢复用 archive snapshot。

源码核实：

- `[project.scripts]` 确认 `loopx` 指向 `loopx.entrypoint:main`（`pyproject.toml:40-41`）。
- **`requires_python >=3.11`**（`pyproject.toml:10`）。**本机 `python3 -V` = `Python 3.11.2`，刚好满足。**
- **运行时依赖为空**：`dependencies = []`（`pyproject.toml:14`）。也就是说 `pip install loopx` 不会顺带装 `mcp`、`pydantic`、`pyyaml` 等。唯一的 optional group 是 `deepseek-harness = ["deepseek-harness-sdk==0.1.2a3"]`（`pyproject.toml:23-26`）与 `test`（`pyproject.toml:27-38`）。

### 3.2 `loopx workflow-skills --install` 会装到哪里

**结论：默认装到 **Codex** 的技能根，不是 DSH 的；要用在 DSH 上必须显式传 `--skills-dir`。**

源码核实：

- 默认目录 = `CODEX_HOME/skills`，否则 `~/.codex/skills`（`loopx/workflow_skill_install.py:151-156`）。
- 参数面（`loopx/cli_commands/workflow_skills.py:24-53`）：`--install` / `--uninstall`（互斥组）、`--skills-dir`、`--cli-bin`（默认 `loopx`）、`--host-surface`（**choices 恰好两个**：`ark-managed-agent`、`deepseek-harness-native`）、`--dry-run`。
- `--host-surface deepseek-harness-native` 会生成一个**托管的 `$loopx` 入口技能**（`loopx/cli_commands/workflow_skills.py:29-30`；实现在 `loopx/slash_command_install.py` 的 `materialize_loopx_entry_skill`，被 `loopx/workflow_skill_install.py:29,312,364` 调用）。
- 8 个技能随 wheel 分发：`loopx-benchmark`、`loopx-change-quality`、`loopx-doc-registry`、`loopx-material`、`loopx-pr-program`、`loopx-pr-review`、`loopx-project`、`loopx-self-repair`（`ls skills/`；分发清单见 `pyproject.toml:73-125`）。
- 安装是幂等的：内容哈希相同即返回 `unchanged`，否则 `created` / `updated`（`loopx/workflow_skill_install.py:168-196`）。

**与 DSH 技能根的对应关系（源码核实）**：DSH 的 `@deepseek-ai/dsh-skill-filesystem` 默认扫描 6 个根，其中 rank 500 `user-agents` 就是 `<agentsHome>/skills`，而 `agentsHome = $DSH_AGENTS_HOME ?? ~/.agents`（`node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:78` 与 `:177-179`；README 的 Roots 表 `README.md:46-53`）。所以 `--skills-dir ~/.agents/skills` 恰好落在 DSH 的默认技能根上。

### 3.3 Node 依赖、后台进程与端口

**结论：LoopX 是 Python + Node 双运行时。Node 不是可选项——Effect core 就是 TS。它会按需拉起一个 loopback、token 认证、idle 退出的侧车；此外 `dashboard` / `dash` / `serve-status` 各自是显式启动的本地 HTTP 服务，默认端口 8765 / 8767。**

源码核实——默认端口：

| 服务 | 默认监听 | 证据 |
| --- | --- | --- |
| `loopx dash` | `127.0.0.1:8767`，刷新 10s，只读路由 `/`、`/panel`、`/status.json`、`/healthz` | `loopx/dash_server.py:34,40-42` 与 `:185-203` |
| `loopx serve-status` | `8765` | `loopx/status_server.py:39` |
| `loopx dashboard` / `chat` | `8767` | `loopx/chat_server.py:89` |

`loopx/dash_server.py:1-8` 的模块 docstring 明确它是「read-only: it renders public-safe projections and exposes no write controls」。

文档声明——托管 Effect runtime 的网络面：「binds only to loopback, authenticates requests with a user-private token ... and exits after an idle period」（`docs/guides/installing-loopx.md:33-35`）。源码核实其断言方式：info 文件里 `host` 不是 `127.0.0.1` 就直接判为不可用（`loopx/control_plane/effect_runtime.py:296-303`），请求必须带 `token`（`:325-337`）。

**本机核对**：本次核对的那一刻这些服务都**没有在跑**（`loopx` 不在 PATH 上，也没有相关监听进程），因为它们属于"安装后会引入的"而不是"当时存在的"。**注意**：编排方随后确实在本机完成了一次真实安装并重启（见上文第 12 行与 §4.11），所以本句只描述核对时点，不表示 LoopX 从未安装。

### 3.4 升级与卸载

**结论：升级通道是 `loopx update apply`；卸载的核心风险是**状态目录不会被清理**——`.loopx/` 与 `~/.codex/loopx` 会留在原地。**

文档声明与源码核实：

- 升级：`loopx update apply`（`docs/guides/installing-loopx.md:14`）；维护者路径是 `loopx update --execute --ref main`（`skills/loopx-project/SKILL.md:336`）。
- 自更新/卸载相关模块存在：`loopx/self_update.py`、`loopx/self_update_download.py`、`loopx/upgrade.py`、`loopx/project_uninstall.py`、`loopx/python_install_owner.py`。
- 归档而非删除：`loopx archive-runtime --goal-id <GOAL_ID>`（`skills/loopx-project/SKILL.md:1006`）；`loopx/runtime.py:29-48` 的 `archive_runtime_goal` 会挑一个不冲突的 `archive_root/<goal-id>-<timestamp>[-N]` 路径。
- **没有任何文档承诺卸载会清理 `~/.codex/loopx` 或项目 `.loopx/`。** 项目侧的正确做法被写成"把 `.loopx/` 与 `.codex/goals/` 加进 `.gitignore`"（`skills/loopx-project/SKILL.md:753-755`），也就是说这些目录本就预期长期留在磁盘上。

---

## 4. 它与 DSH 结合

本节回答"在这套 DSH 上装 LoopX 官方插件值不值得"，并把原本被点名的四条通道（技能根 / `tool-bash` / `mcp-client` / `webhook`+`schedule`）降为逐条核实结论。

### 4.0 结论先行

**LoopX 已经有官方的 DSH 集成，而且是 Cordis 插件——所以问题不是"能不能接"，而是"接哪一层"。**

- 想拿 LoopX 的**状态机与治理语义**：只需要 CLI + 技能，走 `tool-bash`。
- 想拿**自动续跑 + UI 进度条**：需要官方插件，代价是把 DSH 的 Web 启动绑到 Python/pip/网络。
- 想要**与 DSH 自带 goal 体系并存**：可以，但两者是两套并行的权威，需要明确谁管哪个 goal。**「推断」**：混合使用会让"这个 goal 归谁管"变成需要人来记住的隐式约定。

### 4.1 官方插件本体

**结论：`packages/dsh-loopx-plugin/` 是一个完整的、可分发的 DSH 插件，声明 `dsh.bundle` 与 `dsh.client` 两面。它不在 npm 上，只以 GitHub Release tarball 分发。**

第一方证据：

- 包元数据：`name = dsh-loopx-plugin`，`version = 0.1.1-beta.5`，`engines.node = ^22.19.0 || >=24.0.0`，`license = Apache-2.0`（`packages/dsh-loopx-plugin/package.json`）。
- 双面声明：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": [...6 个 client 包...], "platform": "web" } }`（同文件）。
- peer 范围：`@deepseek-ai/dsh` 为 `>=0.1.0-rc.7 <0.1.1 || >=0.1.1-rc.1 <0.2.0-0`（同文件）。
- **本机 DSH `0.1.5-rc.1` 满足该范围**（`0.1.5 > 0.1.1-rc.1` 且 `0.1.5 < 0.2.0-0`）。
- 分发通道实测：`https://registry.npmjs.org/dsh-loopx-plugin` → **HTTP 404**；官方 Release asset `https://github.com/huangruiteng/loopx/releases/download/dsh-loopx-plugin-v0.1.1-beta.5/dsh-loopx-plugin-0.1.1-beta.5.tgz` → **HTTP 200**。安装命令见 `packages/dsh-loopx-plugin/README.md:54-57`。

### 4.2 `dsh plugin --profile web add <tgz>` 会不会自动挂载

**结论：会自动挂载。** 这一点值得单独确认，因为如果不会，装了也没生效。

源码核实：`dsh plugin` 是一条 **pnpm 转发 + 安装态对账**管线（`node_modules/@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:7-17`）：

1. 转发 pnpm 到 profile 目录（`plugin-Ddi42qoW.js:109-113`）；
2. pnpm 成功（exit 0）后调用 `reconcilePlugins(before, dir)`（`:122`）；
3. `reconcilePlugins` 遍历 profile manifest 的 `dependencies`，对每个包调 `exportsPatch()` —— 即检查该包清单里 `dsh.bundle.patch !== undefined`（`:25-33`）；是 bundle 且不在 `bundles` 数组里就 push 进去并回写清单（`:52-59`、`:69-78`）。

而 `dsh-loopx-plugin` 的 `package.json` 恰好声明了 `dsh.bundle.patch`，所以它会被自动追加到 `/root/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组。

**实测确认（会话内那次安装）**：安装后 `/root/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` **从 14 项变成 15 项，`dsh-loopx-plugin` 被追加在末位**；`dependencies` 里对应条目是 GitHub Release tarball URL。安装后的包确实带 `cordis.patch.yml`，且 `dsh.bundle.patch = "./cordis.patch.yml"`、`dsh.client.platform = "web"`。**这与 `plugin-Ddi42qoW.js:52-56` 描述的"按依赖顺序 append"完全一致 —— 本节从推断升级为已验证。**

**如果这一步被漏掉会怎样**：包会被安装成"普通依赖"并收到警告 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`（`plugin-Ddi42qoW.js:57`），而它的 `cordis.patch.yml` 完全不会进入 layer stack —— 表现为"装完了但 DSH 里什么都没有"。

**layer 顺序**：「each bundle in package.json's `dsh.profile.bundles` order, then `cordis.patch.yml`, then any `--patch` overlays」（`node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:125`）。所以 LoopX 的 patch 会被本机 profile 自己的 `cordis.patch.yml` 覆盖在后面 —— 所幸本机那份 patch 没有触碰 `webserver` 的 `inject`（只改了 `webserver-auth` 的 config），所以不冲突。

### 4.3 四个 Loader row 各自做什么、在哪一层

**结论：四个 row 全部是 **host 平面**。这不是偏好问题，是被 `loopxBootstrap` 这个服务强制的——`webserver`（host row）注入它，所以提供它的行必须在 host 解析得到。**

`cordis.patch.yml` 插入的四行（`packages/dsh-loopx-plugin/cordis.patch.yml:3-16`）：

| row id | 模块 | `inject` | 提供 | 平面 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `loopx-goalbar` | `dsh-loopx-plugin`（包根） | `['agents','connection','loopxBootstrap']` | 无具名服务；注册进 `ctx.connection` | Host | `src/index.ts:10-27` |
| `loopx-init-command` | `dsh-loopx-plugin/init-command` | `['commands']` | **`loopxBootstrap`** | Host | `src/init-command.ts:25-26`、`:631` |
| `loopx-driver` | `dsh-loopx-plugin/driver` | `['agents','loopxBootstrap']` | 无 | Host | `src/driver.ts:22-23` |
| `loopx-shadow-observer` | `dsh-loopx-plugin/observer` | `[]` | 注册 `dsh-session-events` provider | Host（默认关闭） | `src/observer.ts:20-21` |

判定 hook：本机 preset 自己的注释给出了平面判据——「a host row that injects a service is the criterion for host-plane ownership — injection resolves before any session exists, so there is no agent to key by」（`/root/.dsh/.agent-presets/yiln/agent.cordis.yml`，shell-env 段）。`webserver` 注入 `loopxBootstrap`，因此该服务必须在 host 平面解析。

另外，Driver 对**全部** agent 生效，而不只是某个 preset 的会话：它在 `apply()` 里遍历 `ctx.agents.list()` 并对每个 agent 调 `observeAgent`（`src/driver.ts:1245`），并订阅 host 级事件 `agent/created`、`agent/session-start`、`agent/status`、`agent/inbox/*`、`agent/pre-step`、`session/event`（`src/driver.ts:1216-1240`）。

**它与本机 DSH UI 的 slot 关系（源码核实，吻合官方 README 的说法）**：GoalBar 注册在 `conversation.input.dock`，`id: 'loopx-goal'`，`order: 15`（`src/client/index.tsx:48-51`）。本机原生 dock 行的 order 是：`todo` = 0（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:16455-16458`）、`goal` = 10（`@deepseek-ai/dsh-client-ui-goal/lib/client.js:549-552`）、`queue` = 20（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:14369-14372`）。所以 15 确实把 LoopX GoalBar 夹在原生 Goal 与 Queue 之间，与 README 的「between DSH's native GoalBar and Queue dock rows」一致（`packages/dsh-loopx-plugin/README.md:15-16`）。

### 4.4 `loopxBootstrap` 门禁的失败模式（爆炸半径）

**结论：设计上"降级不阻断"，但这个保证有一个硬前提——init row 必须真的被执行到 `provide` 那一行。这是本次评估里最大的单点风险。**

源码核实——设计上确实降级：

```ts
// src/init-command.ts:617-632
export async function apply(ctx, options = {}) {
  registerLoopXInitCommand(ctx, options)
  let status: LoopXBootstrapStatus
  try {
    await initializeLoopX(options)
    status = Object.freeze({ state: 'ready' })
  } catch (error) {
    status = bootstrapFailureStatus(error)
    try { ctx.logger.warn(automaticFailure(error)) } catch { /* ... */ }
  }
  ctx.reflect.provide('loopxBootstrap', status)   // ← 成功与失败都 provide
}
```

- 失败被降级成 `{ state: 'failed', stage, causeKind }`，且注释明确「Diagnostics must never turn an isolated LoopX bootstrap failure into a DSH startup failure」（`src/init-command.ts:626-629`）。
- `cordis.patch.yml:20-28` 把 `webserver` 与 `web-runtime` 的 `inject` 改成 `[webStartup, loopxBootstrap]`，目标是「The browser must not advertise readiness while first-run skill bootstrap is still in flight.」

**但硬前提是**：`apply` 必须先跑起来。而该 row 声明 `inject = ['commands']`（`src/init-command.ts:26`）。**「推断」**：如果 `commands` 服务因任何原因缺席，该 row 停在 pending，`provide` 永不执行，`webserver` 与 `web-runtime` 都等不到注入 —— **DSH 的 Web 服务不会绑定**。这与"LoopX 装失败"不同：装失败是被捕获的降级路径；row 没能激活是未被捕获的阻断路径。

**没有全局超时，也没有绕过开关。** 只有逐个子进程的超时：Python 版本探测 5s、`pip --version` 5s、`pip install` **120s**、launcher 写入 5s、技能安装 60s（`src/init-command.ts:213,223,270,290,362`）。首次启动且需要真正安装 LoopX 时，这些累加起来会把 Web URL 的打印推迟到分钟级——因为「the printed URL is a real bootstrap boundary」（`packages/dsh-loopx-plugin/README.md:66-70`）。

`/loopx-init` 是显式修复入口，但它**不能修复 row 没被激活这件事**（row 不存在就没有命令）。

### 4.5 自动 `pip install --target` 的实际行为

**结论：它把 LoopX 装进用户家目录下的**私有 target**，绝不碰系统 Python；但它在**每次 DSH 启动**都会跑一遍探测，并且"禁用"只能靠不装插件。**

源码核实：

- 触发时机：init row 的 `apply()` 在**每次** DSH 加载该 row 时都调 `initializeLoopX()`（`src/init-command.ts:617-621`）。但真正 install 是有条件的：先 `resolvePluginLoopXCommand()`，再 `compatible()` 探测（跑 `workflow-skills --format json` 且校验 `schema_version === "loopx_workflow_skill_install_v0"` 且 `host_surface` 匹配），只有不可用才 install（`src/init-command.ts:315-350`）。**已兼容的 CLI 会被保留而不是升级。**
- 安装命令（`src/init-command.ts:256-273`）：`<python> -m pip install --disable-pip-version-check --no-input --upgrade --target <runtimeDir>/site-packages 'loopx>=0.5.4'`。**固定 argv，不经 shell。**
- 目标路径（`src/managed-runtime.ts:41-52`）：`pluginAgentsHome()` = `$DSH_AGENTS_HOME` 或 `~/.agents`；`pluginRuntimeDir()` = `<agentsHome>/runtime/dsh-loopx-plugin`。**本机即 `/root/.agents/runtime/dsh-loopx-plugin`。**
- 本地会多一个 launcher：`loopx_cli.py`（`src/managed-runtime.ts:7`），内容是 `sys.path.insert(0, site-packages)` 后 `runpy.run_module("loopx.cli")`（`src/init-command.ts:37-44`）。
- Python 选择：显式 `PYTHON_BIN` 优先；否则依次探测 `python3`、`python3.14`、`python3.13`、`python3.12`、`python3.11`，要求 `>=3.11` 且 `pip` 可用（`src/managed-runtime.ts:10-16`；`src/init-command.ts:201-240`）。
- 不碰系统环境：README 明确「never mutates the system Python environment ... does not use `--break-system-packages`」（`packages/dsh-loopx-plugin/README.md:45-48`）；文档同款表述见 `docs/plans/2026-08-20-dsh-native-skill-driver.md:74-81`。
- **失败如何呈现**：分成 `stage`（`probe` / `install_cli` / `install_skills` / `readback`）与 `causeKind`（`src/init-command.ts:63-64`），只记安全字段；`automaticFailure()` 只输出 stage/kind 并附 `/loopx-init remains available for repair`（`:578-590`）。**不暴露子进程原始输出或本地绝对路径。**
- **Python 或网络缺失时的降级**：Python 不可用 → `install_cli` 阶段失败、`causeKind = 'missing'`（`:233-239`）；网络导致 pip 卡住 → 120s 超时后 `install_cli` 失败、`causeKind` 为 transport 类（`:274-278`）。两种情况都走 `provide('failed')` 降级路径。
- **能否禁用**：**没有插件级开关。** 唯一的"禁用"是不装插件，或让已安装的 CLI 保持兼容从而跳过 install。
- **卸载是否清理**：README 给了显式三步，并且强调移除插件**不会**清理 LoopX 状态（`packages/dsh-loopx-plugin/README.md:328-352`）：

```bash
dsh plugin --profile web remove dsh-loopx-plugin
loopx workflow-skills --uninstall --skills-dir "${DSH_AGENTS_HOME:-$HOME/.agents}/skills"
DSH_LOOPX_RUNTIME="${DSH_AGENTS_HOME:-$HOME/.agents}/runtime/dsh-loopx-plugin"
test -f "$DSH_LOOPX_RUNTIME/loopx_cli.py" && rm -rf -- "$DSH_LOOPX_RUNTIME"
```

- **它并不把 `loopx` 放进 shell 的 PATH。** Driver / GoalBar 通过 `resolvePluginLoopXCommand()` 解析那个托管 launcher（`src/index.ts:8,23`；`src/managed-runtime.ts:55-73`）。**实测确认**：安装完成后 `command -v loopx` 仍为空。这是一个**有意设计**而非缺陷，理由见 §4.5「实测」小节。

**实测（来自会话内那次已发生的安装，2026-09-13 17:14）**，逐项与源码预测吻合：

| 预测（源码） | 实测结果 |
| --- | --- |
| 落到 `<agentsHome>/runtime/dsh-loopx-plugin`（`src/managed-runtime.ts:47-51`） | `/root/.agents/runtime/dsh-loopx-plugin/` ✓ |
| 含 `site-packages` 与 `loopx_cli.py`（`src/managed-runtime.ts:7-8`） | 二者均存在 ✓ |
| launcher 内容为 `sys.path.insert` + `runpy.run_module("loopx.cli")`（`src/init-command.ts:37-44`） | 与源码字符串逐行一致 ✓ |
| 装的是 `loopx>=0.5.4` 的当前版本（`src/init-command.ts:36`） | 装到 `loopx-1.0.3.dist-info` ✓（与 PyPI 最新一致） |
| 不污染系统 Python | 全部落在上述私有目录，`python3` 侧无变化 ✓ |

### 4.6 技能根：`~/.agents/skills/` 能不能用

**结论：能用，而且 LoopX 的 8 个技能**全部通过 DSH 的 frontmatter 校验**（只用了 `name` + `description` 两个字段）。唯一实测到的瑕疵是一个 description 超过 DSH catalog 的 500 字符上限，会被截断 6 个字符。**

源码核实——DSH 侧：

- 根：`<agentsHome>/skills`，`agentsHome = $DSH_AGENTS_HOME ?? ~/.agents`，rank 500（`node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:78`、`:177-179`；README Roots 表 `README.md:46-53`）。
- 识别形态：目录包 `<name>/SKILL.md`；**嵌套 `**/SKILL.md` 不发现**（README「Skill format」段）。
- frontmatter 白名单（解析入口 `parseSkillFile`，`lib/index.js:664-704`）：**必填** `name`、`description`；**选填** `whenToUse`（`:699`）、`metadata`（`:701`）、`disable-model-invocation`（`:845`）、`user-invocable`（`:846`）。
- **`allowed-tools`、`license`、`version` 都不是被识别的字段**——全量 grep 三个 skill 包零命中。写了会被静默忽略（**「推断」**：代码里没有 unknown-key 白名单校验，所以是"忽略"而不是"报错"）。
- **旧 camelCase 名会被显式拒绝**：`disableModelInvocation`、`modelInvocable`、`userInvocable` 三个键会 throw `frontmatter field "..." is unsupported; use "..."`，并导致整个技能被丢弃（`lib/index.js:842-844` 与 `:852-854`）。
- 校验失败的表现是 **warn + 跳过该技能**，模型侧收不到 per-skill 诊断（`lib/index.js:672,676,682,686,693`）。也就是说，如果你写错了字段名，现象会是"技能凭空消失"，而不是报错。
- 技能名必须匹配 kebab-case：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`node_modules/@deepseek-ai/dsh-skill/lib/index.js:17,29-31`）。
- 暴露方式是**目录 + 工具两者都有**：`<available_skills>` 块注入（`@deepseek-ai/dsh-tool-skill/lib/index.js:246-251`）以及 `skill` 工具（`:60`、`:167`）。

源码核实——LoopX 侧（对 8 个 `skills/*/SKILL.md` 做 frontmatter 解析）：

| 技能 | frontmatter 键 | description 长度 |
| --- | --- | --- |
| `loopx-benchmark` | `name`, `description` | 351 |
| `loopx-change-quality` | `name`, `description` | 352 |
| `loopx-doc-registry` | `name`, `description` | 314 |
| `loopx-material` | `name`, `description` | 387 |
| `loopx-pr-program` | `name`, `description` | 468 |
| `loopx-pr-review` | `name`, `description` | 357 |
| `loopx-project` | `name`, `description` | 389 |
| `loopx-self-repair` | `name`, `description` | **506** |

只有 `name` 与 `description`，全部命中白名单；名字全部 kebab-case，合法。**唯一问题**：`loopx-self-repair` 的 description 506 字符超过 DSH catalog 的 `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500`（`node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:40,49,57,218`），在模型可见目录里会被截掉 6 个字符。影响很小，但它是本次能实测到的唯一格式性瑕疵。

**本机现状（只读核实 + 实测）**：调研开始时 `ls -d /root/.agents/skills/loopx-*` 不存在、对 `/root/.agents/skills/` 全量 grep `loopx` 无命中 —— 即 **loopx 技能当时完全没装**。调研后期（17:14）发生了一次安装（见「研究范围」说明），结束时实际落盘 **7 个条目**：入口技能 `loopx` 加 6 个工作流技能 `loopx-benchmark`、`loopx-doc-registry`、`loopx-pr-program`、`loopx-pr-review`、`loopx-project`、`loopx-self-repair`。

**一个值得单独指出的分发事实**：仓库 `skills/` 下有 **8** 个技能，但 wheel 只分发了 **6** 个 —— `loopx-material` 与 `loopx-change-quality` **不在 `pyproject.toml:73-125` 的 `[tool.setuptools.data-files]` 清单里**，实测 wheel 的 `share/loopx/skills/` 目录也确认只有 6 个。**「推断」**：这两个技能是"项目内按需安装"而非"全局下发"，与它们各自的 SKILL.md 自述一致 —— `loopx-change-quality` 写着「LoopX owns the canonical source but does not install it globally. Install a managed copy in a connected project for the relevant host」，`loopx-material` 写着「LoopX ships the canonical source for this skill, but does not install it into ...」（`skills/loopx-change-quality/SKILL.md`、`skills/loopx-material/SKILL.md` 正文首段）。

### 4.7 `tool-bash` 调用 `loopx` CLI 的路子，以及与 DSH 自带能力的重叠

**结论：这是最干净的一条路，也是官方 DSH-native 入口技能**明确要求**的路子。但它有三个硬前提：CLI 必须在 PATH 上、技能必须已安装、模型必须拿到 `$DSH_SESSION_ID`。**

第一方证据——LoopX 自己要求走 shell：

- 生成的 DSH-native 入口技能第 3 条：「Use DSH's shell tool to invoke the authoritative LoopX CLI. Never call plugin-provided LoopX model tools and never edit a LoopX registry directly.」（`loopx/slash_command_install.py:119-123`）
- 第 4 条要求 `$DSH_SESSION_ID`：「Require the exact non-empty `$DSH_SESSION_ID` supplied by DSH. Never synthesize, normalize, or reuse a Session id from prose.」（`loopx/slash_command_install.py:124-127`）
- 第 5 条给出实际命令：`loopx start-goal --guided --project . --goal-text='<shell-escaped complete original visible user task>' --host-surface deepseek-harness-native --thread-id "$DSH_SESSION_ID"`（`loopx/slash_command_install.py:133-142`）
- 设计文档也把这写死：「invoke the LoopX CLI through the DSH shell tool, never through plugin model tools」（`docs/plans/2026-08-20-dsh-native-skill-driver.md:136-138`）。

DSH 侧核实：`bash` 工具由 `@deepseek-ai/dsh-tool-bash` 提供（`node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js:259-260`），执行器是 `@deepseek-ai/dsh-bash-local`（`bash -c`），每次调用是全新 shell、无跨调用状态（`:127`）。本机 preset 也带着 `tool-bash` 行（`/root/.dsh/.agent-presets/yiln/agent.cordis.yml`）。

**关键澄清（我曾推断错，实测纠正）**：我起初推断"插件把 CLI 装进私有目录、不写 PATH，而技能又要求 shell 直接调 `loopx`，所以技能里的命令会 `command not found`"。**实测证明这个推断是错的**：插件在生成入口技能时把托管 launcher 的**绝对路径**嵌了进去 —— 实测落盘的 `~/.agents/skills/loopx/SKILL.md` 里写的是

```bash
python3 /root/.agents/runtime/dsh-loopx-plugin/loopx_cli.py start-goal --guided --project . \
  --goal-text='<...>' --host-surface deepseek-harness-native --thread-id "$DSH_SESSION_ID"
```

机制在源码里是 `--cli-bin <command.skillCommand>`（`src/init-command.ts:144-148`，其中 `workflowArgs()` 把 `command.skillCommand` 作为 `--cli-bin` 传给 `loopx workflow-skills`），所以 skill 文本里的 `cli_bin` 不是裸 `loopx` 而是完整解释器路径（`loopx/slash_command_install.py:133-142` 用 `{cli_bin}` 插值）。**因此插件路径是自洽的，不需要 PATH。**

**但这留下一个真实的坑**：`loopx workflow-skills --install` 的 `--cli-bin` **默认值是裸 `loopx`**（`loopx/cli_commands/workflow_skills.py:47-51`）。所以**手工**（不经插件）执行 `loopx workflow-skills --install --skills-dir ~/.agents/skills --host-surface deepseek-harness-native` 时，生成的入口技能会嵌入裸 `loopx`，此后模型在 DSH shell 里跑它就需要 `loopx` 在 PATH 上。**这是 §4.11 方案 1 的一个必须显式处理的前提。**

**与 DSH 自带能力的重叠/冲突**（按重叠程度）：

| DSH 能力 | 提供包 | 与 LoopX 的关系 |
| --- | --- | --- |
| `create_goal` / `get_goal` / `update_goal` | `@deepseek-ai/dsh-tool-goal`（`lib/index.js:265,276,302`） | **直接重复**。DSH 的 goal 持久化在 session event log（`dsh-goal/lib/index.js:865` `agent.session.append("goal/change", ...)`），LoopX 的 goal 在 `.loopx/registry.json` + `.codex/goals/`。**两套权威、两套生命周期、两套 UI。** |
| `todo_write` | `@deepseek-ai/dsh-tool-todo`（`:96`） | **直接重复**。DSH todo 是 session 内；LoopX todo 是带 claim/lease/owner 的跨会话状态（`loopx/cli_commands/todo.py`、`task_lease.py`）。 |
| `exit_plan_mode`（plan mode） | `@deepseek-ai/dsh-plan-mode`（`:34`、`:230`） | **部分重叠**。DSH plan mode 是单会话的模式门；LoopX 的 `--guided` 起 goal 也要求 plan-before-todo-write（`skills/loopx-project/SKILL.md:148`）。**「推断」**：两者叠加会让"当前该不该动手"有两个独立判据。 |
| `subagent` / `workflow` / `ralph` | `dsh-tool-subagent`、`dsh-tool-workflow`、`dsh-tool-ralph` | **设计意图接近、实现完全不同**。DSH 的 ralph 是 fresh-agent 轮次循环、workflow 是脚本化 fan-out；LoopX 的对应物是 quota 门控的 heartbeat + typed continuation。**注意 DSH 的 ralph 是本次见过唯一把 `evidence` 当一等字段的地方**（`dsh-tool-ralph/lib/index.js:42,46`）。 |

DSH 侧**不存在**的一等概念（供对照）：`handoff`、`gate` 在 DSH 核心中不是一等概念（仅词形巧合命中）；`quota` 在 DSH 里只指 provider 配额错误与文件存储配额。**换句话说，LoopX 带来的 gate / evidence / quota / handoff 语义在 DSH 里确实是新增的，不与现有能力撞名。**

### 4.8 MCP：先核实 LoopX 有没有 MCP server

**结论：有，但它不是"LoopX 控制面的 MCP 接口"。它是一个 host-adapter 级的 FastMCP server，只服务 goal-mode 的完成/租约通道，而且不在 `pip install loopx` 的依赖里。**

源码核实：

- 实现：`loopx/goal_mode_mcp.py:280` `def create_fastmcp_server(...)`，内部 `from mcp.server.fastmcp import FastMCP`（`:285`）后 `FastMCP(config.server_name)`（`:293`）。
- 工具面恰好 6 个：`host_prompt`（`:296-297`）、`should_run`（`:301-302`）、`list_todos`（`:306-307`）、`claim_task`（`:311-312`）、`review_task_vision`（`:316-317`）、`complete_task`（`:331-332`）。
- 两个入口：Claude Code 走 `loopx/claude_goal_mode/mcp/loopx_mcp.py:18`（server_name `"loopx"`）；KunlunCode 走 `loopx/kunluncode_goal_mode/`，由**独立的 console script** `loopx-kunluncode` 安装（`pyproject.toml:42`），不经 `loopx`。
- **依赖不在包里**：`dependencies = []`（`pyproject.toml:14`）；`mcp==1.28.1` 只在 `test` extra（`pyproject.toml:29`）。`goal_mode_mcp.py:12-18` 的注释直说「pydantic ships with the FastMCP extra; base installs have no pydantic」，并给了一个 inert 替身类。
- Claude Code 侧要单独建 venv 装 `mcp<2`（`loopx/claude_goal_mode/scripts/install.py:76-110`，探针常量 `MCP_PROBE = "import mcp.server.fastmcp"`，要求 `MCP_REQUIREMENT = "mcp<2"`），且明确「We install `mcp` ONLY into a dedicated venv we own.」
- **没有 `loopx mcp` 子命令**（AST 抽取全部 `add_parser` 站点 + 顶层注册表核对，无命中）。

DSH 侧能否接：`@deepseek-ai/dsh-mcp-client` 支持 `stdio` 与 `streamable-http` 两种 transport，工具名规范化为 `mcp__<serverName>__<tool>`（`node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts:25-69`、`lib/index.js:121`），且「bridges tools only; MCP resources and prompts are unsupported」。

**结论：技术上可行，实用上不划算。** **「推断」**：要在 DSH 里用它，需要自己准备一个能 `import mcp.server.fastmcp` 的解释器（专用 venv）、指向 `loopx.claude_goal_mode.mcp.loopx_mcp`、并为 `deepseek-harness` 表面伪造 `GoalModeMCPConfig`；换来的 6 个工具里有 4 个（`list_todos` / `claim_task` / `complete_task` / `review_task_vision`）只是对 CLI 的薄包装（`goal_mode_mcp.py:151,163,185,259` 都走 `self.run_cli(...)`），而 CLI 通过 `tool-bash` 已经在手。**没有 `deepseek-harness-native` 的 MCP 入口**——官方 DSH-native 路径刻意不走 MCP。

### 4.9 `webhook` / `schedule` 与 LoopX watch/schedule/dashboard

**结论：结合点存在但不成立。** 原因是三处语义错配：DSH 侧两个包都不是通用事件总线，LoopX 侧也没有可以被订阅的 HTTP 端点。

源码核实——DSH 侧：

- `@deepseek-ai/dsh-webhook` 是**入站**、fire-and-forget 的规则运行时，唯一内建动作是"创建 Workspace Session"（`node_modules/@deepseek-ai/dsh-webhook/lib/types/index.d.ts:1,11`），提供的是 `ctx.webhookRuntime`（`:7-9`）。**该包自己不暴露任何 HTTP 端点**（全量 grep 无 `listen`/`createServer`）；HTTP 由适配器提供，例如 `@deepseek-ai/dsh-webhook-github` 挂在 `ctx.webServer` 上并要求 HMAC 签名（`dsh-webhook-github/lib/types/index.d.ts:1,21-36`）。
- `@deepseek-ai/dsh-schedule` 是**会话内持久提醒**，「**不是 cron**」——README 明确「Avoid it when ... you need calendar-style rules such as 'every weekday at 9'」，只能固定间隔、下限 300 秒，且交付依赖 live root agent（`dsh-schedule/README.md` Summary；`lib/index.js:13` `MIN_EVERY_INTERVAL_SECONDS = 300`）。

LoopX 侧核实：

- **`loopx watch` 不存在**（见 §2.3）。LoopX 的"watch"概念是 scheduler/heartbeat：`loopx/control_plane/scheduler/` 下有 `heartbeat_followup.ts`、`monitor_poll_writeback.py`、`provider_monitor_poll.py` 等。
- **LoopX 没有 webhook 接收端。** 全仓 grep `webhook` 只有 6 处，且全部是"能力名/字段名"而非服务器实现：`loopx/host_mode_planner.py:75` 的 `"connector_id": "http_webhook"`、`:80`「Use a chat/webhook gateway only for durable intake, then hand execution to LoopX state」，以及 `loopx/control_plane/goals/botmux_runtime.py:607,1023` 的 `"source": {"type": "webhook"}`。**也就是说 LoopX 把 webhook 当**外部入口**来消费，而不是自己提供。**
- Dashboard 是显式启动的本地只读服务（`loopx/dash_server.py:34,40-42`），不是常驻事件源。

**「推断」**：若要接，方向只有一条——用 LoopX 的 scheduler/heartbeat 产出的 plan 去驱动 `dsh-schedule` 的提醒，或反过来用 `dsh-webhook-github` 把 GitHub 事件灌进 LoopX 的 `heartbeat-prompt`。两条都需要新写代码，且都不是官方支持的路径。**本轮不建议投入。**

### 4.10 与本机 preset 体系的关系

**结论：四个 row 都在 host 平面，对 preset 会话一律可见；LoopX 技能落在 rank 500 的用户根，同样对所有 preset 可见。** 但要注意，这**不是**"插件被隔离在某个 realm 里"的场景——它是全局生效的。

源码核实：

- 本机唯一用户 preset 是 `yiln`（`/root/.dsh/.agent-presets/yiln/agent.cordis.yml`），内含三个 `isolate` realm：`planning`（隔离 `planMode`）、`compaction`（隔离 `compaction` + `toolResultPruner`）、`delegation`（隔离 `workflowEngine`）。
- 这三个 realm 隔离的服务（`planMode`、`compaction`、`toolResultPruner`、`workflowEngine`）与 LoopX 的四个 row 需要的服务（`agents`、`connection`、`commands`、`loopxBootstrap`）**没有交集**，所以不存在"row 在 realm 里被隐藏"的风险。
- Driver 遍历 host 的 `ctx.agents.list()`（`src/driver.ts:1245`），并订阅 host 级 agent 事件（`:1216-1240`）。**「推断」**：因此 preset 会话同样会被 Driver 观察到；一旦该会话成功调用过 `loopx` 技能，它就会进入自动续跑的候选集。
- 技能侧：preset 自己有一行 `skill-filesystem`，用 `customSkillDirs` 指向 preset 目录内的 `skills/`（`/root/.dsh/.agent-presets/yiln/agent.cordis.yml`，末尾）。它注册进的是"该 preset 的那一层"，而 host 的 `dsh-base` 还有一行 `skill-filesystem`（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:276-277`）负责 rank 400/500 用户根。**两层叠加，所以 `~/.agents/skills` 对新会话可见。**

**唯一真实的"可见性"风险不在 realm，而在前端**：GoalBar 需要浏览器侧与插件版本匹配的 `connection`/`slots` 服务。本机 DSH 是 `0.1.5-rc.1` 而插件是 `0.1.1-beta.5` 时代的产物——peer 范围允许，但这是"允许"而非"验证过"。见 §5。

### 4.11 状态与方案（按实测结论排序）

> **状态：已安装，并已于 2026-09-13 17:16:23 重启生效；bootstrap = ready（有证据，见下）。**
> - **安装**：17:13:59 `dsh plugin --profile web add <release-tgz>` 完成；`dsh-loopx-plugin` 被自动追加进 `/root/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`（14→15 项，末位）与 `dependencies`。此步**实测验证了 §4.2**。
> - **预热**：17:14:54 由编排方在独立 Node 进程中直接调用插件导出的 `initializeLoopX({})`，落盘 `/root/.agents/runtime/dsh-loopx-plugin/` 与 `~/.agents/skills/`。
> - **重启生效**：systemd `dsh-web.service` 于 **17:16:23** 以新 PID **1800211** 启动，**17:16:35** 打印 Web URL。
> - **`loopxBootstrap = ready` 的证据（我的独立核实，比"日志里没有 warn"更强）**：`~/.agents/skills/.loopx-skill-install.json` 的 mtime 从预热时的 `17:14:54` **变到 `17:16:32`** —— 即**新进程启动后约 9 秒、URL 打印前 3 秒，init row 自己又跑了一遍 `workflow-skills --install`**。这是一个**正向产物**，证明 patch 已生效、init row 已激活并推进到 `install_skills` 步；再加上 `web-runtime` 注入 `loopxBootstrap` 而 URL 确实打印，可确认 `provide()` 已执行。新进程 journal 里除 URL 外无任何行，与 `ready` 一致。
> - **回滚（不需要 DSH 在跑）**：`dsh plugin --profile web remove dsh-loopx-plugin`。它同样会触发 reconcile，把该行从 `bundles` 摘掉；但**不会**清理 `~/.agents/runtime/dsh-loopx-plugin`、`~/.agents/skills/loopx*` 或 LoopX 业务状态（§3.4）。

| # | 方案 | 现状与做法 | 代价与前提 |
| --- | --- | --- | --- |
| **1** | **保留官方 `dsh-loopx-plugin`**（已落地，无需动作） | **已安装并已生效**，不需要再做什么 | **前提**：Node ≥22.19（本机 24.14.1 ✓）、Python ≥3.11 + pip（本机 3.11.2 ✓）。**代价**：① Web 启动被 `loopxBootstrap` 门控——本次实测从进程启动 17:16:23 到 URL 17:16:35 共 **12 秒**（因为 CLI 已在预热时装好，走的是"已兼容则跳过安装"快路径；冷装路径的上限仍是 §4.4 的分钟级）；② init row 若未激活则 Web 永不绑定（§4.4，仍是最大单点风险）；③ 已落盘 runtime 与技能。**收益**：GoalBar、quota 门控的自动续跑、typed continuation。 |
| **2** | **只保留 CLI + 技能，撤掉插件**（回退路径） | `dsh plugin --profile web remove dsh-loopx-plugin`，此后模型仅通过 `tool-bash` 调 LoopX | **前提**：删插件后技能里嵌的仍是**托管 launcher 绝对路径**（`python3 /root/.agents/runtime/dsh-loopx-plugin/loopx_cli.py ...`），所以**技能仍可用**，只要不删那个 runtime 目录。若改用 PATH 上的独立安装，注意 `--cli-bin` 默认是裸 `loopx`（见 §4.7/§5.1#3）。**代价**：失去 GoalBar 与自动续跑。**收益**：DSH 的 Web 启动路径**恢复为完全不依赖 LoopX**——这是它相对方案 1 的全部价值。**可逆**：重新 `add` 那个 tarball 即可。 |
| **3** | **headless `dsh_goal_mode` 适配器**（只想被 LoopX 外部驱动） | `python -m loopx.dsh_goal_mode --cordis <cordis.yml> --model ... --provider ...`，由 LoopX 的 `turn run-once` 调起 | **前提**：`loopx[deepseek-harness]`（钉在 `deepseek-harness-sdk==0.1.2a3`，`pyproject.toml:24-26`）+ `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`（`loopx/dsh_goal_mode/README.md:86-94`）。**代价**：**明确不承诺跨 turn 的 DSH 会话连续性**（`loopx/dsh_goal_mode/README.md:75`）。与方案 1/2 是**两套并行的 DSH 表面**（`deepseek-harness` vs `deepseek-harness-native`），不要混用。 |
| **4** | **用 `dsh-mcp-client` 接 LoopX 的 MCP server** | 自建 venv 装 `mcp<2`，配 `stdio` 指向 `loopx.claude_goal_mode.mcp.loopx_mcp` | **明确不推荐。** 只有 6 个 goal-mode 工具、4 个是 CLI 的薄包装、需要伪造未文档化的 `GoalModeMCPConfig`、且没有 DSH-native 表面的 MCP 入口。**收益低于方案 2，成本高于方案 1。** |

**仍未验证的一件事（见 §5.2#2）**：GoalBar 的 **Client 半边是否真的组装并渲染**。我无法从 tokenless HTTP 探测确认——`/plugins/*` 对所有插件一律 404，带 launch token 访问 `/` 得到 303（认证跳转）。所以"插件 Host 面已生效"有证据，"浏览器里能看到 GoalBar"**没有**。

---

## 5. 风险与未确认项

### 5.1 已核实的运维风险

1. **Web 启动可用性被绑到 Python/pip/网络上（最高）。** `webserver` 与 `web-runtime` 都被 patch 成 `inject: [webStartup, loopxBootstrap]`（`packages/dsh-loopx-plugin/cordis.patch.yml:20-28`）。正常失败会降级（`src/init-command.ts:626-629`），但 init row 的 `inject = ['commands']`（`:26`）意味着"row 未激活"是未被捕获的阻断路径。**没有全局超时，没有绕过开关。**
2. **首次启动的分钟级延迟。** 需要真正安装时是 `pip install`（120s 超时）+ 技能安装（60s）+ 若干 5s 探测（`src/init-command.ts:213,223,270,290,362`）；而 URL 打印被明确设计成 bootstrap 边界（`packages/dsh-loopx-plugin/README.md:66-70`）。
3. **手工安装技能时的 `--cli-bin` 默认值是裸 `loopx`。** 插件路径会用绝对 launcher 路径覆盖它（`src/init-command.ts:144-148`），但如果绕过插件手工跑 `loopx workflow-skills --install`，生成的入口技能会嵌入裸 `loopx`（`loopx/cli_commands/workflow_skills.py:47-51`），而 `loopx` 默认不在 PATH 上。**这是 §4.11 方案 1 必须显式处理的前提**：要么先把 CLI 装到 PATH，要么手工传 `--cli-bin`。
4. **Python + Node 双运行时。** 即使只用 CLI 也需要 Node ≥22.18 跑 Effect core（`docs/guides/installing-loopx.md:30-35`；`loopx/control_plane/effect_runtime_server.ts:1`）。**本机 node v24.14.1 满足**，但这是一个额外的版本约束面。
5. **状态目录污染。** 全局 `~/.codex/loopx`（`loopx/paths.py:7`，注意是 `.codex` 不是 `.loopx`）与项目内 `.loopx/` + `.codex/goals/`（`loopx/paths.py:8`、`skills/loopx-project/SKILL.md:747-749`）。官方建议把它们加进 `.gitignore`（`skills/loopx-project/SKILL.md:753-755`），也就是说**默认会往你的仓库里写目录**。
6. **端口与常驻进程。** `dash`/`dashboard` 默认 `127.0.0.1:8767`、`serve-status` 默认 `8765`（`loopx/dash_server.py:34`、`loopx/status_server.py:39`、`loopx/chat_server.py:89`）。它们只在显式启动时存在，但**8767 被两个不同的服务共用**（`dash` 与 `dashboard`/`chat`），`loopx/dashboard_launcher.py:251` 自己就写了 "stop that service or start LoopX on another port with --port"。
7. **SQLite 通道会线性增长。** 若启用，文档自陈「Fixed live state therefore produces linear database growth, not bounded total disk use」（`docs/reference/sqlite-authority-store.md`「Placement and persistence」段）。
8. **插件的 reader/writer 面已收窄，但仍会读 registry。** GoalBar 只有 `loopback` authority（`src/goalbar/connection-rpc.ts:155`），wire allowlist 排除 Todo 文本、Goal objective、quota、evidence、CLI 输出与 registry 路径（`packages/dsh-loopx-plugin/README.md:219-225`）。它**不是**用户认证：「Loopback is a network reachability fence, not user authentication, and Phase 1 does not support LAN or remote browsers」（同文件 `:213-215`）。**本机 DSH 暴露在 `0.0.0.0:3080` 且有 `dsh.yiln.de` 反代与两步验证配置**（`/root/.dsh/profiles/web/cordis.patch.yml`）——**「推断」**：这会放大对 loopback-only 假设的依赖，需人工确认反代是否会让 `/loopx` 通道变得可达。
9. **默认关闭的 observer 仍会写盘。** 只有同时给出 `LOOPX_DSH_SHADOW_OBSERVER_GOAL_ID` / `_SESSION_ID` / `_RUN_IDENTITY_JSON` 才注册 hook（`src/observer.ts:227-243`），否则不写文件。一旦开启，默认落在 `~/.codex/loopx/reliability_diagnostics/<goal-id>.ndjson`（`src/observer.ts:220-224`）。
10. **Lark / IM 扩展面。** `pyproject.toml:43-45` 有 `loopx-lark-provider` 等独立 console script；`loopx/chat_lark_api.py`、`loopx/cli_commands/lark_inbox.py`、`lark_kanban.py` 都在。**本轮未深入核实其凭据与网络面**——列入 §5.2。

### 5.2 未核实 / 只能推断

1. **安装由编排方执行，不在我的只读范围内；实测事实来自真实安装 + 一次真实重启。** `pip install loopx`、`loopx workflow-skills --install`、`dsh plugin --profile web add <tgz>` 与 `systemctl restart dsh-web` 全部**由编排方执行，我没有执行任何写操作**。我能做的是**核实其结果**，而结果已核实：插件在 `dsh.profile.bundles` 中（§4.2 由推断升级为实测）、`~/.agents/runtime/dsh-loopx-plugin/` 与 7 个技能落盘、服务于 17:16:23 以新 PID 1800211 重启、URL 于 17:16:35 打印。**唯一仍是纯推断的数字是"冷装路径最多约 2 分钟"**——它由各子进程 timeout 相加得出（`src/init-command.ts:213,223,270,290,362`），本次实测走的是"CLI 已兼容则跳过安装"的快路径，只用了 12 秒，**没有覆盖冷装情形**。
   - **仍然没有任何实测的是"GoalBar 在浏览器里渲染"**：`/plugins/*` 对所有插件一律返回 404（含本机已在用的 `terminal-tab`），带 launch token 访问 `/` 返回 303 认证跳转，因此**该路径需要浏览器会话才能验证，我无法从 tokenless HTTP 探测确认**。Host 面生效已有正向证据（manifest mtime + URL 打印），**Client 面未验证**。
2. **`dsh-loopx-plugin@0.1.1-beta.5` 与本机 DSH `0.1.5-rc.1` 的实测兼容性未验证。** peer 范围允许，但插件是在 `@deepseek-ai/dsh@0.1.1-rc.2` 上开发的（`packages/dsh-loopx-plugin/package.json` 的 devDependencies），而 beta 号本身说明它还不是稳定版。
3. **`/loopx` 通道在反代下的可达性未核实，仍需人工确认（保留项）。** 见 §5.1 第 8 条：GoalBar 的 `/loopx` Connection 通道声明的是 `authority: 'loopback'`（`src/goalbar/connection-rpc.ts:155`），而项目自己写明「Loopback is a network reachability fence, not user authentication, and Phase 1 does not support LAN or remote browsers」（`packages/dsh-loopx-plugin/README.md:213-215`）。本机同时存在 `0.0.0.0:3080` 监听、`dsh.yiln.de` 反代与 `requireTwoFactor: true`（`/root/.dsh/profiles/web/cordis.patch.yml`）。**「推断」**：这三者叠加需要一次人工确认——特别是经反代访问时 `/loopx` 是否被视为 loopback。**本轮无法从 tokenless HTTP 探测得出结论**（一律 303/404），必须用真实浏览器会话验证。
4. **与本机 11 个 `@yiln-dsh/dsh-plugin-*` 的交互未核实。**（调研当时为 14 个，其后 `dsh-plugin-sandbox-guidance` 已移除。）已知唯一的具体交集是 slot：LoopX GoalBar 用 `conversation.input.dock` 的 `order: 15`，本机原生行占 0/10/20。**「推断」**：没有 id 冲突（`loopx-goal` 是唯一的），但 `@yiln-dsh/dsh-plugin-auth-webserver` 的两步验证与 `dsh-plugin-web-daemon` 是否与 `webserver` 的 `inject` 改动相容，**本轮未逐包核实**。
5. **LoopX 的 Lark/IM 扩展与 `docs/extensions/` 未深入。** 已知 `pyproject.toml:64` 打包 `loopx.extensions.lark` 的 `extension.toml`/README/docs，且 `packages.md` 提到 Lark Kanban adapter；其凭据模型与数据出境面**未核实**。
6. **`docs/book/` 双语开发手册只做了目录级浏览**，未逐章阅读；`AGENTS.md`（25KB）只做了标题级浏览（其章节为 Commit/PR Hygiene、First-Screen Review Gate、Public And Private Boundary、Capability And Extension Placement 等）。这两处的深度内容**未进入本报告**。
7. **LoopX 的 `capabilities/` 与 `extensions/` 目录未展开。** `loopx/` 下有 `capabilities/` 与 `extensions/` 两个子包（`pyproject.toml:62-66` 有打包声明），本轮只核实了它们在架构中的定位（`README.zh-CN.md:342-347`），未逐个能力核实成熟度。
8. **`loopx-self-repair` 技能 description 被截断 6 字符**是**推断**：`DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500` 是 `dsh-tool-skill` 的默认值，但我没有验证本机部署是否覆盖了 `catalogDescriptionMaxLength`。

### 5.3 一句话风险总结

**LoopX 本身的风险面（`.codex`/`.loopx` 目录污染、双运行时、8765/8767 端口）都是"用的时候才发生"的；而官方 DSH 插件的风险面不同——它把 DSH 的 Web 启动可用性变成 LoopX 安装链路的函数。** 这一点在本次实测中已经**兑现过一次但没造成故障**：重启后 bootstrap 走的是快路径、12 秒内完成、Web 正常起来。风险不在"这次会怎样"，而在"CLI 失效、Python 缺失或网络不可达的那次重启会怎样"。**所以 §4.11 把"只保留 CLI + 技能、撤掉插件"（方案 2）保留为一个随时可用的一步回退**。

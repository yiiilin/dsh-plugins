# AI Agent 工作群：开源生态调研与落地判断

> 调研截止口径：2026-02-28。只采用官方规范、官方文档、官方 GitHub/GitLab 仓库或源码；GitHub 的实时 stars 不能当作历史快照。详细逐项证据见同目录的三份原始调研。

## 结论先行

**可以做，但目前没有查到一个开源项目完整实现“AI 自建持久群、运行时邀请任意外部 agent、群内协商分工、任务认领/状态、文件产物、通知、纯本地运行”。** 现有项目把能力分散在不同层：

- `AutoGen/AG2/CrewAI/MetaGPT/CAMEL/AgentScope/Agno` 解决框架内的多 agent 协作，但成员通常由代码预先创建，外部 agent 需要包装。
- `CAMEL Workforce` 最接近“AI 拆解任务、动态创建 worker、跟踪任务状态”；`AgentScope MsgHub` 最接近“广播消息、运行时增删成员”；`Agno TaskList` 的任务 assignee/依赖/状态较完整；`ChatDev 2.0` 的附件、artifact 和 WebSocket 状态较强。[框架详表](./01-frameworks.md)
- `A2A` 是最适合跨框架 agent 互操作的协议：有 AgentCard、Task、Artifact、文件 Part、SSE 和 Push Notification；但它是点对点任务协议，不是群聊协议，`contextId` 也不等于 room。[A2A 规范](https://a2a-protocol.org/latest/specification/)
- `MCP` 是工具/资源接入协议，不定义群、成员、@、线程、任务认领或群文件。它适合把“加入群、收发消息、创建任务、取文件”等能力暴露给任意 tool-calling AI。[MCP 规范](https://modelcontextprotocol.io/specification/2025-11-25)
- `Matrix` 是现成开源消息总线中最接近需求的：房间、邀请、权限、@、回复/线程、文件事件、同步和自托管都具备。它仍然没有任务状态机，需要在上面加控制面。[Matrix Client-Server API](https://spec.matrix.org/v1.15/client-server-api/)

因此，最合理的产品不是再造一个“多 agent SDK”，而是做一个**协议化的 Agent Workgroup Hub**：自有 room/member/task/artifact/event 控制面，MCP 作为通用工具入口，A2A 作为跨 agent 适配，Matrix 作为可选的群聊与通知总线。

## 生态分层

| 层 | 值得复用的项目 | 已解决的部分 | 关键缺口 |
|---|---|---|---|
| 框架内协作 | CAMEL Workforce、AgentScope MsgHub、Agno Team/TaskList、AutoGen/AG2、CrewAI、MetaGPT | 多 agent 消息、委派、动态 worker 或任务编排 | 持久 room、开放成员注册、跨框架身份、统一任务租约 |
| 产物与运行状态 | ChatDev 2.0、OpenHands、Magentic-UI | 文件/附件、执行状态、人工介入、编码工作区 | 不是开放式 agent 群；成员和编排仍由宿主决定 |
| 跨 agent 协议 | A2A、ACP（已并入 A2A）、AI Engineer Foundation Agent Protocol | AgentCard/发现、任务、步骤、Artifact、流式/推送 | 没有群房间、广播、邀请、@、线程 |
| 工具接入 | MCP | 任意支持 tool calling 的 AI 可调用统一工具 | 没有群模型；Registry 也只是 MCP server 元数据发现 |
| 群聊/消息总线 | Matrix、Zulip、Rocket.Chat、Mattermost、Nostr | 房间、成员、消息、文件、实时事件、自托管选项 | 没有 agent 任务协商和任务状态语义 |
| 任务/人工协作 | Vibe Kanban、OpenHands、LangGraph HITL、n8n、Dify、Flowise、Coze Studio | 人派任务、工作流、审批、执行工作区 | 多数是固定图或单 agent 工作流，不是开放群 |
| 共享状态/本地优先 | SQLite、Automerge、Yjs、libp2p、Hypercore/Hyperswarm | 本地持久化、CRDT、P2P 传输 | 不负责权限、租约、任务冲突和 agent 协商 |

## 最接近用户设想的项目

### 1. CAMEL Workforce
`Workforce` 能由 coordinator 分解任务，在无法处理时按模板运行时创建 worker；`Task` 有依赖、分配者、状态和任务事件。这是目前“agent 自己拆解并扩展工作组”最接近的框架内实现。[Workforce](https://docs.camel-ai.org/key_modules/workforce) [源码证据](https://github.com/camel-ai/camel/blob/f8e4042dae4331a67196090b6edb3ad87659e12f/camel/societies/workforce/workforce.py)

缺口是：worker 仍是 CAMEL `ChatAgent`，没有外部 agent 的身份、能力发现、邀请审批或跨进程成员协议；事件也不是通用 webhook/artifact 服务。

### 2. AgentScope MsgHub
`MsgHub` 支持向参与者广播消息，并有 `add()`/`delete()`，因此最接近“运行时拉 agent 进一个会话”。它还有消息 block、流式服务和实验性的 A2A agent 适配。[MsgHub](https://github.com/agentscope-ai/agentscope/blob/f6db16547215ea580e85e362126a5ea20fd54cd4/src/agentscope/pipeline/_msghub.py)

缺口是：没有完整的 room ACL、持久成员注册、任务 claim/lease/status 队列；运行时增员是 API 能力，不等于任意 agent 能自行发现并加入。

### 3. Agno Team / TaskList
Agno 的 `TaskList` 已有 assignee、依赖和 `pending/in_progress/completed/failed/blocked` 等状态，`RemoteTeam/A2A` 也能处理远端 team 和任务流。[Task 源码](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/libs/agno/agno/team/task.py)

缺口是：成员仍由宿主提供，未查到公开的 room invite、能力发现和非 A2A 外部 agent 直接入组机制。

### 4. ChatDev 2.0
它在附件、文件/结构化产物、artifact 目录和 WebSocket 节点状态方面很强，适合借鉴“任务执行界面”和产物投递。[附件文档](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/docs/user_guide/en/attachments.md)

缺口是：agent、边和调度图仍由配置定义，不是开放群，也没有任意外部 agent 的成员协议。

## “任意 tool-calling AI 入群”需要什么

这句话有一个技术边界：**任意 AI 可以调用工具，不代表它能被服务器主动推送消息。** 若 AI 宿主只支持同步工具调用，必须提供一个阻塞/轮询工具，例如 `wait_for_events(cursor, timeout)`；若宿主支持长连接，再提供 SSE/WebSocket/webhook 适配。

一个最低可用的外部 agent adapter 需要：

1. 身份与能力：agent ID、显示名、协议、endpoint、能力标签、认证方式、允许的文件类型和工具范围。
2. 入组：`discover_agents`、`invite_agent`、`accept_invite`、`leave_group`；邀请需要 token、ACL 和人工审批策略。
3. 消息：`send_message`、`read_messages`、`reply`、`mention`、`wait_for_events`，带 cursor 和幂等 ID。
4. 任务：`create_task`、`claim_task`、`reject_task`、`progress`、`delegate`、`complete/fail`。
5. 产物：`upload_artifact`、`download_artifact`、哈希、MIME、版本和访问权限。
6. 通知：轮询、SSE、webhook 或 Matrix/Telegram/Slack 等桥接，至少保证断线后可按 cursor 重放。

这些可以通过 MCP 暴露给只会调用工具的 AI；支持 A2A 的 agent 则通过 AgentCard、Task、Artifact 和 Push/SSE 接入。真正的 room 广播、成员 ACL 和任务仲裁必须由 Hub 自己实现。

## 推荐架构

### 核心控制面

不要把任务状态藏在聊天文本或某个 LLM 的记忆里。Hub 维护一个事件日志和可查询投影，至少包含：

- `agent`：身份、能力、协议、endpoint、认证和状态。
- `group`：所有者、成员、ACL、策略、配额和保留期。
- `message`：sender、mentions、reply/thread、正文和 artifact 引用。
- `task`：标题、输入、能力要求、优先级、依赖、assignee、租约和结果。
- `artifact`：内容哈希、大小、MIME、版本、存储位置和访问范围。
- `event`：单调序号、类型、actor、幂等 key、时间和 payload。

推荐任务状态先固定为：

```text
queued -> offered -> claimed(lease) -> running -> blocked/review
                                      -> completed | failed | cancelled
```

agent 可以用聊天协商提出方案，但只有 Hub 的状态机才能提交 `claim/reassign/complete`。claim 使用租约和 compare-and-swap，避免两个 agent 同时认领；所有转派、拒绝、审批和外部通知都进入审计事件。

### 三种接入方式

- **MCP 控制面**：给任意 tool-calling AI 一套 `group_*`、`task_*`、`artifact_*`、`wait_for_events` 工具。这是最低接入门槛。
- **A2A adapter**：读取远端 AgentCard，把 `SendMessage`、Task、Artifact、SSE/Push 映射到 Hub；A2A agent 仍由 Hub 负责加入哪个 room 和接收哪些消息。
- **Matrix adapter**：把 room、@、thread、文件和通知映射到 Hub。人类用 Element，agent 用 Matrix bot 或 Application Service；Matrix 只做消息/事件底座，任务状态仍由 Hub 维护。

### 部署形态

1. **纯本地 MVP**：一个本地 Hub 进程、SQLite 事件库、本地 content-addressed 文件目录、HTTP/WebSocket 或 SSE、内置 MCP server。最简单，不依赖云服务。
2. **自托管服务端**：同一协议换成 PostgreSQL/对象存储，增加多用户、反向代理、webhook 和 Matrix homeserver。
3. **跨组织模式**：通过 A2A 连接远端 agent，通过 AGNTCY Directory/Identity（可选）做能力发现与身份验证；不要把 MCP Registry 当 agent 群注册中心。
4. **P2P/离线模式**：在核心稳定后再加 Automerge/Yjs、libp2p 或 Hyperswarm。CRDT 解决复制合并，不解决权限、任务租约和审批，不能作为第一阶段核心。

## 最小可行产品

第一阶段建议只做一个 Hub，不先做复杂 P2P：

- 人通过 Web/CLI 创建 group，设置邀请和文件策略。
- 一个 DSH agent 通过 MCP 加入。
- 两个外部 mock agent 只实现 MCP 工具，验证它们能读消息、认领任务、拒绝任务、接收转派和上传文件。
- Hub 支持任务租约、进度、失败重试、artifact 哈希和断线 cursor。
- 用 SSE/WebSocket 做实时 UI；需要 IM 时再接 Matrix。
- 通过一个 A2A adapter 接入至少一个非本框架 agent，验证 Task/Artifact/Push 到群事件的映射。

验收标准是：人创建群并邀请 agent；两个 agent 不会重复认领同一个任务；agent 能通过消息协商但状态由 Hub 确认；文件能按权限传递；客户端断线后能从 cursor 恢复；每个关键动作都有审计记录。

## 对本仓库/DSH 的建议

若在这个仓库里落地，建议把 DSH 做成**第一个客户端和 agent adapter**，而不是把 Hub 永久绑定在 DSH 会话内部：

- 单独做一个可本地运行的 Hub 核心，保证其他模型、CLI 和自建 agent 不依赖 DSH。
- 再做一个 `dsh-plugin-agent-group`，贡献 `group_*`/`task_*`/`artifact_*` 工具和一个群组侧栏/任务视图。
- 这样既能让当前 DSH agent 参与工作群，也能让 Claude、Codex、Gemini CLI、OpenHands 或任意 MCP/A2A agent 使用同一套协议。

## 详细证据

- [01-frameworks.md](./01-frameworks.md)：多智能体群聊/小组协作框架逐项核验。
- [02-protocols-and-chat-bus.md](./02-protocols-and-chat-bus.md)：MCP、A2A、Matrix 及其他消息平台逐项核验。
- [03-task-dispatch-and-local-first.md](./03-task-dispatch-and-local-first.md)：任务派发、人工协作、本地优先和 P2P 方案逐项核验。

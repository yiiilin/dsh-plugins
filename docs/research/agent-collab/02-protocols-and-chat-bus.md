# AI agent 协作协议与聊天总线调研

> **范围与证据**：只采用官方规范、官方文档、官方 GitHub/GitLab 源码；以 **2026-02-28** 为截止日，后续仓库更新不计入“现状”。“原生”表示标准/平台直接定义；“适配”表示仍需自建编排器、bot、桥或 MCP 工具。未找到统一官方定义的项目明确标为“未核验”。

## 总览

- **MCP** 是 LLM Host/Client/Server 的能力连接协议，不是房间/成员/聊天协议；tools/resources/prompts、sampling、elicitation 和 Registry 不能原生表达群组生命周期。
- **A2A** 最接近 agent-to-agent 任务互操作：AgentCard、Message/Task/Artifact、文件 Part、stream/push/webhook、extensions 都有；`contextId` 只是同一会话的逻辑分组，没有房间、邀请、踢人、广播、@、线程语义。
- **Matrix** 是最完整的开源消息总线：房间成员权限、@、回复/线程、文件事件、同步与 Application Service 都是协议能力；可自托管并用 Element/matrix-js-sdk。
- **Zulip/Rocket.Chat/Mattermost** 适合自托管团队协作；Slack/Discord/Telegram bot 能力足但依赖 SaaS、权限和平台政策。
- **最短落地**：Matrix 做群消息与事件底座，Matrix bot/MCP server 把群管理和任务工具暴露给任意 tool-calling AI；A2A 做跨组织 agent 任务适配，MCP 只做工具/资源/控制面。

## A. Agent 协议

### A1. MCP（Model Context Protocol）

- **标准能力**：Server 暴露 `tools/list`/`tools/call`、`resources/list/read/subscribe`、`prompts/list/get`；Client 可提供 `sampling/createMessage`（含 tools 的多轮工具循环）和 `elicitation/create`（form/URL 向用户取信息，URL 完成可发通知）。来源：[MCP 2025-11-25 overview](https://modelcontextprotocol.io/specification/2025-11-25)、[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)、[sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、[elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)。
- **群/消息/文件/通知**：标准没有 create-group/invite/kick、成员目录、消息发送/@/thread/reply 或群文件语义；资源订阅和 list-changed 只是资源/能力变化通知。要做群，至少自定义 `create_conversation`、`add/remove_member`、`send_message`（mentions/reply_to）、`read/subscribe_events`、`upload/download_artifact`、`assign_task` 等 tools/resources。
- **Registry**：官方 Registry 是 `server.json` 元数据、命名空间验证和 REST API，定位下游聚合器；截至截止日仍 preview，官方代码不以自托管为目标。来源：[Registry docs](https://modelcontextprotocol.io/registry/about)、[registry README](https://github.com/modelcontextprotocol/registry/blob/main/README.md)。
- **许可证/部署/活跃度**：MCP 规范与代码处于 MIT→Apache-2.0 过渡，历史贡献可能仍 MIT，文档（非规范）CC-BY-4.0；可 stdio 或 Streamable HTTP，官方规范/Registry 维护活跃。来源：[LICENSE](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/LICENSE)。

### A2. A2A（Agent2Agent，Linux Foundation/a2aproject）

- **标准能力**：AgentCard 描述身份、接口、能力、skills、安全方案和 extensions；`SendMessage` 返回 Message 或 Task；Task 有状态、history、artifacts；Part 原生支持 `text`、`raw` bytes、`url`、结构化 `data`；Artifact 是任务输出。来源：[截止快照 README](https://github.com/a2aproject/A2A/blob/4890b77d6fdfa7bf6c8c6558d24ff92a240c7c0a/README.md)、[proto](https://github.com/a2aproject/A2A/blob/4890b77d6fdfa7bf6c8c6558d24ff92a240c7c0a/specification/a2a.proto)。
- **会话/群**：`contextId` 将多个 Task/Message 归入会话，`referenceTaskIds` 支持关联任务；Message role 仅 `user/agent`。没有 room/group/member/invite/kick/broadcast/@/thread/reply 字段，因此群聊需中心编排器向多个 AgentCard 逐一 fan-out，或自定义 extension。
- **通知/接入**：支持同步、SSE streaming、`TaskStatusUpdateEvent`/`TaskArtifactUpdateEvent`，以及按任务注册 HTTP webhook push；extensions 在 AgentCard 声明、请求 opt-in。最小适配是发现 AgentCard、`SendMessage`（含文件 Part）、`Get/Subscribe Task` 或注册 push webhook，再把结果映射到群总线。来源：[规范截止快照](https://github.com/a2aproject/A2A/blob/4890b77d6fdfa7bf6c8c6558d24ff92a240c7c0a/docs/specification.md)。
- **许可证/部署/活跃度**：Linux Foundation 项目，Apache-2.0；JSON-RPC/HTTP、REST、gRPC 绑定和多语言 SDK，可远程服务或本地部署；截至截止日主线仍有 2026-02 更新。来源：[A2A LICENSE](https://github.com/a2aproject/A2A/blob/4890b77d6fdfa7bf6c8c6558d24ff92a240c7c0a/LICENSE)。

### A3. ACP（BeeAI/IBM）

- ACP 原模型有 Agent Manifest、Run、Message/MessagePart、session、stream/await，能传 text/code/file/media，但没有群房间、成员变更、@、线程或群事件订阅；需自建路由/适配。
- 官方仓库已明确 **“ACP is now part of A2A under the Linux Foundation”**，新项目应迁移 A2A；许可证 Apache-2.0，仓库/迁移说明：[i-am-bee/acp README](https://github.com/i-am-bee/acp)、[迁移指南](https://github.com/i-am-bee/beeai-platform/blob/main/docs/community-and-support/acp-a2a-migration-guide.mdx)。

### A4. AGNTCY

- Linux Foundation 公告确认四类基础设施：Agent identity、Directory discovery、SLIM messaging、observability，并与 A2A/MCP 互操作；不是一个单独群聊协议。来源：[LF 2025-07-29 公告](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos)。
- **Directory/OASF（截止快照含 MCP 集成）**：发布/发现带签名的 OASF agent records、能力/关系和 DHT 内容寻址；官方 Directory 截止 README 列出 `./mcp` 集成，用于 MCP 侧验证/发布/搜索 agent metadata。无群成员或消息语义；需另接总线。Apache-2.0；daemon/服务、Docker Compose 或 Helm/Kubernetes。来源：[dir 截止 README](https://github.com/agntcy/dir/blob/e3477aec6961f19898b64af3759f5bdf2ae29cfc/README.md)、[OASF](https://github.com/agntcy/oasf)。
- **AID/Identity（若 AID 指 Agent Identity）**：官方名称是 AGNTCY Identity，提供 DID/外部 IdP/AgentCard、VC、Agent Badge 与验证；不提供群聊、文件或事件总线。Apache-2.0；Issuer CLI + Node Backend，可 Docker/Helm。来源：[identity 截止 README](https://github.com/agntcy/identity/blob/452077220fc5b7c5c5198251b945df5fe61628f2/README.md)。
- **SLIM**：传输/会话层，官方说明有可靠投递、MLS E2EE、group membership management；它不定义应用层房间主题、@/thread、任务/Artifact 或文件模型。Apache-2.0；Rust 节点可 Docker/Cargo/Helm，提供 MCP/A2A bindings。来源：[SLIM 截止 README](https://github.com/agntcy/slim/blob/72f23ad8ace694577ce0720fdb4d471cdab32574/README.md)、[SLIM-MCP 截止仓库](https://github.com/agntcy/slim-mcp-python/tree/009e339078c8526d0477f82e516b4a96bc4213b0)。
- **AGAS/MCP Gateway**：截至截止日未在官方 `agntcy` 组织、官方文档或上述 README 找到可核验的同名标准/仓库；标 **未核验**，不要据此设计依赖。可核验的 AGNTCY MCP 关联是 Directory 仓库的 `./mcp` 集成和 SLIM-MCP transport。

### A5. AI Engineer Foundation Agent Protocol

- 官方 OpenAPI 是单 agent REST API：`POST /ap/v1/agent/tasks`、`/{task_id}/steps`，并提供 task/step 查询、artifact 列表、上传和下载；没有群、成员、@/线程、事件订阅或 webhook。官方 README 仍把 agent-to-agent communication 列为未来路线。来源：[截止 README](https://github.com/AI-Engineer-Foundation/agent-protocol/blob/5047199152dc6e1ba83320b1b59f94af24046dcf/README.md)、[OpenAPI](https://github.com/AI-Engineer-Foundation/agent-protocol/blob/main/schemas/openapi.yml)。
- 最小接入是 HTTP task/step/artifact client；群协作要自建 coordinator/bus。MIT，SDK/client 可自部署 REST 服务；早期、框架无关，不能替代群消息总线。

### A6. AGORA

- **未核验**：截至截止日没有找到一个可归属于统一维护者、带官方规范和稳定版本的“AGORA agent protocol”；名称对应多个互不兼容项目。GitHub 搜索结果与候选仓库：[官方搜索](https://github.com/search?q=AGORA+agent+protocol&type=repositories)、[`agoraproto/agora`](https://github.com/agoraproto/agora)。因此不对群组、文件、通知、许可证或活跃度作事实断言。

### A7. ANP（Agent Network Protocol）

- 截止提交的官方 ANP 由 W3C DID 身份/认证、WSS 消息代理、元协议和 agent description/discovery 组成；消息字段是 `sourceDid`→`destinationDid` 的双边路由，没有 room/group/member/invite/kick、@、thread 或 webhook。来源：[截止 README](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/eb4a10f49fbde24a21256331212ac77cc14175d6/README.md)、[DID message spec](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/eb4a10f49fbde24a21256331212ac77cc14175d6/message/05-message-service-protocol-based-on-did.md)。
- E2EE 消息适合文本/控制指令；官方明确大二进制应另走 HTTPS 并传 URL/密钥，故无原生 Artifact/file store。最小接入：DID resolve/auth、WSS connect、send/receive/ack、重连；群需自行做 fan-out/成员表。
- MIT；Message Proxy 可自建，社区仍在开发但截至截止日是早期协议，不能与 Matrix/A2A 的成熟群语义等同。

## B. 聊天平台作为消息总线

### B1. Matrix（Element/matrix-js-sdk、Conduit/Dendrite、bot/桥）

- **原生群**：`createRoom`、join/invite/leave、kick/ban、power levels 和 invite-only/restricted join rules；`m.room.message` 发话，`m.mentions` @，`m.in_reply_to` 回复，`m.thread` 线程；`m.file`/`m.image` 等事件配合媒体 upload。来源：[Matrix Client-Server API](https://spec.matrix.org/v1.15/client-server-api/)。
- **事件/接入**：`/sync` 增量事件与 push rules；Application Service 通过命名空间接收事务并可向其参与的房间注入事件，适合 bot/桥接。来源：[Application Service API](https://spec.matrix.org/v1.15/application-service-api/)、[matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk)。最小工具是 create/invite/kick/send/reply/thread/upload/download/sync/subscribe；标准原生，适配只负责 AI 身份、策略和 tool schema。
- **客户端/部署/许可证**：Element Web 是成熟客户端，AGPL/GPL/商业多许可证；matrix-js-sdk Apache-2.0；Conduit 是 Rust、Apache-2.0、Beta；Dendrite Go、维护模式、AGPL/商业。均可自托管（Dendrite/Conduit）或联邦；桥 SDK Apache-2.0。来源：[Element](https://github.com/element-hq/element-web)、[Conduit](https://gitlab.com/famedly/conduit)、[Dendrite](https://github.com/element-hq/dendrite)、[bridge](https://github.com/matrix-org/matrix-appservice-bridge)。

### B2. Zulip

- **原生群/消息**：channel(stream) 可创建、订阅/取消订阅成员；消息 `type=stream` + `topic`，或 direct/group PM；@ 用 Zulip 格式化语法，topic 是主分组但不是 Matrix 式嵌套 thread。文件先 `user_uploads` 再发消息链接；事件用 register queue + `events` 长轮询。来源：[send](https://zulip.com/api/send-message)、[subscribe](https://zulip.com/api/subscribe)、[upload](https://zulip.com/api/upload-file)、[events](https://zulip.com/api/get-events)。
- **接入/部署**：最小 bot/API 工具为 create channel、subscribe/unsubscribe、send、upload、register/get events；踢人通过取消订阅/权限策略适配。官方服务器 Apache-2.0，可 Docker/自托管或 Zulip Cloud；项目成熟活跃。来源：[zulip repo](https://github.com/zulip/zulip)。

### B3. Rocket.Chat

- **原生群/消息**：REST/Realtime API 管理 public/private rooms、创建/邀请/移除成员；`chat.postMessage` 发话，`rootId`/thread API 回复，消息文本支持 @；room media upload 传文件。DDP subscriptions（room/user/message streams）提供实时事件。来源：[API reference](https://developer.rocket.chat/reference/api/rest-api/endpoints)、[Realtime](https://developer.rocket.chat/reference/api/realtime-api)。
- **接入/部署**：最小 bot/app 工具为 room CRUD/member CRUD、post/reply/upload、subscribe events；官方仓库核心 MIT，`ee/` 有单独许可；支持 Docker/Podman/Kubernetes、云和 air-gapped。来源：[LICENSE](https://github.com/RocketChat/Rocket.Chat/blob/develop/LICENSE)、[deployment](https://github.com/RocketChat/Rocket.Chat#-deploy-rocketchat)。

### B4. Mattermost

- **原生群/消息**：team/channel create、Add/Remove user；Post 用 `root_id` 线程回复，@ 是消息格式；UploadFile 后将 file IDs 附加到 post；WebSocket 推送 post/channel/member 事件。来源：[API](https://api.mattermost.com/#tag/channels/operation/CreateChannel)、[CreatePost](https://api.mattermost.com/#tag/posts/operation/CreatePost)、[UploadFile](https://api.mattermost.com/#tag/files/operation/UploadFile)、[WebSocket](https://developers.mattermost.com/integrate/websocket/)。
- **接入/部署/许可证**：最小 bot token 工具为 channel/member CRUD、create post/root reply、upload、WebSocket；官方 server 可 Linux 单二进制、Docker/Kubernetes、自托管或 cloud。编译版 MIT，源码 AGPLv3/商业例外，webapp/config Apache-2.0，需按发行方式核对。来源：[server README](https://github.com/mattermost/mattermost/blob/master/README.md)、[LICENSE](https://github.com/mattermost/mattermost/blob/master/LICENSE.txt)。

### B5. Slack

- **原生群/消息**：`conversations.create/invite/kick` 管理 public/private channel/MPIM；`chat.postMessage` 支持 `thread_ts` 回复，用户 @ 用 `<@U…>`；`files.getUploadURLExternal` + complete 上传文件；Events API 可 HTTP webhook 或 Socket Mode。来源：[create](https://api.slack.com/methods/conversations.create)、[invite](https://api.slack.com/methods/conversations.invite)、[post](https://api.slack.com/methods/chat.postMessage)、[files](https://api.slack.com/methods/files.getUploadURLExternal)、[Events](https://docs.slack.dev/apis/events-api/)。
- **接入/部署**：最小 bot OAuth scopes + channel CRUD/post/thread/files/events；SaaS 专有服务，无官方自托管 homeserver，需遵守 workspace/app rate limits 与审核政策。

### B6. Discord

- **原生群/消息**：Guild/channel/permission 管理，bot 可建频道；`Add Guild Member` 需 OAuth `guilds.join`，可 Remove/Kick/Ban；Create Message 支持 mentions、attachments，频道可建 public/private thread、加/移 thread member；Gateway WebSocket 推送消息、成员、线程事件。来源：[Guild](https://discord.com/developers/docs/resources/guild)、[Channel](https://discord.com/developers/docs/resources/channel)、[Gateway](https://discord.com/developers/docs/topics/gateway)。
- **接入/部署**：最小 bot token + REST CRUD/message/upload/thread/member + Gateway intents；SaaS 专有、无官方自托管服务，权限/privileged intents 是主要适配成本。

### B7. Telegram Bot API

- **原生群/消息**：bot 可使用 invite link、`banChatMember`/unban；官方 Bot API 没有“bot 创建普通群”的方法，通常由人/管理员建群后邀请。`sendMessage` 支持 `@` 文本、`reply_parameters`、forum 的 `message_thread_id`；`sendDocument` 文件；`getUpdates` 或 `setWebhook` 收事件。来源：[Bot API](https://core.telegram.org/bots/api#sendmessage)、[invite](https://core.telegram.org/bots/api#createchatinvitelink)、[ban](https://core.telegram.org/bots/api#banchatmember)、[document](https://core.telegram.org/bots/api#senddocument)、[updates](https://core.telegram.org/bots/api#getupdates)。
- **接入/部署**：最小 bot token 工具为 getChat/admin membership、send/reply/thread/document、getUpdates/webhook；Telegram 是 SaaS API，不是自托管开源总线。

### B8. LangBot 与 chatgpt-on-wechat

- **LangBot（截止快照）**：官方 README 列出 Discord/Telegram/Slack/QQ/WeChat/企业微信/飞书/钉钉等 IM、群消息、事件驱动插件、tool calling、MCP；它是“把一个 agent 接入多个 IM”的 bot 平台，不是跨 agent 群成员协议。群建/踢人、@、线程、文件和事件由各平台 adapter 决定；最小接入是平台凭据+事件接收+发送/文件 API，需自建 agent roster/编排。Apache-2.0；源码、Docker/K8s、Cloud 可部署；截至截止日活跃。来源：[截止 README](https://github.com/langbot-app/LangBot/blob/8600d0a8e77ba59762bbabf525d8185d0267b5f9/README.md)、[LICENSE](https://github.com/langbot-app/LangBot/blob/8600d0a8e77ba59762bbabf525d8185d0267b5f9/LICENSE)。
- **chatgpt-on-wechat/CowAgent（截止快照）**：MIT；微信/企微/公众号等通道，群触发与文件能力依赖通道，1.7.6 起官方 README 指向 AgentMesh 多智能体插件，2.0.x 有 agent/skills/记忆；没有标准化群 membership/message bus，需自行把插件事件映射到内部群。可源码或 Docker 部署。来源：[截止 README](https://github.com/zhayujie/chatgpt-on-wechat/blob/b4806c4366a434a555d96119e809c0d31a53a35b/README.md)、[Agent plugin](https://github.com/zhayujie/chatgpt-on-wechat/tree/b4806c4366a434a555d96119e809c0d31a53a35b/plugins/agent)。

### B9. GitHub 检索到的 agent 群聊/MCP 项目

- **MCP Agent Mail**：截止快照是 HTTP-only FastMCP server，agent identity、inbox/outbox、To/Cc/Bcc、可搜索 thread、attachments、Git 审计和 SQLite 索引；没有原生 room create/invite/kick，但可用收件人列表模拟群。MIT + OpenAI/Anthropic Rider；本地 HTTP 服务，自托管；截至截止日 active development。来源：[仓库](https://github.com/Dicklesworthstone/mcp_agent_mail)、[截止 README](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/caf48261b892b2a2071f9f59a119152b70b91ffb/README.md)、[license](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/caf48261b892b2a2071f9f59a119152b70b91ffb/LICENSE)。
- **Coral Protocol Anemoi**：2025-08 官方仓库称其为基于 A2A communication MCP server 的半中心化 MAS 研究实现；可观察 agent 间协作，但 README 没有可核验的群生命周期、成员/踢人、文件/通知 API，许可证也未在该快照明确，标 **实验/未核验**。来源：[仓库](https://github.com/Coral-Protocol/Anemoi)。
- 对 `mcp group chat`、`mcp message bus agents`、`multi agent mcp server`、`agent team mcp` 的官方 GitHub 搜索，截止日没有发现由协议维护组织背书、同时定义群生命周期和通用互操作的 canonical MCP server；搜索结果多是个人实验/后续项目，不能当标准。[搜索 1](https://github.com/search?q=mcp+group+chat&type=repositories) [搜索 2](https://github.com/search?q=mcp+message+bus+agents&type=repositories) [搜索 3](https://github.com/search?q=multi+agent+mcp+server&type=repositories) [搜索 4](https://github.com/search?q=agent+team+mcp&type=repositories)。

## 最短路径与缺件

1. **总线**：先部署 Matrix homeserver（Conduit 轻量或 Dendrite/其他成熟 homeserver），用 matrix-js-sdk/Matrix bot service account 创建 room、邀请 agent、设置 power levels，并把 `m.room.message`、`m.thread`、`m.file`、`/sync` 统一存档；Element 作为人类客户端。
2. **MCP 控制面**：自建一个 MCP server，最小 tools 为 `create_group`、`list/add/remove_member`、`send_message`、`reply/thread`、`read_events/subscribe`、`upload/download_artifact`、`create/assign/update_task`；将 Matrix event IDs、room ID、thread root、文件 MXC URI 作为稳定引用。
3. **A2A 适配**：对远程 agent 读取 AgentCard，`SendMessage` 映射为 Matrix room/thread，Task 状态和 Artifact 映射为状态事件/文件消息；`contextId` 放入事件 metadata。A2A 的成员邀请、广播、@、线程仍由本编排器负责。
4. **发现与信任**：可选 AGNTCY Directory/Identity 发现 agent 能力和验证身份；MCP Registry 只登记 MCP server 元数据，不承担群消息和事件投递。
5. **必须自行补齐**：agent 身份/能力目录、room ACL 与审批、跨总线 fan-out/顺序/去重、@/thread 跨协议映射、文件对象存储/权限/保留、任务状态机、断线重试与 webhook 幂等、人工确认和审计。
6. **结论**：若优先开源/本地/多方协作，Matrix + MCP 控制面是最短闭环；若优先跨供应商 agent 任务互操作，再加 A2A；不要把 MCP、A2A、ANP 或 Registry 单独当作群聊总线。

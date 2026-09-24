# 多智能体群聊/小组协作框架调研

> 研究范围：多 agent 互相发言、协作编排、任务与外部互操作；能力证据固定到各仓库在 2026-02-28 前的官方 commit。项目名和 API 名保留英文。

## 总览

没有一个项目同时提供“AI 自建持久群、运行时邀请任意外部 agent、群内任务认领/状态机、共享 artifact、webhook”全套能力。主流框架大多是预配置的 supervisor、workflow 或 handoff，不是开放式群服务器。

最接近的能力分层是：CAMEL `Workforce`（AI 协调、运行时创建 worker、任务状态/事件）；AgentScope `MsgHub`（广播、运行时 `add/remove`）和 A2A 适配（远端 agent）；Agno `Team`/`TaskList`（分配、assignee、依赖和状态）；ChatDev 2.0（附件、artifact REST/WebSocket、运行状态）；A2A（跨框架任务、artifact、SSE/Push Notification）。实际产品应把 A2A 当外部成员协议，再自建 room/member/task/artifact/event 控制面。

**时间与元数据口径。** `curl` 调 GitHub REST `/repos/{owner}/{repo}` 已核实 stars、`pushed_at`、`license`、language、archived。下表是本机查询日 2026-09-22 的 live 值，GitHub REST 不提供历史 stars 快照，故不能冒充 2026-02 截面；截止敏感的能力判断均引用 2026-02-28 前 commit，并在各节给出截止前最近 commit 日期。API 值会继续变化。

|项目 repo|stars / pushed_at（live API）|license / language|截止前最近 commit|
|---|---|---|---|
|[microsoft/autogen](https://api.github.com/repos/microsoft/autogen)|61,105 / 2026-04-15|CC-BY-4.0（代码 MIT）/ Python|2025-10-04|
|[ag2ai/ag2](https://api.github.com/repos/ag2ai/ag2)|4,949 / 2026-09-21|Apache-2.0 / Python|2026-02-27|
|[crewAIInc/crewAI](https://api.github.com/repos/crewAIInc/crewAI)|58,887 / 2026-09-22|MIT / Python|2026-02-28|
|[langchain-ai/langgraph](https://api.github.com/repos/langchain-ai/langgraph)|42,108 / 2026-09-21|MIT / Python|2026-02-28|
|[langchain-ai/langgraph-supervisor](https://api.github.com/repos/langchain-ai/langgraph-supervisor)|1,656 / 2026-07-15|MIT / Python；当前 archived=true|2025-12-04|
|[langchain-ai/langgraph-swarm-py](https://api.github.com/repos/langchain-ai/langgraph-swarm-py)|1,569 / 2026-09-20|MIT / Python|2025-12-04|
|[geekan/MetaGPT](https://api.github.com/repos/geekan/MetaGPT)|70,547 / 2026-01-21|MIT / Python|2026-01-21|
|[OpenBMB/ChatDev](https://api.github.com/repos/OpenBMB/ChatDev)|34,358 / 2026-07-24|Apache-2.0 / Python|2026-02-27|
|[OpenBMB/AgentVerse](https://api.github.com/repos/OpenBMB/AgentVerse)|5,136 / 2024-09-09|Apache-2.0 / API language=JavaScript（源码主要 Python）|2024-09-09|
|[camel-ai/camel](https://api.github.com/repos/camel-ai/camel)|17,752 / 2026-09-20|Apache-2.0 / Python|2026-02-27|
|[agentscope-ai/agentscope](https://api.github.com/repos/agentscope-ai/agentscope)|32,149 / 2026-09-22|Apache-2.0 / Python|2026-02-15|
|[langroid/langroid](https://api.github.com/repos/langroid/langroid)|4,103 / 2026-09-17|MIT / Python|2026-02-28|
|[openai/openai-agents-python](https://api.github.com/repos/openai/openai-agents-python)|29,626 / 2026-09-22|MIT / Python|2026-02-28|
|[google/adk-python](https://api.github.com/repos/google/adk-python)|21,597 / 2026-09-22|Apache-2.0 / Python|2026-02-28|
|[a2aproject/A2A](https://api.github.com/repos/a2aproject/A2A)|25,886 / 2026-09-21|Apache-2.0 / API language=Shell|2026-02-26|
|[metauto-ai/GPTSwarm](https://api.github.com/repos/metauto-ai/GPTSwarm)|1,046 / 2026-02-05|MIT / Python|2026-02-05|
|[mastra-ai/mastra](https://api.github.com/repos/mastra-ai/mastra)|28,253 / 2026-09-22|API=NOASSERTION；仓库 LICENSE.md Apache-2.0 / TypeScript|2026-02-28|
|[pydantic/pydantic-ai](https://api.github.com/repos/pydantic/pydantic-ai)|20,109 / 2026-09-22|MIT / Python|2026-02-27|
|[VoltAgent/voltagent](https://api.github.com/repos/VoltAgent/voltagent)|10,660 / 2026-08-27|MIT / TypeScript|2026-02-28|
|[agno-agi/agno](https://api.github.com/repos/agno-agi/agno)|42,294 / 2026-09-22|Apache-2.0 / Python|2026-02-27|

## 项目逐项

### Microsoft AutoGen：RoundRobinGroupChat / SelectorGroupChat / Swarm / Magentic-One
- **群聊/选人：有。** `RoundRobinGroupChat` 轮询，`SelectorGroupChat` 用 LLM/自定义 selector，`Swarm` 由 `HandoffMessage` 转交，`MagenticOneGroupChat` 由 Orchestrator 计划、委派并追踪；消息在 team participant 间广播。[官方 teams 文档](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)；[截止前 group-chat 源码](https://github.com/microsoft/autogen/tree/13e144e5476a76ca0d76bf4f07a6401d133a03ed/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat)
- **成员/任务：部分。** participant 在构造时固定，Swarm 目标必须已在 participant 名单；未查到 AI 自己 `add/invite` 的官方 API。`run/run_stream` 返回 `TaskResult(messages, stop_reason)`，有 termination、pause/resume/state，但不是可认领的任务队列；Magentic-One 的 Task/Progress Ledger 是其内部编排。[Swarm 源码](https://github.com/microsoft/autogen/blob/13e144e5476a76ca0d76bf4f07a6401d133a03ed/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_swarm_group_chat.py)；[Magentic-One 文档](https://github.com/microsoft/autogen/blob/13e144e5476a76ca0d76bf4f07a6401d133a03ed/python/docs/src/user-guide/agentchat-user-guide/magentic-one.md)
- **文件/事件/接入：部分。** Magentic-One 有 `FileSurfer`、Coder 和新 artifact；`StructuredMessage` 支持 Pydantic 结构化消息；`run_stream`/agent events 可推送到宿主，但未查到通用 webhook 或共享 artifact store。外部 tool-only AI 必须包装成 `ChatAgent`/team participant，未查到 A2A 成员协议。[messages 源码](https://github.com/microsoft/autogen/blob/13e144e5476a76ca0d76bf4f07a6401d133a03ed/python/packages/autogen-agentchat/src/autogen_agentchat/messages.py)
- **语言/部署/活跃：** Python 与 .NET；可本地运行、AutoGen Studio/应用服务化。截止前最近 commit 2025-10-04；仓库文档 CC-BY-4.0、代码 MIT（API 根 license 显示 CC-BY-4.0）。[README](https://github.com/microsoft/autogen/blob/13e144e5476a76ca0d76bf4f07a6401d133a03ed/README.md)

### AG2 GroupChat
- **群聊/选人：有。** `GroupChat` 支持 agent 互发消息，`auto`、`manual`、`random`、`round_robin` 和自定义 speaker selector；还支持 swarm、nested/sequential patterns。[官方源码](https://github.com/ag2ai/ag2/blob/3e1f2295794dd8fbb5a9b3251c2c683ef0011221/autogen/agentchat/groupchat.py)；[README](https://github.com/ag2ai/ag2/blob/3e1f2295794dd8fbb5a9b3251c2c683ef0011221/README.md)
- **成员/任务：弱。** `agents` 是 GroupChat 配置列表，未查到受支持的运行时 add/remove 或 AI 自建群邀请；`max_round`、`ChatResult`/group events 只能表示一次对话运行，未查到 claim/assignment/status/task queue 生命周期。
- **文件/事件/接入：弱。** 消息和 function/tool call 可带结构化数据，文件需自行用 tool 处理；未查到共享 artifact store、通用 webhook 或外部 agent 加入协议。外部只会调用工具的 AI 需实现/包装 `ConversableAgent`。[agentchat 源码](https://github.com/ag2ai/ag2/tree/3e1f2295794dd8fbb5a9b3251c2c683ef0011221/autogen/agentchat)
- **语言/部署/活跃：** Python，Apache-2.0（原始部分另有 MIT 说明）；本地 Python，可自行服务化。截止前最近 commit 2026-02-27。[LICENSE/README](https://github.com/ag2ai/ag2/blob/3e1f2295794dd8fbb5a9b3251c2c683ef0011221/README.md)

### CrewAI Crew / Flows
- **群聊/选人：部分。** Crew 是 role-based team，不是公开广播群聊；`Process.hierarchical` 用 manager 按角色委派，未提供群内 peer speaker election。[Crew 文档](https://docs.crewai.com/en/concepts/crews)
- **成员/任务：部分。** agents/tasks 通常在 Crew 构造时声明，未查到运行时自增/移除或 AI 邀请外部成员。Task 有直接 agent、hierarchical assignment、async execution、guardrail、callback；有 task started/completed/failed events，但没有通用 claim/lease 状态机。[Task 文档](https://docs.crewai.com/en/concepts/tasks)；[task 源码](https://github.com/crewAIInc/crewAI/blob/c00a348837aab2b96c27080e2c9d682b66c88d90/lib/crewai/src/crewai/task.py)
- **文件/事件/接入：有局部能力。** `output_file`、`output_json`、`output_pydantic` 提供文件和结构化结果；Flows 有 `@start/@listen/@router`、event bus/callback，可接宿主通知，但未查到内置 webhook。LangGraph/OpenAI Agents 有 adapter，任意外部 tool-only AI 仍需适配 `BaseAgent`，不是直接成员。[Flows 文档](https://docs.crewai.com/en/concepts/flows)；[adapter 源码](https://github.com/crewAIInc/crewAI/tree/c00a348837aab2b96c27080e2c9d682b66c88d90/lib/crewai/src/crewai/agents/agent_adapters)
- **语言/部署/活跃：** Python/MIT；本地运行，也可接 CrewAI AMP/服务端。截止前最近 commit 2026-02-28；[README](https://github.com/crewAIInc/crewAI/blob/c00a348837aab2b96c27080e2c9d682b66c88d90/README.md)

### LangGraph supervisor / swarm
- **群聊/选人：否（编排式）。** supervisor 是中心 agent 通过 tools 路由/委派，swarm 是预定义 agents 间 handoff；不是广播群聊，也没有独立的群内 speaker election。[supervisor 源码 README](https://github.com/langchain-ai/langgraph-supervisor-py/blob/2f89ad0e2a8e6555f0d05b44abcecf525c31f746/README.md)；[swarm 源码 README](https://github.com/langchain-ai/langgraph-swarm-py/blob/73b0fe138cc5087142dde4c125c893209900a2e0/README.md)
- **成员/任务：弱。** agent 节点和 handoff 名称在 graph compile 前确定，未查到运行时 add/remove/self-invite。StateGraph 的 run、interrupt、checkpoint、stream 记录执行状态，但没有内置任务 claim/assignment/worker lease。
- **文件/事件/接入：部分。** graph state/store/checkpoint 可保存任意可序列化结构，工具可读写文件；streaming/update/custom events 与 LangGraph Platform 可服务化，但未查到共享 artifact 目录或 webhook。外部 tool-only AI 需包装为 node/tool。[LangGraph README](https://github.com/langchain-ai/langgraph/blob/79a75645cafaac57104bf22f2e25e7f1f659740e/README.md)
- **语言/部署/活跃：** Python/MIT；本地 CLI、LangGraph server/Platform。主仓库截止前最近 commit 2026-02-28；`langgraph-supervisor-py` 截止前 2025-12-04，当前 API 标记 archived；`langgraph-swarm-py` 同日 commit。[官方 core 源码](https://github.com/langchain-ai/langgraph/tree/79a75645cafaac57104bf22f2e25e7f1f659740e)

### MetaGPT
- **群聊/选人：部分。** `Environment.publish_message` 是 publish/subscribe 消息总线，Role 按 SOP/react 消费；是异步角色协作，不是自由群聊或通用 speaker selector。[Environment 源码](https://github.com/geekan/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/environment/base_env.py)
- **成员/任务：较强但需宿主调用。** `Team.hire`、`Environment.add_role/add_roles` 可运行时加入角色，但未查到 LLM 自己调用 hire/invite 的官方工具。`Task` 有依赖、`assignee`、`is_finished`、`is_success`；`Plan` 可增删/重排任务并 `finish_current_task`。[Team/schema 源码](https://github.com/geekan/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/team.py)；[Task/Plan 源码](https://github.com/geekan/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/schema.py)
- **文件/事件/接入：** CLI 默认写 `./workspace` 软件项目，Task 有 code/result 字段；未查到标准 artifact object、webhook 或外部 agent 协议。外部 tool-only AI 需包装为 Role/Action。
- **语言/部署/活跃：** Python/MIT；本地 Python/CLI，偏软件研发场景。截止前最近 commit 2026-01-21，之后未查到截止内新 commit。[README/License](https://github.com/geekan/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/README.md)

### OpenBMB ChatDev 2.0（legacy 1.0 另有 branch）
- **群聊/选人：部分。** 2.0 是 YAML graph/workflow 的 agent nodes，消息沿边流转、可 Map/Tree fan-out；不是开放群聊或 LLM speaker selector。README 将 1.0 描述为固定角色/phase 的 Virtual Software Company。[官方 README](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/README.md)
- **成员/任务：部分。** dynamic execution 可动态扩展节点实例，但不是新增 agent 身份；配置决定 agents/edges，未查到 AI 自建群或邀请外部 agent。DAG/cyclic scheduler 有节点执行和 session 状态，无 claim/assignment 生命周期。[dynamic execution](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/docs/user_guide/en/dynamic_execution.md)
- **文件/artifact/通知：强。** attachment REST、`WareHouse/<session>`、manifest、`artifact-events`，FastAPI WebSocket 推送 node state/log/artifact；这是外部通知能力，但不是通用 webhook。消息支持 text/image/audio/video/file blocks；provider/MCP 适配的是工具/模型，不是任意 agent 成员。[附件文档](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/docs/user_guide/en/attachments.md)；[架构文档](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/docs/user_guide/en/index.md)
- **语言/部署/活跃：** Python 后端 + 前端，Apache-2.0；Docker Compose/FastAPI、本地 SDK/服务。截止前最近 commit 2026-02-27。[License](https://github.com/OpenBMB/ChatDev/blob/6fe4fd1a0a27cbd690ba64431072c82c45495dce/LICENSE)

### OpenBMB AgentVerse
- **群聊/选人：部分。** task-solving environment 由 manager/role assigner/solver/critic/executor/evaluator 组成；simulation 有 visibility/order/selector 规则，可让多 agent 发言，但未查到通用 GroupChat API。[README](https://github.com/OpenBMB/AgentVerse/blob/f90c4bd9680fdd3bcff8c52c9170911a59b23478/README.md)
- **成员/任务：弱。** agents 从 task config 初始化；role assigner 只为固定 group members 生成角色/名字，未查到运行时 add/remove/self-invite。task description 贯穿多轮 rule，日志/评估存在，但无通用 claim/status/持久 task lifecycle。[AgentVerse 源码](https://github.com/OpenBMB/AgentVerse/tree/f90c4bd9680fdd3bcff8c52c9170911a59b23478/agentverse)
- **文件/事件/接入：弱。** tool response、memory、output parser 可扩展，未查到共享文件/artifact、webhook 或外部 agent protocol；外部 AI 需实现 `BaseAgent` 并注册/写配置。
- **语言/部署/活跃：** 源码主要 Python、Apache-2.0；本地 CLI/GUI；截止前最近 commit 2024-09-09，明显低活跃。[License](https://github.com/OpenBMB/AgentVerse/blob/f90c4bd9680fdd3bcff8c52c9170911a59b23478/LICENSE)

### CAMEL
- **群聊/选人：部分。** `RolePlaying` 是双 agent 对话；`Workforce` 是 coordinator-to-workers，含 single-agent/role-playing/team worker，不是任意 peer 广播群。coordinator 以 agent 决策委派。[Workforce 文档](https://docs.camel-ai.org/key_modules/workforce)
- **成员/任务：最强之一。** `Workforce` 可在任务无法处理时基于 `new_worker_agent` 模板运行时创建 worker，也有 worker 删除事件；这接近 AI 自己拉人，但新成员仍是 CAMEL `ChatAgent`。`Task`/`TaskChannel` 有 `OPEN/RUNNING/DONE/FAILED/DELETED`、依赖、`assigned_worker_id`、SENT/PROCESSING/RETURNED；支持 decomposition/assignment/complete/fail。[Workforce 源码](https://github.com/camel-ai/camel/blob/f8e4042dae4331a67196090b6edb3ad87659e12f/camel/societies/workforce/workforce.py)；[Task/事件源码](https://github.com/camel-ai/camel/blob/f8e4042dae4331a67196090b6edb3ad87659e12f/camel/tasks/task.py)
- **文件/事件/接入：** file toolkit、structured output handler 和任务内容可承载结果；`WorkforceCallback`/`TaskCreated/Assigned/Started/Updated/Completed/Failed` 可供宿主通知，未查到内置 webhook 或共享 artifact registry。外部 tool-only AI需包装 `ChatAgent/Worker`。[事件源码](https://github.com/camel-ai/camel/blob/f8e4042dae4331a67196090b6edb3ad87659e12f/camel/societies/workforce/events.py)
- **语言/部署/活跃：** Python/Apache-2.0；本地、Docker/runtime，支持多模型与 MCP。截止前最近 commit 2026-02-27。[README](https://github.com/camel-ai/camel/blob/f8e4042dae4331a67196090b6edb3ad87659e12f/README.md)

### Alibaba AgentScope
- **群聊/选人：有广播，选人需自编排。** `MsgHub` 把参与者消息广播给其他参与者；Pipeline/ChatRoom 可做 sequential/fanout/conversation，但未查到通用 LLM speaker selector。[MsgHub 源码](https://github.com/agentscope-ai/agentscope/blob/f6db16547215ea580e85e362126a5ea20fd54cd4/src/agentscope/pipeline/_msghub.py)
- **成员/任务：成员较强、任务较弱。** `MsgHub.add()`/`delete()` 支持运行时增减，AI 可在获得该对象的 tool 后自建/拉人；框架没有默认 invite/权限策略。Session/state 可保存 agent 状态，但未查到共享 claim/assignment/status task queue。[多 agent conversation 示例](https://github.com/agentscope-ai/agentscope/blob/f6db16547215ea580e85e362126a5ea20fd54cd4/examples/workflows/multiagent_conversation/README.md)
- **文件/事件/接入：较强。** `Msg` 支持 text/image/audio/video/tool blocks 与 JSON metadata；ChatRoom/server events 可流式给客户端。`A2AAgent` 可用 Agent Card 调远端 A2A agent，含 polling/streaming task，但文档明确 A2A 是 experimental 且不能完全对齐本地 agent。[A2A 源码](https://github.com/agentscope-ai/agentscope/blob/f6db16547215ea580e85e362126a5ea20fd54cd4/src/agentscope/agent/_a2a_agent.py)
- **语言/部署/活跃：** Python/Apache-2.0；本地、AgentScope Studio/服务和 A2A HTTP。截止前最近 commit 2026-02-15。[README](https://github.com/agentscope-ai/agentscope/blob/f6db16547215ea580e85e362126a5ea20fd54cd4/README.md)

### Langroid
- **群聊/选人：部分。** `Task` 是 agent/entity responders 的轮询路由，`RecipientTool` 可点对点发言；官方有 round-table 示例，但没有统一广播群或中央 speaker election。[Task 源码](https://github.com/langroid/langroid/blob/ce169711e87f88e6c3be48caf1d8c56dc61e8560/langroid/agent/task.py)
- **成员/任务：动态子任务较强。** `TaskTool` 是 LLM 可调用的 sub-agent spawner，可在运行时创建带工具、模型、名字的本地 `ChatAgent`；`Task.add_sub_task` 可组合子任务，但不是外部 agent 邀请。`DoneTool/FinalResultTool`、done sequences 和事件记录完成/返回，无 claim/lease 队列。[TaskTool 源码](https://github.com/langroid/langroid/blob/ce169711e87f88e6c3be48caf1d8c56dc61e8560/langroid/agent/tools/task_tool.py)；[delegation 文档](https://github.com/langroid/langroid/blob/ce169711e87f88e6c3be48caf1d8c56dc61e8560/docs/quick-start/multi-agent-task-delegation.md)
- **文件/事件/接入：** file tools、ToolMessage/Pydantic result 可传文件/结构化结果；callbacks/Chainlit 可通知，未查到标准 webhook、共享 artifact store 或 A2A 成员协议。MCP 主要是工具接入，外部 agent 仍需包装 `ChatAgent/Task`。
- **语言/部署/活跃：** Python/MIT；本地/CLI，也可接 Chainlit 等 UI。截止前最近 commit 2026-02-28。[README/License](https://github.com/langroid/langroid/blob/ce169711e87f88e6c3be48caf1d8c56dc61e8560/README.md)

### OpenAI Agents SDK
- **群聊/选人：否。** `handoff()` 是当前 agent 把控制权转给一个已声明的 agent，不是 peer broadcast 或 speaker election；一次 Runner loop 只有当前 active agent。[官方 handoffs 文档](https://github.com/openai/openai-agents-python/blob/5edf91a6c66586c45c64ddb1a0577fb1739ca9e3/docs/handoffs.md)
- **成员/任务：弱。** handoff target 在 Agent 配置，`is_enabled` 可动态开关但未查到 add/remove/self-invite。Runner/guardrail/tool loop 和 Session history 有运行/恢复边界，没有 claim/assignment/status task queue。[running agents](https://github.com/openai/openai-agents-python/blob/5edf91a6c66586c45c64ddb1a0577fb1739ca9e3/docs/running_agents.md)；[Session API](https://github.com/openai/openai-agents-python/tree/5edf91a6c66586c45c64ddb1a0577fb1739ca9e3/docs/ref/memory)
- **文件/事件/接入：部分。** input files、FileSearch/MCP tools 和 typed `output_type` 可用；`run_streamed` 有 agent-updated/handoff/tool events，未查到 webhook 或共享 artifact。外部 tool-only AI 可作为 MCP/function tool，但外部 agent 不能直接成为 handoff member。[streaming 文档](https://github.com/openai/openai-agents-python/blob/5edf91a6c66586c45c64ddb1a0577fb1739ca9e3/docs/streaming.md)
- **语言/部署/活跃：** Python/MIT；SDK 嵌入本地或任意 Python server。截止前最近 commit 2026-02-28。[README/License](https://github.com/openai/openai-agents-python/blob/5edf91a6c66586c45c64ddb1a0577fb1739ca9e3/README.md)

### Google ADK multi-agent
- **群聊/选人：部分。** `sub_agents` 树、LLM transfer parent/peer、`SequentialAgent`、`ParallelAgent`、`LoopAgent` 和 `AgentTool` 支持协作，但拓扑是树/流程，不是广播群或通用 speaker election。[ADK README/示例](https://github.com/google/adk-python/blob/8ddddc040ca10c75eca6752154773862069d9a1a/README.md)；[LlmAgent transfer 源码](https://github.com/google/adk-python/blob/8ddddc040ca10c75eca6752154773862069d9a1a/src/google/adk/agents/llm_agent.py)
- **成员/任务：部分。** `sub_agents` 在构造时声明，未查到运行时 add/remove/self-invite；ADK Session/Event/State 管执行历史但没有公共 claim/assignment task queue。若通过 A2A 接远端 agent，任务能力见下一节。
- **文件/事件/接入：取决于 A2A。** ADK 本身以 events/session/tool 传递内容；外部只会调用工具的 AI 需封装 tool/agent。语言/部署为 Python、本地或 server/Google 托管运行；Apache-2.0，截止前最近 commit 2026-02-28。

### A2A protocol（Google 发起、Linux Foundation 项目）
- **群聊/选人：否。** A2A 是 agent-to-agent 点对点任务协议，不定义群房间或 speaker election；Agent Card 用于发现能力。[官方 specification](https://a2a-protocol.org/latest/specification/)
- **成员/任务：协议级强。** `message/send` 创建 Task，支持任务查询、列表、取消、订阅；Task 有 submitted/working/input-required/completed/canceled/failed 等状态，适合把外部 agent 当可寻址成员，但没有 room membership/claim arbitration。[任务生命周期](https://a2a-protocol.org/latest/topics/life-of-a-task/)
- **artifact/通知/接入：最强。** Message Part 支持 text/file/data，Task 可含 durable `Artifact`；支持 JSON-RPC/REST、SSE streaming 和 Push Notifications。任何实现 Agent Card 与协议的 agent 可互通，但“只会调用工具”的 AI 仍需一个 A2A adapter/server。[官方 README](https://github.com/a2aproject/A2A/blob/4890b77d6fdfa7bf6c8c6558d24ff92a240c7c0a/README.md)
- **语言/部署/活跃：** 协议语言无关，官方规范仓库 API language 标签为 Shell；Apache-2.0；可本地或 HTTP 服务部署。截止前最近 commit 2026-02-26。

### GPTSwarm
- **群聊/选人：否。** 这是 graph-based nodes/agents，边决定数据流；optimizer 可自组织边，但不是群消息广播或发言人选择。[README](https://github.com/metauto-ai/GPTSwarm/blob/c23a827f561c934ce21dd950408f7606aa4a8821/README.md)；[Graph 源码](https://github.com/metauto-ai/GPTSwarm/blob/c23a827f561c934ce21dd950408f7606aa4a8821/swarm/graph/graph.py)
- **成员/任务：弱。** `Graph.add_node` 是宿主代码 API，Swarm 依据 `AgentRegistry`/agent_names 组装；没有 AI 运行时 invite/claim/status lifecycle，只有 graph `run(num_steps)` 与 node inputs/outputs。
- **文件/事件/接入：弱。** README 示例可给 file analyzer 输入文件；未查到 artifact、webhook、事件总线或外部 agent protocol。自定义 agent 必须实现框架接口/注册。
- **语言/部署/活跃：** Python/MIT；本地研究框架。截止前最近 commit 2026-02-05。[License](https://github.com/metauto-ai/GPTSwarm/blob/c23a827f561c934ce21dd950408f7606aa4a8821/LICENSE)

### Mastra
- **群聊/选人：部分。** Agent Network/supervisor 由 routing agent 在已配置的 agents/workflows/tools 中决定委派顺序；不是 peer broadcast 或 speaker election。[supervisor 文档](https://mastra.ai/docs/agents/supervisor-agents)；[network 文档](https://mastra.ai/docs/agents/networks)
- **成员/任务：部分。** `agents` 配置对象固定 primitive，delegation hooks 能改 prompt/maxSteps/feedback/bail，但未查到运行时 add/remove/self-invite。Workflow 有 typed steps/state、retry/stream、suspend/resume snapshot，能表达任务生命周期，却不是共享 claim queue。[workflow 文档](https://mastra.ai/docs/workflows/overview)；[suspend/resume](https://mastra.ai/docs/workflows/suspend-and-resume)
- **文件/事件/接入：较强。** Zod input/output schemas、storage 和 MCP/file tools 可产出结构化数据；stream 有 routing/agent/workflow/step/finish events。官方 client SDK 有 A2A Agent Card、`message/send`、SSE、`tasks/get/cancel`，所以可与 A2A agent 互调，但未查到 A2A agent 动态加入本地 network 或通用 webhook。[A2A client 源码](https://github.com/mastra-ai/mastra/blob/9e77e8f0e823ef58cb448dd1f390fce987a101f3/client-sdks/client-js/src/resources/a2a.ts)
- **语言/部署/活跃：** TypeScript/Node；可 standalone server、现有 Node/React/Next.js、workflow runners/cloud；仓库 LICENSE.md Apache-2.0（GitHub API SPDX=NOASSERTION）。截止前最近 commit 2026-02-28。[README/License](https://github.com/mastra-ai/mastra/blob/9e77e8f0e823ef58cb448dd1f390fce987a101f3/README.md)

### PydanticAI
- **群聊/选人：否。** 官方 multi-agent patterns 是 agent delegation（agent-as-tool）、programmatic handoff、graph/FSM，不是群聊/发言人选择。[multi-agent 文档](https://ai.pydantic.dev/multi-agent-applications/)
- **成员/任务：部分。** delegate agent 和 graph nodes 可在代码/工具中组合，未查到运行时 room add/remove 或 AI invite。`pydantic-graph` 有 typed state、`End`、persistence；Deep Agents 工具集有 planning/task management/file operations，但没有跨 agent claim/lease 服务。[graph 文档](https://ai.pydantic.dev/graph/)
- **文件/事件/接入：较强但非群。** Pydantic typed output、file toolsets、deferred tools 和 event stream；官方 `FastA2A` 可把 agent 暴露为 A2A server，Task storage 保存 status/artifacts，结构化 Pydantic result 转 DataPart。A2A server 仍需外部 room 才能群协作。[A2A 文档](https://github.com/pydantic/pydantic-ai/blob/94dc8f888bf5ff20478c43d737e76d5756cb3f1d/docs/a2a.md)；[A2A 源码](https://github.com/pydantic/pydantic-ai/blob/94dc8f888bf5ff20478c43d737e76d5756cb3f1d/pydantic_ai_slim/pydantic_ai/_a2a.py)
- **语言/部署/活跃：** Python/MIT；本地 Python/ASGI，亦可用 durable execution 后端。截止前最近 commit 2026-02-27。[README/License](https://github.com/pydantic/pydantic-ai/blob/94dc8f888bf5ff20478c43d737e76d5756cb3f1d/README.md)

### VoltAgent
- **群聊/选人：部分。** Supervisor runtime 路由 specialized sub-agents；不是广播群或 peer speaker election。[官方 README](https://github.com/VoltAgent/voltagent/blob/7f228b98ea1aa818c292adf54a5bd9c075eca3ae/README.md)
- **成员/任务：动态本地成员。** `SubAgentManager.addSubAgent/removeSubAgent` 可由宿主运行时改成员，PlanAgent 的 `task` tool 可生成短生命周期 sub-agent；未查到 AI 自己把外部 agent 邀入持久 room。Workflow/PlanAgent 有 todo、suspend/resume，workflow result 状态为 completed/suspended/cancelled/error。[subagent 源码](https://github.com/VoltAgent/voltagent/blob/7f228b98ea1aa818c292adf54a5bd9c075eca3ae/packages/core/src/agent/subagent/index.ts)；[workflow types](https://github.com/VoltAgent/voltagent/blob/7f228b98ea1aa818c292adf54a5bd9c075eca3ae/packages/core/src/workflow/types.ts)
- **文件/事件/接入：较强但仍需适配。** PlanAgent filesystem、typed tools/streams、timeline events；官方 `@voltagent/a2a-server` 暴露 Agent Card、message/task endpoints，可让 A2A client 调用并看到 completed task，但这是单 agent server，不是动态群成员。未查到通用 webhook。[A2A 示例](https://github.com/VoltAgent/voltagent/tree/7f228b98ea1aa818c292adf54a5bd9c075eca3ae/examples/with-a2a-server)
- **语言/部署/活跃：** TypeScript/Node/MIT；本地 server、serverless/VoltOps observability。截止前最近 commit 2026-02-28。[README](https://github.com/VoltAgent/voltagent/blob/7f228b98ea1aa818c292adf54a5bd9c075eca3ae/README.md)

### Agno Team / Workflows
- **群聊/选人：部分。** Team leader 依据 `mode`/成员描述委派，可 `delegate_to_all_members` 并选择是否分享 member interactions；不是 peer broadcast/elected speaker。[Team 源码](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/libs/agno/agno/team/team.py)
- **成员/任务：最完整之一。** `members` 可是 list 或按 run 生成 list 的 callable，宿主可动态供给成员；未查到 AI 自己 add/remove 外部成员。`mode=tasks` 内置 `TaskList`/tools：create、assignee、dependencies，状态 pending/in_progress/completed/failed/blocked，且可列出/更新，接近用户要的任务生命周期。[Task 源码](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/libs/agno/agno/team/task.py)；[task tools](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/libs/agno/agno/team/_task_tools.py)
- **文件/事件/接入：强但不是开放群。** Team 支持 Pydantic `output_model`、File/Image/Audio/Video、member/run events、pause/continue；`RemoteTeam`/A2A client 支持远端 team、文件和 task stream。未查到通用 webhook或任意非-A2A tool-only AI 直接加入。[RemoteTeam/A2A 源码](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/libs/agno/agno/team/remote.py)
- **语言/部署/活跃：** Python/Apache-2.0；本地、AgentOS API、A2A remote team。截止前最近 commit 2026-02-27。[README/License](https://github.com/agno-agi/agno/blob/bbb213d33933d072fefd6802936e5007cc797a00/README.md)

## 结论：选型与共同缺口

- **若优先“群广播+运行时增减成员”：** AgentScope `MsgHub` 最直接；再接 A2AAgent，把远端 agent 转成成员。它仍缺任务 claim/lease、权限和持久 room。
- **若优先“AI 自主拆解、增 worker、任务状态回报”：** CAMEL `Workforce` 最接近；Agno `TaskList` 在状态/依赖/assignee 更清晰。两者的成员仍是框架 agent，外部互操作需另接 A2A。
- **若优先“外部任意框架 agent、文件/artifact、异步通知”：** A2A 是唯一明确的开放协议；PydanticAI、AgentScope、Mastra、VoltAgent、Agno 已有不同程度 A2A 支持，但 A2A 本身不提供群房间。
- **共同缺口：** 持久 room/member registry 与邀请/准入/身份；跨框架能力声明和“只会调用工具”的 agent adapter；可认领任务的 lease/retry/dependency/audit；共享 artifact 版本、权限和引用；统一事件 schema、webhook/Push、断线重放；多租户、资源配额和安全隔离。上述均未在单一项目中查证为完整内置能力。

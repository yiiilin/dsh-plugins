# mentor

Internal module of `@yiln-dsh/dsh-plugins`. Install and release the root package;
this module has no separate npm package or version. Loader row: `dsh-mentor`.
See the [root README](../../README.md) for installation, migration and testing.

把一个独立、按需唤醒的 DSH Agent 注册为主 Agent 可调用的 `mentor` 工具。工具和引导只安装在 root Agent scope；子 Agent 不会拿到它。没有 Mentor 工具调用时不会创建导师 Agent 或发起导师模型请求。

Mentor 只有**一份全局设置**（本插件自己的配置行）。模型路由、思考强度、超时、并发和工具开关都不再按会话区分；会话级 `Mentor` 标签只展示该会话的历史记录。

## 配置

插件默认关闭。安装到 `web` profile 后，在对应 `dsh-mentor` 行启用插件；`provider`/`model` 可留空以使用 DSH 全局模型目录默认值，也可作为全局回退路由：

```yaml
- id: dsh-mentor
  name: '@yiln-dsh/dsh-plugins/mentor'
  inject:
    - tools
    - agents
    - agentLoop
    - commands
    - connection
    - sessions
    - sessionPersistence
    - sessionController
    - settings
    - systemPrompt
  config:
    enabled: true
    provider: '' # 可留空，使用 DSH ModelCatalog 默认值
    model: ''
    reasoningEffort: '' # 可留空，使用 Profile/模型默认值
    maxInputBytes: 98304
    requestTimeoutMs: 300000
    globalConcurrency: 2
```

所有字段都是全局的，也被 **Settings > Plugins > Mentor** 页面读写（见下）。service tier/priority 沿用所选模型的 Profile 配置。直接改 YAML 后重启 DSH Web daemon。

### 不再有生成/输入/上下文/输出/回复上限

插件不再限制每个会话的生成次数、单次输入、完整上下文、输出 tokens 或回复字节数，也不会向 provider 传 `maxTokens`。这些量仍然被测量并写入该会话的 Mentor journal，只是不再拦截：

| journal 字段 | 含义 |
| --- | --- |
| `consultation-accepted.newInputBytes` | 本次提交的 message + evidence 的 UTF-8 序列化字节数（`inputMeasureMode: serialized-json-utf8-bytes`）。 |
| `consultation-dispatched.contextUpperBoundBytes` | 实际派发请求的保守 JSON/UTF-8 字节上界（`contextMeasureMode: serialized-json-utf8-upper-bound`），`requestMaxTokens` 记录请求自带的输出上限（没有则不写）。 |
| `consultation-settled.replyUtf8Bytes` | 导师最终回复的 UTF-8 字节数。 |
| `consultation-settled.usage` / `consultation-indeterminate.usage` | provider 报告的 token 用量；未报告时保持 `null` 与 `unknown`。 |

同一主 Session 的咨询按提交顺序串行运行；超过 `globalConcurrency` 的请求在运行时等待，等待可取消。`requestTimeoutMs` 从开始实际咨询时计时，不包含排队时间。一次调用成功、失败、取消或超时并释放 child 后结束，历史 journal 的未决/未送达状态不占用运行锁，也不再返回永久 `THREAD_BUSY`。工具参数仍保留 schema 级字符/字节边界（`maxInputBytes`）。

首次咨询只需 `message`。可选的 `evidence` 接收 `id`、`kind`、`source`、`content`；来源只是主 Agent 提供的标签，不会触发文件或 URL 读取。每个主 Session 自动使用一个 Mentor 线程；成功且已送达的上下文可继续。旧线程有失败、未决或未送达记录时，新调用自动封存并新建干净线程，无需 `/mentor reset`；手工 reset 或配置变化也会封存。提交的 message/evidence 会发送给可信配置中的 provider；不要提交凭据或不应外发的数据。

## 界面

- **会话标签**：Web Client 在原生“对话 / 轨迹”旁增加会话级 `Mentor` 标签（Conversation 视图顺序 30），显示最近 20 条已完成咨询、提交的问题、可折叠证据、回复和交付状态。它只读历史，不提供任何设置。
- **全局设置页**：`Settings > Mentor`。插件注册自己的 `settings.section`（顺序 25，紧随“智能体预设”），页面读写本插件的 `dsh-mentor` 配置行：启用开关、模型（从当前 DSH `ModelCatalog` 选择，或使用目录默认值）、思考强度、单次超时、全局并发。同一页面也会作为 `settings.plugins.tab` 出现在“内置插件”分区（存在 `configForms` 时）。写入通过 Host `settings` 服务落到当前 profile 的 patch 文件，并由 Loader 热应用；并发编辑导致 revision 冲突时页面会重新加载并提示再次保存。只读部署会显示不可写提示。

设置是全局的：任何会话、任何线程共享同一份值。`/mentor reset` 只封存线程，不动设置。

## 隔离与恢复

Mentor 使用新 Agent Session，不复制父 transcript，也不传入 workspace `cwd`。完成每次咨询后释放 AgentHandle，下次调用从持久 Session 恢复；逻辑线程由 journal 保留。`mentor` 工具和使用引导只注册在 root Agent scope，嵌套 Agent 会隐藏继承的 Mentor 工具，并在执行入口再次拒绝非 root 调用。每次请求只含 Mentor 固定 system prompt、本线程已完成历史和本次显式提交的输入。系统提示采用完整覆盖，并请求禁用 runtime context；Agent scope 强制 native、限制继承工具、安装单调拒绝 guard，并在 DSH `llm/stream` 边界检查最终请求的路由、消息和工具集。任意工具 schema 或非导师消息会在 provider dispatch 前拒绝；即使模型输出伪造工具调用也不会执行。

**runtime context 例外（DSH 0.2.1）。** `suppressRuntimeContext()` 在 DSH 0.2.1 上不再移除标为 `required: true` 的动态 context：`dsh-working-directory` 的 `working-directory:current` 会继续进入 Agent surface，`SystemPrompt.refreshContext()` / `assemble()` 也会在抑制状态下保留它。因此子会话会多出一条 DSH 自有的 `runtime-context` 快照，并随请求发给 provider。校验只放行**子会话已记录且 id 匹配**的这类快照（`source.kind === 'runtime-context'` 且 `form === 'snapshot'`）；未记录的快照、其他任何来源的用户消息，以及 assistant 路由不符仍然一律在 dispatch 前拒绝。这个例外使 0.2.0-rc.2 与 0.2.1-alpha.2 都能通过同一套校验。

这不是同进程插件沙箱。其他受信插件仍可能改变 Agent 组合；提交给导师的文字仍可能包含语义上的 prompt injection。证据被当作 JSON 数据编码，不会因反引号或 Markdown fence 关闭边界。建议仍由主 Agent 自行验证和执行。

导师 Session 保存对话；独立的 DSH 持久化 journal 保存线程、幂等状态、记录到的度量，以及用于 PTC/工具结果丢失恢复的规范回复副本。未知 journal 事件带 `ignorable: true`，不写入父 Session 的未知事件类型。冷 journal 不带 `cwd`，当前 Web controller 的普通会话列表会隐藏它，但它仍能被 `sessionPersistence.list()` / `sessionQuery.listSessions()` 等受信代码发现；它不是私密存储，DSH 也没有通用删除或保留期 API。只有父 Session 记录了与规范回复一致的成功工具结果，旧线程才会继续；结果未落盘、被策略改写或作为错误返回时，不会把父 Agent 未收到的建议带进下一轮。RC.2 若把未完成的父工具调用修复成 `TOOL_OUTCOME_UNKNOWN`，但 journal 已持久化了完成结果，完全相同的规范输入可用新 `callId` 重放该结果而不再生成；人工 reset 会提升 epoch 并关闭这条恢复路径。

本主 Session 可用 Web slash command `/mentor status` 查看状态，用 `/mentor reset` 封存当前线程并开始新线程。`/mentor reset` 同样排队，作为先前与后续咨询之间的屏障；取消后不写入 reset。新输入开始时尚未观察到父结果的成功记录标为未送达并保留原因；迟到交付可更新交付事实，但不重新启用已封存线程。状态行报告路由、当前线程、已派发生成次数（无上限，仅记录）、provider usage、待交付与未送达计数。这依赖 `dsh-commands` 与交互式 Web adapter；headless、ACP、JSON-RPC 和 `dsh mentor ...` CLI 命令不在支持范围。

## 已知边界

- 度量用 JSON/UTF-8 序列化字节数，不是 provider tokenizer 的精确 token 计数。这可能较保守，也不是任意 provider 的通用 token 证明。
- 若 provider usage 未报告，结果会保留 `null` 和 `unknown`，不会记成零。`cost_estimate_usd` 当前始终为 `null`；未实现货币预算或价格表。
- 取消、超时或失败结束当前调用，下一条新调用可以继续；等待前一条 child 收敛并释放后才开始下一次咨询。插件仍在 Agent 请求边界停用循环级重试，adapter 内部是否重试及远端取消是否停止计费由 provider 决定。
- 历史未决状态保留为事实。相同 host `callId` 先从原线程恢复结果，没有完整回复时报告旧调用结果不确定，不自动再次生成；使用新的工具调用可重新咨询。同规范输入存在已完成但未送达结果时优先重放，不同输入自动换干净线程。等待取消不产生咨询 journal，插件关闭时终止等待队列。
- guard 在 `llm/stream` 边界同步拒绝时，AgentLoop 可能尚未发出任何 assistant-stream 帧；此时错误以子会话已记录的 `turn/end` 原因上报，而不是泛化的 `MENTOR_INCOMPLETE`，便于区分本地违规与上游故障。
- Native 工具结果以简洁文本展示导师回复和线程标识；顶层 `tool/result` 的 presentation metadata 保存规范结果，nested PTC 不提供该 metadata，恢复时从 journal 与已持久化的 Mentor turn 重建。真实 `ptc` nested dispatch 尚未联调。
- Mentor 子 Session 带 `origin: subagent` 和 `parentSession` 以保留 Agent runtime parent 关系，但不创建 SubagentRuntime Activation/descriptor；Web daemon 若在它运行时重启，可能把它报告为不可续传。插件只在下一次显式 `mentor` 调用时直接恢复日志，不会自动补发模型请求。
- 全局设置写入 profile patch 需要 `dsh-settings` 与 `dsh-config-editor` 两个 Host 服务；缺少任一时设置页显示只读，可直接编辑 YAML。
- 统一根包当前只声明对 DSH `0.2.0-rc.2` 的兼容；旧独立包的历史验证见兼容性记录。统一包的页面、设置、模型调用与恢复以对应隔离测试记录为准。

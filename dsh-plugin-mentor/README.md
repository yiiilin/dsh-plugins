# @yiln-dsh/dsh-plugin-mentor

把一个独立、按需唤醒的 DSH Agent 注册为主 Agent 可调用的 `mentor` 工具。工具和引导只安装在 root Agent scope；子 Agent 不会拿到它。没有 Mentor 工具调用时不会创建导师 Agent 或发起导师模型请求。

Mentor 只有**一份全局设置**（本插件自己的配置行）。模型路由、思考强度、超时、并发和工具开关都不再按会话区分；会话级 `Mentor` 标签只展示该会话的历史记录。

## 配置

插件默认关闭。安装到 `web` profile 后，在对应 `dsh-mentor` 行启用插件；`provider`/`model` 可留空以使用 DSH 全局模型目录默认值，也可作为全局回退路由：

```yaml
- id: dsh-mentor
  name: '@yiln-dsh/dsh-plugin-mentor'
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

仍然生效的只有两个运行保护：`globalConcurrency`（同时进行的咨询数）和 `requestTimeoutMs`（单次超时）。工具参数本身仍有 schema 级字符/字节边界（`maxInputBytes`）。

首次咨询只需 `message`。可选的 `evidence` 接收 `id`、`kind`、`source`、`content`；来源只是主 Agent 提供的标签，不会触发文件或 URL 读取。每个主 Session 自动使用一个 Mentor 线程，`/mentor reset` 或配置变化时才封存并新建线程。提交的 message/evidence 会发送给可信配置中的 provider；不要提交凭据或不应外发的数据。

## 界面

- **会话标签**：Web Client 在原生“对话 / 轨迹”旁增加会话级 `Mentor` 标签（Conversation 视图顺序 30），显示最近 20 条已完成咨询、提交的问题、可折叠证据、回复和交付状态。它只读历史，不提供任何设置。
- **全局设置页**：`Settings > Mentor`。插件注册自己的 `settings.section`（顺序 25，紧随“智能体预设”），页面读写本插件的 `dsh-mentor` 配置行：启用开关、模型（从当前 DSH `ModelCatalog` 选择，或使用目录默认值）、思考强度、单次超时、全局并发。同一页面也会作为 `settings.plugins.tab` 出现在“内置插件”分区（存在 `configForms` 时）。写入通过 Host `settings` 服务落到当前 profile 的 patch 文件，并由 Loader 热应用；并发编辑导致 revision 冲突时页面会重新加载并提示再次保存。只读部署会显示不可写提示。

设置是全局的：任何会话、任何线程共享同一份值。`/mentor reset` 只封存线程，不动设置。

## 隔离与恢复

Mentor 使用新 Agent Session，不复制父 transcript，也不传入 workspace `cwd`。完成每次咨询后释放 AgentHandle，下次调用从持久 Session 恢复；逻辑线程由 journal 保留。`mentor` 工具和使用引导只注册在 root Agent scope，嵌套 Agent 会隐藏继承的 Mentor 工具，并在执行入口再次拒绝非 root 调用。每次请求只含 Mentor 固定 system prompt、本线程已完成历史和本次显式提交的输入。系统提示采用完整覆盖，禁用 runtime context；Agent scope 强制 native、限制继承工具、安装单调拒绝 guard，并在 DSH `llm/stream` 边界检查最终请求的路由、消息和工具集。任意工具 schema 或非导师消息会在 provider dispatch 前拒绝；即使模型输出伪造工具调用也不会执行。

这不是同进程插件沙箱。其他受信插件仍可能改变 Agent 组合；提交给导师的文字仍可能包含语义上的 prompt injection。证据被当作 JSON 数据编码，不会因反引号或 Markdown fence 关闭边界。建议仍由主 Agent 自行验证和执行。

导师 Session 保存对话；独立的 DSH 持久化 journal 保存线程、幂等状态、记录到的度量，以及用于 PTC/工具结果丢失恢复的规范回复副本。未知 journal 事件带 `ignorable: true`，不写入父 Session 的未知事件类型。冷 journal 不带 `cwd`，当前 Web controller 的普通会话列表会隐藏它，但它仍能被 `sessionPersistence.list()` / `sessionQuery.listSessions()` 等受信代码发现；它不是私密存储，DSH 也没有通用删除或保留期 API。只有父 Session 记录了与规范回复一致的成功工具结果，旧线程才会继续；结果未落盘、被策略改写或作为错误返回时，不会把父 Agent 未收到的建议带进下一轮。RC.2 若把未完成的父工具调用修复成 `TOOL_OUTCOME_UNKNOWN`，但 journal 已持久化了完成结果，完全相同的规范输入可用新 `callId` 重放该结果而不再生成；人工 reset 会提升 epoch 并关闭这条恢复路径。

本主 Session 可用 Web slash command `/mentor status` 查看状态，用 `/mentor reset` 封存当前线程并开始新线程。状态行报告路由、当前线程、已派发生成次数（无上限，仅记录）、provider usage、待交付与未送达计数。这依赖 `dsh-commands` 与交互式 Web adapter；headless、ACP、JSON-RPC 和 `dsh mentor ...` CLI 命令不在支持范围。

## 已知边界

- 度量用 JSON/UTF-8 序列化字节数，不是 provider tokenizer 的精确 token 计数。这可能较保守，也不是任意 provider 的通用 token 证明。
- 若 provider usage 未报告，结果会保留 `null` 和 `unknown`，不会记成零。`cost_estimate_usd` 当前始终为 `null`；未实现货币预算或价格表。
- 取消、超时与重试语义不变：插件会在 Agent 请求边界停用循环级重试。provider adapter 内部是否重试、远端取消是否停止计费仍由 adapter/provider 决定；真正派发状态不明的调用不会重新生成。若 journal 已证明生成完成但父结果丢失，只对完全相同的规范输入重放已保存结果；不同输入在原结果未交付时会转到空线程，不继承未见过的建议。
- Native 工具结果以简洁文本展示导师回复和线程标识；顶层 `tool/result` 的 presentation metadata 保存规范结果，nested PTC 不提供该 metadata，恢复时从 journal 与已持久化的 Mentor turn 重建。真实 `ptc` nested dispatch 尚未联调。
- Mentor 子 Session 带 `origin: subagent` 和 `parentSession` 以保留 Agent runtime parent 关系，但不创建 SubagentRuntime Activation/descriptor；Web daemon 若在它运行时重启，可能把它报告为不可续传。插件只在下一次显式 `mentor` 调用时直接恢复日志，不会自动补发模型请求。
- 全局设置写入 profile patch 需要 `dsh-settings` 与 `dsh-config-editor` 两个 Host 服务；缺少任一时设置页显示只读，可直接编辑 YAML。
- 兼容性 peer window 覆盖 DSH `0.1.5-rc.2` 起的 `0.1.5` 线，以及 `0.1.7-rc.1`；RC.1 已通过隔离 Web profile E2E。未声明对历史 alpha 或其他 DSH 版本的兼容。

## 安装与测试

已发布版本：`@yiln-dsh/dsh-plugin-mentor@0.2.1`。工具只接受 `message` 与可选的 `evidence`；线程由主 Session 自动管理，升级已有本地安装不改变历史 journal 和结果格式。

从 npm 安装：

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-mentor@0.2.1
```

工作区开发也可使用本地路径：

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-mentor
```

运行：

```bash
npm test
```

测试使用 fake Agent、SessionPersistence、settings 服务和 LLM stream，覆盖输入校验、JSON evidence 隔离、消息/turn/finish 关联、零工具断言、持久化 journal、幂等回放、跨 Session 隔离、reset、全局设置的读写/冲突/只读、度量记录和 usage 缺失。它不发起真实模型请求，不证明 provider HTTP wire payload，也不替代当前 profile 的安装联调。

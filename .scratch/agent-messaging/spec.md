# 跨机 agent 通信 —— 设计

状态：设计，未实现。
前置：[ADR 0003](../docs/adr/0003-federation-over-ssh-environments.md)（联邦取代 SSH）、
`docs/changes/federation-decisions.md`（Q39：可给主端加联邦工具）。
相关：`pkgs/gateway`（隧道与 `/admin`）、`GLOSSARY.md`（§7 需要新增术语）。

## 0. 需求

操作者原话：

> 联邦网关能否提供，不同dsh的session的agent之间的相互通信，我看这个会话ID是UUID的，
> 基本不会冲突，能否根据这个UUID去相互通信，像dsh-bot那样，提供tool

拆成可验证的要求：

| # | 要求 | 判据 |
| --- | --- | --- |
| R1 | 任意两点互通 | 主节点 → 边端、边端 → 主节点、边端 A → 边端 B 都能投递 |
| R2 | 按 `envId + sessionId` 寻址 | 一个跨机 tool 参数同时给出环境与 UUID，不广播查找 |
| R3 | 模仿 dsh-bot | 走 `sessionController.prompt({ mode: 'queue' })`，投递即返回 |

操作者已定的取舍（2026-11-06）：

| # | 决定 |
| --- | --- |
| D1 | 范围是**任意两点**，不止主↔边 |
| D2 | 寻址用 `envId + sessionId`，不是裸 UUID |
| D3 | 行为模仿 dsh-bot：异步投递，立即返回 |

## 1. 已核实的事实（2026-11-06，非推演）

这些事实决定了实现形态，逐条都有出处：

1. **会话 ID 是 UUID**。磁盘上是 `session-<uuid>`，
   `<DSH_HOME>/sessions/<workspace>/session-99144949-9e4e-4d5b-b002-17abc33fa325/`。
   跨机冲突概率可忽略。
2. **投递接口存在**：`ctx.sessionController.prompt(request, signal)`，
   `request = { requestId, sessionId, mode: 'queue'|'steer', content, clientTimeZone? }`，
   返回 `{ accepted: true }`。
   （`dsh-api-session-controller/lib/types/types.d.ts:312`）
3. **它会唤醒休眠会话**：`commands.prompt` 先 `resolveAgent(sessionId)`，再
   `agent.followup(message)`（`mode: 'queue'`）或 `agent.steer`。会话不必在运行。
4. **dsh-bot 正是这么做的**，可直接照抄：
   ```js
   await ctx.sessionController.prompt({
     requestId: randomUUID(), sessionId, mode: 'queue',
     content: [{ type: 'text', text }],
   }, AbortSignal.timeout(30_000))
   ```
   （`node_modules/ds-bot/src/host/channel.js:457`）
5. **工具能拿到自己的会话 ID**：`Execution` 上下文带 `agent?: Agent`，而
   `Agent` 有 `readonly id: SessionId`。
6. **隧道可承载任意请求**：`hub.request(envId, { method, path, headers, body })`
   支持非 GET；`relay()` 会带上 `x-dsh-federation` 头与 body。
7. **`/admin` 对隧道已授权——但只在边端成立，主节点不成立。** 门禁条件是
   `proof !== undefined && config.token !== '' && proof === config.token`，而主节点的
   配置里**没有 `token` 键**（`--dump-config` 可见 `role: main` 下无 token，默认空串）。
   空串使条件恒假，所以边端带着自己的 token 去打主节点 `/admin`，拿到的是**登录页
   HTML**——实测三种情况（无头/真 token/假 token）都返回 200 的登录页，状态码看着像
   成功，body 不是 admin JSON。**这是本设计的一个陷阱：不要用状态码判断这条路径通不通。**
8. **网关目前 `inject: []`**，但可用 `ctx.get('sessionController')` 取服务。

## 2. 一个无法回避的限制：消息在目标端显示为「用户消息」

`prompt` 把来源硬编码成用户：

```js
const source = { kind: "user", rpcId: request.requestId, ...clientTimeZone, ...principal }
```

（`dsh-api-session-controller/lib/index.js:4048` 附近）

所以目标会话看到的是「用户说了这句话」，**不是**「另一个 agent 说了这句话」。
dsh-bot 同样受此限制——它的机器人消息在会话里也是用户消息。

**UUID 解决寻址，不解决身份。** 本设计接受这一点，用正文前缀弥补（见 §4）。
若要真正的 `kind: 'agent'`，那是改 DSH 上游，影响消息渲染与持久化 schema，不在本仓库范围。

## 3. 架构：任意两点如何落到隧道上

隧道是**星形**的：边端拨号到主节点，主节点只能沿已建立的连接反向访问边端。
边端之间没有直连。因此任意两点通信用两种路径：

| 路径 | 走法 | 改动 |
| --- | --- | --- |
| 主 → 边 | 主节点 `hub.request(envId, POST /admin/agent-message)` | 新 admin 路由 |
| 边 → 主 | 边端把请求**经自己的隧道**发回主节点，主节点本机投递 | 需要边端能主动发帧 |
| 边 A → 边 B | A 经隧道请主节点转投 B | 主节点做中转 |

三条路径的共同点：**投递永远由目标机自己的 `sessionController` 完成**，
隧道只搬运 `{ envId, sessionId, text, from }`。这样安全模型不变——
仍然是「只有主节点能往隧道里放帧」，且投递权限来自环境 token。

**关键设计决定：边端的出口必须走帧协议，不能借 HTTP。**

原本倾向「边端用自己的 admin 客户端向主节点发 HTTP」，实测否决了它（事实 7）：
主节点 `config.token` 是空串，门禁恒假，边端发往主节点 `/admin` 的请求只会拿到登录页。
而且那条路要要么给主节点配一个 token（多一个凭据要管），要么把 `/admin` 对
无鉴权流量开口（安全上不可接受）。

因此**新增一种帧类型** `agentMessage`（编号 9），方向边端 → 主节点：

```
[4 长度][1 类型=9][16 id][JSON { fromEnvId, toEnvId, sessionId, text }]
```

主节点收到后：
- `toEnvId` 是本机（主节点自己）→ 本机 `sessionController.prompt`
- `toEnvId` 是另一个边端 → `hub.request(thatEnv, POST /admin/agent-message)`
- 未知/离线 → 回一个错误帧，边端把它作为工具错误返回

这样只有**一条**新增对外接口（主 → 边的 admin 路由），边端之间靠主节点中转，
帧协议新增一个类型而不改动既有语义。代价是要动 `frames.js` 与 `agent.js`，
比借 HTTP 大，但不需要第二个凭据，也不削弱任何既有门禁。

## 4. 工具面

新增两个模型可见工具（Host 平面，由 gateway 提供，与 dsh-bot 同级）：

```ts
agent_send({
  envId?: string        // 省略 = 本机
  sessionId: string     // 完整 UUID
  text: string
  from?: string         // 调用方标识，便于对端阅读；省略则用本机 agent 的 sessionId
}) => { ok: true, accepted: true }
```

正文前缀（弥补 §2 的身份缺失），在对端会话里呈现为：

```
[agent-message] env=<envId> session=<sessionId>

<text>
```

`agent_list_envs()` 列出可达环境与在线状态——没有它模型无法知道 `envId` 该填什么。
数据源已有：`/admin/state` 的 `environments[].online`。

## 5. 安全

| 面 | 处理 |
| --- | --- |
| 谁能投递 | 只有**已建立隧道**的边端（环境 token，连入时验证一次）与主节点本机。**不新增凭据**，主节点也不需要配 token |
| 能否跨环境伪造 | 不能：帧里的 `fromEnvId` 由主节点依据**连接本身**填写，不采信帧内容；`toEnvId` 由主节点 registry 解析 |
| 会话是否存在 | 目标机 `resolveAgent` 失败即返回 `session/not-found`，调用方拿到明确错误 |
| 拒绝服务 | 单条消息有大小上限；不提供「批量投递全部会话」 |
| 环路 | A 的帧若把 `toEnvId` 指回 A，直接拒绝，不转发 |

**不做**：不给边端开任意 HTTP 转发或任意 `/admin` 调用（那等于把主节点网络暴露成
跳板）。边端只能发这一种语义化帧，主节点只对**边端**开一个 admin 端点。

## 6. 验证计划

隔离 profile 内完成，不动线上：

1. 两个隔离 profile（一 main 一 edge），验证 main → edge 投递后目标会话真的跑起来
2. 反向 edge → main
3. 两跳 edge A → main → edge B
4. 目标会话不存在 → 明确报错，不静默
5. **静默断链**：投递时隧道已死 → 必须报错，不能挂住（复用上一轮的 keepalive 语义）
6. 消息前缀在目标会话里如实出现，模型能据此判断来源

## 7. 需要同步的文档

- `GLOSSARY.md`：新增「agent message」「环境（已存在）」
- `pkgs/gateway/README.md`：新端点与工具
- `COMPATIBILITY.md`：gateway 新增注入
- `docs/changes/federation-decisions.md`：Q39 从「待做」改为「已实现」

## 8. 未决

| # | 问题 | 结论 |
| --- | --- | --- |
| U1 | 边端主动发起用 HTTP 还是新增帧类型 | **已定：新增帧类型**。HTTP 路被实测否决（事实 7：主节点无 token，只会拿回登录页） |
| U2 | 是否允许投递给**自己** | 允许但无意义；不特判 |
| U3 | `from` 字段是否强制 | 由主节点按连接填写，模型不可伪造 |
| U4 | 「两跳」的时延与失败语义 | 边 A 的帧经主节点转投边 B，主节点把 B 的错误原样回给 A。**未实测**，见 §6 第 3 项 |
| U5 | 是否需要 `agent_list_envs` 之外的发现手段 | 先用 `/admin/state` 的列表，不做额外发现 |

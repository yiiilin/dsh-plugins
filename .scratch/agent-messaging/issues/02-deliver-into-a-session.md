# 02: 把一条消息真正投进目标会话

**What to build:** 目标机收到 `{ sessionId, text }` 后，用**自己的**
`sessionController.prompt` 把它送进那个会话，并如实回报失败。

投递方式照抄 dsh-bot，那是本机唯一有先例的跨会话投递：

```js
await ctx.sessionController.prompt({
  requestId: randomUUID(),
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text }],
}, AbortSignal.timeout(30_000))
```

**它会唤醒休眠会话。** `commands.prompt` 先 `resolveAgent(sessionId)` 再
`agent.followup(...)`，会话不必正在运行。这正是「按 UUID 找会话」能成立的前提。

**一条无法回避的限制：消息在目标端显示为用户消息。**
`prompt` 把来源硬编码成 `{ kind: 'user', ... }`，所以目标会话看到的是「用户说了这句」，
不是「另一个 agent 说了这句」。dsh-bot 同样如此。因此正文必须自带来源前缀：

```
[agent-message] from=<fromEnvId> session=<发送方 sessionId>

<text>
```

前缀是本机构造的，模型不能通过参数伪造。

**Blocked by:** 01

**Status:** needs-triage

- [ ] gateway 注入 `sessionController`（当前 `inject: []`），或经 `ctx.get` 取用
- [ ] 主节点新增 `POST /admin/agent-message`，仅对带合法 `x-dsh-federation` 的边端开放
- [ ] 投递成功 → `{ ok: true, accepted: true }`
- [ ] 会话不存在 → `session/not-found`，**不静默成功**
- [ ] 正文前缀由本机拼装，`from` 与调用方 sessionId 不采信请求体里的值
- [ ] 测试：投递到休眠会话后它真的跑起来；不存在的 id 报错；前缀内容正确

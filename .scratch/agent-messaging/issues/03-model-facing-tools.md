# 03: 给模型两个工具

**What to build:** 模型可见的 `agent_send` 与 `agent_list_envs`，让 agent 能按
`envId + sessionId` 通知另一个 dsh 上的会话。

```ts
agent_send({
  envId?: string      // 省略 = 本机
  sessionId: string   // 完整 UUID
  text: string
}) => { ok: true, accepted: true }
```

`envId` 是可省略的：主节点投递给自己的会话时不必写。工具要能拿到**自己的**会话 ID
作为 `from`——`Execution` 上下文带 `agent?: Agent`，而 `Agent` 有 `readonly id: SessionId`。

`agent_list_envs()` 返回可达环境与在线状态。**没有它模型无法知道 `envId` 该填什么**，
只能猜或者先读文档。数据源已有：`/admin/state` 的 `environments[].online`。

**为什么是异步投递。** 操作者已定「模仿 dsh-bot」，而 dsh-bot 投递后立即返回
`{ accepted: true }`，不等对方跑完。等待会把调用方的回合和隧道一起占住，对方不回复就挂死。

**Blocked by:** 02

**Status:** needs-triage

- [ ] `agent_send` 注册在 Host 平面，工具能读到调用方自身的 sessionId
- [ ] `envId` 省略时投递到本机
- [ ] 目标离线/不存在 → 工具返回**明确错误**，不是 `ok: true`
- [ ] 投递即返回，不等待目标会话完成
- [ ] `agent_list_envs` 列出 `{ envId, label, online }`
- [ ] 工具描述里写明：消息在对方显示为用户消息，带 `[agent-message]` 前缀
- [ ] 测试：工具的 sessionId 取自调用方、离线报错、列表数据与 `/admin/state` 一致

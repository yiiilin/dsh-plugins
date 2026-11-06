# 01: 隧道承载一种 agent 消息帧

**What to build:** 边端能通过自己已有的隧道，把一个「投递给某个会话」的请求交给主节点。

今天帧协议只有请求/响应那一族（类型 1–8），全部由主节点发起、边端响应。
边端没有任何主动发起的通道，所以「边端 A 通知边端 B」在协议层就不可能。

新增一个帧类型 `agentMessage`（编号 9），方向只允许边端 → 主节点，载荷是 JSON：

```json
{ "toEnvId": "env-x", "sessionId": "<uuid>", "text": "..." }
```

**`fromEnvId` 不在载荷里，由主节点按连接填写。** 这是安全边界的核心：发送方不能声称
自己是别人。

主节点收到后有三种处置，本 issue 只要求把请求**路由到位**，投递由 02 完成：

| `toEnvId` | 处置 |
| --- | --- |
| 主节点自己 | 交给本机投递（02） |
| 另一个边端 | 用 `hub.request` 发 `POST /admin/agent-message` 过去 |
| 未知或离线 | 回一个错误帧，边端把它变成工具错误 |

**为什么不用 HTTP 让边端主动发。** 原本倾向这条路，实测否决：主节点配置里没有
`token`（`--dump-config` 可见 `role: main` 下无该键），而门禁条件是
`proof !== undefined && config.token !== '' && proof === config.token`，空串让它恒假。
边端带 token 打主节点 `/admin`，拿回的是**登录页 HTML**，状态码还是 200 —— 看着像成功。

**Blocked by:** None (can start immediately)

**Status:** needs-triage

- [ ] `FRAME.agentMessage = 9` 加入 `frames.js`，并订正它上面「request/response lifecycle」的注释
- [ ] `createTunnelAgent` 暴露 `sendAgentMessage({ toEnvId, sessionId, text })`
- [ ] `hub` 侧 `dispatch` 处理类型 9；`fromEnvId` 取自 connection record，不读载荷
- [ ] `toEnvId` 等于发送方自己 → 拒绝并回错误帧（环路）
- [ ] 转发目标离线 → 回错误帧，不静默丢弃
- [ ] 测试：帧往返、`fromEnvId` 不可伪造、环路被拒、目标离线有错

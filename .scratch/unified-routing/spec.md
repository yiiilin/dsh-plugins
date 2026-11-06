# 统一路由 —— 设计

状态：设计，未实现。分两步：**第一步统一路由**，**第二步开放注册**。
操作者决定（2026-11-06）：
- 拓扑保持**星形**（边端仍不监听入站，ADR 0003 不变）
- 保留「route 为空即本机」的短路
- 不做 `exposure` 开关：**注册到 gateway 就等于开放到隧道**，见 §13

## 0. 问题

同一个能力在代码里写了两到三遍，只为区分「我是主节点还是边端」：

```js
if (envId === '' || envId === 'self') return 本机直接调用(...)
if (config.role !== 'main')           return agent.readRemote(...)
                                      return hub.relayOverTunnel(...)
```

`readWorkspacesOf`、`readSessionsOf`、`getFile`、`sendAgentMessage`、`listReachable`
五处各写一遍，`admin.js` 另有 4 处 `role` 分支，全文 **16 处 `config.role`**。

每加一个跨节点能力，就要重写这个三段式，并且**必然有机会写错方向**——本次已经写错过
一次（边端拿 `hub.isOnline(peer)` 判断对端，恒为假，导致所有边到边消息报 offline）。

## 1. 目标

| # | 要求 | 判据 |
| --- | --- | --- |
| R1 | API 一致 | 主节点与边端跑同一套 `/admin/*`，没有「边端没有 X」的差异 |
| R2 | 跨节点流量统一走隧道 | 主↔子、子↔主、子↔子，调用方写法完全相同 |
| R3 | 隧道对业务不可见 | 业务只说「请求 envId X 的 /admin/F」，不关心本机、agent 还是 hub |
| R4 | 星形拓扑不变 | 边端仍然不监听入站（ADR 0003） |

## 2. 路由模型：源路由

一次请求带一个**目标队列**。每个节点只做三件事：

1. 队首是我的 id → 把它移出队列，转成**本地 HTTP 请求**发给自己的 daemon
2. 队首是别的 envId → 查我的隧道表，从通往它的那条隧道转发出去
3. 队列为空 → 已经是本地，直接走短路

响应沿原路返回。

```
A 请求 B：  targets = [B]
  A: 队首 B ≠ A，查隧道 → 转发给主节点（A 只连主节点）
  主: 队首 B ≠ main，查隧道 → 转发给 B
  B: 队首 B === B，出队 → 本地 HTTP → 响应原路返回
```

边端只连主节点，所以「边 A → 边 B」的路径是 `[B]`，中间经主节点一跳。
**节点不需要知道自己是什么角色**，只需要知道「我有哪些隧道、通向谁」。

## 3. 短路：targets 为空 = 本机

请求不带 envId 时，不进路由，直接调用本机实现。

好处：本机请求不必伪造一个到自己的 HTTP 请求；代价是保留了一个特例，
但它是**唯一**的特例，且语义清晰（「没指定目标就是我自己」）。

## 4. 统一的传输接口

现在 hub 有 6 个转发函数、agent 有 5 个，都是同一件事的变体：

| 现有 | 其实是 |
| --- | --- |
| `hub.relayOverTunnel` | 转发请求，收完整 JSON |
| `hub.relayBinaryOverTunnel` | 转发请求，收完整字节 |
| `hub.streamFileFromTunnel` | 转发请求，边收边写 sink |
| `hub.relayToPeer` | 边端委托 hub 转的入口 |
| `agent.readRemote` | 边端转发，收完整 JSON |
| `agent.readRemoteChunk` | 边端转发，收完整字节 |
| `agent.streamFileFromPeer` | 边端转发，边收边写 |
| `agent.sendAgentMessage` | 边端转发，等一个 JSON 应答 |

收完整 vs 边收边写，是**投递方式**的差别；主节点转发 vs 边端转发，是**我在哪条链上**
的差别。两者正交，所以是 2×N 的重复。

统一成一个：

```js
forward(route, request, { mode })   // mode: 'json' | 'binary' | 'stream'
```

- `route` = 目标队列；由调用方给出，路由层只递减
- `request` = `{ method, path, headers, body }`，与 HTTP 同构
- `mode` 决定响应怎么交付：攒起来解析 / 攒起来当字节 / 逐块交给 sink

## 5. 隧道是协议无关的字节管道

**第一原则：隧道只搬字节，不理解内容。**

现在的隧道理解 HTTP——它解析 method、path、headers，为每个请求开一个 id，还专门为
文件开了流式路径。后果有两个：隧道能承载的东西 = HTTP 能表达的东西（gRPC、WebSocket、
任意 TCP 都进不来）；「理解 HTTP」的代码分散在 `proxy` / `proxyUpgrade` /
`relayOverTunnel` / `streamFileFromTunnel` 等处，每加一个场景就多一个变体——已经长出
了一个没人调用的 `binary` mode。

改为：一条流就是一串字节，从一端送到另一端，隧道的职责到此为止。

### 帧格式

三种，定长头 21 字节：

```
open:  [4 长度][1 类型=1][16 streamId][JSON { toEnvId, port? }]
data:  [4 长度][1 类型=2][16 streamId][原始字节]
end:   [4 长度][1 类型=3][16 streamId][空]
```

- **`toEnvId`**：这条流该交给哪个环境。中间节点**只看这个字段**。
- **`port`**：可选。为空 = 交给目标节点的 daemon（`/admin/*` 所在端口）；非空 = 交给
  该端口，比如 harness 的 56789。
- **`data` 完全不解析**。发起方写什么就是什么——完整 HTTP 报文、gRPC 帧、WebSocket
  握手，隧道都不关心。

**`open` 里没有 path，没有 method。** 这是刻意的：一旦隧道认识 `path`，它就又变成
HTTP 专用。隧道只负责「送到哪个环境」，剩下的归最终节点的 daemon。

### 一次请求怎么走

```
A 想读 B 的 /admin/workspaces
  A 在隧道上 open { toEnvId: 'B' }
  A 把完整的 HTTP 报文写进 data 帧：
      "GET /admin/workspaces HTTP/1.1\r\nHost: ...\r\n\r\n"
  M 只看 toEnvId，按拓扑表转发（不解析 data）
  B 收到流，接上 127.0.0.1:3080 —— 自己的 daemon
  daemon 当成普通 HTTP 请求处理，响应沿同一条流回去
```

发起方用**标准 HTTP 客户端**，只把底层 socket 换成隧道流。所以 A 那侧不需要任何
「隧道专用」的请求构造代码。

## 6. 中间节点如何转发

多跳时中间节点必须知道一条流的方向。判据是**查表**，不是推断：

```
open 到达（来自连接 A）→ 记下 { streamId: { from: A, next: 通往 toEnvId 的隧道 } }
data 到达            → 查表，按记录的 next 单向转发；不解析内容
end 到达             → 转发并清理表项
```

不重写 `streamId`：发起方生成一次，全程沿用。同一个 streamId 已经在表中时**拒绝**，
这是 16 字节随机唯一可能冲突的地方。

## 7. 断连

隧道断了，**经过它的所有流立刻失败**——现在就是这么做的（`socket.on('close')` 把
所有 in-flight 标为失败），保留。

**不做隧道层重传。** TCP 断了就丢了，隧道能做两件事：及时发现（keepalive 已有的 90 秒
判定）和快速失败（不挂住调用方）。续传属于**上层协议**——HTTP 有 `Range`，gRPC 有自己
的语义。隧道不知道自己在搬什么，也就不该假装能重传。

## 8. 身份验证

现在有**两个**东西都叫 token，混在一起：

| 用途 | 现状 | 结论 |
| --- | --- | --- |
| 隧道接入时认出是哪个环境 | 边端拨号带 `?token=`，主节点 `byToken` 查 envId | **保留**，这是 envId 的唯一来源 |
| `/admin` 的访问凭据 | 边端转发时加 `x-dsh-federation: token`，daemon 比对 | **可取消** |

第二条可以取消，因为**入站路径本身已证明身份**：从隧道进来的请求只能由建立该隧道的
环境发出；走 loopback 的请求则是本机进程。用请求头证明身份是可伪造的，用传输通道证明
则不是。

实现上：daemon 对 `/admin` 的放行条件改成「来自 loopback 的 daemon 内部请求」，
不再比对 token。

**注意**：主节点当前 `config.token` 是空串，所以那条比对恒假——现有检查本来就有缺口，
不是本次改动引入的。

## 9. 主节点是否要配 token

按 §6，`/admin` 不再需要 token，所以**主节点不需要配 token**。这解决了一个遗留问题：
之前「边端无法用 HTTP 请求主节点」的根因是主节点没 token，现在这个前提消失了。

## 10. 影响面

| 位置 | 改动 |
| --- | --- |
| `hub.js` | 6 个转发函数合并为 1 个；`relayToPeer`/`streamRelay` 由统一路由取代 |
| `agent.js` | 5 个转发函数合并为 1 个 |
| `index.js` | 5 处三段式分派改为一次 `forward(route, ...)`；删除 `role` 判断 |
| `admin.js` | 4 处 `role` 分支改为「本机就是本机」 |
| `frames.js` | 帧 9 载荷改为 `{ route, method, path, headers, body }` |
| 测试 | 现有 24 个文件相关测试需按新接口调整；补路由路径计算与多跳的测试 |

## 11. 验证计划

隔离三节点（一主两边）：

1. 主 → 边：`GET /admin/workspaces`
2. 边 → 主：同一路径，反向
3. 边 A → 边 B：两跳，经主节点
4. 短路：不带 envId，直接本机
5. 流式：一份 256 MiB 文件跨两跳，校验 SHA-256
6. 离线：目标不在任何隧道表里，明确报错
7. 环路：`route` 指回自己，拒绝

## 12. 未决（第一步）

| # | 问题 | 倾向 |
| --- | --- | --- |
| U1 | `route` 是数组还是单个 toEnvId | 数组：源路由的本质，为将来的多跳留位 |
| U2 | 边端是否需要知道自己「不是主节点」 | 不需要；只需要隧道表 |
| U3 | 主节点转发给自己（`route` 首项 = main） | 支持：让边端可以请求主节点的 `/admin` |
| U4 | 现有 `/admin/*` 路由是否也走统一层 | 是：否则又出现两套分派 |

---

# 第二部分：开放注册（第二步，未实现）

## 13. 核心决定：没有 exposure 开关

原本设想给每个注册的接口加 `exposure: 'local' | 'federation'`。操作者否决，理由成立：

> 不暴露在隧道的，可以不注册到 gateway，他自己注册自己的标准 dsh 接口就行了，
> 只要注册到 gateway 就是开放到隧道的。

也就是说，**存在一个更基础的注册面**——DSH 自己的 `webServer.register`——它注册的
接口只在本机可达，跨机请求根本不会路由过去。所以「要不要跨机」这个选择，已经由
「注册到哪一层」表达了：

| 注册到 | 谁能访问 |
| --- | --- |
| `webServer.register` | 只有本机的浏览器/进程 |
| `gateway.register` | 本机 + 所有联邦环境 |

加一个 `exposure` 字段会造出「注册了但不开放」这种自相矛盾的状态，而那种状态用
`webServer.register` 就能表达。多一个开关只是多一种写错的方式。

## 14. 接口形态

gateway 发布一个服务，插件通过 `ctx.get('gateway')` 拿到：

```js
ctx.inject(['gateway'], (injected) => {
  const dispose = injected.gateway.register({
    path: 'report',                    // 相对本插件的命名空间
    methods: ['GET'],
    handler: (req, res) => { ... },    // 标准的 Node http handler
  })
  ctx.effect(() => dispose)
})
```

### 命名空间

插件不能注册到 `/admin/` 根下——那会与 credential、environments 等管理路由冲突，
一个插件就能改联邦拓扑。

实际路径是 `/admin/p/<pluginName>/<path>`：

```
register({ path: 'report' })  在插件 @yiln-dsh/dsh-foo 里
  →  GET /admin/p/%40yiln-dsh%2Fdsh-foo/report
```

`p` 段是固定的。插件名来自 gateway 如何识别调用方，不由注册方自报（见 §13）。

### handler 是标准 HTTP

不发明新的请求/响应对象。`handler(req, res)` 拿到的就是 Node 的 `IncomingMessage` 和
`ServerResponse`，所以流式、SSE、大文件都能自然工作——`file-route.js` 就是这么写的。
一个抽象层如果要求把响应改成“返回一个对象”，流式就得另开一条路，那正是这次要消除的
那种分裂。

## 15. 谁能注册

注册发生在**本机进程内**。插件不能靠传参指定自己的命名空间，否则谁都能占用别人的。

**这一点尚未核实。** Cordis 的 `Fiber` 有一个 `name`（`fiber.d.ts:138`：「插件显示名，
继承自最近的具名祖先，否则 `'root'`」），但 `Context` 类型上**没有**查到直接暴露它的
getter，也没有查到本仓库有道过 `ctx.scope` 的先例。所以「注入回调里能取到声明该行的
包名」目前是**推测**，不是事实。

实现前必须先验证，三条路按优先级：

1. `ctx.inject` 回调的 `injected` 参数或 `this` 上能取到 fiber 名 → 直接用它
2. 取不到 → 要求注册方显式传 `name`，但**由 gateway 校验**它属于已挂载的插件
   （`ctx.registry` 里有该包名才能注册），否则拒绝
3. 两条都不行 → 退到「注册方自报名字」，并把「命名空间可被冒用」记成已知限制

前两条都不会让命名空间被冒用；第三条会。**不要在没有验证的情况下假设第 1 条成立。**

## 16. 认证

注册的接口不需要自己实现认证，两侧都由路径决定：

| 来源 | 认证依据 |
| --- | --- |
| 隧道进来的请求 | 连接本身绑定了一个 envId（§6） |
| 本机 loopback 请求 | 只有本进程能访问 |

**已知风险，明确记录**：一个环境注册的接口，会被**所有**联邦环境调用。这是「注册到
gateway = 开放到隧道」的直接后果，不是缺陷。如果某个接口需要限制调用方，由 handler
自己检查 `req.headers['x-dsh-route-from']`（由路由层注入，见 §15），而不是再引入一个
框架级开关。

## 17. 路由层注入的头

转发时注入，供 handler 判断来源，不允许调用方伪造（路由层覆盖而非透传）：

| 头 | 含义 |
| --- | --- |
| `x-dsh-route-from` | 发起请求的 envId；本机请求不设置 |
| `x-dsh-route-hop` | 走了几跳，0 表示本机 |

## 18. 与第一步的关系

注册 API 依赖「转发是透明的」这个前提。如果路由没统一，注册的每个接口都要自己写
`self / role === 'main' / else` 的三段式分派——等于把 §0 的问题复制给每个插件作者。

**所以顺序不能倒**：先统一路由（第一步），再开放注册（第二步）。

## 19. 验证计划（第二步）

1. 插件注册一个接口 → 本机 curl 可达
2. 同一接口从边端经隧道可达
3. 未注册的路径 → 404（不是 500，也不是登录页）
4. 两个插件注册同名 `path` → 不冲突（命名空间隔离）
5. handler 里读 `x-dsh-route-from` → 得到真实发起方
6. 调用方伪造 `x-dsh-route-from` → 被路由层覆盖
7. dispose 之后 → 立即 404

## 20. 未决（第二步）

| # | 问题 | 倾向 |
| --- | --- | --- |
| U5 | 注册是否要声明 methods | 要：默认 `['GET']`，写操作必须显式列 |
| U6 | 是否需要 `description` 供 `agent_list_envs` 之类展示 | 暂不需要 |
| U7 | 插件名过长时的路径形态 | 用包名原文并 URL 编码；不做缩写映射 |

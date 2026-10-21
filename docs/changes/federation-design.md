# 联邦式环境管理 —— 设计

状态：设计已定，实现未开始。
前置：ADR 0003（弃用 SSH 环境）、ADR 0004（隧道自建）。

## 0. 需求

操作者的原话，是全部设计的判据：

> 主端能远程操作远端环境的 dsh，并且修改远端 dsh 的 skill、插件、profile 等内容。
> 跟操作本地 dsh 看到相同的东西：能看到工作区和它下面的会话，能看到会话记录，
> 各类插件照样使用。主 dsh 能操作远端，远端 dsh 也能操作自己。

拆成四条可验证的要求：

| # | 要求 | 本设计如何满足 |
| --- | --- | --- |
| R1 | 远程操作远端 dsh | 隧道 + `/<envId>/` 整页切换 |
| R2 | 修改远端的 skill / 插件 / profile | 远端有自己的完整 dsh，改它就是改自己 |
| R3 | 看到工作区、会话、会话记录、插件，与本地一致 | 切换后加载的是**远端自己的完整界面**，不是拼接的数据 |
| R4 | 远端也能独立操作自己 | 边端不依赖主节点在线 |

R3 决定了架构选择：只有「整页加载远端 UI」才能做到「与本地完全一致」，
因为拼接式（本地框架 + 远端数据）必须在本地重实现远端的每一种界面元素。

## 1. 要解决的问题

一台机器上的 dsh 只能服务那一台机器。要管理多台机器上的开发环境，有两个可选方向：

- **SSH 环境**：本地进程把文件与命令操作转发到远端，用一个进程管理多个环境。
- **联邦**：每台机器跑自己的完整 dsh，主节点通过隧道访问它们。

本设计采用**联邦**，原因是 SSH 方向有三个无法消除的缺陷：

| 缺陷 | 证据 |
| --- | --- |
| 每次工具调用 +511 ms | `dsh-ssh` 硬编码 `-o ControlPersist=no`，每次重新握手 |
| 宿主上产生幻影目录 | 建会话时 `mkdir(cwd)` 用 `node:fs`，cwd 是远端路径时在本机也建出同名空目录 |
| 远程目录无法成为工作区 | 工作区注册用 `realpath`，在宿主执行，远端路径必然 ENOENT |

联邦把这些一起消除：工具在本机跑（无延迟）、`mkdir` 的是真实路径（无幻影）、
工作区就是本机工作区（无 ENOENT）。

代价是**数据不集中**：每个环境有自己的一份会话与配置。主节点看不到边端的会话列表，
这是设计选择而非缺陷——会话属于运行它的那台机器。

## 2. 结构

两端是**同一套安装**：都装完整 dsh 与我们的插件，都监听同样的端口。

```
主节点 dsh (role: main)
  ├─ harness          127.0.0.1:56789   自己的界面
  ├─ daemon (main)    0.0.0.0:3080      认证、环境路由、隧道服务端
  └─ 隧道端点         wss://…/_tunnel   边端主动连入
                            ▲
                            │ 边端主动发起，无需开入站端口
                            ▼
边端 dsh (role: edge)
  ├─ harness          127.0.0.1:56789   自己的界面（只绑回环，Q59）
  ├─ daemon (edge)    0.0.0.0:3080      可被直接访问，走边端自己的认证（Q2 补充）
  └─ 出站连接                          同时连向主节点，还原被转发的请求
```

边端 daemon 绑在 `0.0.0.0` 是有意的：它允许**绕过主节点直接访问边端**，
这时走的是边端自己的登录。两条路并存，各用各的认证。

端口在每个环境里都只有两个（Q48）：`3080` 给 daemon，`56789` 给 dsh 本体。
**不再有「一个环境一个本地端口」那套分配（56800+ 作废）。**

两个角色由同一个插件、同一份配置结构决定。差别只有三项：

| 配置项 | main | edge |
| --- | --- | --- |
| `role` | `main` | `edge` |
| 主端地址 | — | 必填 |
| token | — | 必填（Q49） |

## 3. 请求流程

用户在浏览器访问主节点的 `/<envId>/…`：

```
① 主节点 daemon 收到请求，按前缀识别出 envId
② 查找该环境对应的隧道连接；没有则返回「离线」页
③ 给请求分配 requestId，编码成帧推入隧道
④ 边端 daemon 收到帧，还原成 HTTP 请求，转发给本机 127.0.0.1:56789
⑤ 边端把响应编码成帧回传
⑥ 主节点还原成 HTTP 响应，返回浏览器
```

WebSocket 同理：主节点收到 upgrade 请求后，分配 streamId 打开一条隧道内的子通道，
双向透传帧。同一时刻多条请求在飞，靠 requestId 区分。

## 4. 隧道的帧格式

```
[4 字节长度][1 字节类型][16 字节 requestId][payload]
```

类型：

| 值 | 含义 |
| --- | --- |
| 1 | 请求头（方法、路径、头字段） |
| 2 | 请求体分片 |
| 3 | 请求结束 |
| 4 | 响应头（状态码、头字段） |
| 5 | 响应体分片 |
| 6 | 响应结束 |
| 7 | 取消（浏览器断开） |
| 8 | 心跳 |

长度前缀让接收方不必猜边界；requestId 让并发请求不互相覆盖。

## 5. 两种验证，不要混淆

| | 谁验证谁 | 用什么 | 什么时候 |
| --- | --- | --- | --- |
| **隧道验证** | 主节点验证边端 | 环境 token（Q36） | 边端连入时，一次 |
| **用户验证** | 各自验证用户 | 各自的配对凭据 | 每次打开界面时 |

「主端验证边端」不代替「用户登录主节点」，而「边端独立认证」也不影响隧道已经建立。
两者独立，各自失败不影响对方：边端登录过期，隧道照常；隧道断了，边端本地照常可用。

### cookie 的隔离

daemon 的会话 cookie 名是固定常量 `dsh_daemon_session`，上游的则是
`dsh-auth-<sha256(authority)>`（随 host 变）。因此：

- **直接访问不同主机**（`http://6.13:3080` 与 `https://dsh.yiln.de`）：浏览器按域名隔离，
  同名 cookie 互不干扰。
- **经主节点代理访问同一域名下的不同路径**（`https://dsh.yiln.de/` 与 `/6.13/`）：
  同名 cookie 会撞。现有 `scopeCookiePath` 把 `Path` 改写成 `/<envId>/` 来隔离，
  联邦沿用这个机制。

### 经隧道的请求不再验证（Q69）

主节点转发过来的请求，边端**不做任何用户验证，直接代理到 `127.0.0.1:56789`**。

理由是信任来自**代码路径**，而不是某个可伪造的标记：

```
网络路径    socket → local(req,res,url) → auth.handle() → 代理 56789
隧道路径    隧道帧 → decodeFrame() → 代理 56789          ← 到不了 local()
```

两条路在代码里就分开：`local()` 是网络入口，隧道帧的解码结果直接交给代理函数，
根本不经过 `local()`。因此「来自隧道」不是靠请求头声明的——**外部无法伪造一个
不存在的代码路径**。

隧道连接本身已由环境 token 验证过（Q36），且是**边端主动拨出**的：
只有主节点能在这条连接上发帧。所以信任隧道帧等于信任主节点。

边端给 56789 的凭据沿用现有机制（`embeddedRoot.ensure()`）：daemon 通过
`connection.authenticatedUrl()` 取得本进程 harness 的 token，代理时带上。
这与主环境代理自己的根 profile 是同一段代码。

#### 这条决定的代价，写清楚

1. **边端的安全性等于主节点的认证强度**。主节点的会话 cookie 被窃，等于能进所有边端。
   这是单点登录的固有代价，不是本设计的疏忽。
2. **边端 56789 的认证被 daemon 绕过**。这是有意的：56789 只绑回环（Q59），
   外部到不了它；daemon 用自己进程内的 token 访问它，属于进程内部通信。
3. **直接访问边端 3080 仍然要登录**，走 `local()` 那条路。两条路互不影响。

## 6. 鉴权

边端连入时携带 token，主节点用它反查环境身份。**两种传法都支持**：

```
wss://主节点/_tunnel?token=<token>         优先
Authorization: Bearer <token>              兜底
```

查询参数优先是必要的：WebSocket 的浏览器 API 不能自定义 header，
而边端将来可能运行在受限环境里。这个做法借自 Komari 的 `IdentifyPrincipal`：
token 反查身份，不需要 id 与 token 双因子。

主节点侧的识别顺序（同样借自 Komari 的分层做法）：

```
① API Key       → 管理员调用
② 会话 cookie   → 已登录用户
③ 环境 token    → 边端
④ 匿名          → 拒绝
```

## 7. 环境 id 的分配与复用

边端首次连入时上报：

```
hostname        人类可读的名字
machineId       /etc/machine-id，重装才变，用于去重
```

envId 在主节点**创建接入凭据时就分配好**，不等边端连入：

```
① 主节点上创建一条接入凭据 → 生成 token，同时分配 envId
② 操作者把「主端地址 + token」填进边端配置（不填 envId）
③ 边端连入，上报 hostname 与 machineId
④ 主节点用 token 找到那条凭据，回传它的 envId
⑤ 边端把 envId 持久化
```

`machineId` 只用于两件事：在面板上区分同名主机；边端换 token 重连时提示
「这台机器已作为环境 X 存在」。

边端重连时如果主节点回传的 id 与本地不同，以主节点为准并更新本地
（主节点是 id 的权威）。

## 8. 断线与重连

边端用指数退避重连，上限 60 秒，无限重试。网络抖动是常态，无人值守必须有重连。

主节点侧：连接断开后环境标记为**离线**，不从列表移除——移除会让人以为环境被删了。
离线时访问 `/<envId>/` 显示「远端不可达」页，并给出最后在线时间。

## 9. 环境列表与切换

主节点的面板里列出全部环境，本地（主环境）默认排第一。切换环境即跳转到 `/<envId>/`。

边端的 dsh 不显示这个列表：它只服务自己，没有「其它环境」这个概念。

## 10. 远端配置的读取与修改

主节点需要能看到并修改边端的技能、插件、profile。这走**隧道内的管理 API**，
不走 SSH：

```
GET  /_federation/<envId>/state       边端 daemon 返回它的 profile、插件、技能清单
POST /_federation/<envId>/skills      把主节点的一个技能目录推送到边端
POST /_federation/<envId>/plugins     触发边端的插件安装
```

这些端点由边端 daemon 提供，主节点转发过去。边端也可被直接操作（它自己就有界面），
两条路等价。

## 11. 给 agent 的联邦工具

主节点的 agent 需要能操作边端，工具分三档：

| 档 | 能力 |
| --- | --- |
| 只读 | 列边端目录、读边端文件、看边端 profile |
| 读写 | 加上写文件、改配置、装插件 |
| 全权 | 加上重启边端 dsh、执行任意命令 |

默认给**全权**（操作者的选择：风险与便利成反比），但有一个全局开关
`confirmDangerous`，开启后高危操作（删除、改 profile、重启、装卸插件）需要二次确认。

## 12. 实施顺序

每步可独立验证，前一步不通过不做下一步。

| 步 | 内容 | 验收 |
| --- | --- | --- |
| 0 | 删除 SSH 模式与 6.13 那个空环境 | 代码里不再有 SSH 环境，主环境照常工作 |
| 1 | 隧道（daemon 加 role/edge、帧协议、重连） | 主端能连上边端并转发一个 HTTP 请求 |
| 2 | 边端接入（边端装 dsh + 配置 role/edge） | 主端 `/<envId>/` 能打开边端的完整 UI |
| 3 | 环境列表与切换 | 面板列出环境、切换后 UI 正确 |
| 4 | 远端配置读取（`/state` 经隧道） | 主端能看到边端的插件与技能清单 |
| 5 | 同步与联邦工具（Q44 复制技能、Q45 全权工具） | 主端能改边端配置 |
| 6 | `web-daemon` → `supervisor` 改名 | 包名、目录、row id 一致 |

**删 SSH 排在第一步**，因为它是从未投产的死代码：6.13 上那个环境是空的，
主环境（`main`）不依赖 SSH——它是内嵌的根 profile。留着它会让联邦实现时
不断面对「要不要兼容旧路径」的干扰。

## 13. 第 0 步要删除的既有代码

**先删再建**。这些代码从未投产：6.13 那个环境注册了但里面没有数据。

```
pkgs/daemon/lib/ssh.js            SSH 执行、helper 部署、健康检查
pkgs/daemon/lib/credentials.js    密钥生成、ssh_config、known_hosts
pkgs/daemon/lib/helper.js         静态 helper 的构建/下载/缓存
配置项：helperVersion / helperDownloadUrl / binPath / sshConfigPath
prepare/confirm 的 SSH 分支
```

保留并改造：`registry.js`（去掉 SSH 字段）、`entry.js`（前缀反代改成可选目标）、
`auth/*`（不变）、`client.js`（环境列表 UI）。

## 14. 模型配置的同步与编辑

### 三层结构

模型配置不是一个整体，它分三层，安全性各不相同：

| 层 | 内容 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 选用 | `agent-default-model`：provider、model、reasoningEffort | profile patch | 纯配置 |
| 2 定义 | `llm-pi-ai.providers`：apiKeyEnv、api、baseURL、reasoning、重试策略 | profile patch | 纯配置，含服务地址 |
| 3 密钥 | `SUB2API_API_KEY` 的实际值 | `.credentials.yaml` 的 `refs` | **明文密钥** |

### 能力要求

主节点对边端的模型配置要能做三件事：

- **查看**：读到边端当前用哪个 provider、哪个 model、服务地址是什么
- **同步**：把主节点的第 1、2 层推送到边端，让两端用同一个模型
- **手动编辑**：在面板里直接改边端的值，不经过主节点

同步是**单向推送**（主节点 → 边端），不做双向合并。理由：双向合并需要一个
「谁的配置更新」的判据，而时间戳在两端时钟不同步时会给出错误答案。要反向同步就再推一次。

### 第 3 层（密钥）单独处理

密钥默认**不同步**。理由：同步密钥等于把主节点的凭据复制到每台边端，
一旦某台边端被入侵，主节点的密钥就泄露了。

操作者可以选择同步，但要走一个明确的独立动作：`syncCredentials: true`，
且在 UI 上显示「这会把你的 API 密钥复制到 <hostname>」。

**边端没有可用密钥时，它自己的 dsh 无法对话** —— 这是可见的失败，
不是静默降级。面板上标出「边端缺少模型密钥」。

### 服务地址的陷阱

第 2 层里的 `baseURL`（如 `https://sub2api.yiln.de/v1`）从边端访问可能不通：
边端在内网、或服务只允许特定来源。同步时不能假设它可直接用。

处理方式：同步后**探测一次**，从边端请求 `baseURL` 的一个轻量端点。
不通就在面板上标出，并保留边端原来的配置作为回退（同步前先备份到
`profile.patch.yml.bak-<timestamp>`）。

## 15. 本设计不解决的问题

- **会话共享**：边端的会话不会出现在主节点。这是有意的。
- **工作区跨机器合并到一个列表**：并置模式下不合并。看边端的工作区就切换到边端，
  那里显示的就是它真实的工作区（含路径、会话数）。合并会让「同一个 `/root/workspace`
  在两台机器上是同一个还是两个」变成无法回答的问题。
- **多主节点**：一个边端只连一个主节点。
- **主节点互备**：主节点挂了，边端仍独立可用，但无法被远程访问。

## 16. 实施进度与已知问题（2026-10-19）

### 已完成

| 步 | 内容 | 证据 |
| --- | --- | --- |
| 0 | 删除 SSH 模式 | 2077 行移除，index.js 869→383 |
| 1 | 反向隧道 | 两个实例间 HTTP 与 WebSocket 升级均通过，端到端测试在 `test/daemon.test.js` |
| 2 | 6.13 作为边端接入 | `online: True`，`/env-6-13/` 返回 200，静态资源 200 |

### 未解决：经隧道的会话事件流

**症状**：`/env-6-13/` 页面能加载、24 个 HTTP API 全部成功、WebSocket 升级返回 101
且边端确认收到 4190–6106 字节，但浏览器侧的 mux 收不到任何消息
（`messages: 0`）。表现是界面停在初始状态：工作区能列出，会话列表为空，
某些按钮点击无效。

**已排除**：

- 隧道本身（HTTP 全通，upgrade 返回 101）
- 边端与 harness 之间的连接（日志显示字节确实从 harness 流出）
- 帧格式（同一套帧在纯 HTTP 请求上工作正常）
- 浏览器侧限制（页面内直接 new WebSocket 到 mux 能 open 并保持 OPEN）

**已定位到主端的转发**：边端日志 `sent so far N frame(s)/N byte(s)` 证实它发出了
帧，主端的 `upgrade relayed N byte(s)` 从未打印，说明 upgrading 请求的
responseBody 帧没有进入 `entry.onBody`。

**已尝试的修复**：`socket.resume()`（升级后的 socket 默认暂停）、在握手期间缓冲
客户端帧、合并重复的 `responseEnd` 分支。前两项对 HTTP 路径有效，upgrade 路径
仍未打通。

**下一步应查**：`record.pending` 在 upgrade 生命周期中的存活时间——边端每次
upgrade 会收到请求头帧后又收到其他帧，若 key 在某个 `responseEnd` 上被提前删除，
后续帧就会因为 `entry === undefined` 被静默丢弃。建议在 `dispatch` 里对未知 key
的帧计数并打印，而不是 `return`。

### 部署细节（6.13）

- pnpm 12 默认拦截生命周期脚本，必须 `--config.dangerously-allow-all-builds=true`
- `dsh-web-app` 随 dsh 自带，从 `/usr/local/lib/node_modules/...` 安装
- 装完要手工把 bundle 名加入 `package.json` 的 `dsh.profile.bundles`
- settings 编辑器默认关闭，边端要能编辑模型配置需显式开 `allowRemoteSettings`

### 模型配置同步（手工验证过，未固化为功能）

三条链路缺一不可，文档 §14 说这是三层：

1. `agent-default-model` 与 `llm-pi-ai` 两行写进 profile 的 `cordis.patch.yml`
2. `SUB2API_API_KEY` 写进 `.credentials.yaml` 的 `refs`
3. `webserver-auth` 开 `allowRemoteSettings`，否则编辑器改不动

**一个教训**：这两行不能用 YAML 解析后再序列化往返——`off:` 会被写成 `false`，
而 `reasoningEfforts` 的键名恰好是 `off`，导致 `ValidationError`。必须按原文复制。

### 2026-10-19 追加：settings 写入为何失败

**`dsh: profile reload requires the root Include entry` 与本设计无关。** 在**本机**用
一个全新创建的最小 profile 复现了同一个错误，所以它不是联邦、不是 6.13、也不是
pnpm 12 造成的。

已确认的事实：

- 精简 profile（`dsh-base` + `dsh-web-app`）在本机与 6.13 上都会报这个错
- 生产 profile 能成功写入，说明差异在 profile 内容而非运行时
- `settings/describe` 在两边都返回 `writable: true`、`hasDocument: true`、21 个命名空间
- 报错来自 `dsh-app-boot/lib/index.js:3803` 的 `recompose()`：拿不到
  `bootstrapIncludes.get(ctx)` 就抛错

**绕过方式（已用于 6.13）**：UI 设置是写回 profile patch 的，所以直接把
`ui-settings-general` 行预置进 `cordis.patch.yml`，避免应用内写入触发 reload：

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
```

预置后 6.13 的 `Preview Notice` 弹窗不再出现。

### 一次造成生产不可用的操作（记录）

在**生产**上用 RPC 直接调 `settings/mutate` 改 `welcomeNoticeVersion`，返回 `ok: true`，
但随后 daemon 的 3080 监听消失、进程仍在、56789 正常。`systemctl restart dsh-web` 恢复。

**教训**：settings 写入会触发 profile reload，而 reload 在本部署上不可靠。
**不要在生产上用 RPC 直接触发它**，改配置就改文件 + 重启。

### 2026-10-19：mux 事件流已通

**根因**：升级后的 socket 在两端都是暂停态，只挂 `data` 监听器收不到字节；边端又在
握手完成前用占位对象接帧，丢弃了浏览器发出的第一帧。两处都修好之后，
`/env-6-13/` 的编辑器开始接受输入、会话能创建、对话能完成。

**验收证据**：

| 项 | 证据 |
| --- | --- |
| 切换环境 | `/env-6-13/` 返回 200，加载的是 6.13 自己的 UI |
| 建会话 | 会话文件落在 6.13：`/root/.dsh/sessions/--root-Documents-.../session-0fa4bc21…`（23 KB） |
| 完成对话 | 在 6.13 环境里问 `cat /root/work/proof/data.txt`，agent 答 `SIX13_FILE_MARKER`——该文件只存在于 6.13 |
| 模型可用 | 模型选择器显示 `deepseek-v4.1-flash-free / High`，Model 与 Effort 两项可选 |
| 工作区 | `Default workspace` 正常列出，会话挂在它下面 |

**同时确认了一件事**：会话文件确实只落在执行它的那台机器上——本机没有那条会话。
这正是 ADR 0003 里「数据不集中」的代价，也是设计选择。

### 仍未做

- 环境列表与切换 UI（第 3 步）：目前靠直接访问 `/<envId>/`，`sidebar.footer.action`
  里的 select 未实现
- 经隧道读取边端 profile/插件/技能清单（第 4 步）
- 模型配置的同步与编辑做成功能（第 5 步）：手工验证过链路，未固化为界面
- `dsh: profile reload requires the root Include entry` 的根因：已确认与本设计无关
  （本机全新 profile 同样失败），但未找到成因

### 2026-10-19：模型配置的读取、同步与编辑已实现

三个端点，两端各有一份（主端额外提供按环境转发）：

| 端点 | 作用 |
| --- | --- |
| `GET /admin/model` | 本节的模型配置摘要：provider、model、effort、baseURL、api、密钥是否存在 |
| `POST /admin/model` | 用给定的 `rows` 替换本节的模型行，先备份原 patch |
| `GET/POST /admin/environments/<id>/model` | 主端转发到该环境；POST 时 `push: true` 表示「把本节的模型行推过去」 |

**关键实现约束**：全部按行处理，从不经过 YAML 解析再序列化。理由是实测过的——
YAML 往返会把键名 `off` 改写成 `false`，而 `reasoningEfforts` 恰好用 `off` 作键，
于是配置被 schema 拒绝（`ValidationError`）。

**密钥不随配置传输**。`GET /admin/model` 只报告 `hasApiKey: true/false`，从不读取值。
一个环境有模型但没密钥时会在第一条消息上失败，面板上能看出这是缺密钥而不是别的问题。

**写入先备份**：`cordis.patch.yml.bak-model-<ts>`。模型配置写坏了会让 harness 起不来，
而唯一能回去的地方就是那份备份。

**验证证据**：

```
主端读取       provider=sub2api-gpt model=deepseek-v4.1-flash-free effort=high hasApiKey=true
跨隧道读取 6.13  同上
推送 push:true   成功，备份 cordis.patch.yml.bak-model-1792366273274
6.13 重启后      激活失败 0，off: null 保留 6 处、false 键 0 处
6.13 界面        deepseek-v4.1-flash-free / High 可选
6.13 对话        问「只回答该文件内容」，答 SIX13_FILE_MARKER
```

**需要重启才生效**：写入只改文件，不触发 reload。响应里的 `note` 明确说明这一点，
因为 reload 在这套部署上不可靠（见上文的 `requires the root Include entry`）。

### 2026-10-19：daemon 启用后自配置 systemd

**问题**：手工启动的 daemon 在机器重启后就不存在了，而且没有任何东西提示这一点——
直到有人想用它。6.13 上正是这个状态：`nohup` 起的进程，`PPID=1`，没有任何单元。

**做法**：`systemdUnit: auto`（默认）。监听器起来之后，daemon 判断三种情况：

| 情况 | 行为 |
| --- | --- |
| 已在 systemd 下（`INVOCATION_ID` 存在） | 不动。从单元内部改写它正在读的文件没有意义 |
| 手工启动 | 渲染单元、写入、`daemon-reload`、`enable`（单元名固定 `dsh-daemon`） |
| `systemdUnit: ''` | 不做 |

**为什么在监听器之后**：单元里写着端口。一个绑定失败还写了单元的进程，会得到一份
同样起不来的单元。

**渲染原则是「照抄现状」而不是「套模板」**：可执行文件、脚本、profile、端口、
`DSH_HOME`/`HOME`/`PATH` 都取自当前进程。`argv[1]` 缺失（进程被包装器起）时**拒绝
写入**并说明原因——写一个启动别的东西的单元，比不写更糟。

**两个刻意的决定**：

- **只用 `enable`，不 `start`**：这个进程已经在跑，再 start 一个会和它抢端口。
- **单元名固定为 `dsh-daemon`**：它是「那个守护进程」，不随角色或端口变化。按端口派生
  会让改端口后留下一个仍在开机启动的旧单元。包里导出 `UNIT_NAME` 常量，调用方和测试
  共用一处定义。

**验证**（6.13 实测）：

```
手工启动          → wrote /etc/systemd/system/dsh-edge-3080.service and enabled it
单元内容           ExecStart=/root/.hermes/node/bin/node /usr/local/bin/dsh --profile main --port 56789
                  Environment=DSH_HOME=/root/.dsh / HOME=/root / PATH=...
                  WantedBy=multi-user.target
is-enabled         enabled
手工进程停掉后 systemctl start → active，56789 与 3080 都在听，PID 来自 systemd
再次启动          running under systemd; not installing another unit
生产（已在单元下）  already managed by systemd，未重复安装
```

#### 单元名统一后的两端状态（2026-10-19）

```
生产    dsh-daemon.service  active + enabled，公网 200，旧 dsh-web.service 已删
6.13    dsh-daemon.service  active + enabled，56789 与 3080 都在听
```

生产的切换由 `/root/switch-unit.sh` 经 `systemd-run` 独立单元执行：从自身服务内部停
自身会把这个脚本一起杀掉。脚本在任一检查失败时回滚到 `dsh-web` 并重新启用它。
输出 `RESULT=OK`，随后删掉旧单元文件。

`supervisor`（原 web-daemon）的 `systemdUnit` 也改成 `dsh-daemon.service`，否则它每次
启动会用旧名字重写单元，把这次改名撤销。

# 浏览器实例：把 desktop-vnc 从单例改成多实例

Status: ready-for-agent

## Problem Statement

`pkgs/desktop-vnc` 目前只支持**一个**可视化浏览器：插件加载时创建一套
Xephyr + Chromium + x11vnc（`index.js:245-267`），整套状态是闭包里的单例。

这带来三个具体问题：

1. **agent 无法并行做浏览器测试。** 两个任务同时要浏览器，第二个会接管第一个的窗口。
2. **没有列表。** 侧边栏只能看到「那一个」浏览器，看不出有没有别的、也不知道它是谁开的。
3. **没有生命周期归属。** 会话结束了，浏览器窗口还留在桌面上，要人工去关。

改造中发现的三个**单例假设**是真正的阻塞点（均经代码核实）：

- **端口**：`rfbPort` 是构造期冻结的 `const`（`x11vnc.js:156`），且 `startOnce` 的复用逻辑是
  「端口有人监听就复用」（`x11vnc.js:346-350`）。第二个实例用同一端口时，会探测到第一个的
  x11vnc，返回 `running:true`，WS 桥随后连上去 —— **第二个面板静默显示第一个的桌面，零报错**。
- **路径**：`baseDir = tmpdir()`、`instancePid = process.pid`（`browser.js:387-388`），
  `index.js` 从未传 `tmpDir`/`pid`（`index.js:245-255`）。两个实例会共享
  `/tmp/dsh-desktop-vnc-<pid>/profile`（Chromium SingletonLock 互锁）和 `Xauthority`
  （后写者覆盖前者 cookie，先启动者失去授权）。
- **客户端**：`VncPage` 内部是单一 `rfbRef`/`hostRef`/`state`（`client.js:716-729`），
  连接目标硬编码 `WS_PATH()` 无参数（`client.js:45,926`），渲染树只有 toolbar + stage，
  没有任何列表结构（`client.js:1127-1235`）。

使用者要的是：**能同时开多个浏览器，agent 按 id 指定操作哪一个，所有客户端都能看到同一份
列表，会话结束时它开的实例自动收走。**

## Solution

把 desktop-vnc 的 Host 半部从「一个浏览器栈」改成「一张浏览器实例表」，Client 半部从
「单一查看器」改成「列表 + 查看器」。

**Host 侧**：

- 引入 `BrowserInstanceRegistry`：一个 `Map<instanceId, { browser, vnc, capture, ownerSessionId, ... }>`。
  三个工厂（`browser.js` / `x11vnc.js` / `capture.js`）**无模块级可变状态**，同进程多次调用
  互不干扰，可直接多开。
- 每个实例传**唯一的 `pid`**（复用现有注入点 `browser.js:375-376`），让 profile 与
  Xauthority 目录互不碰撞。
- 每个实例分配**独立的 RFB 端口**，取自配置区间 `rfbPortRange`（默认 `[5900, 5999]`）。
  **改掉复用语义**：从「端口有人监听就复用」改为「端口属于本实例才复用」，否则阻塞点 1 仍在。
- 实例 id 由本插件生成（`crypto.randomUUID()` 的短形式），**不取自 bsk**。
- 实例记录 `ownerSessionId`；监听 `session/disposed`，关闭该会话名下的全部实例。

**Client 侧**：

- 新增 `VncShell` 作为 slot body，内部持有 `focusedInstanceId`（客户端本地状态）。
- 列表区渲染 `GET /sessions` 的结果；点击某行设焦点。
- 现有 `VncPage` 作为查看器子组件，用 `key={focusedInstanceId}` 挂载 —— 现有的
  per-lifetime 重置逻辑（`client.js:771-793`）天然按实例切换生效。
- 未选中任何实例时显示空态。

**不做的**：不提供 `focus` 工具（焦点是客户端界面状态，服务端工具跨层修改语义不清）；
不做 dsh 重启后的实例持久化（Xephyr 是子进程，dsh 死了它必然死，持久化只会制造幽灵实例）。

## User Stories

1. 作为 agent，我想创建一个浏览器实例并拿到它的 id，以便后续操作有明确目标。
2. 作为 agent，我想按 id 关闭一个实例，以便用完释放资源。
3. 作为 agent，我想列出全部实例及其状态，以便知道有哪些可用、哪些是自己开的。
4. 作为 agent，我想在 id 不存在时收到明确报错，以便不会误操作到别的实例。
5. 作为 agent，我想让不同实例互不干扰，以便并行跑两个浏览器测试。
6. 作为使用者，我想在侧边栏看到所有浏览器实例的列表，以便知道当前开了什么。
7. 作为使用者，我想点击列表里的某一项就看到那个实例的画面，以便在多个实例间切换。
8. 作为使用者，我想在列表里看到每个实例的状态（启动中/就绪/失败），以便知道它能不能用。
9. 作为使用者，我想在列表里看到每个实例是谁开的，以便判断能不能关掉。
10. 作为使用者，我想让会话结束时它开的实例自动关闭，以便不用手工收拾桌面。
11. 作为使用者，我想让不同客户端看到同一份实例列表，以便换个客户端也能接着用。
12. 作为使用者，我想让每个客户端各自记住自己聚焦的是哪个实例，以便两个人各看各的。
13. 作为使用者，我想在两个客户端同时看一个实例时看到提示，以便知道不是自己一个人。
14. 作为使用者，我想让 agent 操作和人手动操作能共存，以便我随时能接管。
15. 作为使用者，我想在实例启动失败时看到原因，以便知道是缺依赖还是别的问题。
16. 作为开发者，我想让端口冲突显式报错而不是静默复用，以便不会看错桌面。
17. 作为开发者，我想让两个实例的 profile 目录互不碰撞，以便多开不会互相锁死。
18. 作为开发者，我想让显示号池足够大，以便「一直开」不会撞上人为上限。
19. 作为开发者，我想让实例 id 不依赖外部工具，以便换掉驱动层时 id 语义不变。
20. 作为开发者，我想让新增的行为有测试覆盖，以便改动时敢下手。

## Implementation Decisions

### 术语

已在 `GLOSSARY.md` 固化三个词：**浏览器实例**、**浏览器实例 id**、**焦点实例**。
`_Avoid_` 明确排除了「VNC 会话」「桌面会话」「bsk 实例号」等说法。

关键约定：**实例 id 由本插件生成，不取自 bsk**。外部工具怎么称呼同一台浏览器是实现细节。

### 端口分配

- 新增配置 `rfbPortRange: [5900, 5999]`（默认值），保留 `rfbPort` 作为 v1 兼容单值。
- 分配策略：区间内**从低到高取第一个空闲且未被本进程其他实例占用的端口**。
- **改掉复用语义**：`startOnce` 的 `probe(port)` 判断必须区分「本实例已持有的端口」与
  「外部服务占用的端口」。前者复用，后者跳过该端口继续找下一个。
- 区间耗尽时 create 报错，附现有实例列表（让 agent 一步完成「关旧的再开新的」）。

### 显示号池

`NESTED_DISPLAY_MIN/MAX` 从 `:200`–`:250` 扩到 `:200`–`:999`（`browser.js:55-57`）。
池满时的既有报错文案（`browser.js:736`）保留。

### 实例表与生命周期

- `BrowserInstanceRegistry` 持有 `Map<instanceId, entry>`。
- `entry = { id, ownerSessionId, browser, vnc, capture, createdAt, lastActiveAt, state }`。
- `state`：`starting` | `ready` | `failed`（Q10 定案：`starting` 是一等状态）。
- 监听 `ctx.on("session/disposed")`，关闭该会话名下的全部实例。
- **不监听 `agent/disposed`**（Q25 定案）：agent 结束但会话还在时，实例继续存活。
- 不做持久化（Q26 定案）：dsh 重启后实例表清空，子进程随父进程退出。
- 启动时清理 `/tmp/dsh-desktop-vnc-*` 残留目录（best-effort，失败不阻塞）。

### HTTP 端点

沿用现有 `webServer.register({ kind, path, handler })`，**无 method 字段**，
在 handler 内判 `req.method`（先例：`pkgs/delete-session/index.js:343-350`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_dsh/desktop-vnc/sessions` | 列表，返回扁平数组 |
| POST | `/_dsh/desktop-vnc/sessions` | 创建，**立即返回** `{id, state:"starting"}`，不等启动完成 |
| DELETE | `/_dsh/desktop-vnc/sessions/<id>` | 关闭。用**一条 prefix 路由**自己解析 id（同 kind 同 path 重复注册会抛错） |
| GET | `/_dsh/desktop-vnc/sessions/<id>/ws` | 该实例的 VNC WebSocket（现有 `/_dsh/desktop-vnc/ws` 保留为兼容，指向焦点/唯一实例） |

列表响应形状（Q20 定案）：

```jsonc
[{ "id": "...", "state": "ready", "width": 1280, "height": 800,
   "createdAt": 1792637133, "ownerSessionId": "...", "lastActiveAt": 1792637200,
   "viewers": 1 }]
```

**不返回焦点**（焦点是客户端本地状态），**不返回 total/limit**（Q17 后无上限）。

`GET /_dsh/desktop-vnc/state` 保持现有形状不变（Q8 定案），仅在其 `browser` 字段中
投影「当前唯一实例」以兼容既有客户端判断（`client.js:654-665`）。

### agent 工具

三个，前缀 `browser_instance_`：

| 工具 | 参数 | 返回 |
|---|---|---|
| `browser_instance_list` | 无 | 同 `GET /sessions` |
| `browser_instance_create` | `ownerSessionId` | `{id, state:"starting"}` |
| `browser_instance_close` | `id` | `{closed: true}` 或错误 |

**id 不存在即报错**，不回退到「最近一个」或「唯一的那个」，不自动新建。

不提供 `browser_instance_focus`（Q22 定案）。

### 客户端结构

- 新增 `VncShell` 作为 `sidebar.right.pane.tab` 的 body，替代 `VncPage` 直接注册。
- `VncShell` 持 `focusedInstanceId`（`useState`），渲染：左侧列表 + 右侧 `VncPage`。
- `VncPage` 接受 `instanceId` prop，WS URL 改为 `wsUrlFor(WS_PATH(instanceId))`。
- `key={focusedInstanceId}` 强制重挂载，复用现有 per-lifetime 重置。
- 列表每行显示：id（截短）、状态点、尺寸、创建者会话、最后活动时间、观看人数（Q11/Q12 定案）。
- 不显示「谁正在看」（不可知且无用）。

### 并发语义

- 多个客户端可同时观看同一实例（Q12 定案），VNC 本身支持多 viewer。
- agent 操作与人手动操作**不互斥**（Q13 定案）：人可以随时介入，agent 的下一步以最新 DOM 为准
  —— 这正是 bsk 已有的 fresh-ref 行为。

## Testing Decisions

**只补关键路径**（Q28 定案），对应三个 blocker：

1. **端口不撞**：两个实例分配不同 `rfbPort`；复用语义改为「本实例持有」后，
   外部服务占用某端口时跳过它。
2. **路径不撞**：两个 `createBrowserStack` 传不同 `pid`，断言 profile 与 Xauthority 目录不同
   （`test/browser.test.js:137-164` 的 `makeStack()` 已参数化 `tmpDir`/`pid`）。
3. **会话关闭收实例**：emit `session/disposed`，断言该会话名下实例被关闭、其他会话的不受影响。

扩展点：
- HTTP 路由测 `test/index.test.js` 的 `fakeCtx()`（记录 `routes[]`，已有直调 handler 的先例）。
- **注意**：`test/index.test.js:211-220` 对 `browser` 对象做 `deepEqual` 精确全等；
  若 `state` 端点形状变化必须同步更新（本 spec 决定不变，故无需改）。

不做的测试：端到端起两个真实 Chromium（需要真实 bsk 与浏览器，CI 中脆）。

## Out of Scope

- **agent 自动打开客户端侧边栏**（Q23 定案）。这需要 Host→Client 的推送通道，
  是独立的下一期工作。本期用户手动点开侧边栏即可看到列表。
- **实例持久化**（Q26 定案）。dsh 重启后实例表清空。
- **实例归属转让 / 收养**（Q19 定案）。归属创建时确定，不可转让。
- **agent 与人的操作互斥**（Q13 定案）。不加锁。
- **bsk 集成**。本期只做实例管理，不调用 bsk。

## Further Notes

- 三个工厂无模块级可变状态这一点已逐一核实（`browser.js` / `x11vnc.js` / `capture.js`
  的模块作用域只有常量），是多实例方案成立的前提。
- 显示号池扩容后，实际约束变成内存与进程数，不再是人为常量。
- 端口区间 `[5900, 5999]` 与显示号池 `:200`–`:999` 解耦，取小者 100 为实际并发上限。
- 网关链路 method 全量透传已核实（`pkgs/gateway/lib/entry.js:293`），
  DELETE 不受限制；`pwa.js` 的 method 判断只作用于 PWA 静态资源，不影响本插件的路径。

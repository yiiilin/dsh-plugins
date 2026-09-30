# DSH 升级研究

> 历史快照（2026-09-29）：以下结论记录适配前的 `0.1.7-rc.1` 环境。后续已完成 `0.2.0-rc.2` 升级及插件适配；当前兼容窗口和运行验证见 [COMPATIBILITY.md](COMPATIBILITY.md)。

**研究时间：** 2026-09-29
**范围：** 只读盘点本共享工作区的 `dsh-plugin-*` 包，对照本机 DSH 0.1.7-rc.1 和官方发行信息；未安装、发布、改动 `package.json` 或插件源码。

## 结论摘要

- 本机安装的 `@deepseek-ai/dsh` 是 **0.1.7-rc.1**；npm dist-tag `latest` 是 **0.1.7-rc.2**。另有较新的 `next` 预发布 **0.2.0-rc.1**。依据：本机 `.../@deepseek-ai/dsh/package.json:2-4`；官方 npm metadata `https://registry.npmjs.org/@deepseek-ai%2fdsh`（dist-tags，查询日期同上）。
- **5 个插件的 DSH peer 范围排除了 0.1.7-rc.2**，不只是待测风险：DSH 启动兼容性检查会逐项把 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 范围与运行时 DSH 版本比较，使用 `includePrerelease: true`；不匹配的插件行会被禁用。依据：官方 `plugin-compatibility.ts` 0.1.7-rc.2 第 52-88 行、`compatibility-preflight.ts` 第 63-117 行；5 个包各自的 peer 范围见下表。**在获准加载前应先验证代码并发布/提供包含 rc.2 的兼容范围；不应只靠版本豁免当作兼容性修复。**
- `dsh-plugin-session-list-cache` 没有任何 `@deepseek-ai/dsh-*` peer 范围，因此不会因上述 DSH peer 检查而被挡；这并不证明 `sessionQuery.listSessions()` 在新运行时的服务语义一定兼容。
- 官方 **0.1.7-rc.2** 发行说明没有列出新的插件 API breaking change；但目前 `mentor` 和 `web-daemon` 使用的 `Session.ownEvents()`、`eventAt()`、`snapshotEvents()` 已在本机 0.1.7-rc.1 类型声明中标记为 deprecated，并明确写明禁止新增调用。这是现存迁移债务，不是 rc.2 才引入的破坏。

## DSH 版本与官方变更

- 本机 DSH 包元数据为 0.1.7-rc.1，声明仓库 `deepseek-ai/deepseek-harness`，运行时核心依赖也锁在 0.1.7-rc.1：`/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/package.json:2-11,22-36`。本机 `@deepseek-ai/dsh-plugin-manager` 同为 0.1.7-rc.1：其 `package.json:2-4`；已安装源码在 `lib/index.js:1422-1423,1717-1720` 调用兼容性检查。
- Registry 查询 `npm view @deepseek-ai/dsh dist-tags versions --json` 的 `latest` 为 0.1.7-rc.2，`next` 为 0.2.0-rc.1。RC2 包元数据显示 DSH 的运行时依赖包已指向 0.1.7-rc.2（例如 `dsh-web-app`、`dsh-session-projection`、`dsh-plugin-manager`）：`https://registry.npmjs.org/@deepseek-ai/dsh/0.1.7-rc.2`。
- 0.1.7-rc.2 官方发行说明（2026-09-24）：[release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)。主要是 UI、提醒/快捷键、插件管理体验和缺陷修复；发行说明未宣布新的插件 `ctx`、locale、slot、server API breaking change。
- RC1 官方说明回顾了此前的插件/运行时变化，包括运行时插件卸载与兼容性检查、Client Session 多实例 API/slot 变化、V4 session log、附件和 Remote API 行为调整：[release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)。这些多数已属于本机安装的 0.1.7-rc.1 基线，不应误写成 rc.2 新变化。
- 若“最新”指更高版本线而非 npm `latest`，0.2.0-rc.1 已发布到 `next`（2026-09-28）：[release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)。它的发行说明没有列新的插件 API break，但仍不在下表现有 peer 范围内；兼容性门禁对它同样适用。

## 插件清单

以下列出每包 `package.json` 的版本及 DSH 相关 peer；表中所有插件共同声明 `@deepseek-ai/cordis >=4.0.0`。除特别说明外，每个列出的 DSH peer 都有 `>=0.1.7-rc.1 <0.1.7-rc.2` 分支（通常还保留若干 0.1.5/0.1.6/0.1.7-alpha 窗口），因此不匹配 rc.2 和 0.2.0-rc.1。

| 插件包 | 包版本 | DSH peerDependencies（省略共同的 Cordis） | 依据 |
|---|---:|---|---|
| `dsh-plugin-auth-webserver` | 0.10.4 | `dsh-atomic-write`、`dsh-client-ui-settings`、`dsh-client-ui-settings-general`、`dsh-client-ui-settings-plugins`、`dsh-client-connection`、`dsh-settings` | `dsh-plugin-auth-webserver/package.json:2-3,57-65` |
| `dsh-plugin-delete-session` | 0.4.5 | `dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-client-ui-sidebar`、`dsh-client-ui-workspace` | `dsh-plugin-delete-session/package.json:2-3,38-43` |
| `dsh-plugin-git-graph` | 0.2.2 | `dsh-api-remotes`、`dsh-client-ui-layout`、`dsh-client-ui-renderer`、`dsh-client-ui-sidebar-right`、`dsh-fs`、`dsh-sandbox-policy`、`dsh-subprocess` | `dsh-plugin-git-graph/package.json:2-3,35-47` |
| `dsh-plugin-mentor` | 0.2.1 | `dsh-agent`、`dsh-agent-loop`、`dsh-api-session-controller`、`dsh-commands`、`dsh-llm`、`dsh-session`、`dsh-session-persistence`、`dsh-system-prompt`、`dsh-tools`、`dsh-client-connection`、`dsh-client-locale`、`dsh-client-ui-conversation`、`dsh-client-ui-settings-plugins` | `dsh-plugin-mentor/package.json:2-3,42-58` |
| `dsh-plugin-session-list-cache` | 0.1.1 | **无 DSH peer**；仅 `@deepseek-ai/cordis` | `dsh-plugin-session-list-cache/package.json:2-3,27-29` |
| `dsh-plugin-web-daemon` | 0.8.2 | `dsh-agent-preset-registry`（optional）、`dsh-client-ui-sidebar`、`dsh-client-ui-settings-plugins`、`dsh-llm`、`dsh-settings` | `dsh-plugin-web-daemon/package.json:2-3,39-51` |

包本身的普通 runtime dependencies：auth-webserver 声明 `@simplewebauthn/server` 与 `js-yaml`（`dsh-plugin-auth-webserver/package.json:53-56`）；git-graph 声明 `markdown-it` 与 `monaco-editor`（`dsh-plugin-git-graph/package.json:45-47`）。其余包没有额外普通 `dependencies`，以 peer 方式依赖 DSH/Cordis。

## 当前 API 使用与兼容性

- **locale / client slots：**各 Web 客户端通过 `locale.register(namespace, {zh,en})` 和 `locale.bind(namespace)` 提供本地化；例如 mentor `client.js:481-498`、auth-webserver `client.js:1520-1557`、web-daemon `lib/client.js:651-673`、delete-session `client.js:923-940`。这符合本机 locale 类型声明提供的 `register`/`bind` 合约：本机 `dsh-client-locale/lib/types/client/index.d.ts:188-226`。没有发现需要因 rc.2 发行说明而改名的 locale API。
- **右侧 Sidebar / slots：**git-graph 使用 `sidebarRight`、`sidebarRightTabs` 和 `sidebar.right.pane.tab`（`dsh-plugin-git-graph/client.js:261-278,1859-1880`）；delete-session 使用 `sidebar.footer.action` 与 `conversation.session.header.actions`（`dsh-plugin-delete-session/client.js:923-940`）；mentor 使用 `conversation.view` 与设置页 slot（`dsh-plugin-mentor/client.js:490-522`）。这些具体 slot 在本机 0.1.7-rc.1 类型声明中仍存在：`conversation.session.header.actions` 与 `conversation.view` 为 `scope: 'session'`（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:155-187`），右侧 Sidebar pane tab 也为 `scope: 'session'`（`dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:30-48`）；footer action 是 root scope（`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:75-79`）。因此这些具体 slot 不是被移除的泛用 `conversation` slot；仍需在多 Client Session 同时存在的场景验证 session 归属和页面注册/卸载。
- **host/server：**auth-webserver 依赖 `webServer.tapIndex/register`、`settings.register/watch/configure` 和 `ctx.connection`（`dsh-plugin-auth-webserver/index.js:665-716,1263-1275,2003`）；git-graph 依赖 `webServer.register`、`subprocess.spawn`、`fs.resolve/processPath` 与 `sandboxPolicy`（`dsh-plugin-git-graph/index.js:146-154,263-307`）；delete-session 依赖 `ctx.sessions`、`ctx.agents`、`ctx.sessionPersistence` 和 `ctx.webServer`（`dsh-plugin-delete-session/index.js:227-263,343`）；web-daemon 使用 `webServer`、`settings`、`agents/subagents`、`sessionController`、`agentLoop` 与 `sessionPersistence`（`dsh-plugin-web-daemon/index.js:1791-1845`）。rc.2 发行说明未宣告这些服务签名变化；应验证对应服务实际可注入、路由在 WebServer 重启后恢复，且插件卸载后 effect 注册和 monkey patch 均撤销。
- **Client Session 历史读取：**mentor 多处调用 `ownEvents()`，并以 `eventAt()`/`snapshotEvents()` 读取历史（`dsh-plugin-mentor/lib/mentor.js:577-579,636-639,857,1082-1129,1342,1495`）；web-daemon 使用 `snapshotEvents()`，先尝试 `session.events`（`dsh-plugin-web-daemon/index.js:260-269`）。本机 DSH rc.1 的 `dsh-session/lib/types/index.d.ts:175-199` 将这三种同步读取 API 全部标记为 `@deprecated` 且“new calls are prohibited”。这是明确应排期的 API 迁移项；由于官方 rc2 notes 未说已删除，当前证据不足以称为 rc.2 的确定 runtime break。升级前应确认 rc2/0.2 提供的替代读取接口、覆盖完整历史和 fork-owned events 的语义，并为 Mentor 重放/恢复路径补行为测试。
- **设置表单：**auth-webserver 与 web-daemon 已采用 `settings.register(..., { applies: "live" })`、`watch()` 和 `ctx.effect()` 清理；依据分别为 `dsh-plugin-auth-webserver/index.js:682-716`、`dsh-plugin-web-daemon/index.js:1747-1761`。该模式与 0.1.7-rc.1 的 Profile 插件设置迁移一致；仍需确认升级后旧设置只导入一次、Profile 级写入和 live 更新结果正确，见 RC1 官方发行说明的 Settings 变更。
- **Remote / APIProxy：**web-daemon 把 `ctx.get("apiProxy")` 作为可选参数传给恢复 gate（`index.js:1832-1845`），但 `recovery-gate.js:40-49` 在该服务不存在时改走 `sessionController/goals/agentPresets/subagents` 的现代接口；这是旧结构兼容分支，不构成对已移除 APIProxy 的硬依赖。其他插件使用 `ctx.connection` 或 `ctx.get("remote")`，静态扫描未发现直接 `ctx.agent`、`agent/session-start`、Inbox 构造器或旧 Inbox 私有方法的调用；mentor/web-daemon 监听 `agent/created`（mentor `lib/mentor.js:1678-1685`、web-daemon `index.js:710-726`），与 RC1 的异步串行 `agent/created` 事件方向一致。
- **认证设置补丁：**auth-webserver 按表达式锚点修改 Settings 客户端 bundle（`settings-client-patch.js:8-12,23-30,33-78`）。本机已安装 bundle 显示曾被该插件改写，不宜拿它当干净上游基线；官方 0.1.7-rc.1 和 rc.2 源码 `packages/client/ui-settings/src/client/index.ts:38-53` 表达式相同，并且 npm 发布的 rc2 构建产物 `https://unpkg.com/@deepseek-ai/dsh-client-ui-settings@0.1.7-rc.2/lib/client.js:1509` 精确包含 `const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";`。当前正则接受单/双引号并要求分号，因此**该补丁锚点已在 rc2 构建产物验证匹配**。仍应在新 profile 的未补丁包上验证 rebuild 和 disposer 恢复。
- **会话列表缓存：**插件直接替换 `ctx.sessionQuery.listSessions`，并在 `session/created`/`session/disposed` 时清 cache、卸载时还原原方法（`dsh-plugin-session-list-cache/index.js:155-182`）。这不受 DSH peer 门禁保护；重点验证函数是否仍可写、调用参数/结果结构、并发 coalescing、筛选/排序以及多实例会话变化后的缓存正确性。
- **子进程与文件服务：**git-graph 使用 DSH `subprocess.spawn`，但扫描没有发现读取 `handle.pid`；因此 RC1 已移除普通 subprocess handle `pid` 不应直接影响它。它也通过 `fs.resolve/processPath` 而非旧 Remote 文件读取接口；仍需测 sandbox policy 下 Git 命令与路径解析。

## 升级验证建议

1. 先把 5 个有 DSH peer 的插件列为“当前声明不兼容”，在代码与测试验证后再为每个实际使用的 DSH peer 声明 rc.2 支持；若目标改为 `next`，单独决定是否支持 0.2.0-rc.1。兼容性豁免是精确版本授权，不替代测试；官方源码 `plugin-compatibility.ts:52-88`、本机插件管理器 `lib/types/tools.js:14` 明确将不兼容安装与启用视为会导致崩溃/数据损失的风险。
2. 对 mentor、web-daemon 做 session V4 迁移/恢复测试，覆盖旧 session、fork/subagent、事件重放和服务重启；安排从 deprecated 同步事件读取接口迁移。
3. 验证浏览器两条 Client Session 并存时的 slots、Sidebar、当前会话动作与设置隔离；测试 locale 切换、页面注册、无关页面不注入。
4. 验证 plugin-manager 运行时 disable/remove/re-enable：HTTP 路由、locale/slot 注册、`listSessions` 包装、系统监听器、HTTP listener 和 Settings bundle patch 都应准确释放并可重建。
5. 做全量插件 smoke test：认证登录/设置保存/PWA、删除单个与批量会话、Git Graph 路径与子进程、Mentor 工具/消息恢复、web-daemon systemd 与 subagent 恢复、session-list-cache 并发与失效。

## 核心来源

- 本机 DSH 包与依赖：`/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/package.json:2-11,22-36`；本机 DSH Session API 声明：`.../node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts:175-199`；本机 Plugin Manager 兼容检查调用：`.../node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:1422-1423,1717-1720`。
- npm 官方 registry：`https://registry.npmjs.org/@deepseek-ai%2fdsh`、`https://registry.npmjs.org/@deepseek-ai/dsh/0.1.7-rc.2`。
- DSH 0.1.7-rc.2 官方兼容逻辑：[`plugin-compatibility.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts#L52-L88)、[`compatibility-preflight.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/boot/app-boot/src/compatibility-preflight.ts#L63-L117)。
- DSH 发行说明：[0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)、[0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)、[0.2.0-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)。
- Settings 源码版本对比：[rc.1 `packages/client/ui-settings/src/client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-settings/src/client/index.ts#L38-L53)、[rc.2 同文件](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/client/ui-settings/src/client/index.ts#L38-L53)；已发布 rc.2 构建产物：`https://unpkg.com/@deepseek-ai/dsh-client-ui-settings@0.1.7-rc.2/lib/client.js:1509`。

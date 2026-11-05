# 升级 DSH 0.2.1-rc.5 → 0.2.2-alpha.3

2026-11-04。目标：判断 live `main` profile 能否升到 `0.2.2-alpha.3`。
本文分两部分：前面是**升级前的只读研究与隔离演练**，文末「执行记录」是随后
实际执行的验收结果。两部分的表述各自对应其时间点，不要混读。

## 结论先行

**能升，但要先改一行配置。** 9 个自研插件**零改动**；升级的真正代价是 profile 里
一条引用了已删除子路径的 Loader 行。

| 判定 | 对象 | 说明 |
| --- | --- | --- |
| 必须改 | `yiln.cordis.yml` 的 `tool-subagent-list-agents` 行 | 上游删掉了 `./list-agents` 子路径导出，该行装载即抛 |
| 必须升级 | 12 个钉在 `0.2.1-rc.5` 的官方包 + agent-teams | 否则启动时被版本门禁逐行禁用 |
| 零改动 | 9 个 `@yiln-dsh/*` | 兼容性、挂载、Host 路由、Client 模块全部实测通过 |

**在隔离演练里，改掉那一行之后：`disabling profile plugin` 计数为 0，37 行全部正常挂载，
Bot 会话成功创建，9 个插件的 GUI 全部可用。**

## 1. alpha.3 是什么

**2026-11-04 研究当时**：npm 上 `latest` / `next` 仍是 `0.2.1-rc.5`，`alpha` tag
指向 `0.2.2-alpha.3`（2026-11-03T07:48Z 发布，有 GitHub release
`dsh-v0.2.2-alpha.3`）。此后 `next` 已推进到 `0.2.2-rc.1`，见文末执行记录。

release notes 里与本仓库相关的三条：

1. **「Git 工作树」入口并入「变更请求与工作树」**——原文要求启用过独立插件的用户
   **手动从 `dsh.profile.bundles` 移除 `dsh-experimental-tool-worktree`**。
2. Cordis Core 升到 `4.0.0-rc.11`、Loader `1.0.0-rc.8`、Include `1.1.1`
   （统一配置访问、条目变更与持久化）。
3. 文件修改的先读/外部修改防护默认关闭（沙箱与 Review 不变）。

## 2. 唯一的硬阻断：`./list-agents` 子路径被删除

`@deepseek-ai/dsh-tool-subagent-control` 的 `exports` 对比如下：

| 版本 | exports |
| --- | --- |
| rc.5 | `.`, **`./list-agents`**, `./src/*`, `./package.json`, `./locale/*.json`, `./list-agents/locale/*.json` |
| alpha.3 | `.`, `./src/*`, `./package.json`, `./locale/*.json` |

`list_agents` 工具本身**没有被删**——alpha.3 把它合并进了主入口的 `apply()`
（`lib/index.js` 里 `registerListAgents(ctx)` 在 `apply` 中调用）。
所以处理方式是**删掉那一行，不是换个包**：

```yaml
# yiln.cordis.yml — 删除这 2 行
    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

`tool-subagent-control` 主行（id `tool-subagent-control`）保留，`send_message` /
`interrupt_agent` 仍由它提供，`list_agents` 随之一起回到工具面。

### 这一行的失败形态

不是"少一个工具"，而是**整个会话创建失败**：

```
session create failed: agent-preset/invalid:
tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
```

即 GUI 打不开新会话、历史会话恢复失败。演练中实测到这条，删行后消失。

## 3. 必须升级的官方包

`main` profile 里 12 个钉死版本的官方包在 alpha.3 下全部被门禁禁用（peer 硬枚举
`0.2.1-rc.5`）。按 runbook 的教训，**在 `main` 里直接升到 alpha.3**：

```sh
cd /root/.dsh/profiles/main
pnpm add \
  @deepseek-ai/dsh-app-boot@0.2.2-alpha.3 \
  @deepseek-ai/dsh-atomic-write@0.2.2-alpha.3 \
  @deepseek-ai/dsh-brand@0.2.2-alpha.3 \
  @deepseek-ai/dsh-experimental-tool-worktree@0.2.2-alpha.3 \
  @deepseek-ai/dsh-experimental-worktree@0.2.2-alpha.3 \
  @deepseek-ai/dsh-package-manifest@0.2.2-alpha.3 \
  @deepseek-ai/dsh-plugin-manager@0.2.2-alpha.3 \
  @deepseek-ai/dsh-timeout@0.2.2-alpha.3 \
  @deepseek-ai/dsh-tool-schedule@0.2.2-alpha.3 \
  @deepseek-ai/dsh-tool-terminal@0.2.2-alpha.3 \
  @deepseek-ai/dsh-util-values@0.2.2-alpha.3 \
  @deepseek-ai/dsh-workflow-ptc@0.2.2-alpha.3
```

其余 20 个官方 bundle 由 `@deepseek-ai/dsh-base` / `dsh-web-app` 传递带进 alpha.3，
不需要单独钉版本。

**agent-teams 必须从 `0.1.27` 升到 `0.1.28`**：0.1.27 的 21 个 peer 是
`0.2.1-rc.3 || 0.2.1-rc.2 || ...` 硬枚举，在 alpha.3 下 BLOCKED，而 `compatibility.json`
里的豁免只对 `0.2.1-rc.5` 生效。0.1.28 把 peer 放宽成 `*`，实测 mounts，
**因此升级后可以撤掉豁免**。

## 4. 9 个自研插件：零改动

用 alpha.3 自带的 `evaluatePluginCompatibility`（不是 rc.5 的）逐个计算：

```
@yiln-dsh/dsh-browser-vnc    mounts
@yiln-dsh/dsh-delegate-mode  mounts
@yiln-dsh/dsh-delete-session mounts
@yiln-dsh/dsh-gateway        mounts
@yiln-dsh/dsh-git-graph      mounts
@yiln-dsh/dsh-session-list-cache mounts
@yiln-dsh/dsh-supervisor     mounts
@yiln-dsh/dsh-tool-restrict-presets mounts
@yiln-dsh/dsh-tool-visibility mounts
```

`engines.dsh` 的 `>=0.2.1-0 <0.3.0-0` 窗口本来就包含 alpha.3（`0.2.2-alpha.3` 排序在
`0.2.1-0` 之上、`0.3.0-0` 之下），**不需要改 `package.json`**。

Host 侧用到的服务在 alpha.3 里都还在：`webServer`、`settings`、`subprocess`、`fs`、
`sandboxPolicy`、`sessions`、`agents`、`sessionPersistence`、`sessionQuery`、
`agentPresets`、`tools`、`commands`、`systemPrompt`、`sessionController`、`jobs`、
`connection`。

Client 侧用到的 4 个 Slot 全部保留：`sidebar.right.pane.tab`、`sidebar.panellist`、
`sidebar.footer.action`、`conversation.input.left`、`conversation.session.header.actions`、
`settings.section`、`settings.plugins.tab`。
`ISidebarRight.openTab` / `openResource` 与 `SidebarRightTabDefinition` 的字段
（`id` / `kind` / `priority` / `title` / `guide`）在 alpha.3 中**签名未变**。

## 5. 隔离演练做了什么

`DSH_HOME=/tmp/iso022/home`，profile `drill`，用 live `main` 的
`package.json` + `cordis.patch.yml` + `yiln.cordis.yml` + `fragment.yml` 的**副本**
（把三处绝对 include 路径改指副本自身，否则会反向从 live 目录解析 rc.5 包——
这是我第一次演练踩的坑，37 行假报错全部由此而来）。

演练结果：

- `disabling profile plugin`：**0**
- `--dump-config`：18 行 `@yiln-dsh/*`、9 个 Loader id 齐全、无 `disabled: true`
- Boot payload：`release.version = 0.2.2-alpha.3`，6 个 Client 模块全部登记
- Host 路由：`/_dsh/supervisor/state` → 200；`/_dsh/desktop-vnc/sessions` → 200；
  `/_dsh/git-graph/git-log` POST 真实仓库 → `ok:true` 带 commit 列表
- 浏览器：侧栏 CPU/内存条、Federation gateway 三页签、右栏 Git Graph 与 Desktop VNC
  卡、输入框 Delegate mode 开关**全部在位**；Bot 会话（ds-bot Chief）成功创建并回复
- 控制台：0 个 error 与本仓库相关

## 6. 顺带发现（不是 alpha.3 的回归）

**Preview Notice 的「Continue」存不下去。** 点确认会报
`The acknowledgement could not be saved. Please try again.`。

我在**全新 rc.5 控制实例**（`/tmp/rc5home`）上复现了同样的报错，所以这是**现存问题**，
不属于本次升级的回归。它是 `ui-settings-general` 命名空间的写入没落盘，
和 9 个自研插件无关。升级时不必为它卡住。

## 7. 未验证

- 真实 models 调用（演练实例没有配模型）
- supervisor 面板的 systemd start/stop/restart（容器内没有 unit）
- agent-teams 0.1.28 的多 Bot 协作实际流程
- browser-vnc 的真实 X server 链路（容器无 X，与 rc.5 时同一限制）

## 8. 回滚

`npm i -g @deepseek-ai/dsh@0.2.1-rc.5` + 恢复 `package.json` / `cordis.patch.yml` /
`yiln.cordis.yml` 备份 + `pnpm install` + 重启。
注意：0910 那次把 `compatibility.json` 里的 agent-teams 豁免**撤销了**（因为 0.1.28
不再需要它）。回滚到 rc.5 + agent-teams 0.1.27 时要重新授予：

```sh
dsh plugin --profile main allow-version \
  "@nanmicoder/dsh-agent-teams@0.1.27" --dsh-version 0.2.1-rc.5 --accept-risk
```

---

# 执行记录（2026-11-04 09:31–09:40）

**已执行完毕（2026-11-04 09:40）。当时 live `main` profile 运行 `0.2.2-alpha.3`。**
后续已于 2026-11-05 升到 `0.2.2-rc.1`，见 [COMPATIBILITY.md](../../COMPATIBILITY.md)
的当前验证基准。本文记录的是 alpha.3 这一步。

## 备份

```
/root/.dsh/upgrade-alpha3-20261104-093141/
├── package.json
├── cordis.patch.yml
├── cordis.yml
├── yiln.cordis.yml
├── fragment.yml
├── pnpm-lock.yaml
├── compatibility.json
└── node_modules.tar.gz   (41M)
```

## 实际步骤

1. 删除 `yiln.cordis.yml` 里 `tool-subagent-list-agents` 那 2 行，换成一端说明注释。
   用带 `!!js` schema 的 js-yaml 复验：24 个顶层条目、`delegation` 组的 8 个子行
   不再包含 `list-agents`。
2. `npm i -g @deepseek-ai/dsh@0.2.2-alpha.3` → `dsh --version` 输出 `0.2.2-alpha.3`。
3. `pnpm add` 12 个官方包到 `0.2.2-alpha.3` + `@nanmicoder/dsh-agent-teams@0.1.28`。
   全部核实安装副本的版本，不只看命令成功。
4. `dsh plugin --profile main revoke-version "@nanmicoder/dsh-agent-teams@0.1.27" --dsh-version 0.2.1-rc.5`
   → `compatibility.json` 变成 `{}`。**这次升级不依赖任何豁免。**
5. `systemd-run --collect` 调度脱离进程树的单元执行重启（会话本身在
   `dsh-daemon.service` 的 cgroup 里，直接重启会杀掉自己）。

## 验收结果

- 服务：active，PID 2025794，0 次重启，重启后 5 分钟内 0 条 error。
- 启动日志：`disabling profile plugin` **0 条**（升级前的演练里是 109 条）。
- 依赖审计（alpha.3）：**36 个依赖 0 个不通过**，豁免已清空。
- `--dump-config`：18 行 `@yiln-dsh/*`、9 个 Loader id 齐全、无 `disabled: true`；
  `list-agents` 行已消失；`agent-teams` 行正常展开。
- Boot payload：`release.version = 0.2.2-alpha.3`，93 个 client 条目，
  6 个 `@yiln-dsh/*` 模块全部登记。
- Client 模块：6 个全部 HTTP 200，字节数 = 源码 + 73~82 字节的模块包装
  （`supervisor` 的源码在 `lib/client.js`，实际 39546 字节对得上）。
- Host 路由：`/_dsh/supervisor/state` → 200（`status: running`、`pid: 2025794`、
  `restarts: 0`，与真实进程一致）；`/_dsh/desktop-vnc/sessions` → 200。
- 浏览器：GUI 正常，会话历史正常渲染，控制台无 DSH 相关 error。
- **`list_agents` 实测可用**：在当前会话里调用返回 `(no subagents)`，
  证明删掉那一行没有丢掉工具能力。

## 与演练的一处差异

演练时该会话的 `list_agents` 未被调用过；正式执行后确认它由
`tool-subagent-control` 主行的 `apply()` 注册，删行只去掉重复注册，能力完整保留。

## 未验证

- 真实模型调用（当前 profile 用的是 `sub2api-gpt`，未在本轮对话里实际发起）
- supervisor 面板的 systemd start/stop/restart 按钮
- agent-teams 0.1.28 的多 Bot 协作实际流程
- browser-vnc 的真实 X server 链路

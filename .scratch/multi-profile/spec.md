# 一个入口管理多个 profile —— 设计

状态：第 1–3 步已实现并验证（2026-10-28），第 4–7 步未开始。
前置：ADR 0001（守护进程内嵌于主环境）、ADR 0003（联邦取代 SSH）、`docs/changes/federation-decisions.md`。
相关：`GLOSSARY.md`（本设计需要修订它，见 §7）。

## 0. 需求

操作者原话：

> 多 profile 可以，甚至远程也可以多 profile，你先探索一下可不可行

拆成两条可验证的要求：

| # | 要求 | 判据 |
| --- | --- | --- |
| R1 | 一个页面管理本机的多个 profile | 侧边栏能切到本机另一个 profile 的完整界面，与切到远端环境体验一致 |
| R2 | 一台机器上跑多个 profile，且远程可访问 | 边端跑 N 个 dsh，主端把它们当 N 个环境列出与切换 |

以及三个操作者已定的取舍（2026-10-28）：

| # | 决定 |
| --- | --- |
| D1 | 会话存储**按 profile 隔离**，各写自己的目录 |
| D2 | 本机 profile 进程由 **gateway 内 spawn 子进程**看护，不走 systemd |
| D3 | 先写本文档，评审通过再实现 |

## 1. 探索结论（已实测，非推演）

在 `/root/.dsh` 上做了以下验证，全部有据可查：

| 结论 | 证据 |
| --- | --- |
| 同机可并发跑两个 profile，互不干扰 | 56994(`review`) 与 56995(`main`) 同时监听，各自 preset 列表独立 |
| 并发写共享会话存储**不损坏** | 两实例同时写，两个会话各 21/24 行，全部可解析 |
| **会话列表目前完全共享** | 两个 profile 都列出同样的 1294 个会话，含对方刚建的那个 |
| 路由机制**已写好但未接** | `lib/entry.js` 的模块注释描述的就是 profile 路由；`routeEnvironment`/`proxyRequest`/`scopeCookiePath`/`scopeLocation` 均可用 |
| 注册表**没有本机形态** | `lib/registry.js:35` 字段白名单只有 `id/label/token/hostname/machineId/lastSeen/enabled` |

会话共享的根因：两个 profile 的 `session-persistence-jsonl` 都是 `root: dshHomePath('sessions')`，
而存储按 **cwd** 分目录（`projectKey(cwd)`），与 profile 无关。

## 2. 与现有设计的冲突（必须先解决）

**`GLOSSARY.md` 第 10 行写着：**

> 每个环境**有且只有一个 dsh 进程在运行**，那个进程就在该环境所在的机器上。

**`federation-decisions.md`「仍然开放」写着：**

> 一台机器跑两个 dsh（多实例边端）是否需要支持

本设计回答那个开放项：**需要，且一个 profile 一个 dsh 进程**。

因此术语表这句话必须改，否则后续所有讨论都会在「一个环境到底几个进程」上打转。
建议改为：

> 一个环境是**一台机器上的一个 profile**，每个 profile 有且只有一个 dsh 进程在运行。

这条改动同时让 R1 与 R2 用同一套词：本机 profile 与远程 profile 都只是「环境」，
区别只在可达方式（本机 loopback / 隧道）。这正是本设计的核心简化。

## 3. 形态

```
dsh-daemon.service → dsh --profile main --port 56789          ← 主节点，唯一公网监听
                      ├─ gateway（登录 / 路由 / 环境列表）
                      ├─ root harness（main profile，挂 /main/）
                      ├─ spawn ─→ dsh --profile review --port 57001   （本机 profile）
                      └─ spawn ─→ dsh --profile work   --port 57002   （本机 profile）

边端（另一台机器）
  dsh-daemon.service → dsh --profile main --port 56789        ← 边端主节点
                        ├─ gateway（role: edge，拨号回主端）
                        ├─ root harness（本机 main）
                        └─ spawn ─→ dsh --profile review --port 57001
```

**边端内部也是同一套机制**：边端的 gateway 一样管理本机多个 profile，只是它自己
还要拨号回主端。主端看到的是「一个环境」，进去之后看到的是边端自己的完整界面——
包括它的本机 profile 列表。这是联邦 Q16/Q32 的延续，不是新增语义。

## 4. 数据模型

### 4.1 环境记录加本机形态

`lib/registry.js` 的 `FIELDS` 增加两个，并引入 `kind`：

| 字段 | 适用于 | 含义 |
| --- | --- | --- |
| `kind` | 全部 | `'local'`（本机 profile）或 `'remote'`（隧道边端）。缺省 `'remote'`，兼容现有记录 |
| `port` | `kind: 'local'` | 本机 harness 的 loopback 端口 |
| `profile` | `kind: 'local'` | 要拉起的 profile 名 |

`token` 对 `local` 可选：本机 profile 不经过隧道验证，走的是 `root` 那套
「gateway 自己换取 cookie」的路径。校验规则按 `kind` 分支，而不是放宽全局。

现有 `environments.json` 里那条 `6.13` 记录没有 `kind`，按 `'remote'` 读取，
无需迁移。

### 4.2 会话存储按 profile 隔离（D1）

每个非 root profile 在自己的 patch 里覆盖：

```yaml
- id: session-persistence-jsonl
  config:
    root: /root/.dsh/profiles/<name>/sessions
```

由 gateway 在**生成 profile 骨架**时写入，不需要手工配置。

代价（必须写进文档）：新 profile 看不到 `$DSH_HOME/sessions` 下的历史会话。
`main` 保持现状不动，因此现有会话零影响。

## 5. 进程管理（D2：gateway 内 spawn）

### 5.1 为什么不是 systemd

操作者选了 gateway 内 spawn。记录理由与代价：

- 好处：不需要 root、不需要为每个 profile 写 unit、生命周期跟着 gateway 走，
  停止 gateway 就停止全部 profile，不会留下孤儿。
- 代价：**gateway 崩了所有本机 profile 一起消失**；重启后需重新拉起；
  与 supervisor 的会话恢复职责有重叠，需划清。

划清方式：supervisor 继续只管**本进程**的会话恢复（它恢复的是本进程内被中断的
agent），不介入 profile 子进程。profile 子进程的存活由 gateway 负责。

### 5.2 拉起

新增 `lib/profile-process.js`：

| 方法 | 行为 |
| --- | --- |
| `ensure(profile)` | 未运行则 `spawn(execPath, [script, '--profile', p, '--no-open', '--port', port])`，stdout 里读出启动 token 后缓存 cookie |
| `stop(profile)` | 先 SIGTERM，超时后 SIGKILL；等待端口释放 |
| `status(profile)` | `{ state: 'running'\|'starting'\|'stopped'\|'failed', port, pid }` |
| `restart(profile)` | stop 后 ensure |

端口分配：从配置的 `localProfilePortRange`（默认 `57000-57099`）取最低可用，
与 `browser-vnc` 的 `rfbPortRange` 同一策略——**只复用自己启动的**，
已有响应的端口一律跳过而非接管。

`spawn` 的环境必须显式带 `DSH_HOME`。这一点有历史教训：早前测试副本里
`yiln-company` 一直失败，根因就是换了 `DSH_HOME` 后模块解析基址不对
（`dsh` 启动时不传解析基址，`boot()` 只有 3 个参数）。

### 5.3 崩溃处理

子进程退出后不自动无限重启（避免崩溃循环吃满 CPU）：记录 `failures`，
1 分钟内超过 3 次则标 `failed` 并在面板显示最后一次退出码与 stderr 尾部，
由操作者点「重启」。这与 `browser-vnc` 对陈旧实例目录的态度一致：
宁可留一个看得见的失败，也不静默重试。

## 6. 路由

### 6.1 一个前缀，两种后端

`handleHttp` 与 upgrade 处理各加一档：

```js
const routed = routeEnvironment(url, ids)        // 现有：/env-<id>/
if (routed !== undefined) {
  const env = registry.find(routed.id)
  if (env.kind === 'local') {
    await localProfiles.ensure(env.profile)
    return proxyRequest({ req, res, port: env.port, path: routed.path, prefix: `/${routed.id}`, cookie: ... })
  }
  // 现有隧道分支
}
```

复用 `proxyRequest`、`scopeCookiePath`、`scopeLocation`——它们本来就是为这个写的
（见 `entry.js` 模块注释的三条前提，均已满足）。

**不做的事**：不把本机 profile 塞进 `root`。`root` 是「本进程自己那个 harness」，
语义是单数；扩成复数会让 ADR 0001 的结论失去边界。

### 6.2 cookie 隔离

`scopeCookiePath` 已把 `Set-Cookie: Path=/` 改写为 `Path=/<id>/`，
profile 之间不会互相污染。本机 profile 的 cookie 由 gateway 用启动 token 换取，
与 `embeddedRoot.ensure()` 同一手法，只是每 profile 一份。

### 6.3 前缀命名

环境 id 由注册表生成（`[a-z][a-z0-9-]{0,31}`）。本机 profile 的 id 建议直接取
profile 名（`review`、`work`），因为它天然唯一且可读；冲突时回退到生成 id。
`RESERVED_IDS` 已排除 `main`/`admin`/`api` 等，无需改动。

## 7. 需要一并修改的既有文档

| 文件 | 改什么 |
| --- | --- |
| `GLOSSARY.md:10` | 「每个环境有且只有一个 dsh 进程」→ 按 §2 改为「一个 profile 一个进程」 |
| `GLOSSARY.md` 环境 id 一节 | 补：本机 profile 的 id 取 profile 名 |
| `federation-decisions.md`「仍然开放」 | 移除「一台机器跑两个 dsh」这一项，改为指向本文档 |
| `federation-decisions.md` | 新增 Q 条目记录 D1/D2 两个决定 |
| `docs/changes/daemon-design.md` §5 | `local` 类型从「已放弃」改回「已实现」，并说明与旧 SSH 方案的区别 |

`federation-decisions.md` 的 Q48（「环境不占本地端口」）**与新设计冲突**：
本机 profile 就是占本地端口的。必须显式修订为「远端环境不占本地端口；
本机 profile 占 loopback 端口」。

## 8. 实施顺序

每步独立可验证，前一步不绿不进下一步。

| 步 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 注册表加 `kind`/`port`/`profile`，按 kind 分支校验 | 现有 `environments.json` 原样读入；单元测试覆盖两种 kind |
| 2 | `lib/profile-process.js`：spawn / stop / status | 能拉起一个 profile，`/admin/state` 看到 `running` |
| 3 | 路由接上本机 profile（HTTP + upgrade） | 浏览器打开 `/<id>/` 看到该 profile 的完整界面 |
| 4 | cookie 换取与隔离 | 两个 profile 同时登录，互不踢出 |
| 5 | 面板：新建/删除本机 profile | 面板操作后 `environments.json` 正确 |
| 6 | 生成 profile 骨架时写入独立会话根（D1） | 新 profile 的会话不出现在 main 列表 |
| 7 | 边端同机制（远程多 profile） | 边端跑两个 profile，主端看到两个环境 |

第 7 步依赖边端 gateway 与本机 profile 管理是同一份代码——本设计天然满足，
因为边端的 gateway 也跑同一插件。

### 8.1 进度（2026-10-28）

| 步 | 状态 | 证据 |
| --- | --- | --- |
| 1 注册表 `kind`/`port`/`profile` | ✅ 完成 | `pkgs/gateway/lib/registry.js`；`test/registry.test.js` 14 例 |
| 2 `lib/profile-process.js` | ✅ 完成 | 18 例单测；真机 spawn 见 §8.2 |
| 3 路由接上本机 profile | ✅ 完成 | `test/local-profile-route.test.js` 7 例（含 WebSocket upgrade） |
| 4 cookie 换取与隔离 | ✅ 完成 | 真机：launch token → `dsh-auth-…` cookie → 200 带 boot payload |
| 5 面板新建/删除 | ⬜ 未开始 | — |
| 6 独立会话根 | ⬜ 未开始 | — |
| 7 边端多 profile | ⬜ 未开始 | — |

第 4 步随第 2、3 步一起做完：`localProfileFor` 在 `ensure()` 之后用子进程打印的
launch token 换 cookie，并按环境 id 缓存，`refresh()` 在重启后丢弃它。

### 8.2 真机验证（2026-10-28）

不是纸面推演，是实际跑通的：

```
[log] daemon: profile review listening on 127.0.0.1:57100
READY port=57100 token=rEye4qSyvjBd…
COOKIE dsh-auth-vM3Xl69b1x2AXe3I8AOdBj0…
PAGE 200 has boot payload
STATUS running pid=3220047 rss=2369MB
STOPPED
```

即：spawn 子进程 → 读到 launch URL → 换到 cookie → 用 cookie 拿到该 profile 的
完整界面 → 读到 pid 与 RSS → 干净停止。RSS 实测 **2.37 GB**（不是 §9.2 里
main 进程的 3.87 GB，因为那个已经跑了 2 小时）。

### 8.3 实现中发现并修掉的并发缺陷

`ensure()` 原本在 `await claimPort()` **之后**才创建记录，于是两个并发调用都通过
状态检查、各领一个端口、各 spawn 一个进程——同一个 profile 起两份，把一个会话
注册表劈成两个监听。测试 `a second ensure while starting joins the same promise`
抓到了它。修法是把记录**在第一个 await 之前**就建好（先占位、后填端口）。

这个缺陷不会在单线程顺序调用里出现，只有并发才会触发；而并发恰恰是浏览器同时
打开两个标签页时的常态。

## 9. 已定的取舍（2026-10-28，操作者）

| # | 问题 | 决定 | 落地 |
| --- | --- | --- | --- |
| D4 | 会话迁移 | **不迁移** | 1294 个历史会话留在 `$DSH_HOME/sessions`；新 profile 从空开始。不提供导入动作 |
| D5 | 凭据共享 | **保持共享** | 不设 `credentials.path`，所有 profile 读 `$DSH_HOME/.credentials.yaml` |
| D6 | 资源显示 | **要显示** | 面板每个 profile 一行常驻内存 |

### 9.1 凭据共享的事实（写下来，避免以后再查）

`dsh-credentials-local` 的默认路径是（`lib/index.js:58`）：

```js
filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), '.credentials.yaml'))
```

而 `resolveDshHome()`（`dsh-home-paths:109`）**只读 `$DSH_HOME`，不看 profile**。
实测：`/root/.dsh/.credentials.yaml` 存在，`profiles/*/` 下没有任何 `.credentials.yaml`。

因此 D5 的实际含义要说清楚：**任何一个 profile 都能读到全部密钥**，
包括审查用的 profile 也能拿到 `SUB2API_API_KEY`。这是操作者明确接受的取舍。

隔离是可选的，不需要改代码——`path` 是 schema 字段：

```yaml
- id: credentials
  config:
    path: /root/.dsh/profiles/<name>/.credentials.yaml
```

将来若要收紧，只改这一行，代价是新文件要重新填一次 key。

### 9.2 资源显示的来源

每个 profile 的内存取 `/proc/<pid>/status` 的 `VmRSS`（`profile-process.js` 已持有 pid）。
面板在 `describe(environment)` 里多带一个 `rssBytes`，本机 profile 才有，
远端环境留空（远端由它自己的面板显示，不跨隧道采集）。

**实测修正 ADR 0001 的基准**：本机 main 进程（pid 2835772，跑了 2 小时）的
`VmRSS` 是 **3.87 GB**，不是 ADR 0001 记的 380 MB。380 MB 应是刚启动时的空载值。

这个差距改变了结论：开 4 个 profile 不是 1.5 GB 而是可能到十几 GB。
所以资源显示不是「锦上添花」，而是决定能开几个 profile 的前提；
实现时应在面板上按 RSS 排序，并对超过阈值（建议 4 GB）的行标黄。

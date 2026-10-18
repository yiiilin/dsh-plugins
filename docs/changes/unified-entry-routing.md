# 技术方案：一个入口，三包协同

> 状态：待评审。目标是把「公网入口 / 路由 / 认证 / 守护」收成一个对外面，
> 但不把 6200 行代码合并成一个包。

## 1. 问题

当前生产有三个独立对外面：

| 组件 | 端口 | 认证 | 问题 |
|---|---|---|---|
| core profile | `127.0.0.1:3080` | 无（loopback） | — |
| auth-webserver | 15 个网卡 `:3080` | 登录 + TOTP + Passkey | 唯一公网入口 |
| fleet 网关 | `0.0.0.0:8090` | **无** | 门户带 box 的 root token，已在 13:08 封停 |
| web-daemon API | 随 core 的 `/api` | 宿主的 `/api` 栅栏 | 路径散落 |

两个具体缺陷：

1. **fleet 网关旁路了宿主认证**：任何能连 8090 的主机拿门户 HTML 就能拿到
   box 的启动 token，而 box 内有 root bash。已确认在 `10.10.10.222:8090` 上可复现。
2. **两个入口两套凭据**：同一台机器上要维护两套"能不能进"的判断，且第二套是空的。

## 2. 目标与非目标

**目标**

- 一个对外监听（auth-webserver），一套认证
- 每个 profile / box 一个路径前缀，全部经同一入口
- web-daemon 的管理面收进 `/admin`，与业务路径分离
- 三个包仍各自独立发布、独立升级

**非目标**

- 不做包级合并（见 §8 风险）
- 不做 unix socket（core 的 `host` 校验只接受 IP 字面量，见附录 A）
- 不改变 profile 内部仍用 loopback HTTP 的事实

## 3. 整体结构

```
                  ┌──────────────────────────────────────────┐
   浏览器 ────────►│ auth-webserver   0.0.0.0:3080 (15 NIC)   │
   (公网/内网)     │  · 登录 / TOTP / Passkey / PWA           │
                  │  · 路由表（本方案新增）                    │
                  └───────┬──────────────────┬───────────────┘
                          │                  │
              kind: core  │                  │ kind: proxy
                          ▼                  ▼
              core profile            fleet 网关
              127.0.0.1:3080          127.0.0.1:8090
              · cookie 桥接             · 剥 /fleet、按 box 转发
              · stripLaunchToken       · cookie Path 作用域化
                          │                  │
                          │                  ▼
                          │            box profile
                          │            127.0.0.1:3101
                          ▼
                       ┌────────────────────────┐
                       │ web-daemon（同进程）    │
                       │  管理 API 在 /admin     │
                       └────────────────────────┘
```

要点：

- **auth-webserver 是唯一公网监听**。fleet 网关和 box 全部回到 loopback。
- **路由表是 auth-webserver 里唯一的决策点**，最长前缀匹配。
- **fleet 的网关逻辑不搬进 auth-webserver**：它保留自己的端口和转发实现，
  auth-webserver 只负责"这一段转给谁"。
- **web-daemon 与 auth-webserver 同进程**（同一个 profile），`/admin` 由
  auth-webserver 识别后交给进程内的 webDaemon 服务，不经 HTTP 回环。

## 4. 路由表

### 4.1 配置形状

`auth-webserver` 新增 `routes`：

```yaml
- id: webserver-auth
  config:
    port: 3080
    targetHost: 127.0.0.1
    targetPort: 3080
    routes:
      # 管理面：进程内直连，不经 HTTP 回环
      - prefix: /admin
        kind: local          # 交给进程内服务
        service: webDaemon
      # fleet：网关自己的监听
      - prefix: /fleet
        kind: proxy
        host: 127.0.0.1
        port: 8090
        # 这一段不参与 core 的 cookie 桥接与 launch-token 剥离
        coreSession: false
        stripLaunchToken: false
```

默认值（无 `routes` 时）与本方案前完全一致：单一 core 上游。

### 4.2 匹配

```js
// 最长前缀优先；未命中走 core（默认路由）
function resolveRoute(pathname) {
  let best
  for (const route of routes) {
    if (pathname !== route.prefix && !pathname.startsWith(`${route.prefix}/`)) continue
    if (best === undefined || route.prefix.length > best.prefix.length) best = route
  }
  return best   // undefined → core
}
```

语义与 `dsh-host-webserver` 的 prefix 匹配保持一致（`lib/index.js:499-503`），
避免两套"前缀"含义不同。

### 4.3 每类路由的处理差异

| 步骤 | `kind: core`（默认） | `kind: proxy` | `kind: local` |
|---|---|---|---|
| `validateGatewayRequest` | 是 | 是 | 是 |
| 登录校验 | 是 | **是** | 是 |
| `stripLaunchToken` | 是 | **否** | 否 |
| `attachCoreCookie` | 是 | **否** | 否 |
| Host 改写 | `coreTarget.authority` | 目标 authority | — |
| Origin 改写 | 是 | 是 | — |
| 响应 `Set-Cookie` | 原样 | 交给 fleet 作用域化 | — |
| WS upgrade | 转发 core | 转发目标 | 不支持 |

**为什么 `proxy` 必须跳过 `stripLaunchToken`**：auth-webserver 剥的是
`?token=`（`core-session.js:5`），而 box 的启动 token 也是 `?token=`。
不跳过就是本方案要解决的问题本身。

**为什么 `proxy` 必须先过登录**：这正是修复缺陷 1 的关键——fleet 门户
（含 box token）从此只有在登录后可见。

## 5. fleet 的改动

| 项 | 现状 | 改后 |
|---|---|---|
| `gatewayHost` | `0.0.0.0` | **`127.0.0.1`**（已改默认值） |
| `basePath` | 无 | **`/fleet`**，`routeRequest` 先剥这段 |
| 门户链接 | `/box1/?token=…` | `/fleet/box1/?token=…` |
| cookie `Path` | `/box1/` | `/fleet/box1/` |
| `Location` 改写 | `/box1/…` | `/fleet/box1/…` |
| box 的 `--trusted-host` | 网关 authority | 不变（网关仍需该值以通过 box 的 `/api` 栅栏） |

`basePath` 同时让 fleet 在 `standalone` 模式下继续可用（`basePath: ''`），
换 web 插件时不必改代码。

## 6. web-daemon 的 `/admin`

### 6.1 现状

`web-daemon` 通过 `ctx.webServer.register` 挂了 6 个精确路径：

```
/_dsh/web-daemon/{state,save,start,stop,restart,reset}
```

这些路径经由 core profile 的 `/api` 栅栏鉴权（Host + Origin + cookie）。

### 6.2 改后

```
/admin/daemon/{state,save,start,stop,restart,reset}
```

由 auth-webserver 的 `kind: local` 路由接管，**在登录之后、进程内**调用
webDaemon 服务，不经过 HTTP 回环，也不经过 `/api` 栅栏。

好处：

- 管理面与业务面路径分离，一眼能看出哪些是运维动作
- 不再依赖 `/api` 栅栏的 Host 假设（该栅栏是为浏览器 API 设计的）
- 少一跳

### 6.3 兼容期

保留 `/_dsh/web-daemon/*` 一个发布周期（标记 deprecated），客户端两处都读。
下个版本删除。

> 注：`web-daemon` 的 client 半当前调用的就是 `/_dsh/web-daemon/*`，
> 所以本次要同步改 client。

## 7. 变更清单

| 文件 | 改动 | 预估 |
|---|---|---|
| `pkgs/auth-webserver/index.js` | `routes` 配置、`resolveRoute`、proxy/local 两个分支 | ~90 行 |
| `pkgs/auth-webserver/index.js` | `proxyRequest`/`proxyUpgrade` 参数化目标 | ~30 行 |
| `pkgs/auth-webserver/index.js` | `/admin` local 分发到 webDaemon 服务 | ~25 行 |
| `pkgs/fleet/lib/gateway.js` | `routeRequest` 支持 `basePath` | ~10 行 |
| `pkgs/fleet/lib/gateway.js` | cookie/Location 前缀带 `basePath` | ~5 行 |
| `pkgs/fleet/lib/portal.js` | 链接带 `basePath` | ~3 行 |
| `pkgs/fleet/index.js` | `basePath` 配置、传入 gateway/portal | ~8 行 |
| `pkgs/web-daemon/index.js` | 新增 `/admin/daemon/*` 行，旧路径标记 deprecated | ~20 行 |
| `pkgs/web-daemon/lib/client.js` | 改调新路径 | ~6 行 |
| 各包 `cordis.patch.yml` | 新增配置项默认值 | ~10 行 |
| 测试 | 路由匹配、proxy 不剥 token、`/admin` 分发、fleet basePath | ~14 用例 |

**不改动**：fleet 的 supervisor、profile 生成、bootstrap；web-daemon 的
systemd 单元生成与会话恢复；auth-webserver 的登录/TOTP/Passkey/PWA。

## 8. 为什么不做包级合并

| 包 | 行数 | 职责 | 风险 |
|---|---|---|---|
| auth-webserver | 2491 | 公网唯一入口 | 坏了全网进不去 |
| web-daemon | 3085 | systemd 守护 + 会话恢复 | 状态敏感 |
| fleet | 612 | 网关 + box 监管 | 新写，仍在修 bug |

合并后约 6200 行，且把**未稳定的代码放进关键路径**。本方案让三者仍然独立
发布、独立回滚，而对外只有一个入口——即用户要的结果，不承担合并的中间风险。

若日后确需合并成一个名为 `daemon` 的包，本方案是安全的中间态：路由表就是
合并后的分发器，届时只是把三个 `apply` 搬进同一个包。

## 9. 安全影响

**修复**：fleet 门户及其携带的 box token 不再对未认证访问可见（§4.3）。

**新增攻击面**：无。路由表只增加"已登录用户能到达哪里"，不增加对外监听。

**保留的判断**：

- `/fleet/` 与 `/admin/` 都要登录 → 只有 box 权限的人进不去（预期行为）
- box 仍需自己的 token（经 fleet 的交换流程）→ 纵深防御

**需要注意**：`kind: proxy` 的目标是 loopback，所以**必须**确信目标端口只被
可信进程占用。fleet 网关与 box 都是本机进程，符合。

## 10. 验证计划

沿用本轮已证明忠实的方法：**同 `DSH_HOME`、新 profile 名、独立端口**。

1. 单元：`resolveRoute` 最长前缀、`proxy` 不剥 token、`/admin` 分发
2. 集成（副本）：
   - 未登录访问 `/fleet/` → 302 登录页
   - 登录后访问 `/fleet/` → 门户，box 可 Open
   - `/admin/daemon/state` 返回守护状态
   - core 首页、`/api`、插件路由全部不受影响
3. 生产：备份 → 重启 → 上述检查 → 失败自动回滚

## 11. 分步交付

| 步 | 内容 | 可独立上线 |
|---|---|---|
| 1 | fleet：`gatewayHost` 回 loopback（**已完成**） | 是 |
| 2 | fleet：`basePath` + 门户/cookie/Location 带前缀 | 是（standalone 仍可用） |
| 3 | auth-webserver：`routes` + `kind: proxy` | 是（无 `routes` 时行为不变） |
| 4 | web-daemon：`/admin/daemon/*` + client 迁移 | 是（保留旧路径） |
| 5 | 生产启用 `routes`，fleet 网关保持 loopback | 是 |

每步都可回滚：配置项默认值保持"等于本方案之前的行为"。

## 附录 A：为什么不做 unix socket

`dsh-host-webserver` 对 `host` 的校验要求 IP 字面量：

```js
// lib/index.js:252-257
host: z.transform(z.string(), (value) => {
  const parsed = parseIpLiteral(value)
  if (parsed === void 0) throw notLiteralError(value)
  if (isWildcardAddress(parsed)) throw new Error(`... wildcard ... not supported`)
  return value
})
// :468  this.server.listen(this.config.port, this.config.host, …)
// :189  bindUrlHost() 假定 host 可解析为 IP
```

`/run/dsh/web.sock` 会在配置校验阶段直接失败。支持它需要改 core（上游代码），
升级会被覆盖，因此不做。若日后需要，可行的替代是在 daemon 侧加 socket，
再把连接代理到 loopback——本方案的 `kind: proxy` 已为这种扩展留好了位置。

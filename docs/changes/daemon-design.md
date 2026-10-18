# 技术方案：daemon —— 单入口、多 profile、自动部署 helper

> 新插件 `daemon`。整合 auth-webserver（认证）、fleet（profile 监管与转发）、
> web-daemon（守护管理）三者对外的职责。
>
> 不复用旧架构，按新设计实现；旧包在 daemon 稳定后退役。
>
> 本文的三处可行性结论均已实测，见 §9。

## 1. 结构

```
                    ┌─────────────────────────────────────────────┐
   浏览器 ──────────►│ daemon                                      │
   (0.0.0.0:3080)    │  · 唯一公网监听（TLS 由外部反代终止）        │
                    │  · 登录 / 会话 / TOTP / Passkey             │
                    │  · 路由 /<id>/… → 127.0.0.1:<port>          │
                    │  · /admin：profile 管理与 SSH 自动部署       │
                    │  · 监管：启停 profile 子进程                 │
                    └──────┬──────────────┬───────────────────────┘
                           │              │
                    /local/│              │/box1/ · /box2/ …
                           ▼              ▼
                  local profile      ssh profile
                  127.0.0.1:56789    127.0.0.1:56790
                  fs/subprocess      fs/subprocess/sandbox
                  = 本地             = 经 SSH helper 落到远端
```

- **daemon 是唯一对外监听**：`0.0.0.0:3080`（可配）
- **每个 profile 是独立的 dsh 进程**，只听 `127.0.0.1:<高位端口>`
- **ssh profile 的 dsh 进程仍在本地**，只有 `fs`/`subprocess`/`sandbox`
  三个 provider 通过 SSH helper 落到远端——dsh 既有机制
- **没有独立网关**：daemon 自持 HTTP server，直接做前缀路由与 WS 隧道

## 2. 端口

| 用途 | 默认 | 说明 |
|---|---|---|
| daemon | `0.0.0.0:3080` | 可配 host/port |
| profile | `127.0.0.1:56789` 起 | 依次递增，分配前探测空闲 |

- 起始端口可配（`portBase`，默认 56789）；该段当前仅 59015 被占
- 分配后持久化在注册表，重启不变（避免 cookie 失效）

## 3. 路由

daemon 自持 server，前缀匹配与 WS 升级都由自己决定：

```js
// 越具体越先匹配
/admin/**     → 进程内管理 API
/api/auth.*   → 登录端点（进程内）
/<id>/**      → 代理到该 profile
/             → 门户（profile 列表）
```

WS：`server.on('upgrade')` 用同一套前缀匹配，连目标端口后原样隧道。
**不需要为每个 profile 预注册 WS 路径**——dsh 自带的 `webServer` 的 upgrade
只支持精确路径（`lib/index.js:445`），自持 server 绕开了这个限制。

### 3.1 转发时的改写

```js
headers.host   = `127.0.0.1:${port}`
headers.origin = `http://127.0.0.1:${port}`
headers['x-forwarded-for'] = clientAddress(req)
```

profile 的 `/api` 栅栏（`dsh-client-connection/lib/index.js:245`）接受
loopback authority，因此 **profile 无需 `--trusted-host`**。

## 4. 认证

复用 auth-webserver 已验证的模块，不重写：

| 模块 | 用途 |
|---|---|
| `session-store.js` | 会话持久化 |
| `passkey-store.js` | Passkey |
| `totp.js` | 两步验证 |
| `policy.js` | Host/Origin 校验 |
| `login-page.js` | 登录页（中英） |
| `pwa.js` | PWA |

**cookie 名天然不冲突**（已核实）：

```
daemon   → dsh_auth_token                                    固定名
profile  → dsh-auth-<b64(sha256("127.0.0.1:56789"))>         // :335-336
             authority = url.host，含端口（:312）
```

端口不同即名字不同，隧道无需做 cookie 重命名。

**token 直通**：daemon 用登录 cookie，不占 `?token=`，profile 的启动 token
原样转发即可。（旧方案里 auth-webserver 剥 `?token=`，是必须做交换的根因。）

## 5. profile 类型

| | `local` | `ssh` |
|---|---|---|
| dsh 进程 | 本地 | 本地 |
| fs/subprocess/sandbox | 本地 provider | `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` |
| 注册表字段 | id, kind, port, workspace | 另加 ssh*（见 §6） |
| workspace | 本地目录 | 远端目录 |

`ssh` profile 的 patch（沿用已验证组合）：

```yaml
- insert:
    - id: ssh
      name: '@deepseek-ai/dsh-ssh'
      config:
        host: <sshHost>
        launch: { kind: executable }          # 见 §6，二进制模式
        helper: <远端 helper 绝对路径>
        helperHash: <小写 sha256>
        workspace: <远端目录>
- id: fs-sandbox
  disabled: true
- insert: [{ id: fs-ssh, name: '@deepseek-ai/dsh-fs-ssh' }]
- id: subprocess
  disabled: true
- insert: [{ id: subprocess-ssh, name: '@deepseek-ai/dsh-subprocess-ssh' }]
- id: sandbox
  disabled: true
- insert: [{ id: sandbox-ssh, name: '@deepseek-ai/dsh-sandbox-ssh' }]
- id: sandbox-policy
  config: { mode: danger-full-access, workspaceRoot: <远端目录> }
- id: approval
  config: { policy: never }
```

> `danger-full-access` 必须配 `approval: never`，否则权限预设拒绝激活
> （`composed sandbox and approval defaults match no preset`）——实测踩过。

## 6. SSH 自动部署（本方案的核心新增）

### 6.1 用户流程

```
/admin  →  「添加远程服务器」
  ① 填写：地址(host[:port])、用户名、认证方式（密码 / 私钥 / 已有 alias）
  ② 点「连接测试」   → daemon 建连，回报：主机名、OS/glibc、架构、磁盘可写目录
  ③ 点「下一步」     → 上传 helper（进度条）、校验 hash、写注册表、生成 profile
  ④ 自动启动 profile → 出现在门户，可对话
```

第 ③ 步的「下一步」是显式确认点：在用户看到远端信息并点确认之前，
daemon 不写任何文件到远端。

### 6.2 helper 形态（已实测，见 §9）

**单文件、全静态链接的二进制：不依赖目标机的任何系统库。**

| 项 | 数值 |
|---|---|
| 构建方式 | `@yao-pkg/pkg`，目标 `node22-linuxstatic-x64` |
| 链接 | `statically linked`（`ldd` 无任何输出） |
| 未压缩 | 69 MB |
| gzip -9 | **26 MB** |
| 目标机依赖 | **无**：不需 Node、不需 glibc/libstdc++、不需 node_modules |
| 兼容 | 静态链接，glibc 版本无关（CentOS 7 亦可） |

实测依据：

```
$ ldd helper-static
        statically linked
$ file helper-static
ELF 64-bit LSB pie executable, x86-64, static-pie linked
$ gzip -9 -c helper-static | wc -c   →  26 MB
$ NODE_OPTIONS='--disable-sigusr1' ./helper-static   → exit 0
```

**为什么这条路可行**：`@yao-pkg/pkg` 用一份预编译的静态 Node 作为基底，
把 bundle 注入其中。比自建 Node（`--fully-static` 需完整工具链、30 分钟以上）
简单得多，也不需要 CI 环境。

**为什么不用 bun compile**：bun 的 musl 产物实测仍依赖 `libstdc++.so.6` 与
`libgcc_s.so.1`，在精简系统上无法启动。

**为什么不用 Node SEA**：SEA 是从本机 `node` 二进制复制而来，本机 node 是
动态链接（`libc.so.6` / `libstdc++.so.6` / `libgcc_s.so.1`），因此产物仍受
glibc 版本约束，且体积 119 MB（gzip 41 MB）。SEA 只在"目标机与本机同构且
glibc 足够新"时可用，作为退路保留。

### 6.2.1 helper 获取：缓存 → 动态构建 → 下载

三级策略，前一级成功即停止：

```
① 查缓存   $DSH_HOME/daemon/cache/dsh-helper-<ver>-<arch>.gz  (+ sha256)
             命中 → 直接分发（0 ms）

② 动态构建  本机用 bun + pkg 从已安装的 @deepseek-ai/dsh-ssh 构建
             热构建 1.6 s（base 二进制已缓存）
             冷构建 18.6 s（首次需下载 138 MB base）
             成功 → 落盘缓存 → 分发

③ 下载      https://<host>/daemon/helper-<ver>-<arch>.gz
             校验 sha256 → 落盘缓存 → 分发

都失败 → 明确报错，指出缺什么（无 bun / 无网络 / 源不可达）
```

**为什么动态构建优先**（实测依据）：

| 优点 | 依据 |
|---|---|
| 顺手解决 arm64 | 换 `--targets node22-linuxstatic-arm64` 即可，无需另行分发 |
| 版本永远匹配 | 从当前 profile 里装的 `dsh-ssh` 构建，不会与运行时版本错位 |
| 不需要托管二进制 | 少一个发布物与一个外链依赖 |
| 快 | 热 1.6 s |

**代价**：daemon 主机需要 `bun`（打包）与 `pkg`（注入）。
因此下载仍是必要的兜底——在精简容器里没有 bun 时，只能下载。

**构建源**：daemon 把 `@deepseek-ai/dsh-ssh` 声明为自己的依赖，
构建时用该包的 `lib/helper.js`。已实测：从 npm 装的普通依赖出发，
全套构建 1.6 s，产物 `statically linked` 且可运行。

### 6.2.2 本地缓存

```
$DSH_HOME/daemon/cache/
  dsh-helper-0.2.1-rc.2-linux-x64.gz          26 MB
  dsh-helper-0.2.1-rc.2-linux-x64.gz.sha256
  dsh-helper-0.2.1-rc.2-linux-arm64.gz        （按需构建或下载）
```

缓存键 = `版本 + 架构`。dsh 升级后版本变化，缓存自动失效并重建。

**远端去重**：部署前先 `ssh <host> 'sha256sum <helper>'`，
hash 命中则跳过上传（26 MB 传输可省）。

**分发**：

```sh
gzip -c <cache> | ssh <host> 'cat > <tmp> && gunzip -c <tmp> > <helper> && chmod +x <helper>'
# 之后远端回传 sha256 与缓存比对
```

实测：26 MB 经 gzip 管道传输到远端并校验成功。

### 6.3 构建

构建脚本产出 `dist/dsh-ssh-helper-<version>-linux-x64.gz`。三步补丁（均已实测）：

1. `../package.json` 的版本读取 → 内联常量（bundle 里没有这个文件）
2. `import.meta.resolve(...)` ×4 → `process.execPath`
   （CJS bundle 无 `import.meta`；4 处均为 lazy，且 PTC/Windows 专用）
3. `node:sea` → stub，令 `isSea()` 返回 `true`
   （helper 据此走 `kind: "executable"`、`entryPath: process.execPath`）

构建产物建议随 daemon 一起发布，或由 `/admin` 首次部署时按需生成。

### 6.4 连接方式

| 方式 | 存储 | 说明 |
|---|---|---|
| 密码 | 加密存 `$DSH_HOME/daemon/credentials.json`（0600） | 仅用于首次部署与建连 |
| 私钥 | 引用本机路径，或粘贴后保存 | 推荐 |
| 已有 alias | 引用 `~/.ssh/config` 的 alias | 最简，但需预先配置 |

无论哪种方式，**运行期都通过 OpenSSH 转发**（`dsh-ssh` 用 `ssh -T -M -S`），
daemon 只持有建立该连接所需的凭据。

### 6.5 远端信息探测

「连接测试」回报并写入注册表：

```
hostname, uname -m, /etc/os-release 的 ID+VERSION_ID
ldd --version 的 glibc 版本（判断二进制兼容性）
node -v（存在与否，决定是否需要二进制模式）
可写目录候选：$HOME、/opt、/tmp
```

若 glibc < 2.28 且远端无合适 Node，明确报错并给出建议，而不是静默失败。

## 7. `/admin`

```
GET    /admin/state                       注册表 + 运行状态
POST   /admin/profiles                    新建（local / ssh）
DELETE /admin/profiles/<id>               删除（先停止）
POST   /admin/profiles/<id>/start|stop|restart
GET    /admin/profiles/<id>/log           有界日志尾部
POST   /admin/ssh/test                    连接测试（不写远端）
POST   /admin/ssh/deploy                  上传 helper（需确认）
POST   /admin/reload                      重载 daemon 自身配置
```

全部要求登录会话 + CSRF。浏览器端一个设置页（`settings.plugins.tab`）。

路径由 daemon 自动管理：

- id 由用户给或自动生成；**daemon 校验并保证唯一、无冲突**
- 缺省 id 取 `hostname` 清洗后的形式（如 `box1`、`web-02`）
- 保留字：`admin`、`api`、`assets`、`plugins`、`connect`、`devtools`。
  用户给出保留字时，daemon 自动改为 `<name>-2` 而不是报错

`web-daemon` 的 systemd 单元生成与会话恢复逻辑整体搬入 daemon。

## 8. 迁移与退役

| 阶段 | 内容 |
|---|---|
| 1 | daemon 骨架：自持 server + 登录 + 门户 + `/admin` |
| 2 | local profile：provision + supervisor + 路由 + WS |
| 3 | ssh profile：二进制构建 + 自动部署 + 连接测试 |
| 4 | 搬入 systemd 单元生成与会话恢复 |
| 5 | 生产切换；旧包保留一个版本 |

前 4 步都在隔离副本验证，沿用本轮证明可靠的方法：**同 `DSH_HOME`、新 profile 名、
独立端口**（换 `DSH_HOME` 会破坏模块解析，曾因此误判一周）。

## 9. 可行性实测记录

全部于本机（Debian 12、Node v24.14.1、bun 1.3.14）与远端
`dsh-box1`（Debian 12 / glibc 2.36）实测。

### 9.1 二进制方案对比

| 方案 | 未压缩 | gzip | 动态依赖 | 远端需 Node | 结论 |
|---|---|---|---|---|---|
| **pkg linuxstatic** | 69 MB | **26 MB** | **无** | 否 | ✅ **采用** |
| Node SEA | 119 MB | 41 MB | `libc` `libstdc++` `libgcc_s` | 否 | 受 glibc 约束 |
| bun compile musl | 88 MB | — | `libstdc++` `libgcc_s` | 否 | ❌ 精简系统起不来 |
| source + node_modules | 46 MB | — | — | **是** | 退路 |

补充依据：`ldd` 对当前 node 与本机 node 的 musl 构建均显示动态链接
（`libstdc++.so.6`、`libgcc_s.so.1`），所以 SEA 与 bun 都逃不掉系统库。

### 9.2 端到端往返（最重要的一项）

在隔离 profile `sshtest`（同 `DSH_HOME`、端口 3145）上完成：

1. 静态二进制经 gzip 管道部署到 `dsh-box1:/opt/dsh-helper/dsh-ssh-helper`，
   远端 `sha256sum` 与本地一致
2. profile 配 `launch: { kind: executable }` + `helperHash`
3. 浏览器内新建会话，让智能体执行 `cat proof.txt`
4. 结果为 `REMOTE_ONLY_TOKEN`——该文件**只在远端存在**

三方比对：

```
本地  /usr/local/src/project/dsh-plugin/proof.txt   不存在
远端  /usr/local/src/project/dsh-plugin/proof.txt   REMOTE_ONLY_TOKEN
智能体报告                                          REMOTE_ONLY_TOKEN
```

**结论**：`kind: executable` + 静态二进制 + `fs-ssh`/`subprocess-ssh` 全链路可用，
远端无需安装 Node。

另一处旁证：会话失败时曾报
`working-directory: directory does not exist: "/usr/local/src/project/dsh-plugin"`，
而该路径在本地存在、远端不存在——说明 cwd 的 fs 校验走的就是远端 provider。

### 9.3 构建补丁（三处，均已实测）

bundle 由 bun 产出 CJS，再注入 pkg。三处补丁缺一不可：

| # | 补丁 | 原因 |
|---|---|---|
| 1 | `../package.json` 的版本读取 → 内联常量 | bundle 旁没有这个文件 |
| 2 | `import.meta.resolve(...)` ×4 → `process.execPath` | CJS bundle 无 `import.meta`；4 处均 lazy 且 PTC/Windows 专用 |
| 3 | `node:sea` → stub，`isSea()` 返回 `true` | helper 据此走 `kind: "executable"`、`entryPath: process.execPath` |

`NODE_OPTIONS='--disable-sigusr1'` 也已验证：静态二进制接受该 flag，
而这是 `dsh-ssh` 在 executable 模式下的硬性要求。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| `0.0.0.0:3080` 认证有洞等于裸奔 | 认证整体复用已验证模块；上线前跑完整越权测试 |
| 二进制 41 MB 上传耗时 | 流式 + 进度 + 可续；同版本二次部署跳过上传（hash 命中） |
| glibc < 2.28 无法运行 | 探测阶段明确报错；保留 source 模式退路 |
| daemon 挂了所有 profile 不可达 | `Restart=always`；profile 子进程独立存活 |
| 凭据落盘 | 0600 + 可配外部 `ssh-agent`；密码仅部署期使用后可清除 |
| 大文件/长连接吞吐 | 流式 `pipe`，不缓冲 |

## 11. 已确认的决定

| 项 | 决定 |
|---|---|
| TLS | 由外部反代终止，daemon 不做 TLS |
| helper 获取 | **缓存 → 动态构建 → 下载**（三级，见 §6.2.1） |
| 下载源模板 | `https://<host>/daemon/helper-<ver>-<arch>.gz` |
| 密码认证 | 保留。部署期用密码建连并装公钥；运行期强制 key（`dsh-ssh` 用 `BatchMode=yes`） |
| 路径 id | daemon 自动管理，保证唯一、避开保留字 |

## 12. 动态构建的实测数据

| 场景 | 耗时 | 说明 |
|---|---|---|
| 热构建 | **1.6 s** | bun + pkg base 均已缓存 |
| 冷构建 | **18.6 s** | 首次需下载 138 MB 的 pkg base 二进制 |
| 从 npm 依赖构建 | **1.6 s** | 源为 `node_modules/@deepseek-ai/dsh-ssh/lib/helper.js`，已验证 |
| arm64 交叉构建 | 9.3 s | 需 `--fallback-to-source`；产物 `static-pie ARM aarch64`，**本机无 qemu，未实测运行** |

构建依赖：`bun`（打包 ESM→CJS）+ `pkg`（注入静态 Node 基底）。
两者都不在时，只能走下载。

## 13. 仍需确认

arm64 是否需要？若需要，建议在真实 arm64 主机上先跑一次端到端
（同 §9.2 的方法），确认 `--fallback-to-source` 产出的二进制可执行。
本机只能验证到 `static-pie ARM aarch64` 这一层。

## 14. 实现进度（第 1 轮）

已落地并验证，`pkgs/daemon/`：

| 能力 | 状态 | 证据 |
|---|---|---|
| 单入口 3080 + 登录 | ✅ | 未登录返回登录页；错误口令 401；正确口令下发会话 |
| 前缀路由 + WS 隧道 | ✅ | `/t1/` 与 `/box1/` 的页面、资源、WebSocket 全部经前缀可用 |
| cookie Path 作用域化 | ✅ | `dsh-auth-…; Path=/t1/`，profile 之间不串 |
| portBase 56789+ 分配 | ✅ | 57000 起分配，注册表持久化 |
| `/admin` 管理面 | ✅ | 状态、创建、启停、日志、SSH 探测、helper 预览 |
| local profile 对话 | ✅ | 两轮对话 + 刷新恢复 |
| **ssh profile 对话** | ✅ | 远端 bash 返回仅在远端存在的文件内容 |
| helper 三级策略 | ✅ | `source: "build"`，daemon 自行构建 26 MB 静态二进制 |
| 单元测试 | ✅ | 490 通过（daemon 28） |

### 14.1 实现中发现的四个真实缺陷

这些都只有真正运行才会暴露：

1. **ssh profile 未声明 provider 包**
   patch 里 `dsh-ssh` 等四行指向未安装的包 → 导入失败 → 依赖它的服务全部
   `pending`。表现为 profile 起来了、能打开页面，但建不出会话。

2. **省略的 ssh 端口被默认成 22**
   命令行 `-p 22` 会覆盖 `ssh_config` 别名里的 `Port 2222`，报
   `Permission denied (publickey,password)`——看起来像凭据问题，实际连错了端口。

3. **admin 抛错会杀掉整个 daemon**
   Node 对未处理的 promise rejection 默认终止进程。一个失败的部署会让所有
   profile 一起不可达。现在统一答 500。

4. **`working-directory` 用 insert 而非 override**
   insert 新增了第二行，服务没被配置，presets 卡在 `waiting for workingDirectory`。

### 14.2 仍未验证

| 项 | 说明 |
|---|---|
| ~~helper 自动部署~~ | ✅ **已验证**（第 2 轮）：daemon 构建 → 部署到远端全新路径 → 校验 sha256 → profile 启动 → 远端 bash 执行成功 |
| arm64 | 交叉构建产物形态正确，无 arm64 主机可运行验证 |
| 生产切换 | 尚未执行；`adopt` 已验证，是迁移要用的入口 |

### 14.3 生产迁移的形态（`adopt`）

放弃了「daemon 前置到自己进程」的方案：core 的 launch token 每次启动轮换，
写进配置的 token 第一次重启就失效，只在门口失败。

改用**收养**：daemon 在自己的 profile 里监听 `0.0.0.0:3080`，把现有 `web`
profile 原样注册为 `main`，不动它的 manifest、bundle 和已持久化的设置。

已实测：收养后 `package.json` 与 patch 未被改写，profile 在分配的端口上启动，
经 `/main/` 可访问，cookie 作用域为 `/main/`。

### 14.4 根路径保持（第 3 轮已实现）

放弃的只是「daemon 前置到**自己**进程」；改为**根 profile**后同一目标成立：

```yaml
rootProfile: main     # 这个 profile 接管所有无前缀的路径
```

成立的关键在于**由 daemon 自己 spawn 根 profile**——它能从子进程的启动行读到
当前的 launch token，换出浏览器永远拿不到的会话 cookie，并在转发时附上。

- token 轮换不再是问题：cookie 记录它由哪个启动 URL 铸出，profile 重启即重换
- cookie 被拒时丢弃并回 503 retry，而不是把 401 抛给浏览器
- `/portal` 与 `/admin` 仍归 daemon，根 profile 只接管 `/` 与 `/api`

实测（真实 profile）：未登录 `/` 返回登录页；同一 URL 登录后是 harness UI；
`/api` 透传 200；控制台零错误。

于是生产迁移不再改 URL：`https://dsh.yiln.de/` 保持不变。

### 14.5 迁移形态（已在生产副本上验证）

daemon 不能住在被它代理的 profile 里（否则收养自己会递归），所以：

```
systemd  →  dsh --profile edge --port <spare>     ← daemon 宿主，自身 web-app 闲置
              └─ daemon 0.0.0.0:3080
                   ├─ /portal, /admin            归 daemon
                   └─ /, /api                    → 收养的 web profile (127.0.0.1:57600)
```

「闲置」不精确：edge 自己的 web-app 仍监听 loopback，无害，但可以在不需要时
从 bundles 里移除 web-app。

用**生产 profile 的完整副本**验证过：25 个会话全部加载、`yiln-company` preset
可用、模型可用、中文 UI 正常、对话跑通（`EDGE_ROOT_OK`）、控制台零错误。

### 14.6 迁移的真正阻塞：生产没有密码

查证过程：`cordis.patch.yml` 里 `webserver-auth` 的 `password` 是空串，
`settings.yaml` 不存在，`.credentials.yaml` 只有模型 key，systemd 单元没有
`DSH_AUTH_PASS`。

而 auth-webserver 的判定是：

```js
const passwordValid = Boolean(pass) && safeEqual(submittedUser, user) && safeEqual(submittedPass, pass)
```

`Boolean("")` 为假 → **任何登录都失败**。实测空密码与错误密码都返回 401。

也就是说生产现在是「登录页存在但无人能通过」，唯一进入方式是浏览器里既有的
会话 cookie。迁移到 daemon 会换掉 cookie 名与会话库，**直接锁死**。

因此迁移前必须先设定一个密码（`config.password` 或 `DSH_AUTH_PASS`）。
daemon 已在启动时对空密码发出显式告警。


## 生产迁移（2026-10-18）

从两进程形态切到内嵌形态：

```
旧：dsh --profile edge --no-open --port 39281
      ├─ daemon 0.0.0.0:3080
      └─ 收养的子进程 web 127.0.0.1:57900

新：dsh --profile main --no-open --port 56789
      ├─ harness  127.0.0.1:56789
      └─ daemon   0.0.0.0:3080   →  / 重定向到 /main/
```

迁移脚本 `/root/migrate-to-main.sh` 经 `systemd-run` 独立单元执行：从自身 cgroup 内
重启 dsh-web 会把脚本一起杀掉，这正是上次迁移两个方向都失败的原因。

关键前提：`web-daemon` 每次启动会用自身配置重写单元文件。它原本指向
`edge:39281`，不改就会被下一次重启改回去。脚本第一步先改 home layer。

验证结果（脚本输出 + 迁移后独立复查）：

| 项 | 结果 |
| --- | --- |
| 单元 ExecStart | `--profile main --no-open --port 56789` |
| 监听 | 只剩 3080 与 56789（39281、57900 消失） |
| NRestarts | 0 |
| 未登录 `/admin/state` | 返回登录页，`"ok":true` 计数 0 |
| 已登录 `/` | 302 → `/main/` |
| 面板主环境行 | 本机(当前) 0.0.0.0:3080 dsh-web.service 331 插件 |
| 会话 | 40 个可读 |
| 控制台错误 | 0 |
| 公网 | https://dsh.yiln.de/ → 200 |
| 内存 | 973 MB（两进程时 1345 MB，省 372 MB） |

回滚：`cp /root/migration-backup-20261018-192206/dsh-web.service
/etc/systemd/system/ && systemctl daemon-reload && systemctl restart dsh-web`。
脚本在任一检查失败时会自动执行同样的回滚。

`edge` 与 `web` 两个 profile 保留作回滚依据，未删除。

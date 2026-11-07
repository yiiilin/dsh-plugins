# Code editor (code-server)

Standalone package [`@yiln-dsh/dsh-code-server`](../../pkgs/code-server).
Loader row: `dsh-code-server`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/code-server"
```

See the [root README](../../README.md) for the workspace layout, migration and
testing.

右侧栏的一个标签页，把宿主机上安装的
[code-server](https://github.com/coder/code-server)（浏览器里的 VS Code）嵌进
面板，**每个 DSH Workspace 一个进程**：同一工作区下的所有会话共用一个编辑器，
打开标签页就自动启动，并直接打开该工作区的目录。所有实例**共享一个 VS Code
扩展目录**。插件本身不携带 code-server：启动时探测二进制，缺失时面板给出安装入口，
里面有安装命令和复制按钮，还有确认后执行的一键安装，以及重新检测。

English: a right-sidebar tab that embeds a host-installed code-server (VS Code
in the browser), **one process per DSH Workspace**. Every session in a workspace
shares that editor; opening the tab starts it automatically and opens the
workspace folder. All instances share one VS Code extensions directory. The
plugin does **not** bundle code-server — it detects the binary at mount and, when
missing, the panel shows the configured install command, a copy button, a
confirmed one-click install, a re-detect button and the install output.

## 架构

```text
浏览器 GUI (已由 DSH 认证)
 └─ 右侧栏 tab (iframe src = <baseURI>/_dsh/code-server/i/<id>/?folder=<workspace.path>)
     └─ webServer prefix 路由  →  HTTP 反代，剥掉前缀
     └─ webServer 精确 upgrade 路由 ×4  →  WebSocket 握手重放
         （实例根 ×2，workbench socket 路径 ×2，见下）
         └─ 127.0.0.1:<port> code-server --auth none <workspace.path>
             ├─ --user-data-dir  = <stateDir>/workspaces/<hash>/user-data   ← 每工作区一份
             ├─ config.yaml      = <stateDir>/workspaces/<hash>/config.yaml ← 每工作区一份
             └─ --extensions-dir = <stateDir>/extensions                    ← 所有实例共享
```

- 归属键是 `workspaceId`（DSH `Workspace` 的稳定 uuid），不是 session id。
  多个会话落到 `POST /sessions` 时靠 `byWorkspace` 命中同一个实例。
- `cwd` 取 Host 的 `ctx.workspaceRegistry.get(id).path`（canonical realpath，
  创建后永不改写），Client 传的 `workspacePath` 只是旧 DSH 的回退；所以伪造路径
  不能把编辑器指向别的目录。尚未 attach 到工作区的会话还能按 canonical path
  命中，保证同目录的会话仍共用一个实例。
- 打开标签页后 Client 自动为当前工作区 `POST /sessions`；每个挂载的面板对每个
  工作区只自动尝试一次，失败后等用户点「重试」，避免 4 秒轮询反复打 Host。
  用户手动关闭（×）后也**不会**立刻自动重开。
- iframe URL 带 `?folder=<绝对路径>`，这是 code-server 自己的 URL API（见
  [FAQ](https://github.com/coder/code-server/blob/main/docs/FAQ.md)），优先级高于
  CLI 位置参数和 last-opened；CLI 末尾的位置参数 + `--ignore-last-opened` 是
  第二重保险。两者都指向同一个 `workspace.path`。
- `session/disposed` **刻意不监听**：一个会话结束不代表同工作区其他会话不用了。
  实例只在用户点 ×、`DELETE /sessions/<id>` 或插件卸载时释放。
- `boot()` 在每个 `await` 之后检查 `entry.closing`，否则 `disposeAll()` 与启动竞态
  时会在卸载**之后** spawn 出没人管的子进程（有回归测试覆盖）。

## 路由契约

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/_dsh/code-server/state` | GET | 探测结果、安装命令、共享扩展目录、实例表 |
| `/_dsh/code-server/detect` | POST | 手动安装后重新探测 |
| `/_dsh/code-server/install` | POST | 运行**配置中**的安装命令，要求 `confirm: true` |
| `/_dsh/code-server/sessions` | GET / POST | 列出 / 创建实例 |
| `/_dsh/code-server/sessions/<id>` | DELETE | 关闭实例并立即释放它的路由 |
| `/_dsh/code-server/i/<id>/…` | 任意 | 该实例的 HTTP 前缀反代 |
| `/_dsh/code-server/i/<id>` 与 `<id>/` | upgrade | 实例根的 WebSocket |
| `/_dsh/code-server/i/<id>/stable-<commit>` 与带尾斜杠 | upgrade | **workbench 实际用的 socket 路径** |

### WebSocket 路径是 `stable-<commit>`，不是深层静态目录

VS Code 的连接地址由 `patches/base-path.diff` 拼成
`location.pathname + "/" + <server root>`，实测连到的是
`<prefix>/stable-<commit>?reconnectionToken=…` —— 只有版本段，**不含**
`/static/out/vs/code/browser/workbench`。

DSH 的 `webServer.registerUpgrade` 是**精确路径 Map、没有前缀匹配**，所以这条
路径必须显式注册；而 `<commit>` 只有实例跑起来才知道，因此 Host 在实例就绪后
请求一次它的首页（带 `?folder=`，并跟随 302），从 HTML 里解析出
`stable-<commit>` 再注册，带与不带尾斜杠两种拼写都注册。

`POST /sessions` 的请求体是
`{ workspaceId, workspacePath?, workspaceTitle? }`。返回的行含
`workspaceId` / `workspacePath` / `workspaceTitle` / `cwd` / `port` / `state` /
`error`，以及 `url` —— 它是**相对 `document.baseURI`** 的
`_dsh/code-server/i/<id>/`，不是根绝对路径：GUI 可能挂在 `/main/`、
`/env-6-13/` 之类的环境前缀下，根绝对路径会落到登录页。

## VS Code 扩展

code-server 支持 VS Code 扩展：Extensions 侧栏、`--install-extension <id>`、
VSIX 手动安装、`--list-extensions` 都可用，还有 `--builtin-extensions-dir`
（VS Code 自带扩展，本来就在安装目录里，天然全局共享）。但有边界：

- 默认市场是 [Open VSX](https://open-vsx.org)，**不是**微软官方市场 —— 微软的
  ToS 禁止非微软 VS Code 访问。FAQ 明确列出不可用的闭源扩展：Live Share、
  Remote-SSH / Containers / WSL。可用 `$EXTENSIONS_GALLERY` 指向自己的市场。
- FAQ 里扩展默认存在 `~/.local/share/code-server/extensions`。本插件显式传了
  `--user-data-dir`，而 code-server 的默认值是
  `<user-data-dir>/extensions`（[`cli.ts`](https://github.com/coder/code-server/blob/main/src/node/cli.ts)
  的 `setDefaults`），那会让每个工作区复制一份。所以我们把 `--extensions-dir`
  提到 `<stateDir>/extensions`，由 `extensionsDir` 配置覆盖。
- **共享的是扩展本体，不是设置**：`user-data-dir`（settings、`workspaceStorage`、
  `globalStorage`、`coder.json`）仍按工作区隔离，避免多进程写同一个文件。
- **并发写风险**：多个实例同时安装/卸载扩展会写同一个目录（`.obsolete`、解压），
  可能互相踩。读是安全的。建议在没有实例运行时用
  `code-server --install-extension <id> --extensions-dir <stateDir>/extensions`
  统一安装，或接受偶发。这是「共享扩展」唯一需要运维注意的地方。

## 为什么子路径反代能工作

核实过 code-server 源码（[`docs/FAQ.md`](https://github.com/coder/code-server/blob/main/docs/FAQ.md)、
[`src/node/http.ts`](https://github.com/coder/code-server/blob/main/src/node/http.ts)、
[`patches/base-path.diff`](https://github.com/coder/code-server/blob/main/patches/base-path.diff)）：

1. 它的 workbench HTML 用 `relativeRoot(req.originalUrl)` 生成**相对** URL，
   所以反代把前缀剥掉后转发 `req.url = /`，浏览器仍会按自己带前缀的页面 URL
   解析 `{{BASE}}`、`{{CS_STATIC_BASE}}` 和相对重定向。
2. `patches/base-path.diff` 把 VS Code 的 WebSocket 地址改成
   `window.location.pathname + "/" + path`，所以 socket 落在 iframe 的前缀下；
   而 code-server 的 ws 路由匹配任意路径。
3. `Host` 与 `Origin` 必须**一起**改写成 loopback authority，否则它的
   origin 检查会返回 403。

因此反代做的事是：剥前缀、`Host`/`Origin` 改写、`Set-Cookie: Path=/` 收紧到
实例前缀、把 `/…` 的 `Location` 加回前缀（相对重定向原样保留）、丢弃
`Service-Worker-Allowed`（否则 code-server 的 service worker 可以声明整个 DSH
origin 的 scope），并**不转发浏览器的 cookie**（避免把 `dsh-auth-*` 会话令牌
交给子进程；`--auth none` 下 `authenticated()` 直接返回 true，不需要 cookie）。

## 安全边界

子进程一律 `--auth none` + `--bind-addr 127.0.0.1:<port>`，唯一入口是已经过
DSH 认证的 web server 反代。把实例端口暴露到局域网、或把任意 Host 转发到该
loopback 端口，都等于未认证的远程代码执行。会起进程 / 关进程的路由额外做了
`Origin` 同源检查；安装命令只来自插件配置，绝不接受请求体里的命令。

`subprocess` 是进程级单例，所以编辑器打开的是**跑 DSH 的这台机器**上的目录；
gateway 的远端 edge 上，会话的 `cwd` 属于另一个执行世界，本插件不跨机代理，
需要在那台机器上各自安装并启用。

## 验证

`npm run check` 与 `npm test` 覆盖了：挂载契约、URL 与头改写（含真实 TCP
握手重放）、按工作区归属与幂等创建、共享扩展目录而 user-data 隔离、
`?folder=` 拼接、`useWorkspaces` 解析、卸载竞态和端口回收，还有探测与 Host 路由，
以及 Client 的中英词典和辅助函数。这些测试用真实的 loopback 上游跑反代，但**不证明
VS Code workbench 真的渲染出来**。

workbench 与 WebSocket 已在 live profile 上实测通过（code-server 4.145.0）：
面板打开后自动创建实例、Explorer 与 Welcome 渲染、控制台无 1006。

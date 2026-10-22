# Desktop VNC

Standalone package [`@yiln-dsh/dsh-desktop-vnc`](../../pkgs/desktop-vnc). Loader row: `dsh-desktop-vnc`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/desktop-vnc"
```

See the [root README](../../README.md) for the workspace layout, migration and testing.

右侧栏的一个标签页，**点开即自动连接**，左侧是**浏览器实例列表**，右侧是聚焦实例的画面。每个实例是一台独立的浏览器（Chromium），而不是整个桌面。宿主用 [Xephyr](https://www.x.org/) 给每个实例起一个自己的嵌套 X 显示，Chromium 跑在里面；那个 Xephyr 窗口同时是真实桌面上的一个窗口，所以**浏览器桌面可见、面板可见**，两边完全同步。面板侧用内置的 [noVNC](https://github.com/novnc/noVNC) 客户端显示。

English: a right-sidebar tab that auto-connects on open. It lists the **browser instances** on the left and shows the focused instance's screen on the right. Each instance is its own browser (Chromium), not a whole desktop: the Host runs it inside a nested X display hosted by Xephyr, and that Xephyr window is also a real window on the desktop. The panel renders the focused instance through a bundled noVNC client. The list is the Host's table, so every client sees the same instances; the **focus** is per-client UI state that never leaves the page, so two clients can watch two different instances at once.

## 架构

```text
:0 真实桌面
 └─ 每个实例一个 Xephyr 窗口「DSH Desktop Browser」（嵌套显示 :N，窗口在 :0 上可见、可操作）
     └─ Chromium（该实例独占）
        ↑
   x11vnc -display :N  (仅 127.0.0.1，每个实例一个端口)
        ↑
   WS 桥 /_dsh/desktop-vnc/sessions/<id>/ws  →  右侧栏「实例列表 + 聚焦实例画面」
```

这样面板不受真实桌面锁屏/息屏影响：`:0` 被 light-locker 锁住时，嵌套显示里的浏览器依然正常显示。

## 组成

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 路由注册、状态汇总、生命周期回收、浏览器栈与 x11vnc 的接线 |
| Host | `instances.js` | 浏览器实例表：实例 id、归属会话、状态、端口预留、观看人数 |
| Host | `browser.js` | Xephyr 嵌套显示 + Chromium 的启动/复用/停止（Xephyr 缺失时降级 Xvfb） |
| Host | `x11vnc.js` | 从 `rfbPortRange` 分配端口、按需启动/复用/停止 `x11vnc` 子进程 |
| Host | `ws.js` | 手写 RFC6455 WebSocket 服务端，把 WS 帧与 VNC TCP 字节流双向直通 |
| Host | `capture.js` | 通过 ImageMagick `import` 抓取单帧 JPEG 与 MJPEG 流 |
| Client | `client.js` | 右侧栏标签页：实例列表 + 聚焦实例的 noVNC 视图、自动连接、工具栏、中英双语字典 |
| 资源 | `novnc/` | 内置的 noVNC `core/` 与 `vendor/`（仅 `.js`，由 Host 原样服务） |

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/_dsh/desktop-vnc/asset/<file>` | 服务内置 noVNC 模块（`core/`、`vendor/`），长缓存 |
| GET | `/_dsh/desktop-vnc/frame.jpg` | 单帧 JPEG 截图 |
| GET | `/_dsh/desktop-vnc/stream.mjpg` | MJPEG 降级预览流 |
| GET | `/_dsh/desktop-vnc/state` | 服务状态 JSON（形状冻结；投影表中第一个实例） |
| WS | `/_dsh/desktop-vnc/ws` | RFB 字节桥，v1 兼容路径（指向表中第一个实例） |
| GET | `/_dsh/desktop-vnc/sessions` | 浏览器实例列表，扁平数组 |
| POST | `/_dsh/desktop-vnc/sessions` | 创建浏览器实例，**立即**返回 `{id, state:"starting"}` |
| DELETE | `/_dsh/desktop-vnc/sessions/<id>` | 关闭浏览器实例；id 由一条 prefix 路由自行解析 |
| WS | `/_dsh/desktop-vnc/sessions/<id>/ws` | 该浏览器实例的 RFB 字节桥 |

列表项形状：

```jsonc
[{ "id": "1a2b3c4d", "state": "ready", "width": 1280, "height": 800,
   "createdAt": 1792637133, "ownerSessionId": "session-1",
   "lastActiveAt": 1792637200, "viewers": 1 }]
```

`state` 为 `starting` | `ready` | `failed`。`createdAt` / `lastActiveAt` 是 **epoch 秒**。

`error` 是**条件字段**：只在 `state === "failed"` 时出现，携带失败原因；其余状态整个键
缺席（不是 `null`，也不是 `undefined`）。侧边栏因此能在同一行里解释失败，不必再发一次请求。

`viewers` 是当前真实的 WS 桥连接数（两个客户端同时看一个实例就是 2）。列表**不**报告
「谁在看」：那是别的客户端自己的界面状态，既不可知也无用。

浏览器实例属于创建它的会话：该会话
`session/disposed` 时，它名下的实例全部关闭，其他会话的实例不受影响；`agent/disposed`
不关闭任何实例（agent 结束但会话仍在时，实例继续存活）。

列表里**没有**「焦点」字段：焦点是每个客户端各自的界面状态（见 `GLOSSARY.md` 的
**焦点实例**），不写服务端、不跨客户端同步。侧边栏只在本地记住自己聚焦哪个实例，
切换实例时按 `key` 重挂载查看器，旧 WebSocket 随之释放。

浏览器只与 DSH 的 Web 源交互；`x11vnc` 始终绑定 `127.0.0.1`，从不直接暴露。

## 配置

```yaml
- id: dsh-desktop-vnc
  name: '@yiln-dsh/dsh-desktop-vnc'
  inject: [webServer, subprocess, fs]
  config:
    enabled: true          # 关闭后所有路由返回禁用态，客户端给出提示
    display: ':0'          # 宿主桌面：Xephyr 窗口落在这里（浏览器「桌面可见」的地方）
    rfbPort: 5900          # v1 兼容的单端口；未设 rfbPortRange 时优先尝试它
    rfbPortRange: [5900, 5999]  # 每个实例从这个区间里分配自己的 RFB 端口
    viewportWidth: 1280
    viewportHeight: 800
    jpegQuality: 72        # 降级预览的 JPEG 质量
    frameRate: 8           # MJPEG 降级预览帧率
    maxClients: 4          # 并发预览/桥接客户端上限
    browser:
      enabled: true        # false 退回 v1：直接镜像 display 本身，不启 Xephyr/Chromium
      executable: chromium
      nestedDisplay: auto  # auto = 在 :200..:999 里挑一个空闲显示号
      windowTitle: DSH Desktop Browser
      startUrl: about:blank
      extraArgs: []
```

## 安全边界

- `x11vnc` 只监听 `127.0.0.1`（`-localhost`），外部网络无法直连 RFB 端口。
- WebSocket 升级路由做**同源校验**：Origin 的 host 必须等于本次请求的 Host。因为宿主同一个端口同时绑定回环、多个 LAN 地址与反代域名，字面量地址白名单无法覆盖（早期实现只放行回环，导致 LAN/反代访问时 WS 被 403、面板停在"未连接"）；而「Origin 指向别的主机」正是要拦截的情况，外部页面无法借用户浏览器连本机 VNC。
- 点开标签页即自动连接（这是用户要求的行为）；断开与重连仍受用户控制，自动连接失败最多再自动重试一次，之后停在错误态等用户手动「重新连接」，不会无限刷。未选中任何实例时显示空态，不挂空画布、不开连接。
- **切换实例先释放旧连接。** 查看器按聚焦的实例 `key` 挂载：换一行就是换一个组件，旧组件的清理直接断开它的 WebSocket（以及 x11vnc 那个 viewer），不留悬挂连接。
- **焦点是客户端本地状态。** 不写服务端、不跨客户端同步；聚焦的实例被关闭（或从列表消失）时回到「未选中」，**不自动跳到别的实例**。列表读取失败不算实例关闭，焦点保留。
- 插件只终止**自己启动的** `x11vnc`、`Xephyr` 与 `Chromium`（按记录的 pid，绝不按名字 `pkill`）。
- **端口只复用自己启动的服务。** 分配时从 `rfbPortRange` 里从低到高取第一个没人监听的端口；
  某端口上已经有人在监听，说明那不是本实例的 x11vnc（可能是别的实例、系统服务或残留进程），
  于是**跳过它继续找下一个**，既不连接也不结束它。区间耗尽时返回明确错误，不静默降级。
  早期实现是「有人监听就复用」，那会让第二个实例的面板静默显示第一个实例的桌面且零报错。
- **路径按实例隔离。** 每个浏览器实例有自己的目录（`$TMPDIR/dsh-desktop-vnc-<实例标识>/`），
  里面放 Chromium 的 `profile` 与 Xauthority；两者都不与别的实例共享。实例停止时整个目录一起删除，
  Xauthority 不会残留（它是凭据，不该比它授权的显示活得更久）。

## 依赖

宿主侧需要：

- `x11vnc`（Debian/Ubuntu: `apt-get install x11vnc`）
- ImageMagick 的 `import`（`apt-get install imagemagick`）—— 降级预览用
- `Xephyr`（`apt-get install xserver-xephyr`）—— 嵌套显示，浏览器「桌面可见」的前提
- `chromium`（或 `browser.executable` 指向的其它 Chromium 系浏览器）

缺失时面板显示可读错误而不是白屏。客户端 noVNC 已内置，**不需要**新增任何 npm 依赖，也不需要 `websockify`。

`Xephyr` 缺失时栈会降级到 `Xvfb`：面板仍能看到浏览器，但桌面不可见，`state` 里的
`desktopVisible` 会如实报 `false`。

## 已知限制

- 桌面可见的前提是宿主桌面 `display` 可显示窗口；若 `:0` 处于锁屏，Xephyr 窗口可能被锁屏界面遮住，但**面板不受影响**。
- 浏览器以 root 运行时必须带 `--no-sandbox`，Chromium 会因此在页面顶部画一条「unsupported command-line flag」警告条；插件同时传了 `--test-type` 抑制它 —— 那条窗口会被面板镜像，否则就是常驻的用户可见干扰。
- MJPEG 降级预览是只读画面；交互（鼠标/键盘）走 noVNC 的 WebSocket 桥。
- 未实现 TLS 终止与 VNC 密码的持久化；密码仅在内存中传入当次 RFB 会话。
- `resizeSession: false`：面板缩放不改变嵌套显示的实际分辨率。

# Desktop VNC

Standalone package [`@yiln-dsh/dsh-desktop-vnc`](../../pkgs/desktop-vnc). Loader row: `dsh-desktop-vnc`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/desktop-vnc"
```

See the [root README](../../README.md) for the workspace layout, migration and testing.

右侧栏的一个标签页，**点开即自动连接**，面板里是一个**浏览器**（Chromium），而不是整个桌面。宿主用 [Xephyr](https://www.x.org/) 起一个嵌套 X 显示，Chromium 跑在里面；那个 Xephyr 窗口同时是真实桌面上的一个窗口，所以**同一个浏览器桌面可见、面板可见，只有一个实例**，两边完全同步。面板侧用内置的 [noVNC](https://github.com/novnc/noVNC) 客户端显示。

English: a right-sidebar tab that auto-connects on open and shows **a browser** (not a whole desktop). The Host runs Chromium inside a nested X display hosted by Xephyr; that Xephyr window is also a real window on the desktop, so one browser instance is visible both on the desktop and in the panel. The panel renders it through a bundled noVNC client.

## 架构

```text
:0 真实桌面
 └─ Xephyr 窗口「DSH Desktop Browser」（嵌套显示 :N，窗口在 :0 上可见、可操作）
     └─ Chromium（唯一实例）
        ↑
   x11vnc -display :N  (仅 127.0.0.1)
        ↑
   WS 桥 /_dsh/desktop-vnc/ws  →  右侧栏 noVNC 面板（自动连接）
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
| Client | `client.js` | 右侧栏标签页、自动连接、noVNC 视图、工具栏、中英双语字典 |
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

`state` 为 `starting` | `ready` | `failed`。浏览器实例属于创建它的会话：该会话
`session/disposed` 时，它名下的实例全部关闭，其他会话的实例不受影响；`agent/disposed`
不关闭任何实例（agent 结束但会话仍在时，实例继续存活）。

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
- 点开标签页即自动连接（这是用户要求的行为）；断开与重连仍受用户控制，自动连接失败最多再自动重试一次，之后停在错误态等用户手动「重新连接」，不会无限刷。
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

# DSH Web GUI 内置浏览器 — 技术方案

> 需求：在 DSH Web 终端的右侧（或终端视图内）加一个浏览器功能。
> 关键约束：**DSH 所在机器的网络与访问端（用户浏览器所在）网络隔离**，用户浏览器无法直接访问 DSH 能访问的内网内容。
> 结论：必须**在服务器端（DSH 机器）执行浏览、把画面实时回传 GUI**。客户端 iframe 方案（让用户浏览器直接打开目标 URL）在此约束下不成立。

---

## 1. 需求分析

| 事实 | 推论 |
| --- | --- |
| DSH 服务器与访问端网络隔离 | 目标内网站点只能从 DSH 服务器访问；渲染必须发生在服务器端 |
| 用户要"看"内容 | 服务器端浏览器画面（截图/帧流）必须回传到 Web GUI |
| 用户可能要交互 | 回传的除了画面，还要有输入通道（点击、键盘、滚轮） |
| 现有 conversation.view 宿主 | 浏览器可以作为 conversation.view 的一个 tab，紧挨终端显示；right-panel 是另一种可选挂载点 |

两种候选架构：

- **A. 客户端 iframe / srcdoc**：把 URL 塞进用户浏览器的 `<iframe>`。**失败**——目标内网从用户网络不可达，且大量站点发 `X-Frame-Options`/`CSP frame-ancestors`。
- **B. 服务器端浏览器 + 画面回传（CDP Screencast）**：DSH 服务器上用 Chromium 打开页面，把 JPEG 帧流经 WebSocket 推到 GUI，GUI 把鼠标/键盘事件经 WebSocket 发回服务器注入浏览器。**可行且是唯一满足约束的路线**。

选 B。

---

## 2. 总体架构

```
┌─────────────────────────── 用户浏览器 (Web GUI) ───────────────────────────┐
│ 对话区/终端旁的 Browser 视图       地址栏 + 标签栏                      │
│                          ┌─────────────────────────────────────────────┐ │
│                          │ 地址栏  [←][→][↻]  [标签1][标签2][+]          │ │
│                          ├─────────────────────────────────────────────┤ │
│                          │  <img src=WS帧流>  ← 画面（JPEG 帧）          │ │
│                          │  mousedown/mousemove/up/keydown/滚轮        │ │
│                          └─────────────────────────────────────────────┘ │
└───────────────┬───────────────────────────────┬───────────────────────────┘
                │ POST /_dsh/web-browser/*        │ WS  /_dsh/web-browser/ws
┌───────────────▼───────────────────────────────▼───────────────────────────┐
│ DSH 服务器 (Host 插件 dsh-plugin-web-browser)                              │
│  · webServer 路由：open / close / list / tab_* / ws                        │
│  · URL 校验：scheme 白名单 + host 白名单（借鉴 browser-use 策略）             │
│  · 每个会话一个隔离 BrowserContext（cookie/存储隔离）                        │
│  · playwright-core（或 puppeteer-core）驱动 Chromium                       │
│  · page.screencast.on('screencastFrame') → JPEG 帧 → WS 推给 GUI           │
│  · WS 收 GUI 事件 → mouse.move/click、keyboard.type、wheel                 │
└───────────────────────────────────────────────────────────────────────────┘
```

关键依赖（二期内核）：`playwright-core` 驱动 Chromium，**用裸 CDP `Page.startScreencast`**（`context.newCDPSession(page)`）取帧。Playwright 1.62+ 虽封装了 `page.screencast` API，但实测其事件绑定是内部钩子（`_onFrame`），且帧率与稳定性不如直接 CDP。**裸 CDP 已验证**：`Page.enable` → `Page.startScreencast({format:'jpeg',quality,maxWidth,maxHeight,everyNthFrame})` → 监听 `Page.screencastFrame` → 必须回 `Page.screencastFrameAck`（否则 Chromium 停发帧）。实测：静态页单帧触发，有 CSS 动画的页面 3 秒 179 帧（~60fps），帧为 JPEG 二进制。这比轮询 `page.screenshot()` 高效得多（事件驱动、增量帧、Chrome 原生支持）。

---

## 3. 一期 vs 二期（分期交付）

### 一期（P0，先立框架 + 网络隔离下的最小可用）

**范围**：`conversation.view` tab 栏新增「浏览器」视图（与终端并列）；首次进入自动创建一个 `about:blank` 标签并显示干净的空白新标签页；服务器端 Chromium；顶部地址栏导航 + 帧回传 + 基本点击/输入。

**Host 端 `index.js`**（仿 `dsh-plugin-terminal-tab` 结构）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/_dsh/web-browser/open` | POST | `{ url, sessionId? }` → 校验 scheme/host 白名单 → 启动/复用浏览器 → 导航 → 返回 `{ ok, url, title }` |
| `/_dsh/web-browser/close` | POST | 关闭会话浏览器，幂等 |
| `/_dsh/web-browser/list` | POST | 会话的标签列表 |
| `/_dsh/web-browser/ws?sessionId=…` | WS upgrade | 双向：Host→GUI 推 JPEG 帧 + 页面事件；GUI→Host 发输入事件 |

- 浏览器启动参数对齐 `dsh-plugin-browser-use` 的 `PlaywrightBackend`：私有 HOME/XDG（`buildLaunchEnv`）、`executablePath` 探测链（config → `$DSH_BROWSER_EXECUTABLE` → 系统常见路径 → Playwright 自带）、headless。
- URL 安全策略（**借鉴 browser-use 的 `policy.ts`**）：scheme 只放行 `http/https`（可配置加 `file` 用于本地 HTML 预览）；host 白名单 `allowedHosts`（空 = 任意公网 host）；`allowPrivateNetwork` 默认 `false`——**注意：本需求恰恰要访问内网，所以这个选项在本插件里默认 `true` 或作为配置暴露**，与 browser-use 的默认相反，需在文档中强调。
- 每个会话（agent sessionId）一个隔离浏览器上下文；无会话时（未选中会话）可给一个全局上下文。
- 生命周期：`ctx.effect` 清理浏览器进程；会话结束（agents 事件）时回收该会话上下文。

**Client 端 `client.js`**（仿 `dsh-plugin-file-explorer` 的页面注册）：

- `slots.inject('conversation.view', () => slots.register({ name: 'conversation.view', id: 'browser', order: 30, label: '浏览器' }, BrowserPage))`
- `BrowserPage`：地址栏（回车导航）、后退/前进/刷新、多标签（`+` 新建，标签切换复用同一 WS）、`<img>` 帧渲染层、覆盖层接收鼠标/键盘事件换算坐标经 WS 发送。
- i18n：`ZH_DICT`/`EN_DICT`（仓库规则）。
- 布局：第一行标签栏（无 tab 时隐藏），第二行导航栏；地址栏固定高度，帧画布 `object-fit: contain`，随终端视图宽度自适应（保留纵横比，避免拉伸）。

**一期验收标准**：
- 在隔离网络下，从 GUI 输入 DSH 内网地址 → 与终端并列的浏览器视图显示该站点画面。
- 点击/滚动/键盘输入能作用于页面。
- 多标签切换、关闭、刷新可用。
- 会话切换时浏览器上下文随之切换（或明确提示）。

### 二期（P1，增强）

- **与 `dsh-plugin-browser-use` 共享会话**：agent 的 `browser_*` 工具与用户的可视面板操作同一个浏览器，用户能旁观/接管 agent 的浏览（类似 remote control）。
- **本地文件预览**：把 deeptutor 式自包含 HTML（`html-doc` skill 产物）直接塞进服务器端浏览器（`file://` 或起本地静态服务），实现"生成学习页 → 面板里直接看"。
- **下载/上传**：浏览器下载落到会话 artifacts 目录，GUI 可下载；上传经 `browser_upload` 同款白名单目录。
- **性能优化**：帧率控制（空闲降帧）、`IntersectionObserver` 暂停不可见标签的 screencast、JPEG 质量自适应。
- **DevTools 联动**：console/network 事件透传。

---

## 4. CDP vs VNC（备选画面通道）

| 维度 | CDP `Page.startScreencast` | VNC（Xvfb + x11vnc/tigervnc + noVNC） |
| --- | --- | --- |
| 部署复杂度 | 仅一个 Chromium 进程，headless 直接出帧 | Xvfb 虚拟显示器 + VNC server + noVNC 客户端，三件套 |
| 渲染来源 | Chromium 合成器直接出 JPEG，像素级一致 | X 抓屏再编码，多一跳（合成、色差/撕裂风险） |
| 带宽/延迟 | 事件驱动帧（实测：静态页单帧、动画页 ~60fps） | 全屏位图分块 + tight/JPEG 编码，通常更贵 |
| 动态缩放 | screencast 尺寸跟随面板宽度，随时可调 | 绑定 Xvfb 分辨率，调整需重启 |
| 输入 | CDP Input domain = 浏览器合成事件，精确 | X 键盘码转发，Linux 键盘布局映射是经典痛点 |
| 自动化/agent 集成 | 与 playwright/puppeteer 同协议，可共享 browser-use 会话、取 DOM/console/network | 无 DOM/网络信息，agent 集成不可行 |
| 安全通道 | 走已有 webServer WS，复用 auth-webserver 认证 | VNC 自带端口，需额外隧道 + 认证 |
| 浏览器范围 | 仅 Chromium 系（唯一硬边界） | 任意 X 应用（Firefox、Electron、Java Swing…） |
| 音频 | 无 | 扩展支持但 noVNC 支持有限 |

**决策：主方案 CDP。** 本需求要的是"浏览器"而非"桌面"；CDP 是浏览器原生协议，VNC 是桌面协议绕道控制浏览器，多一层间接层且丢掉 DOM/自动化能力。未来 agent 集成（共享 browser-use 会话）只有 CDP 能实现。**VNC 仅在需求扩展为"远程看服务器上任意 GUI 应用"或"硬性不兼容 Chromium"时才有意义**，列为备选。

为保留切换余地：Host 端把"取帧 + 注入输入"抽象为 `BrowserBackend` 接口（对齐 `dsh-plugin-browser-use` 的 `session.ts` 设计），将来接 VNC/noVNC 只换 backend，Client 页面不动。

## 5. 关键技术点与风险

| 点 | 方案 | 风险/缓解 |
| --- | --- | --- |
| 帧流协议 | WS 推送 JPEG 二进制（`screencastFrame` 的 `data`），GUI 用 `URL.createObjectURL`/`<img>` 或 `ImageBitmap` 渲染 | 帧率过高会占带宽：限制 8–15 fps，尺寸与面板同宽 |
| 输入事件映射 | GUI 记录 `img` 元素内相对坐标 → 乘 `(viewportWidth/imgWidth)` → WS 发 `{type:'mouse',x,y,button,action}` → Host 调 `page.mouse.*` | 页面缩放/滚动条会漂移：以 CDP `layoutViewport` 为准，定期同步 |
| 键盘/IME | `keydown/keyup` 发 key + code；Host 用 `page.keyboard.press`；组合键（Ctrl+C 等）用 `keyboard.down/up` 序列 | 中文输入法（IME）是难点：一期可仅支持 ASCII + 剪贴板粘贴（`page.evaluate` 注入文本） |
| Chromium 缺失 | 启动探测链失败时返回明确错误 `BROWSER_LAUNCH_FAILED` 并给出 `npx playwright install chromium` 指引 | 安装体积大（~150MB），文档写明 |
| 内网策略 | `allowPrivateNetwork` 默认放行（本需求核心），但 `allowedHosts` 可收紧；记录审计日志 | 与 browser-use 默认相反，文档高亮 |
| 会话隔离 | 每个 agent sessionId 一个 BrowserContext；无会话用共享上下文 | 多会话并发内存占用：空闲 10 分钟自动回收 |
| WebSocket 鉴权 | 复用 webServer 的升级机制（terminal-tab 同款）；帧流不携带敏感头 | 与 auth-webserver 代理兼容（它已转发 WS 升级） |

---

## 6. 与现有资产的对接

| 资产 | 对接方式 |
| --- | --- |
| `dsh-plugin-right-panel` | 现有右侧面板宿主仍可承载其他工作区页面；本浏览器一期不挂载到此处。 |
| `dsh-plugin-terminal-tab` | 浏览器作为 `conversation.view` 的一个 tab（order 30），与终端并列；首次进入自动创建 `about:blank` 并显示干净的空白新标签页。 |
| `dsh-plugin-browser-use` | 二期共享其 `PlaywrightBackend`/`BrowserSession`/`policy.ts`；一期可先直接复用其 `playwright-backend.ts` 的启动代码（MIT） |
| `dsh-deeptutor` | 二期：其 `html-doc` 产物 → 服务器端浏览器本地预览（补上它缺的"面板内查看"） |
| 现有发布/验证流程 | 新插件遵循仓库规则：`node --check`、README 同步、版本表、i18n 双字典 |

---

## 7. 实施计划（建议顺序）

1. **P0-1 脚手架**：`dsh-plugin-web-browser/`（package.json / cordis.patch.yml / index.js / client.js 骨架），Host 路由 `open/list/close` + WS，Client 注册 `conversation.view` 浏览器 tab + 两层工具栏。
2. **P0-2 初始页**：首次进入 Browser 视图自动创建 `about:blank`，显示干净的空白新标签页；关闭最后一个 tab 时隐藏标签栏。
3. **P0-3 帧流**：Host 接 `Page.startScreencast`，WS 推帧；Client `<img>` 渲染 + 标签切换。验证内网站点可达。
4. **P0-4 输入**：鼠标/滚轮/键盘回传（Playwright 高层输入 API）；错误码（`BROWSER_LAUNCH_FAILED`、`BROWSER_NAVIGATION_FAILED`、`BROWSER_INVALID_URL`、`BROWSER_HOST_NOT_ALLOWED`）。
5. **P0-5 会话与清理**：sessionId 隔离、空闲回收、卸载清理。
6. **P1**：browser-use 会话共享、本地 HTML 预览、下载/上传、帧率自适应。
7. 每步同步 README + 版本号（仓库发布规则）。

---

## 8. 参考

- `dsh-deeptutor`（TecFancy/dsh-deeptutor）：`html-doc` skill 自包含 HTML 产物；**无嵌入式浏览器**。
- `dsh-plugin-browser-use`（coderdailyone/dsh-plugin-browser-use）：`playwright-core` 驱动 Chromium 的工具套件 + 安全策略 + 私有 HOME 隔离；**无 GUI 展示层**（截图仅落盘给模型）。
- Playwright `page.screencast`（1.62+）：CDP `Page.startScreencast` 封装，JPEG 帧事件流；**实测推荐裸 CDP**（`newCDPSession` + `Page.startScreencast` + `screencastFrameAck`），验证见上文。
- 本仓库 `dsh-plugin-terminal-tab` / `dsh-plugin-right-panel` / `dsh-plugin-file-explorer`：路由、页面宿主、i18n、发布范式。

---

## 9. 结论

- **必须采用服务器端浏览器 + 画面回传**（路线 B），客户端 iframe 在"网络隔离"约束下不可行。
- 技术内核现成：`playwright-core` + 裸 CDP `Page.startScreencast`（帧）+ Playwright 输入 API + WS（双向输入），安全策略与启动逻辑参考 `dsh-plugin-browser-use`。
- 一期交付与终端并列的 Browser 视图：首次进入自动创建干净的空白 `about:blank` 新标签页；二期打通 agent 浏览会话与本地 HTML 预览（对接 deeptutor 产物）。
- 建议新插件名：`@yiln-dsh/dsh-plugin-web-browser`。

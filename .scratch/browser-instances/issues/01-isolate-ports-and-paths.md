# 01: 端口与路径按实例隔离

**What to build:** 同一个 dsh 进程里能同时起两套完整的浏览器栈（Xephyr + Chromium + x11vnc），
两套之间不撞 RFB 端口、不共享 Chromium profile 目录、不互相覆盖 Xauthority。端口被外部服务
占用时，新实例跳过该端口继续找下一个，而不是「有人监听就复用」——后者会让第二个面板静默
显示第一个的桌面。

这一步不改变任何对外接口：现有单实例行为保持不变，所有既有测试仍然通过。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 两个 `createBrowserStack` 传入不同的实例标识，profile 与 Xauthority 落在不同目录，互不碰撞
- [x] 两个 `createX11VncController` 分配不同的 RFB 端口，都能成功 bind
- [x] 端口复用语义改为「本实例已持有才复用」：外部服务占用某端口时，分配逻辑跳过它，不会连到别人的 x11vnc
- [x] 配置新增 `rfbPortRange`（默认 `[5900, 5999]`），`rfbPort` 保留为 v1 兼容单值
- [x] 端口区间耗尽时返回明确错误，不复用、不静默降级
- [x] 嵌套显示号池从 `:200`–`:250` 扩到 `:200`–`:999`，池满时的既有报错文案保留
- [x] 新增测试：两个 stack 用不同实例标识时路径不撞（扩展现有 `makeStack()` 的参数化）
- [x] 新增测试：端口分配在外部占用时跳过该端口
- [x] 既有测试全部通过，单实例行为无变化

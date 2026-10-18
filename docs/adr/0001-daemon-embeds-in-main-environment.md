# ADR 0001 — 守护进程内嵌于主环境

## 状态

已接受（2026-10-18）。

## 背景

需要“一个入口管理多个环境 + 一套认证”。最初实现为两个进程：一个只跑守护进程的
宿主 profile（`edge`），一个被代理的 harness profile（`web`），后者被收养为根目标。

两进程的代价：约 380 MB 额外内存、注册表里多一条指向自己的条目、以及“哪个
profile 才是真正的我”这一持续困惑。

## 决定

守护进程与它所前置的 harness 监听器**同进程**。主环境就是承载守护进程的那个进程，
harness 挂在 `/main/` 前缀下，根路径 302 到该前缀。

## 为什么之前认为做不到

被代理的 harness 用 `dsh-auth-<hash(authority)>` cookie 鉴权，authority 来自 Host 头。
浏览器对着守护进程的地址，永远拿不到那个 cookie。两进程设计靠解析子进程 stdout 里的
启动 token 绕过；同进程时没有子进程可读。

## 打破僵局的事实

`ctx.connection.authenticatedUrl(baseUrl)` 是**公开且有文档**的 API，返回本进程带
token 的 URL。它的文档描述本身就提到“mount proxy 会在 authorizeIndex 前剥掉前缀”——
即上游预期的使用场景正是挂载代理。

因此 token 来源从“抓子进程输出”变成“读公开 API”，交换流程不变：一次 GET 换
cookie，缓存复用，被拒则丢弃重换。

## 后果

正面：少一个进程、少一条注册表条目、少一层“我是谁”的歧义。

负面：守护进程崩溃会带走主环境的 harness 界面（但环境本身仍在，systemd 会拉起）。

被否决的替代方案：
- 让 harness 直接绑 `0.0.0.0` —— `dsh-host-webserver` 的 `Config.host` 拒绝通配地址，
  且发生在配置校验阶段。
- 依赖 `trustedProxy` / `x-forwarded-*` 放行 —— `dsh-client-connection` 没有这类开关，
  Host 围栏只决定“能否进入鉴权”，不产生身份。
- 自签 cookie —— 需要读取 credentials 里的 secret 并复刻 cookie 编解码，
  属侵入上游内部。

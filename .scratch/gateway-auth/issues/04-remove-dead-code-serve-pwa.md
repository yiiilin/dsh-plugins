# 04: 删掉死代码，并把 PWA 资源接上

**What to build:** 认证模块里那批「写了但从没有到达过」的代码消失，同时登录页声明的
PWA 资源真的能被访问到。

两件事方向相反：一边是删——一整套 host/origin 校验无人引用，通行密钥的注册方法没有
注册入口；一边是接——登录页引用了 manifest 与 service worker，但没有任何路由去服务
它们。

**今天它们返回什么**：未认证的 `GET /manifest.webmanifest` 落到会话关卡，
被回答成 **200 + 登录页 HTML**（不是 404）。浏览器把 HTML 当 manifest 解析，静默失败。
有会话时它会被代理到根 harness，于是遮蔽了 harness 自己的 manifest。

**前缀**：登录页的资源引用全是根绝对（`/manifest.webmanifest`、`/sw.js`、
`/apple-touch-icon.png`、manifest 里的 `/icons/*`），在带前缀的部署下会逃出前缀。
服务路由与声明的 href 必须由**同一个值**推导出来——这个值来自配置的根前缀。
登录页是在任意路径上被服务的，所以不能用裸相对路径，要用前缀绝对。

**service worker 的 scope**：脚本必须由 `<前缀>/sw.js` 提供，scope 用同一个前缀——
scope 不能超出脚本自己所在的目录，用 `/sw.js` 注册 scope `/main/` 会抛 SecurityError。

**Blocked by:** 03: 认证模块的接口只留真正被用到的东西

**Status:** ready-for-agent

- [ ] 无人引用的 host/origin 校验模块被删除（已确认与任何在用的配置项无关）
- [ ] 通行密钥的注册方法被删除（没有注册入口，它是一个永远走不到的方法）
- [ ] PWA 模块里未被引用的导出被删除，保留真正在用的
- [ ] manifest 与 service worker 能被实际访问到，不再返回登录页
- [ ] 登录页的 PWA 声明与实际提供的资源一致（资源表里没有的引用要么补上、要么去掉）
- [ ] 资源路由与页面声明由同一个前缀值推导，在带前缀的部署下都能工作
- [ ] service worker 的脚本位置与 scope 一致（scope 不超出脚本所在目录）
- [ ] 带前缀的部署下 scope 就是前缀，不会控制到别的挂载
- [ ] 全部测试通过

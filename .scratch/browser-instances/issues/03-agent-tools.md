# 03: 三个 agent 工具

**What to build:** agent 能通过三个工具管理浏览器实例：列出全部、按归属会话创建、按 id 关闭。
id 不存在时明确报错，不回退到「最近一个」或「唯一的那个」，也不自动新建——自动新建会让
agent 以为自己操作的是 A，实际开了 B。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `browser_instance_list` 返回全部实例及其状态
- [ ] `browser_instance_create` 接受归属会话，返回新实例的 id 与初始状态
- [ ] `browser_instance_close` 按 id 关闭实例
- [ ] 三个工具对不存在的 id 返回明确错误，不回退、不自动新建
- [ ] 工具描述说明 id 是唯一依据，避免 agent 猜测
- [ ] 不提供聚焦工具（焦点是客户端界面状态，服务端工具跨层修改语义不清）
- [ ] 新增测试：三个工具的正常路径与 id 不存在路径

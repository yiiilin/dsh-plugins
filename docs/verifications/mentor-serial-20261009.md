# Mentor 串行队列与失败结束验证

本次用户要求：Mentor 串行即可，一次调用成功或失败都结束，历史 busy 不应永久阻塞后续调用。仅修改根插件内 Mentor 源码、回归和相应说明；本地部署保留原版本 0.1.1，未提交、未发布。

## 最终行为

- 同一主 Session 按提交顺序串行执行，达到全局运行额度时等待，不再因历史 accepted/dispatched/indeterminate 或未送达结果返回永久 THREAD_BUSY。
- 成功、失败、取消、超时在 child 收敛并释放后结束；等待中的请求可取消，插件关闭会终止等待。
- 旧线程异常或包含未送达结果时，下一条新输入自动封存旧线程并创建干净上下文；正常已送达的成功上下文继续使用。
- 同 host callId 优先从原线程恢复已有完整回复，无完整回复时保持准确的未决结果，不自动重新付费生成。新工具调用可以重新咨询。
- reset 与咨询共享串行队列，作为顺序屏障；取消后不写 reset。迟到结果可更新交付事实，但不重新激活旧线程。
- 保留原始 provider 错误，不把上游 HTTP 502 覆盖成泛化 MENTOR_INCOMPLETE。

主实现见 [mentor.js](../../src/mentor/lib/mentor.js)，回归见 [mentor.test.js](../../src/mentor/test/mentor.test.js)，当前契约见 [模块说明](../modules/mentor.md)。

## 实际验证

环境：Linux、Node.js v24.14.1、DSH 0.2.0-rc.2。

| 检查 | 实际结果 |
|---|---|
| Mentor 模块回归 | 57 通过，0 失败，0 跳过 |
| 根项目 npm run build / npm run check | 通过 |
| 根项目 npm test | 286 通过，0 失败，0 跳过 |
| git diff --check | 通过 |
| packed 包在隔离 profile 安装 | 成功，安装源码与测试源码逐字节一致 |
| Web profile 最终安装 | 成功，安装源码与最终 hash 一致，原 profile patch 未修改 |
| 独立 systemd 重启与健康检查 | healthy=true，rollback=false |

先取得的失败证据包括：未送达旧结果导致下一条 blocked；并发请求未排队；reset 越过先提交的咨询；AgentLoop 收敛时原始 provider 502 被错误包装。修复后相应回归通过。附加测试覆盖历史 accepted/dispatched/indeterminate、取消/超时后继续、重复 callId、等待取消、插件关闭、reset 取消、原线程多轮修订恢复、迟到交付、慢 dispose、创建期间取消和跨主 Session 的全局额度。

独立只读 agent 复核修正后的队列与恢复控制流，最终范围内未发现证实交付阻塞；其静态复核不当作运行验证。

## 当前会话的真实调用

本会话此前被历史未决状态卡住。部署串行版本后，未经手工 reset 连续两次新工具调用均实际派发，没有返回 THREAD_BUSY。该两次遇到 provider HTTP 502；子 Session 日志证明原失败为 `sub2api-gpt API error (502): upstream service temporarily unavailable`，宿主重试又触发单次生成保护，旧实现最终只报告 MENTOR_INCOMPLETE。已据此补充原错误保留回归与修复。

最终版本部署后，连续两次 Mentor 调用均成功返回真实回复：

- 同一线程：`mt_9f3f2335-5fad-4d00-b29f-7beecdba54fe`。
- 第一次：修订 1，咨询 `mc_32e57df947f39774b0064377482db7bd`。
- 第二次：修订 2，咨询 `mc_eb470350b25384827130e9b18ba5767b`。

这验证了旧失败后无需 reset 即可开始新咨询，以及成功送达后的串行追问可复用已完成上下文。模型上游仍可能发生网络/服务失败；本插件保证本地结束、记录与后续可继续，不保证上游永远可用或远端取消立即停止计费。

Web 浏览器只建立本机授权的独立验证会话；空新会话页上的 status 尝试未取得命令回显，不据此宣称 slash command 端到端验证通过。此版本无需依赖手工 reset 解除历史 busy。未修改 provider/model 全局配置，未访问其他会话的咨询正文。

## 最终部署标识

- 源码 SHA-256：`548b25284f1faed55638aab74b9f9bf2fa7940a864a7b96c855c161e30edc0a3`。
- 部署包 SHA-256：`4854c73159bd924e14f741ef0c9065af4451bf358490d7e0ad51e5fae65b0f08`。
- 部署包：`/root/.dsh/artifacts/mentor-serial-20261009-v2/yiln-dsh-dsh-plugins-0.1.1.tgz`。
- 最终独立重启任务：`dsh-mentor-serial-reload-v2.service`。
- 结果文件：`/root/.dsh/artifacts/mentor-serial-20261009-v2/restart-result.json`。
- 备份：`/root/.dsh/backups/mentor-serial-v2-cZzRL3WG`。

没有删除原 journal 或 Session 数据。旧 busy 记录通过正常新调用自动退出活动线程，不篡改历史结果。

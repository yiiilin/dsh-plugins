# daemon 环境管理 —— 实测结果

共 45 项，全部通过。

| 项 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 注册表只存远程环境，无 kind 字段 | 通过 | 字段列表无 kind |
| A2 | 主环境不在注册表 | 通过 | 列表仅 dsh-box1 / dsh-box1-2 |
| A3 | adopt 已移除 | 通过 | 定义数 0；POST adopt 被拒 |
| A4 | 同一 helper 重复被拒 | 通过（修复后） | 曾误建 dsh-box1-2，改用解析后地址比对 |
| A5 | 同机不同 helper 允许 | 通过 | /opt/dsh-helper-b 建成新环境 |
| B1 | 密钥 0600 + 固定文件名 | 通过 | -rw------- id_ed25519 |
| B2 | ssh 片段四要素 | 通过 | HostName/Port/User/IdentityFile 齐全 |
| B3 | Include 幂等 | 通过 | 两次写入仍 1 行 |
| B4 | known_hosts 去重 | 通过 | 3 条无重复 |
| B5 | 公钥带标记 | 通过 | dsh-daemon:dsh-box1 × 1 |
| B6 | 轮换后不累积 | 通过 | 标记行数仍为 1 |
| C1 | 四档状态 | 通过 | ok/helper-bad/unreachable/未运行 全实测 |
| C2 | 并发探测 | 通过 | 两台合计 1079ms ≈ 单台两往返 |
| C3 | 60s 缓存 + fresh | 通过 | 676ms vs 1017ms |
| C4 | 主环境无健康状态 | 通过 | self 无 health 字段 |
| D1 | start | 通过 | 57800 起来且 health ok |
| D2 | stop | 通过 | running false |
| D3 | restart | 通过 | 重启后 health 恢复 ok |
| D4 | 日志行内展开 | 通过 | log 端点返回子进程输出 |
| D5 | deploy 幂等 + 回写 | 通过 | skipped:true；删 helper 后 skipped:false 并重装 |
| D6 | enabled 开关 | 通过 | false/true 往返 |
| D7 | 删除询问 helper（默认是） | 通过（已补主机名） | 原文案缺主机，已加 {host} |
| D8 | 卸载脚本可执行 | 通过 | -rwx------ 1018B，bash -n OK |
| D9 | 删除时删远端 helper | 通过 | remoteRemoved:true，远端已无文件 |
| D10 | 删除时保留远端 helper | 通过 | remoteRemoved:false，远端仍在 |
| E1 | prepare 不写远端 | 通过 | authorized_keys 行数 2 -> 2 |
| E2 | prepare 返回主机信息 + 指纹 | 通过 | hostname/arch/os/glibc + fingerprint |
| E3 | confirm 执行全部写入 | 通过 | 环境建立、密钥、helper、hash 回写 |
| E4 | 指纹不符被拒 | 通过 | 明确报错且注册表未污染 |
| E5 | rekey 轮换 | 通过 | 指纹变化，环境仍 ok |
| F1 | 删除时删密钥 | 通过 | 目录不存在 |
| F2 | 删除时删 ssh 片段 | 通过 | .conf 不存在 |
| F3 | known_hosts 保留 | 通过 | 3 条仍在 |
| G1 | self 信息 | 通过 | host/port/plugins/uptime |
| G2 | restartable 默认 false | 通过 | 请求被拒，不会误重启生产 |
| G3 | 重启机制可用 | 通过 | 一次性单元 PID 变更 + 计数递增 |
| G4 | 主环境行渲染 | 通过 | 本机(当前)/未托管/328 插件，0 控制台错误 |
| H1 | portBase 分配 | 通过 | 57800、57801 |
| H2 | 端口持久不变 | 通过 | restart 后端口不变 |
| I1 | ssh 行使用别名 | 通过 | host: dsh-dsh-box1 |
| I2 | 环境启动零激活失败 | 通过 | 日志无 did not activate |
| I3 | 环境能对话 | 通过 | UI 可发消息并回复 |
| I4 | 工具实际落在远端 | 通过 | 返回仅远端存在的 REMOTE_PROOF_* |
| J1 | 登录成功 | 通过 | 带 cookie 返回数据 |
| J2 | 未登录被拒 | 通过 | 无 cookie 返回登录页，无数据泄漏 |

# 生产脚本规范

任何改动生产服务的脚本都必须满足以下规则。每条都对应一次真实事故
（见 [incident-2026-10-18-outage.md](./incident-2026-10-18-outage.md)）。

## R1 — 失败即回滚

`fail()` 必须恢复备份、重启服务、确认恢复成功后才退出。只写日志然后
`exit 1` 会把服务留在中间状态——那正是把 15 分钟宕机从"一次失败"变成
"持续不可用"的原因。

```bash
fail() {
  echo "FAILED at: $*"
  restore_backup
  systemctl restart "$UNIT"
  wait_healthy || echo "ROLLBACK ALSO FAILED — needs a human"
  echo "RESULT=ROLLED_BACK"
  exit 1
}
```

## R2 — journal 是判据，不是 HTTP 码

崩溃循环的间隙里进程是活的，`curl` 会返回 200。只看状态码等于没验证。

```bash
# 必须读日志，且把命中的行本身打出来
if journalctl -u "$UNIT" --since "$START" | grep -qE 'Error:|Fatal:|throw new'; then
  fail "journal contains an error after restart"
fi
```

## R3 — 检查稳定窗口

验证期间服务必须**不重启**。`NRestarts` 增长即为失败，即使端口在响应。

```bash
before=$(systemctl show "$UNIT" -p NRestarts --value)
sleep 20
after=$(systemctl show "$UNIT" -p NRestarts --value)
[ "$before" = "$after" ] || fail "service restarted during verification"
```

## R4 — 不往 `.env` 写 bootstrap-only 变量

`$DSH_HOME/.env` 只接受普通变量。`dsh-app-boot` 的 `BOOTSTRAP_NAMES` 含
**前缀通配** `DSH_` / `XDG_` / `DYLD_` / `BASH_FUNC_`，以及 `PATH`、`HOME`、
`NODE_OPTIONS`、`LD_PRELOAD`、`EDITOR`、`HTTP_PROXY` 等具体名字。命中即
**进程拒绝启动**，且发生在任何插件加载之前。

需要注入启动期变量时用 systemd：

```ini
Environment=DSH_AUTH_PASS=...
```

## R5 — 日志里写原始证据

验证结果不能只是一个布尔值。写清楚看到了什么，否则事后无法判断"当时真的
健康吗"。

```bash
{
  echo "  entry=$entry login=$login passkey=$passkey"
  echo "  restarts=$before->$after  started=$(systemctl show "$UNIT" -p ExecMainStartTimestamp --value)"
  echo "  journal-errors=$(count_errors)"
} >> "$LOG"
```

## R6 — 先停服务，再改被监视的层

profile patch 与 home patch 受 HMR 监视。在运行中的进程里改它们会触发重载，
而重载时若新的 row 指向尚未安装的包，正在服务的插件会被卸载。

```bash
systemctl stop "$UNIT"      # 先停
edit_patch                  # 再改
systemctl start "$UNIT"     # 后起
```

## R7 — 隔离副本先跑通

生产改动前，在**同 `DSH_HOME`、不同 profile 名、不同端口**的副本上跑通。
不要换 `DSH_HOME`：那会改变模块解析基址，让插件找不到只存在于 dsh 安装目录
里的包，从而产生与真实问题无关的假象。

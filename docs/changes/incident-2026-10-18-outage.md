# 事故记录：2026-10-18 迁移期间的 15 分钟宕机

## 摘要

把生产入口从 `auth-webserver` 迁到 `daemon` 之后，为了给凭据“加一层冗余”，
往 `$DSH_HOME/.env` 追加了 `DSH_AUTH_PASS=<原密码>`。该名字属于 dsh 的
**bootstrap-only** 名单，写入 `.env` 会让进程在 CLI 阶段直接退出，插件尚未加载。
结果是约 15 分钟内 **216 次崩溃重启**，公网入口基本不可用。

## 时间线

| 时刻 | 事件 |
|---|---|
| 15:55 | 迁移前备份（service 单元、package.json、patch） |
| 15:56 | 迁移执行：daemon 接管 3080，`edge` 作宿主，注册 `core → web:57900` |
| 15:57 | 迁移脚本自检 `RESULT=OK`；登录/passkey/公网均 200 |
| 16:05:04 | **追加 `DSH_AUTH_PASS` 到 `.env`**（本次事故起点） |
| 16:05–16:08 | 崩溃 82 次；systemd 触发 `Start request repeated too quickly`，放弃重启 |
| 16:09–16:13 | 服务静默，无人察觉 |
| 16:14:54 | 清理脚本 stop + start，**重置了 start-limit 计数**，循环继续 |
| 16:14–16:19 | 再崩溃 134 次 |
| 16:19:56 | 最后一次 `Scheduled restart job` |
| 16:20:11 | 移除该行后启动成功；此后 `NRestarts=0` |

用户首先发现了问题（"你看看 dsh-web 的日志，有报错的"），不是监控，也不是我。

## 根因

`dsh-app-boot` 的 `BOOTSTRAP_NAMES` 是一张白名单，列出**只允许由启动环境设置**
的变量。它不止若干具体名字，还含三个**前缀通配**：`DSH_`、`XDG_`、`DYLD_`。
也就是说 `.env` 里**任何 `DSH_` 开头的变量**都会让进程拒绝启动——`DSH_AUTH_PASS`
只是恰好被我写进去的那一个。`readEnvLayer` 在读到这类名字时直接 `throw`：

```
Error: dsh: /root/.dsh/.env sets "DSH_AUTH_PASS", which only the launching
environment may set; export DSH_AUTH_PASS instead of putting it in a .env file
```

这个错误发生在 `runCli → loadLayeredEnv`，**早于任何插件加载**，所以不是某个
插件的配置问题，而是进程根本起不来。

正确的注入方式是 systemd 的 `Environment=DSH_AUTH_PASS=...`（属于启动环境），
或干脆不用它——`AUTH_PASS` 本来就在 `.env` 里，而 daemon 已同时接受两个名字。

已实测的前缀清单（`dsh-app-boot/lib/index.js:3610-3680`）：

```
具体名字  PATH HOME USERPROFILE SHELL NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS
          LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT BASH_ENV ENV SHELLOPTS BASHOPTS
          PYTHONSTARTUP PYTHONPATH PYTHONHOME RUBYOPT RUBYLIB JAVA_TOOL_OPTIONS
          _JAVA_OPTIONS JDK_JAVA_OPTIONS GIT_SSH GIT_SSH_COMMAND GIT_EXTERNAL_DIFF
          GIT_PAGER GIT_EDITOR GIT_ASKPASS SSH_ASKPASS GIT_CONFIG_GLOBAL
          GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT EDITOR VISUAL PAGER BROWSER
          DEEPSEEK_BASE_URL DEEPSEEK_SEARCH_BASE_URL SSL_CERT_FILE SSL_CERT_DIR
          HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY REQUESTS_CA_BUNDLE
          CURL_CA_BUNDLE NODE_TLS_REJECT_UNAUTHORIZED
前缀      DSH_  XDG_  DYLD_  BASH_FUNC_
```

## 为什么没有被及早发现

三个环节同时失效：

1. **验证只看 HTTP 状态码。** 崩溃循环的间隙里进程是活的，`curl` 能拿到 200。
   脚本据此判 `entry=200` 通过，同时在写日志时服务已经第 N 次退出。
2. **脚本的 `fail()` 不回滚。** 它只写日志并 `exit 1`，把服务留在崩溃状态。
3. **我没有读 journal。** 手上就有 `journalctl`，却只信状态码。用户读日志比我先
   发现问题。

## 修复

1. 从 `.env` 删除 `DSH_AUTH_PASS`（保留 `AUTH_USER`/`AUTH_PASS`）。
2. daemon 同时接受 `DSH_AUTH_*` 与 `AUTH_*`，与退休的网关一致。
3. 补充规范（见下）。

## 规则（已写入 `docs/changes/production-script-rules.md`）

凡是改动生产服务的脚本，必须：

- **R1** 失败即回滚：`fail()` 恢复备份、重启、并验证恢复成功后才退出。
- **R2** 读 journal 作为判据：验证阶段必须检查 `journalctl -u <unit>` 里
  没有 `error|fatal|throw`，不能只看 HTTP 码。
- **R3** 检查稳定窗口：验证必须包含"在 N 秒内 `NRestarts` 没有增长"。
- **R4** 不在 `.env` 里写 bootstrap-only 变量；用 systemd `Environment=`。
- **R5** 验证结果写进日志时附上原始证据（journal 行数、`NRestarts` 值、
  进程启动时间），而不是单个布尔值。

## 影响

- 公网入口：约 15 分钟不可用（16:05–16:20）。
- 数据：无损失。会话存储是全局的（`/root/.dsh/sessions`），数据库未受影响。
- 迁移本身：成功。fleet 与 auth-webserver 的清理亦成功。

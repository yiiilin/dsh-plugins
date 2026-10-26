# 接入期的环境坑

主流程第 3 步判据不过、或换了运行环境时读。只讲接入，不讲日常查询用法。

命令的 flag 一律 `codegraph <command> --help`，本文件不另存副本。

## 网络盘 / 容器文件系统

`codegraph status --json` 的 `journalMode` 不是 `wal`，说明 WAL 没启用，读会被写阻塞。把项目（连同 `.codegraph/`）挪到本地盘。

## WSL2

项目在 `/mnt/c`、`/mnt/d` 下时，本地套接字不可靠，会话会报 `Transport closed`（而 `codegraph status` 还是正常的）。两条路：

- 把项目移到 Linux 原生文件系统（`~/` 下）
- 或给 MCP 服务设 `CODEGRAPH_NO_DAEMON=1`，让每个会话独立进程

**不要在 Windows 和 WSL 之间共用同一个 `.codegraph/`**——SQLite 锁跨不过这条边界（WSL 报 `disk I/O error`）。WSL 会自动用 `.codegraph-wsl/`；若 Windows 已建了 `.codegraph/`，在 WSL 里设 `CODEGRAPH_DIR=.codegraph-wsl` 再 `codegraph init`。

## 大仓库

WAL 文件在索引期会涨到索引大小的 1/4（下限 256MB，上限 2GB），静止后收到 64MB。两个旋钮：`CODEGRAPH_WAL_VALVE_MB`（索引期阈值）、`CODEGRAPH_WAL_HEAL_MB`（静止值）。诊断加 `CODEGRAPH_WAL_VALVE_DEBUG=1`，决策打到 stderr。

## 升级相关的三个坑

- **升级后不重建，图谱和二进制可能对不上。** 判断方法：`codegraph status . --json` 的 `index.reindexRecommended` 是 `true` 就回第 3 步 `codegraph index . --force`。人类可读的 `codegraph status` 会打一行 `⚠ Index was built by vX; re-index...`，看那行也行。
- **别拿顶层 `version` 判断索引新旧。** 那是 CLI 自己的版本号，恒等于 `codegraph --version`，永远和索引一致。索引写的版本看 `index.builtWithVersion`；`reindexRecommended` 实际由 `index.builtWithExtractionVersion` 与当前引擎版本之比决定。
- **`codegraph upgrade` 改的是 CLI 本身**，不碰项目索引，也不碰你手写的 `codegraph.json`。升级不会丢配置。

## 日后撤销

先删项目指令文件里 `<!-- INIT-CODE-GRAPH:START -->` 与 `<!-- INIT-CODE-GRAPH:END -->` 之间的整块，再做：

```bash
codegraph uninit .               # 删掉本项目的 .codegraph/
codegraph uninstall --keep-cli   # 清掉各 agent 的配置，保留 CLI
```

跳过 `--keep-cli` 会连 CLI 一起删。走了 MCP 通道的，另外 `detach_capability` (`name=codegraph`)。

**顺序不能反**：先删指令块再卸 CLI，否则指令里那几条命令会指向一个已经不存在的程序。

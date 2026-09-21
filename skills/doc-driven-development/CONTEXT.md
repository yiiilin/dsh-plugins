# 当前上下文与轻量依赖索引

目标不是记住全项目，而是每个关键步骤读取正确的当前事实。Markdown/代码是来源，工具结果是可重建的派生索引；不另维护数据库版的业务事实。本版不引入 SQLite、向量库、外部服务或额外依赖。

## 1. 何时刷新

开始/恢复任务、从讨论进入实施、开始评审、交付前、切换主题或发现外部修改时：读项目规则、当前工作树、相关文档修订/正文和必要邻接契约；与上次已读范围比较。旧聊天结论不是最新文件，不按“时间最新”把 proposed 覆盖 accepted。现行规格回答期望，代码回答实际，提案回答准备改变什么；矛盾显式暴露。

有变化就回读并判断影响，相关旧评审/证据待核对；不自动重写正文、不盲目刷新哈希。没有变化也不能将“已扫描”变成“已读懂”。记录自己实际读过哪些材料、其版本和下一步在已有提案/接管报告，不再建平行纪要库。敏感数据不写进文档或索引。

## 2. 只读查询，显式保存快照

`context.mjs` 每次从当前文件构建内存索引，不从旧 JSON 取“最新知识”。默认只输出 JSON，不写项目。相对路径均为仓库根：

```sh
# 定位当前条目/文档；中文短词也用字面子串查询，不依赖分词服务。
node "$SKILL_DIR/scripts/context.mjs" . --query "幂等"

# 显式依赖、实现归属及相关条目；默认不将普通链接当强依赖。
node "$SKILL_DIR/scripts/context.mjs" . --doc FEAT-IMPORT --direction dependencies
node "$SKILL_DIR/scripts/context.mjs" . --doc MOD-STORAGE --direction impact --depth 4

# 当前规格身份和代码基线，只用于记录实际完成的检查，不是通过证明。
node "$SKILL_DIR/scripts/context.mjs" . --doc FEAT-IMPORT --bindings

# 经本次写入授权保存一个新的版本快照（不是阅读记录）。
node "$SKILL_DIR/scripts/context.mjs" . --out .doc-driven/context/design-start.json

# 下一阶段比较；有变化即回读，不能只把 compare 当作合规仪式。
node "$SKILL_DIR/scripts/context.mjs" . --compare .doc-driven/context/design-start.json
```

`--out` 仅允许新的 `.doc-driven/context/<name>.json`，已有文件拒绝覆盖；不可用来写 AGENTS.md、设计、配置或其他 JSON。快照保留版本元数据和路径关系、不复制全文。默认 limit 40、depth 3，可用 `--limit 1..300 --depth 1..12` 调整；结果有 truncated 表示不完整，不能声称全影响范围已查清。`--history` 显式包括历史，仍不将它用作当前权威。

比较范围是本次 inventory 策略可见的代码/配置/测试、受管文档及项目规则；报告 added/modified/removed 和受影响条目。每份快照绑定真实工作树路径身份，拒绝跨工作树复用；分支/提交变化也报告。文件哈希/图遍历不会发现漏掉的语义依赖、扫描排除外的变化或运行环境改变。配置、代码基线和排除项仍需人/AI核对。符号链接、不读大文件、潜在密钥等沿用 inventory 边界；未读材料必须披露。

`reading` 与 `semantic` 永远为 `not-assessed`，工具不证明读取、批准、评审或测试执行。发生变化时退出码仍为 0，变化是待处理数据，不是被忽略的程序异常；调用/路径/配置错误退出 2。查询不运行项目代码、Git hook 或外部服务。

## 3. 少量明确关系，而不是全量手工知识图谱

索引使用 Doc-ID、R-/C-/D-/E- 标识、Owns、Targets、Covers、显式 `Depends on` 和普通链接。Depends on 写当前文档或条目 ID，如 `Depends on: MOD-STORAGE, C-STORAGE-001`，必须来自实际设计依赖并保留正文解释。代码文件通过 Owns 关联；同一共享模块只在一个主要位置定义。

语义影响沿显式依赖、目标、归属和证据关系反向遍历；普通链接只标 reference，不推断强依赖。两种方向都处理定义条目与所属文档的关联，保守按文档整体指纹看待变更。新/旧关系合并用于识别删除后的潜在影响。未知或历史目标给诊断，循环图有限遍历，不伪造全覆盖。

每次建索引仍需扫描/哈希（不是增量常驻服务），图查询采用邻接表。没有大仓性能基准，不声称任意规模毫秒级。先在真实项目测查询次数、耗时和漏检，再决定是否值得引入可选 SQLite 后端；未来数据库也应可重建、按工作树隔离，不改事实来源。无 Node.js 时按同一版本/回读规则手动定位，不因没有数据库而不能工作。

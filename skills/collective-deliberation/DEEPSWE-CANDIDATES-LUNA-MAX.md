# DeepSWE 题目筛选记录

检索目标：从官方 DeepSWE 题库中挑选难度中等、验收客观、能拉开 coding agent/model 差异的任务。这里的难度是按题面范围和实现风险做的工程判断，不是官方难度标签。

## 结论

首轮标准横评建议使用下面 4 题：

1. `actionlint-action-pinning-lint`
2. `obsidian-linter-scoped-ignore-markers`
3. `abs-stepped-slices`
4. `httpx-streaming-json-iteration`

它们的共同特点是：有一个明确的核心机制，但题面同时规定了多个容易遗漏的边界；结果主要由程序行为和测试判断，而不是主观评价补丁风格。四题覆盖 Go、TypeScript、Go、Python，既能观察模型对不同代码生态的适应，也不会把评测全部变成大型基础设施或重型编译器任务。

若只做 2 题快速比较，使用 `actionlint-action-pinning-lint` + `httpx-streaming-json-iteration`；若预算允许 6 题，再加入 `cattrs-partial-structuring-recovery` 和 `sql-formatter-bigquery-pipe-formatting`。

## 官方题源与版本

官方项目是 [datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe)，本次检索时 `main` 为 [`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)。官方 README 将 DeepSWE 定义为面向前沿 coding agent 的长程软件工程 benchmark：113 个任务，涉及 TypeScript、Go、Python、JavaScript 和 Rust；任务采用 Harbor 格式，有 `task.toml`、`instruction.md`、隔离环境和 verifier。参考：[官方 README](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/README.md)。

[官方 manifest](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/manifest.json) 给出的关键信息是：

- `task_count = 113`；语言数量为 TypeScript 35、Go 34、Python 34、JavaScript 5、Rust 5。
- `source_dataset = "swe-bench-ultra"`，但 DeepSWE 自己的任务标识是 `task_id`/`ext_id`，不能把它们误称为标准 SWE-bench 的 `instance_id`。
- `task_id` 是仓库目录名；`ext_id` 在对应 `task.toml` 的 `[metadata]` 中。
- manifest 的任务名和展示描述是由 wide-research 生成的摘要，真正应交给模型的题面以各任务的 `instruction.md` 为准。

官方 Hugging Face 数据集是 [`datacurve/deep-swe`](https://huggingface.co/datasets/datacurve/deep-swe)。数据卡声明这是 held-out evaluation data，配置为 `default`、split 为 `test`，并使用 gated access 来减少评测泄漏。公开 GitHub 仓库同时能看到任务目录、solution 和 tests，因此不能把整个仓库原样作为模型上下文；应通过 Harbor/Pier 的任务运行器让 agent 只看到工作区和 instruction，由独立 verifier 负责验收。

每个下述任务的 `task.toml` 都声明了 `verifier.network_mode = "no-network"`、`environment_mode = "separate"`、2 CPU、8192 MB 内存、20480 MB 存储；agent 超时上限为 10800 秒，verifier 超时为 1800 秒。各任务的 Docker image 已在任务元数据中固定，但本机是否已有镜像仍需实际拉取/运行确认。

## 首轮推荐

### 1. `actionlint-action-pinning-lint`：配置合并与静态分析

- 语言：Go
- 仓库：`rhysd/actionlint`
- `ext_id`：`kh79dnvkvq8j9bs22ededakj`
- `base_commit_hash`：`0bdc95715fa58f64e3fd6e63b0f89be8733cbbab`
- 题面：[instruction.md](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/actionlint-action-pinning-lint/instruction.md)
- 元数据：[task.toml](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/actionlint-action-pinning-lint/task.toml)

要实现 `action-pinning` lint rule，支持 `major-minor`、`semver`、`commit-sha` 三档 pinning 强度，同时处理 step action 和 reusable workflow。题面还规定了动态表达式、`./`/`docker://` 排除、大小写不敏感的 allow/deny 列表、全局与 per-path 配置合并、denial 优先级、CLI 覆盖、配置错误诊断和已知 action 版本建议。

**为什么有区分度：** 只实现一个正则检查很容易在 happy path 得分，但配置继承、动态 ref、allow/deny 合并、可复用 workflow 的错误类型和 CLI 覆盖都要求模型先读清现有配置架构再改。错误通常是局部可见、测试容易客观判断的。

**成本判断：** 中等。核心是 AST/config/lint 代码，不涉及外部服务或大型运行时；官方镜像 Dockerfile 只需 Go 依赖和测试 reporter。适合作为第一道题观察代码导航、接口接入和边界覆盖。

### 2. `obsidian-linter-scoped-ignore-markers`：词法上下文与嵌套作用域

- 语言：TypeScript
- 仓库：`platers/obsidian-linter`
- `ext_id`：`kh7fmf1y6r9ajpg3htmaj237h182vztd`
- `base_commit_hash`：`6393b3ab32a2ace1fc24d4b0f5e0f13a179c874f`
- 题面：[instruction.md](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/obsidian-linter-scoped-ignore-markers/instruction.md)
- 元数据：[task.toml](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/obsidian-linter-scoped-ignore-markers/task.toml)

加入 HTML/Obsidian 两种 comment marker，支持全规则或指定规则、next-line、next-N-lines、大小写归一化、别名去重、未知规则忽略、嵌套 disable/enable 栈语义。marker 必须是独立行，并且在 YAML frontmatter、代码围栏、缩进代码、inline code、math block 中无效；marker 本身不得被规则修改。

**为什么有区分度：** 这是一个边界丰富但范围集中的扫描状态机。浅层实现通常漏掉代码块上下文、行尾截断、空规则列表、按最近 scope 移除规则或“disable all 后局部 enable”的组合。测试输入可完全离线、确定性强，适合比较模型是否能系统整理状态转移。

**成本判断：** 中等。Node 依赖在官方环境镜像中安装；没有网络服务、数据库或编译器链。建议作为首轮 TypeScript 代表题。

### 3. `abs-stepped-slices`：解释器 parser/runtime/Unicode 一致性

- 语言：Go
- 仓库：`abs-lang/abs`
- `ext_id`：`kh7d5m4ed35zfp7gyhx7wdahed82yw72`
- `base_commit_hash`：`cb1b3b671d0ee9fa9da9f7b02f86967953ffd10a`
- 题面：[instruction.md](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/abs-stepped-slices/instruction.md)
- 元数据：[task.toml](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/abs-stepped-slices/task.toml)

为数组和字符串加入 `value[start:end:step]`，包括省略边界、正/负步长、AST 字符串化、步长为零、数组和字符串的 range assignment、广播、长度错误和精确错误文本。字符串索引、切片和赋值必须按 Unicode rune 而不是字节工作，并保持既有单索引/两段切片行为。

**为什么有区分度：** 题面有很清楚的验收契约，但需要贯穿 parser、AST、evaluator、assignment 和错误路径。只修读取或只按字节实现的模型会在负步长、空选择、广播、Unicode 和现有错误格式上暴露。它还允许比较模型是否能保持旧行为，而不只是添加新 happy path。

**成本判断：** 中等偏上，但仍适合首轮。Go 项目本身不依赖外部服务，环境是 2 CPU/8 GB；实现面比单纯 API 添加稍宽，但比多模块运行时或网络协议任务可控。

### 4. `httpx-streaming-json-iteration`：流式协议、编码和消费状态

- 语言：Python
- 仓库：`encode/httpx`
- `ext_id`：`kh73snc7v9x3psk69rg4eqvjgs836v5a`
- `base_commit_hash`：`b5addb64f0161ff6bfe94c124ef76f6a1fba5254`
- 题面：[instruction.md](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/httpx-streaming-json-iteration/instruction.md)
- 元数据：[task.toml](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/httpx-streaming-json-iteration/task.toml)

添加 `Response.iter_json()`/`aiter_json()`。题面覆盖 `application/json`、`+json`、NDJSON、JSON Text Sequences，大小写和 charset 参数、UTF-8/16/32 检测、BOM、尾随数据、空记录、RS/LF 规则、数组展开、同步/异步流消费、自动关闭、重复迭代的 `StreamConsumed` 以及内存响应可重复迭代。

**为什么有区分度：** 这不是“调用 `json.loads`”就能完成的题。模型必须处理媒体类型分派、增量数据拼接、协议边界和 HTTPX 自己的 streaming 生命周期。测试可以直接检查返回值、异常和资源状态，能明显区分只覆盖常见 JSON 的实现与真正读懂规范的实现。

**成本判断：** 中等偏上，是首轮四题中最难的一题，建议保留充足上下文和运行时间。Python 依赖在任务镜像中准备，运行阶段无网络。

## 备选题

### `cattrs-partial-structuring-recovery`

- Python，`python-attrs/cattrs`
- `ext_id`：`kh7f7cahc5ddm1qzpxz13kpmrh8235pc`
- base：`6bc4708fb9b2ac52d9a18997e923da6a58916102`
- [题面](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/cattrs-partial-structuring-recovery/instruction.md) · [元数据](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/cattrs-partial-structuring-recovery/task.toml)

`PartialResult` 同时涉及 attrs/dataclass/TypedDict、嵌套部分成功、默认值、集合原子失败、`refine`、`forbid_extra_keys` 和详细校验。运行成本低、验收客观，但语义组合比首轮四题更密集，适合第二批。

### `sql-formatter-bigquery-pipe-formatting`

- TypeScript，`sql-formatter-org/sql-formatter`
- `ext_id`：`kh712k0bfwxew9fvg12k70g59n83pw33`
- base：`954e5a474b9e3d45ca58f02a3a4eac8e1947acc5`
- [题面](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/sql-formatter-bigquery-pipe-formatting/instruction.md) · [元数据](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/sql-formatter-bigquery-pipe-formatting/task.toml)

考察新 token、parse node、管道专属子句、嵌套 `GROUP BY`、缩进重置和传统 SQL 不回归。适合测试 parser/formatter 代码导航；比普通格式化 bug 更有区分度，但语法实现可能让它落在中等偏上。

### `tomlkit-toml-table-converters`

- Python，`python-poetry/tomlkit`
- `ext_id`：`kh7ezsk4ze1jyjta967ypwnxhh83etpm`
- base：`dd05eebc8ed9e30fc6c223088a5a450cb54c1cab`
- [题面](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/tomlkit-toml-table-converters/instruction.md) · [元数据](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/tomlkit-toml-table-converters/task.toml)

要求 standard/inline/dotted/super table 双向原地转换、comment 迁移和 `parse(dumps(doc))` round-trip。它很适合检验 AST 修改和保留语义，但 comment/AoT/父容器组合较多，建议作为扩展集而非最小 smoke test。

### `fastapi-deprecation-response-headers`

- Python，`fastapi/fastapi`
- `ext_id`：`kh75azsnb5eqs3mf4xm0zkzha582rvcd`
- base：`11614be9021aa4ac078d4d0693a8b5250a1010d8`
- [题面](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/fastapi-deprecation-response-headers/instruction.md) · [元数据](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/fastapi-deprecation-response-headers/task.toml)

运行时 Deprecation/Sunset/Link header、OpenAPI 扩展、route/router/app 多层继承和 tracking middleware 都有明确验收。它有很好的区分度，但传播层次和回归面较大，属于中等偏难；不建议作为第一次只有 2-4 题的基准。

## 不建议首轮使用的题型

- `fastapi-implicit-head-options`：同一 FastAPI 路由传播面再叠加 HEAD/OPTIONS、OpenAPI、CORS 和 middleware，范围过宽。
- `sqlite-utils-safe-import-checkpoints`：事务、schema 回滚、嵌套 checkpoint、持久化 invariant 和 CLI 同时变化，容易把结果变成“能否完成大型功能”的测量。
- `ts-pattern-match-each`、`valibot-recursive-schema-composition`：TypeScript 类型级 API、编译期 exhaustiveness 和 runtime 行为同时变化，适合专门测类型系统能力，不适合一般模型首轮横评。
- `kcp-go-multiplexed-kcp-streams`、`pwntools-tube-multiplexing`、`wazero-multi-module-snapshots`、`boa-hierarchical-evaluation-cancellation`：协议/运行时状态面过大，环境成本和调试时长会显著增加。
- `superjson-error-stack-serialization`：配置规范、错误 cause 图、stack 处理、sanitization、类注册和容器 round-trip 组合太多，适合作为压力题。

## 建议的运行和评分方式

1. 用官方 [Pier quickstart](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/README.md) 或兼容 Harbor 的 runner；单题路径形如 `deep-swe/tasks/abs-stepped-slices`。固定同一个 agent harness、模型提示前缀、最大步数、超时、温度/采样设置和容器资源。
2. 每题从对应 `base_commit_hash` 的干净环境开始。不要把公开仓库的 `solution/`、`tests/`、未来提交历史或参考 patch 放进 agent 上下文；正式验收只让独立 verifier 读取隐藏测试/评分配置。
3. 首轮不要只跑一次。建议每题至少 3 个独立 seed，报告 pass@1、成功率、超时/格式失败、测试通过比例和平均耗时；单次结果只能作为 smoke test，不能作模型强弱的统计结论。
4. 统一记录 patch 是否提交、模型是否修改了测试、依赖安装是否越界、网络访问、测试失败类型和 token/时间成本。行为 verifier 接受任意等价实现，不应用参考 patch 相似度代替正确性。
5. DeepSWE 数据卡明确它是 held-out evaluation data，但题目描述、目录名和部分仓库上下文仍可能在公开网络出现。模型训练/发布日期可能造成污染，横评报告应记录模型 cutoff 和已知暴露风险，不把“熟悉题目”误判成推理能力。

本记录只读取官方 README、manifest、任务 `task.toml`、公开 `instruction.md` 和相关环境配置；没有读取任何候选任务的 `solution/solution.patch`、`tests/test.patch` 或解题提交，也没有运行修复或声称任何候选已在本机跑通。

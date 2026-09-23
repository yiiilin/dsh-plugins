# doc-driven-development 0.3.0

通过讨论文档控制 AI 的实现，而不是只说愿望、事后读大量代码。普通功能默认一篇文档，内部保留清晰的**需求说明、概要设计、详细设计**三层；复杂模块才拆开。AI 应主动查证、找逻辑缺口、带场景和代价与人探讨，再整理结论；已确认文档可以被质疑，不能擅自改变约束。

支持新功能开发、已有项目渐进接管、全量代码设计恢复和人工改代码后的核对。核心流程是 Markdown 规则；附带工具提供项目安装/核验、文件盘点、索引和结构检查，不调用任何模型、不依赖其他 skill、不需要 API 密钥或联网。


## v0.3.0：实际运行、自动采证、当前版本交付

重点不再只是核对 agent 填写的验证字段。新增 [验证闭环](VERIFICATION.md)、[可执行计划模板](FORMATS/verification-plan.md)、`verify.mjs` 实际执行器，以及 [真实 agent 评测入口](EVALUATION.md)。继承此前即时记录、共同讨论、三层设计/ASCII、领域目录、持续实施授权和安全升级。

```text
[验收场景] -> [计划和实际入口] -> [已授权运行]
                                     |
                                     v
                   [自动结果 + 规格/代码/测试版本]
                                     |
                         +-----------+-----------+
                         v                       v
                  [失败/受阻/过期]       [当前场景已验证]
                         |                       |
                         v                       v
                    [修复后重跑]          [双向核对与交付]
```

默认只读预览；只有 `--run --expect-plan` 才运行用户项目命令。不隐式使用 shell、不自动安装依赖、清理资源或触及生产。缺环境、必测 skip/TODO、零用例、未报告命名场景、超时/输出超限、规格/测试/代码变化均不能当作通过。静态检查与行为验收分开，人工步骤不自动签字。原生 Node reporter、规范 JSON 适配和严格 flat TAP；其他格式不猜测。没有 npm/数据库/模型 SDK 依赖。

```sh
node "$SKILL_DIR/scripts/verify.mjs" . --plan docs/changes/actual.verify.json --json
node "$SKILL_DIR/scripts/verify.mjs" . --plan docs/changes/actual.verify.json --run --expect-plan <预览指纹>
node "$SKILL_DIR/scripts/verify.mjs" . --report .doc-driven/verification/runs/<本次ID>/run.json
node "$SKILL_DIR/scripts/verify.mjs" . --report .doc-driven/verification/runs/<本次ID>/run.json --evidence
```

新实施规格用 `Verification-Format: runner-v1` 和实际 `Verification-Plan` 路径。`--evidence` 只输出可合入原验证区的当前片段，旧手填记录不自动变成运行事实。严格交付可加 `--verification-report`；复杂交付包加 runner-v1 模式及 pinned runs。所有记录只代表声明场景，非签名、防恶意篡改或正确性证明，重要交付仍需受保护 CI/审阅。

可实际运行的隔离反例：`node "$SKILL_DIR/examples/verification-demo.mjs" --run --out /实际全新目录`。演示入口断开失败、接通通过、规格变化拒绝旧记录、skip+ok 不通过；不运行用户项目或模型。

`eval.mjs` 可通过真实宿主适配器运行多轮任务与独立判定。包内测试用 fixture 适配器，仅证明评测管道；真实模型效果、费用对比和主观交互质量未因此验证。见 [TESTING.md](TESTING.md)。

## 延续 v0.2.5：已确认就执行，按用户可用行为交付

先读原任务：已要求实现且同意同一方案，agent 应继续开发、接入实际入口、测试和核对，不反复询问是否实施；仅设计仍不写业务代码。任务漏项、SKIP+ok、接口存在但没有消费者，不能称完成。见 [EXECUTION.md](EXECUTION.md)。

对人按领域/模块/行为解释，讨论按需图文结合；新正文可隐藏稳定编号，旧编号继续兼容。见 [COMMUNICATION.md](COMMUNICATION.md)。多 agent 可选择强主 agent 主持，或协调主 agent + 按需强设计子 agent；单写入者、明确边界、有限并行和预算，不保证必然省钱。见 [ORCHESTRATION.md](ORCHESTRATION.md)。

**升级优先入口：[UPGRADE.md](UPGRADE.md)。**把可信 TGZ 安全解压到项目之外，从新包运行下列命令；原升级请求覆盖正常受管写入时，agent 预览无冲突后应直接继续 apply，不再让用户重复推动。项目设计保持原样，格式整理单独处理。

```sh
NEW_SKILL="/实际新包位置/doc-driven-development"
PROJECT="/实际项目位置"
node "$NEW_SKILL/scripts/check.mjs" --no-tests
node "$NEW_SKILL/scripts/upgrade.mjs" "$PROJECT"
node "$NEW_SKILL/scripts/upgrade.mjs" "$PROJECT" --apply
node "$NEW_SKILL/scripts/doctor.mjs" "$PROJECT" --json
```

完成后当前 agent 重读项目实际新入口；新会话加载需真实验证。没有新包不声称已升级，旧发行包运行出来的结果也不是最新版本检查。已存在的 AGENTS/CLAUDE 原文和项目设计不会被整篇重写。

```sh
# 自然查询；默认 JSON 方式仍兼容旧使用。
node "$NEW_SKILL/scripts/context.mjs" "$PROJECT" --query "恢复提示词" --human
# 跨模块/正式入口接线/多 agent 的交付包复用已有 change，先实际做完再检查。
node "$NEW_SKILL/scripts/delivery.mjs" "$PROJECT" --packet docs/changes/current.md --complete
```

跨模块、正式入口接线或多 agent 实施维护交付包；简单局部修复可用简短正文核对。隐藏标识迁移可选，不强迫历史文档迁移。节点/字段/日志通过只证明记录结构，不能证明人真的批准、模型真的读懂或生产路径真正正确。工程参考和真实行为评估边界见 [ENGINEERING.md](ENGINEERING.md)、[TESTING.md](TESTING.md)。

## 继续有效的基础机制（v0.2.4 引入）

每轮明确决定及时小范围保存到已有提案/草稿；先场景和上下文解释，再使用术语；实施前按风险评审，主 agent 查证意见、修改后定向复核。已确认文档可质疑但不能擅改，阶段切换刷新当前材料，不凭旧聊天执行。

新证据使用 `Spec-Refs` 同时绑定目标规格修订/正文；`Baseline` 继续绑定实现/测试/配置，执行证据补真实 `Environment`。新增 `--review` 核对真实设计评审记录；设计评审不算实现测试。旧未绑定记录保留并警告，但不能通过严格交付。新格式 `Evidence-Format: bound-v1` 的 passed 也不能没有有效绑定。流程细则见 [DESIGN.md](DESIGN.md)、[REFERENCE.md](REFERENCE.md)。

新增 [context.mjs](scripts/context.mjs) 每次读当前文件构建依赖索引和版本报告，默认只读；可按 ID/中文子串查询、反查影响、比较旧快照、取得实际检查应使用的规格身份。没有 SQLite、npm 包、常驻进程或 API；索引不替代原文，未做大仓性能保证。见 [CONTEXT.md](CONTEXT.md)。

```sh
# 这些命令在项目根执行；SKILL_DIR 指向实际完整安装目录。
node "$SKILL_DIR/scripts/context.mjs" . --doc FEAT-IMPORT --bindings
node "$SKILL_DIR/scripts/context.mjs" . --query "幂等"

# 实施前：先实际评审并记录，再检查结构和版本。REF 换成真实 Git 基线。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base REF --design --review

# 实施后：先真实测试及双向核对，再检查交付。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base REF --design --release
```

旧记录不批量补假 Spec-Refs/Approval，只有实际重新核对后才记录当前版本；未实施、不允许改代码、纯设计恢复不是 release。升级保护原有正文/配置/规则，未修改的真实 v0.2.5 及此前已支持发行包可由新 upgrade/install 安全升级。使用旧包目录里的命令仍是旧行为，必须从新包启动升级。

## 1. 安装到项目

将完整发行包解压到项目之外。使用**新包的安装器**预览并安全部署，不要直接覆盖旧 skill 目录。

```sh
# 实际路径按你的环境填写；脚本需要 Node.js 22+。
SKILL_DIR="/actual/path/doc-driven-development"
PROJECT="/actual/path/your-project"

node "$SKILL_DIR/scripts/install.mjs" "$PROJECT" --host both
node "$SKILL_DIR/scripts/install.mjs" "$PROJECT" --host both --apply
```

默认只预览；`--apply` 才写入。`both` 接入 AGENTS/Codex 和 Claude；也可选 `agents`、`codex`、`claude`、`auto` 或 `custom`。默认完整包放到项目 `.agents/skills/doc-driven-development/`，不假设所有宿主都原生发现它，而由相应项目规则指向实际入口。

**已有 AGENTS.md、CLAUDE.md 等规范只追加带边界的区块，边界外逐字节保留；原配置、业务代码和设计正文不覆盖。**重复安装不重复追加；手改受管区块或旧包有本地改动则停止，不提供强制覆盖。修改前保存备份与操作清单。详见 [INSTALL.md](INSTALL.md)。

**从 0.2.2 起，不再有面向用户/agent 的“只初始化然后当作启用”路线。**`install.mjs` 是唯一项目启用入口：包部署、受管规则、配置/索引、安装收据和静态核验一次完成。首次可用 `--mode full` 指定全量接管；安装不会自动分析代码或生成虚假的设计文档。

`init.mjs` 文件仅为旧 agent/脚本保留，行为已改变：兼容转发到完整安装器，默认只预览，带 `--apply` 才部署全部必需产物，不再单独写启用配置。`--mode`、宿主和保护规则与 `install` 相同。没有独立的 config-only 命令。

**用户声明项目采用此流程后，agent 必须先做接入检查。**缺安装时先预览再在授权内执行，不能跑完预览就声称已启用；已经 `ready` 则直接工作。明确仅本次或禁止安装时使用临时流程，不写启用配置、不承诺后续自动接入。

### 修复旧 init 留下的半安装状态

已有 `.doc-driven.json` 为 `enabled: true`，但缺项目 skill/规则区块时，直接对原项目运行上面的新包 `install` 两条命令。**无需删除配置或已有 docs；原配置逐字节保留，已有规范只追加受管区块。**使用新解压的 v0.3.0，不要继续调用旧全局 v0.2.1 的 init。

## 2. 检查后续会话是否接入

在项目根运行（按实际安装位置调整）：

```sh
node .agents/skills/doc-driven-development/scripts/doctor.mjs .
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --probe
```

`doctor` 将 `requestedEnabled`（配置意愿）与派生的 `activation`（`not-installed` / `incomplete` / `disabled` / `ready`）分开。配置为 true 但缺项目包、收据或规则仍是 `incomplete`，退出 1 并给出完整安装的下一步。它只读核查规则区块、索引与入口，提示覆盖规则/本地设置等风险；关闭配置不会算成功。`--probe` 生成一段发给**新 agent 会话**的只读检查请求，结合宿主实际加载记录和工具读取轨迹验收，不把文件存在或 agent 自称遵守当成证明。

静态成功与实际加载分开报告；本地脚本不调用模型，所以 runtime 始终为 `not-run`。不支持自动规则加载的宿主，需要实际配置持久入口或显式读取 skill；没有跨宿主的强制保证。高级命令、保护边界、旧版迁移和卸载见 [INSTALL.md](INSTALL.md)。

## 3. 三种常用请求

### 正常开发

> 为“具体功能”先调查当前文档与代码，主动找出目标、状态和数据处理中的逻辑缺口。带着具体场景、推荐与代价跟我讨论，可以先画 ASCII 草图；每个明确决定本轮就保存，主题收敛后整理需求说明、概要设计、详细设计和验收。不要预先把未经讨论的选择写成既定方案，先不改业务代码。

这应是安装后的默认行为，不要求用户每次重复“主动思考”。已明确的修复和等价重构不强制多轮讨论。共同设计、三类图和机器标记见 [DESIGN.md](DESIGN.md)；人类可读的完整形态见 [导入设计示例](examples/import-design.md)。

确认后：

> 同意刚才展示的方案和修订；按已确认范围实现，补测试并核对文码一致性。发现新的重要选择时只暂停受影响部分。

### 已有项目，逐渐补齐

> 使用渐进接管模式维护“具体功能/缺陷”。先恢复这条功能链及必要上下游的现状设计，画出实际流程、数据与状态关系，主动指出矛盾，再区分本次目标。不要为补文档重写整个项目，不把当前 BUG 写成正确需求。

### 先一次性全面梳理

> 使用全量基线模式，分析整个项目并将现有代码恢复成可维护的设计文档。先盘点范围、排除项和代码基线，再按模块及端到端链路分批完成；只写文档，不修改业务代码。事实、推断、未知、疑似缺陷必须区分。每批落盘覆盖进度、ASCII 图和按主题归类的待讨论问题；没读过或代码已变化的部分不得记为完成。

全量分析不是只能完成一批：目标是完成约定的整体范围，分批仅为控制上下文和核对质量。遇到会话容量上限应保存当前成果与明确剩余范围，下次从记录恢复，不能悄悄把目标缩成当前修改的文件。

恢复时：

> 继续上次全量设计恢复。先读接管报告和 progress.json，对照新 inventory 检查代码变化，再从记录的下一批继续；不要重复要求我描述已有信息。

直接修改代码后：

> 根据我这次代码改动核对当前文档。区分等价实现变化、修复偏差和新的契约变化；新的重要选择不要自动当成我已经批准。

## 4. 项目内只保留有用产物

```text
.doc-driven.json                  启用意愿、目录与扫描范围；不是安装完成证据
.doc-driven/install.json          项目采用所需的安装收据与归属哈希
.doc-driven/backups/              本地备份与事务日志，不进入业务快照
<docsRoot>/README.md               人工阅读导航 + 自动索引区块
<docsRoot>/architecture.md         全局概要；可从薄版逐渐补全
<docsRoot>/domains/<domain>/
  README.md                       可选：领域范围与导航
  architecture.md                可选：领域内部概要
  features/<feature>.md           需求 + 局部概要 + 关键细节 + 验收
  modules/<module>.md             共享模块的职责、接口与关键实现约束
<docsRoot>/changes/<change>.md     可选：涉及当前规格的短变更提案
<docsRoot>/adoption/README.md      全量接管的范围、进度、风险与继续入口
<docsRoot>/adoption/inventory.json 自动盘点，不代表已读
<docsRoot>/adoption/progress.json  实际阅读后的记录，不由扫描器自动填完成
```

新布局以领域内聚为默认，不采用 `domains/<domain>.md` + 根部 features/modules 的混合结构；`<domain>` 是实际领域名。每个功能或模块有一个主要归属，跨领域通过链接引用。详细规则与旧布局迁移见 [LAYOUT.md](LAYOUT.md)。

已有多领域目录、独立需求文档、ADR、验证资料和术语表继续沿用，只补必要元数据与链接，不强制迁移。普通功能无需独立创建所有这些目录。长期文档不以“每次变更一篇”不断堆积，提案合入后归档或标历史。

正文面向开发者，稳定机器字段使用英文。状态、确认、证据规则见 [REFERENCE.md](REFERENCE.md)，已有项目流程见 [ADOPTION.md](ADOPTION.md)。

## 5. 可选本地工具

要求 Node.js 22 或更新版本，无 npm 安装、无第三方运行依赖。Git 可选；`--base` 的变更范围检查必须有 Git 且从真实工作树根运行。所有命令支持 `--help`。

| 命令 | 实际做什么 |
|---|---|
| `install.mjs` | 默认预览；显式执行后安装/升级完整 skill 并安全追加项目规则 |
| `verify.mjs` | 默认预览；显式执行已审阅验收计划、自动采证、只读复核/输出证据片段 |
| `eval.mjs` | 默认预览；通过真实宿主适配器执行隔离多轮评测；fixture 与真实模式严格区分 |
| `doctor.mjs` | 只读检查安装与入口，输出新会话探测请求；不假装实际调用过 agent |
| `uninstall.mjs` | 默认预览；只移除未修改的本工具接入与发行文件，保留项目文档 |
| `init.mjs` | 已弃用的兼容文件名，转发完整 `install`；不再单独初始化，不推荐新调用 |
| `inventory.mjs` | 盘点文件、代码快照、归属映射和排除项；不做语义分析 |
| `index.mjs` | 从文档头重建索引区块；其他人工文字保持原样 |
| `context.mjs` | 当前显式依赖/标识检索、版本变化、规格绑定；默认只读，快照不是阅读记录 |
| `check-doc-set.mjs` | 检查受管文档结构、链接、归属、引用、证据字段及可选覆盖/交付条件 |
| `check.mjs` | 检查本 skill 的包完整性与脚本语法，并运行隔离自测；不是目标项目测试 |

```sh
# 生成盘点：已有非盘点 JSON 不会被覆盖；输出必须在配置的 docsRoots 内。
node "$SKILL_DIR/scripts/inventory.mjs" . --out docs/adoption/inventory.json

# AI 实际阅读代码、写文档、记录 progress 后：
node "$SKILL_DIR/scripts/index.mjs" .
node "$SKILL_DIR/scripts/check-doc-set.mjs" .

# 全量覆盖账目检查：未读、部分、受阻、哈希过时均不能冒充完整覆盖。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . \
  --progress docs/adoption/progress.json --full

# 检查本次实质代码变更的文档归属；把 origin/main 换成实际比较基线。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base origin/main

# 定稿前：严格检查本次功能/模块的三层正文与适用 ASCII 图。
# 没有 --base 时 --design 检查全部当前功能/模块；旧文档不会被改写。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base origin/main --design

# 可选严格交付：受影响文档已确认、实现完成、匹配当前代码基线的证据通过。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base origin/main --release

# 适合工具读取的 JSON 结果。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --json

# 自检 skill 本身；也可用 --no-tests 只检查包与语法。
node "$SKILL_DIR/scripts/check.mjs"
```

退出码：`0` 表示所选结构检查通过（可能有警告），`1` 表示检查失败，`2` 表示调用、配置或运行环境错误。`enabled: false` 会明确显示跳过，不能作为项目已验证的证据。

普通检查允许项目尚有未记录区域；`--base` 是可选的路径门禁，只约束本次实质变更，不要求全库补齐。纯格式/无契约变化的小修可以只跑普通检查，不必为满足路径门禁创建无用规格。`--release` 更严格，不用于尚在 `observed` 状态的纯逆向文档批次。

### 配置

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "docsRoots": ["docs"],
  "index": "docs/README.md",
  "adoption": "incremental",
  "language": "zh-CN",
  "include": ["**"],
  "exclude": [],
  "sourcePointers": "optional",
  "layout": "domain"
}
```

`layout` 可为 `domain` 或 `preserve`：新安装默认 domain；旧配置缺字段按 preserve 读取，不改原配置。没有配置但已有受管功能/模块文档时，安装器默认 preserve 并提示。`--layout` 只设置新配置，不能覆盖旧配置。domain 下目录错误使文档检查失败；preserve 下诊断不合布局的当前受管文件但不搬迁。

`schemaVersion` 和 `enabled` 必填。`enabled` 是持久启用意愿，不是安装完成或运行证明；项目接入以 doctor 的实际核验为准，不新增另一个易过期的 enabled/ready 配置字段。`docsRoots` 可映射原来的多个互不包含的文档目录；这些目录按文档区域处理，不应把业务源码目录设为文档根来掩盖分析范围。源码与文档混排时，配置实际文档子目录，并在接管报告明确其他资料的阅读入口。`include/exclude` 是仓库相对 glob，支持 `*`、`?`、`**`，不支持复杂 glob 扩展。`sourcePointers: optional` 只核查已有指针，不强制添加；`off` 关闭它。

盘点默认跳过版本库、依赖、构建和已安装 skill 目录，以及潜在密钥/`.env` 文件；Git 下还遵循忽略规则。完整排除结果和策略记录在 inventory 中。超过 2 MiB 的文件和明显二进制不会标为可文本阅读；应手工排除并说明，或另用适配方法审阅。源码文件中出现的敏感内容仍需模型与开发者避免写入文档，文件名过滤不是全面脱敏。

普通 Markdown、项目规则和受管文档目录不进入“代码快照/全量代码阅读”的分母，避免生成文档改变自己的基线；它们仍要按工作流程阅读与核对。无 Git 时使用文件系统盘点，**不声称解析了 `.gitignore`**。符号链接、子模块和被排除生成物在报告中披露；需纳入时作为明确子范围另行分析，不静默跟随。

### 设计正文检查与旧文档兼容

新 feature/module 使用 `Design-Format: layered-v1`：需求层有验收，概要有处理流程和数据流，详细设计有状态转换或具体不适用理由。章节可用项目语言，通过稳定标记识别。pending 在草稿中提示，在 accepted/严格检查中不能冒充完整。

普通检查对未改的无格式旧文档仅报告缺口；`--base` 检测到新文档或实质设计变化时按新格式检查。定稿用 `--base REF --design` 聚焦本次，不自动重写历史。不添加新的项目配置开关，不覆盖 .doc-driven.json。`stats.design` 与安装/证据状态分开，结构通过不证明图正确或讨论真实发生。完整约定见 [DESIGN.md](DESIGN.md)。

## 6. 检查能够与不能证明的事

脚本能核对当前受管功能/模块的领域目录形状（不推断领域是否正确），检查标识是否重复、链接目标是否存在、当前主要归属是否冲突、提案是否引用过时修订、重要条目是否关联证据、阅读记录是否仍匹配文件哈希。

设计正文检查只核三层骨架、验收入口、简单占位、图容器及引用；不证明状态转换合理、异常分支穷尽、图文代码一致或模型主动思考。

文档/交付旧记录检查不能证明命令执行；新版 verify 才直接启动进程与采集报告，但仍不是认证或语义证明。所有工具都不能证明模型确实读懂了源码、人的批准真实、算法完整正确或未测性能达标；不解析语言符号/配置字段、不校验 Markdown 标题锚点或联网检查链接。Markdown 检查支持常见内联/引用式路径，复杂 HTML/自定义扩展需用项目自己的文档工具。

CI 中可以使用这些脚本作底线，再配合项目测试、审阅权限和保护分支。修改 `.doc-driven.json`、确认记录或检查脚本本身也需要正常代码审阅；这里没有隐藏的防篡改审批平台。

核心 Markdown 流程不依赖 Node.js。环境不能运行工具时，执行实际可做的阅读与文档工作，并在交付中说明未执行的机械检查，不伪造通过。

## 7. 包内资料

[SKILL.md](SKILL.md) 是模型入口；[DESIGN.md](DESIGN.md) 规定共同设计与 ASCII 图；[REFERENCE.md](REFERENCE.md) 是字段与核对规则；[ADOPTION.md](ADOPTION.md) 是两种接管流程；[FORMATS/](FORMATS/) 是按需模板；[examples/scenarios.md](examples/scenarios.md) 展示具体文档及评估场景；[scripts/](scripts/) 是本地工具；[tests/run.mjs](tests/run.mjs) 是隔离测试。

[INSTALL.md](INSTALL.md) 说明安全安装、升级、卸载和两层生效检查；[CHANGELOG.md](CHANGELOG.md) 列出删减、迁移和机制变化；[TESTING.md](TESTING.md) 记录本次实际验证及未验证范围；[LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 保留原始许可与归属。

[多轮协作示例](examples/collaboration-session.md) 展示部分确认、解释、错误评审意见和恢复；[真实 agent 评估计划](examples/evaluation.md) 尚未执行，不能当作模型效果证明。

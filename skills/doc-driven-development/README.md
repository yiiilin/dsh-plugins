# doc-driven-development 0.2.2

通过讨论文档控制 AI 的实现，而不是只说愿望、事后读大量代码。普通功能默认一篇文档，内部依次区分**需求、概要设计、关键详细设计**；复杂模块才拆开。

支持新功能开发、已有项目渐进接管、全量代码设计恢复和人工改代码后的核对。核心流程是 Markdown 规则；附带工具提供项目安装/核验、文件盘点、索引和结构检查，不调用任何模型、不依赖其他 skill、不需要 API 密钥或联网。

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

已有 `.doc-driven.json` 为 `enabled: true`，但缺项目 skill/规则区块时，直接对原项目运行上面的新包 `install` 两条命令。**无需删除配置或已有 docs；原配置逐字节保留，已有规范只追加受管区块。**使用新解压的 v0.2.2，不要继续调用旧全局 v0.2.1 的 init。

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

> 使用 doc-driven-development 为“具体功能”先写需求、概要设计和关键详细设计。先展示本次方案、重要选择、代价和验收方式；没有明确的数值要求时不要编造。先不改业务代码。

确认后：

> 同意刚才展示的方案和修订；按已确认范围实现，补测试并核对文码一致性。发现新的重要选择时只暂停受影响部分。

### 已有项目，逐渐补齐

> 使用渐进接管模式维护“具体功能/缺陷”。先恢复这条功能链及必要上下游的现状设计，再区分本次目标。不要为补文档重写整个项目，不把当前 BUG 写成正确需求。

### 先一次性全面梳理

> 使用全量基线模式，分析整个项目并将现有代码恢复成可维护的设计文档。先盘点范围、排除项和代码基线，再按模块及端到端链路分批完成；只写文档，不修改业务代码。事实、推断、未知、疑似缺陷必须区分。每批落盘覆盖进度；没读过或代码已变化的部分不得记为完成。

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
| `doctor.mjs` | 只读检查安装与入口，输出新会话探测请求；不假装实际调用过 agent |
| `uninstall.mjs` | 默认预览；只移除未修改的本工具接入与发行文件，保留项目文档 |
| `init.mjs` | 已弃用的兼容文件名，转发完整 `install`；不再单独初始化，不推荐新调用 |
| `inventory.mjs` | 盘点文件、代码快照、归属映射和排除项；不做语义分析 |
| `index.mjs` | 从文档头重建索引区块；其他人工文字保持原样 |
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

## 6. 检查能够与不能证明的事

脚本能核对当前受管功能/模块的领域目录形状（不推断领域是否正确），检查标识是否重复、链接目标是否存在、当前主要归属是否冲突、提案是否引用过时修订、重要条目是否关联证据、阅读记录是否仍匹配文件哈希。

它不能证明模型确实读懂了源码、人的批准真实、命令真的执行、算法正确或性能达标；不解析语言符号/配置字段、不校验 Markdown 标题锚点或联网检查链接。Markdown 检查支持常见内联/引用式路径，复杂 HTML/自定义扩展需用项目自己的文档工具。

CI 中可以使用这些脚本作底线，再配合项目测试、审阅权限和保护分支。修改 `.doc-driven.json`、确认记录或检查脚本本身也需要正常代码审阅；这里没有隐藏的防篡改审批平台。

核心 Markdown 流程不依赖 Node.js。环境不能运行工具时，执行实际可做的阅读与文档工作，并在交付中说明未执行的机械检查，不伪造通过。

## 7. 包内资料

[SKILL.md](SKILL.md) 是模型入口；[REFERENCE.md](REFERENCE.md) 是字段与核对规则；[ADOPTION.md](ADOPTION.md) 是两种接管流程；[FORMATS/](FORMATS/) 是按需模板；[examples/scenarios.md](examples/scenarios.md) 展示具体文档及评估场景；[scripts/](scripts/) 是本地工具；[tests/run.mjs](tests/run.mjs) 是隔离测试。

[INSTALL.md](INSTALL.md) 说明安全安装、升级、卸载和两层生效检查；[CHANGELOG.md](CHANGELOG.md) 列出删减、迁移和机制变化；[TESTING.md](TESTING.md) 记录本次实际验证及未验证范围；[LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 保留原始许可与归属。

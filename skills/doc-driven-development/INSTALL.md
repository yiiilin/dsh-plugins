# 项目安装、升级、卸载与生效检查

适用版本：0.2.3。工具需要 Node.js 22+，只用标准库，不联网、不调用模型、不执行项目脚本。

## 0. 启用是一条完整路径，不是 init 加 install 两个选项

用户明确要求在项目采用文档驱动开发时，先只读检查，再完成项目安装，随后进入正常/渐进/全量工作。**不能只运行 init 或写出 `enabled: true` 就交付为“已启用”。**预览成功只说明计划可执行，不代表项目已接入。

`install.mjs` 是唯一推荐的启用/修复/升级入口。配置与索引准备是安装器内部步骤，没有公开的 config-only 初始化 API。旧 `init.mjs` 仅作为同一安装 CLI 的兼容别名：默认预览、`--apply` 完整安装、同样的参数和保护边界。旧脚本依赖其“运行就只写配置”的行为需要更新。

没有安装就从当前完整发行包运行 doctor/install，不要引用项目内尚不存在的路径。已有项目 ready 则无需重复安装。明确只在本次使用、不安装、不改规则或只读时，不写启用配置，不承诺下次生效。

用户已明确授权项目采用、预览未超出必要安装范围且无冲突时，agent 可以按已有授权继续 `--apply`；不要因“还需要一次安装请求”而停在预览。原规则冲突、超范围改动或宿主权限限制必须指出并遵守。项目安装不授权业务功能实现。

## 1. 安装到项目

先把完整发行包解压到项目之外的临时位置。**不要先将文件暴力覆盖进旧 skill 目录**；让新安装器检查旧文件、保留改动、生成备份。

以下为 POSIX shell 示例；Windows 可以将实际脚本路径直接传给 `node`。项目目录须已存在。

```sh
SKILL_DIR="/actual/path/doc-driven-development"
PROJECT="/actual/path/your-project"

# 默认只预览，不写任何文件。
node "$SKILL_DIR/scripts/install.mjs" "$PROJECT" --host both

# 阅读预览后，明确执行。
node "$SKILL_DIR/scripts/install.mjs" "$PROJECT" --host both --apply
```

也可以让正在运行的 agent 执行安装：

> 在当前项目启用这个发行包的 doc-driven-development。先读 INSTALL.md 并检查接入状态；未完整安装时预览路径，在本次授权内使用 install.mjs --apply 完整部署并核验，不停在 init 或预览。原规则或本地修改冲突时停止，不覆盖 AGENTS.md 或任何已有规范和设计正文。

`--host` 的取值：

| 值 | 实际写入的入口 |
|---|---|
| `agents` | 根 `AGENTS.md`；只代表采用 AGENTS 约定，不声称所有工具都读它 |
| `codex` | 有非空根 `AGENTS.override.md` 时选它，否则选根 `AGENTS.md`；不会自行创建 override |
| `claude` | 优先已有根 `CLAUDE.md`，否则已有 `.claude/CLAUDE.md`，否则新建根 `CLAUDE.md` |
| `both` | 接入 AGENTS、Codex 有效根入口及 Claude 入口，相同路径只写一次 |
| `auto`（默认） | 首次仅据仓库已有入口推断；没有线索时选 `agents` 并提示。已有安装则复用记录的入口，不代表识别了当前运行工具 |
| `custom` | 必须用 `--rules-file path/to/RULES.md` 指定宿主真实加载的 Markdown 入口；自动加载能力需自行验证 |

所有入口都只增加简短规则区块，明确读取同一份核心 skill，不复制多套工作协议。Claude 入口直接要求读取仓库内实际 `SKILL.md`，不假设 Claude 会原生发现 `.agents/skills`，也不自动导入其他整个项目规则文件。

默认把完整包放到 `.agents/skills/doc-driven-development/`。可通过 `--skill-dir` 选择 `.claude/skills/doc-driven-development`、`.dsh/skills/doc-driven-development` 或 `.codex/skills/doc-driven-development`；这只选择存放位置，不证明宿主原生发现。已安装后不静默迁移路径；先显式卸载再换位置。

初始化默认为渐进模式；首次可以添加 `--mode full`、`--docs-dir existing/design`、`--language zh-CN`。**已有 `.doc-driven.json` 逐字节保留，参数不会覆盖其目录或模式；已有 `enabled: false` 则拒绝激活。**先由开发者检查并显式修改配置，再重新安装。

## 2. 对现有文件的保护

示意：原来的规范不删除、不改写、不排序、不自动“优化”。

```markdown
# 原来的项目规则
保持项目原有的语言、测试、目录和安全规范。

<!-- doc-driven-development:begin -->
这里只放本 skill 的入口与最少工作约束。
<!-- doc-driven-development:end -->
```

**边界外原文逐字节保留。**支持有效 UTF-8（含 BOM）、中文、已有 CRLF、混合换行以及没有末尾换行的文件；仅增加必要分隔换行，新区块沿用原文件换行风格。不会重写整份规范来“合并”内容。普通文件权限保留；不承诺保留所有文件系统 ACL、扩展属性或特殊链接语义。

重复安装相同版本不会重复追加区块；无需改动时不写文件、不新建备份。升级只替换未被修改的本工具区块和已登记的发行文件。**区块被人修改、删除或边界损坏时停止，不用 `--force` 覆盖。**自定义项目规则请写在区块之外。

旧版手工添加、没有本版边界标记的规则保留并告警，不通过标题或关键词猜测它们可以删除。发现同名边界但内容不是本版生成内容，也拒绝接管。

索引仅添加/重建 `doc-driven:index` 区块，其余导航保留。已有业务设计正文、源码、`.gitignore`、CI、宿主设置和权限文件不由安装器修改。初始化不会创建伪装成已经分析过的架构或功能设计。

所有可计划检查先完成再写入。下列情况拒绝操作：符号链接或硬链接目标、只读待修改文件、越界路径、非普通文件、不可无损解码的文档、重复/嵌套/不成对的标记、未闭合代码围栏/HTML 注释/YAML 头，以及冲突的已有 skill 文件。Markdown 边界检查是保守子集，不能替代宿主实际渲染检查；拒绝时人工处理歧义，而不是删掉原文。

修改前完整旧文件和事务清单写入 `.doc-driven/backups/<批次>/`，安装归属和哈希写入 `.doc-driven/install.json`。备份使用独立文件名，不进入 skill 发现目录。备份可能包含原项目规范中的敏感信息，应留在本地；安装器不自动改你的 `.gitignore`，提交时不要把备份目录一起提交。

写入采用单文件临时文件替换、写前内容/身份检查和安装锁。能捕获的失败尝试回滚；若文件在此期间又被别人修改，保留该并发修改并报告回滚冲突。**多文件操作不是断电级事务，也不是对抗恶意并发文件系统操作的安全沙箱。**不要在同一时刻让其他进程改相同目标。

## 3. 升级已有安装

仍使用“新解压包里的安装器”对项目运行相同命令。已有安装用 `--host auto` 复用原入口；显式加宿主只增加入口，不静默删除另一个宿主的接入。

```sh
node "$SKILL_DIR/scripts/install.mjs" "$PROJECT"
node "$SKILL_DIR/scripts/install.mjs" "$PROJECT" --apply
```

对没有安装收据的 v0.2.0/v0.2.1/v0.2.2，发行包内包含原发行文件哈希：全部旧发行文件仍与原版一致时，可以直接迁移到 0.2.3。旧目录里额外的个人文件保留；它们与新版本文件重名时停止。修改过、缺文件或无法识别的旧包不会覆盖；先备份到宿主技能发现范围之外并人工对比。

本版配置格式与 v0.2.0/v0.2.1 相同，原来渐进/全量接管记录继续沿用。`.doc-driven/` 是新增加的安装元数据区域，不进入业务代码快照或全量阅读分母。

### 修复历史 config-only 半安装

`.doc-driven.json` 为 `enabled: true`、项目没有 skill 目录和入口区块时，不删除或重新生成配置。使用新解压 v0.2.3 的同一 `install` 命令预览和执行；它保留配置、原有 docs 及规则正文，仅补齐缺失的工具接入和索引区块。已有配置内的目录、语言、模式继续生效。

这个场景无需 `--force`、专用 repair 标志或再次初始化。已有安装收据但发行文件缺失/被人修改时，不等同于可安全覆盖的 config-only 状态；仍拒绝覆盖并要求核对。不要通过删除收据绕过保护。

新项目的新配置排在完整包、规则和收据之后写入；可捕获失败回滚。断电/强杀仍可能造成未完成事务，以残留锁和 doctor 为准，不把多文件安装描述成断电级原子事务。历史已有 true 配置保持原字节，不以切换开关掩盖未完成接入。

## 4. 静态生效检查：doctor

在项目根运行，路径按实际安装位置调整：

```sh
node .agents/skills/doc-driven-development/scripts/doctor.mjs .
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --json
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --strict
```

检查安装收据、发行版本/文件哈希、启用意愿、索引、规则区块和实际指向的入口；检测根 override 遮蔽，提示嵌套规则、过长入口、旧手工规则、本地宿主设置和 Git 忽略。不会改写规则以解决语义冲突，也不扫描全局用户或组织设置。

普通 `doctor` 退出 `0` 仅表示所选适配的静态检查通过；警告仍需阅读。明确选择 Codex/both 后发生根 override 遮蔽属于失败；仅选择通用 agents 时，该问题作为 Codex 兼容性警告，不假定用户一定在使用 Codex。`--strict` 将警告也作为失败。`enabled: false`、入口丢失、区块损坏、残留安装锁等不会作为“成功跳过”。

输出始终区分：

```text
Requested enabled: true (configuration intent only)
Project activation: ready
Static installation: passed
Agent runtime: not-run
```

`activation` 根据本次检查派生，不写回另一份配置：

| 值 | 含义 |
|---|---|
| `not-installed` | 没有启用配置/收据及识别到的项目接入，尚未安装 |
| `incomplete` | 配置、完整包、版本、收据、规则、索引或锁等有问题；包括历史 init-only 状态 |
| `disabled` | 明确关闭；保留该选择，不自动重新启用 |
| `ready` | 当前检查器版本的项目安装通过静态检查；不是实际模型加载证明 |

`incomplete`、`not-installed`、`disabled` 均退出 1，不会因配置为 true 报成功。JSON 提供 `requestedEnabled`、`activation` 和 `next`；安装预览还会输出 `setupComplete: false`，只有执行后核验 ready 才是 true。检查器发现项目仍是其他发行版本时要求用相应新包升级，不把旧技能当成已经含有本版修复。

它不调用 AI，所以不伪造“agent 已读过/以后一定遵守”。它检查的是安装与入口；业务文档/代码关系继续由 `check-doc-set.mjs` 和项目测试核对，不混为一个绿色状态。

## 5. 实际 agent 生效检查：新会话烟雾测试

安装完成后打开**新会话**；需要宿主重新加载项目时先重载。不要仅测试正在安装的旧会话，因为它已经从用户请求知道这个 skill，不能证明下一次会自动加载。

```sh
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --probe
```

命令只输出检查结果与一段通用只读探测请求。将标记之间的请求发送给新 agent；它不提前告诉模型 skill 名称和预期文件名，以避免把提示中的答案当成自动加载证据。审阅者应对照安装结果检查：

| 要观察的行为 | 通过的依据 |
|---|---|
| 默认接入 | 宿主实际上下文/日志显示适用项目规则被加载；不是只声称文件存在 |
| 读取工作协议 | 能看到 agent 按项目规则读取实际 skill 入口与正确文档索引 |
| 设计控制 | 重要行为变化先呈现设计与确认；不会擅自声称已获批准 |
| 不破坏原规范 | 同时保留、引用现有项目规范；遇到冲突指出，不覆盖 |
| 诚实交付 | 区分现状与认可；无法执行测试则明确未验证 |

只读探测本身不得修改业务代码或规则。应结合实际工具读取记录/宿主上下文查看，不能把模型自行列出的文件清单视为可靠证明。一次通过只支持该次会话/该宿主的观察，不保证其他模型、未来会话或所有子目录始终遵守。

可在现有测试/接管报告中记录日期、宿主与版本、工作目录、实际入口、可定位的会话/日志证据、结果及限制；没有运行则写 `not-run`。无需强制为每次开发创建新的验收表。doctor 不自动把这些人工记录升级为可信运行证明。

## 6. 安全卸载

```sh
node .agents/skills/doc-driven-development/scripts/uninstall.mjs .
node .agents/skills/doc-driven-development/scripts/uninstall.mjs . --apply

# 本地修改过 skill 时，只移除接入区块，保留整个 skill 目录。
node .agents/skills/doc-driven-development/scripts/uninstall.mjs . --keep-skill --apply
```

默认预览。正式卸载只移除未被手改的受管规则区块、仍匹配登记哈希的发行文件和安装收据；陌生/个人文件保留。首次创建的规则文件只有完全没有其他内容时才删除。原有规则无后续变化时恢复原始字节；边界外后来有个人改动则保留它们，宁可留下空行也不猜测删除。

**所有设计文档、配置和备份保留。**卸载不改 `.doc-driven.json` 的 `enabled`；若仍为 true，doctor 会将项目接入报为 incomplete，而不是 ready。用户级 skill/手工规则可能再次触发接入检查；彻底停用时由开发者显式将 `enabled` 改为 `false` 并检查手工入口。不要把卸载理解为清除项目设计资料。

## 7. 中断恢复与门禁

可捕获失败会回滚并报告备份。进程被强杀/断电时可能留下 `.doc-driven/install.lock`；doctor 明确报错。先确认没有仍在运行的安装进程，再读取锁指定的 `transaction.json`，对照每条操作的 `beforeSha256`、`afterSha256`、备份文件和当前文件。

只有当前内容仍等于该操作的预期 after 时，才能安全考虑恢复对应 before；出现其他哈希表示后来有变化，先人工合并。**不要把整份旧 AGENTS.md 直接拷回去覆盖新修改。**核对完再手工移除残留锁并重新预览。此版本不提供无检查的自动强制恢复命令。

安装器不自动创建 CI、Git hooks 或修改宿主权限。已有 CI 可以显式接入：

```sh
node .agents/skills/doc-driven-development/scripts/doctor.mjs .
node .agents/skills/doc-driven-development/scripts/check-doc-set.mjs . --base origin/main
```

`origin/main` 替换为实际基线。严格的 `--release` 用于已纳管的真实交付，不用于把旧项目所有 observed 文档强行改成 accepted。保护规则、配置、安装收据和检查脚本本身的审阅权限；本工具没有防篡改审批平台。CI 检查交付，不能保证 AI 从来没有提前写过代码。

退出码：安装/卸载预览或执行成功、doctor 静态通过为 `0`；doctor 检查不通过为 `1`；参数、冲突、配置或环境错误为 `2`。安装后的 doctor 失败可令 install 返回 `1`，表示文件已安装但入口问题尚未解决，不等于回滚成功；查看输出中的 `applied/result`。

## 8. 宿主适配依据与限制

以下官方文档在 2026-09-18 核对；适配规则与实际工具版本可能有差异，仍应执行新会话测试。

- [Agent Skills 宿主接入](https://agentskills.io/client-implementation/adding-skills-support)：技能格式不强制统一发现目录，本包使用显式入口而不假定所有宿主原生识别同一路径。
- [Codex 项目规则](https://developers.openai.com/codex/guides/agents-md/)：根目录及适用子目录规则、`AGENTS.override.md` 的选择和可配置的指令大小限制；doctor 的 32 KiB 提示是默认预算风险提示，不宣称读取了你的实际配置。
- [Claude Code 项目记忆](https://code.claude.com/docs/en/memory)：项目入口可为根 `CLAUDE.md` 或 `.claude/CLAUDE.md`，不同于原生读取 `AGENTS.md`。当前文档建议用 `/context` 查看实际 Memory files，`/memory` 用于浏览编辑。内容是行为指引，不是工具权限强制。

只有文件/规则适配与本地程序测试，不声称已在所有宿主和模型上完成真实运行验证。

## v0.2.2 文档布局：安装不是目录迁移

新配置默认 `layout: domain`，功能与模块分别位于文档根的 `domains/<domain>/features/`、`domains/<domain>/modules/`。`<domain>` 是实际领域目录，领域概览只在需要时置于其中的 README/architecture；安装不会创建未经分析的领域或空规格。

`--layout domain|preserve` 仅用于创建新配置。旧配置不覆盖，未含 layout 时按 preserve 读取；首次接入已有受管功能/模块文档时也默认 preserve 并提示。原始正文、目录、历史引用不会因升级而移动。迁移的路径映射、批准和引用核对要求见 [LAYOUT.md](LAYOUT.md)。

Doctor 的 layout 报告与 activation 分开。接入完整不意味着已有文档合乎新目录，安装器不会为让检查通过而搬迁设计。domain 策略下运行 check-doc-set 可拦截当前受管规格的错误落点；preserve 时仅报告差异。不得擅自放宽策略掩盖问题。

## v0.2.3 升级：同步行为入口，不重写设计正文

从项目之外运行新包 install 预览和 --apply，再 doctor。支持未改动 v0.2.2 的有收据升级和原发行包迁入；保留更早的已知版本兼容。更新受管区块中的主动讨论、三层文档与 ASCII 图要求，让后续会话不只沿用旧的“先写再审批”规则。

仍然只更新工具拥有且未被本地修改的区块与发行文件；AGENTS/CLAUDE 其余字节、已有配置和设计正文不改，不自动填 Design-Format 或移动文档。手工遗留的旧规则可能冲突时提示并保留，由开发者审阅；不能按关键词猜测删除。

升级不改变旧设计的批准状态。新建文档采用 layered-v1，旧文档在本次获准维护范围补齐；检查和迁移方式见 [DESIGN.md](DESIGN.md)。doctor --probe 现在还询问模糊目标/文档矛盾的处理及三类图分工，但脚本不实际调用模型，runtime 仍是 not-run。

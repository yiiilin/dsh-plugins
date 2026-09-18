# 项目安装、升级、卸载与生效检查

适用版本：0.2.1。工具需要 Node.js 22+，只用标准库，不联网、不调用模型、不执行项目脚本。

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

> 将这个发行包的 doc-driven-development 安装到当前项目，使用合适的宿主适配。先读 INSTALL.md 并运行安装预览，展示要改的路径；确认执行后使用 install.mjs --apply。保留已有规范、配置和设计文档，不手工重建 AGENTS.md，也不要用复制覆盖代替安装器。

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

对没有安装收据的 v0.2.0，发行包内包含原发行文件哈希：全部旧发行文件仍与原版一致时，可以直接迁移到 0.2.1。旧目录里额外的个人文件保留；它们与新版本文件重名时停止。修改过、缺文件或无法识别的旧包不会覆盖；先备份到宿主技能发现范围之外并人工对比。

本版配置格式与 v0.2.0 相同，原来渐进/全量接管记录继续沿用。`.doc-driven/` 是新增加的安装元数据区域，不进入业务代码快照或全量阅读分母。

## 4. 静态生效检查：doctor

在项目根运行，路径按实际安装位置调整：

```sh
node .agents/skills/doc-driven-development/scripts/doctor.mjs .
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --json
node .agents/skills/doc-driven-development/scripts/doctor.mjs . --strict
```

检查安装收据、发行文件哈希、显式启用、索引、规则区块和实际指向的入口；检测根 override 遮蔽，提示嵌套规则、过长入口、旧手工规则、本地宿主设置和 Git 忽略。不会改写规则以解决语义冲突，也不扫描全局用户或组织设置。

普通 `doctor` 退出 `0` 仅表示所选适配的静态检查通过；警告仍需阅读。明确选择 Codex/both 后发生根 override 遮蔽属于失败；仅选择通用 agents 时，该问题作为 Codex 兼容性警告，不假定用户一定在使用 Codex。`--strict` 将警告也作为失败。`enabled: false`、入口丢失、区块损坏、残留安装锁等不会作为“成功跳过”。

输出始终区分：

```text
Static installation: passed
Agent runtime: not-run
```

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

**所有设计文档、配置和备份保留。**卸载不改 `.doc-driven.json` 的 `enabled`，所以用户级 skill 或手工规则仍可能启用此工作流；彻底停用时由开发者显式将 `enabled` 改为 `false` 并检查手工入口。不要把卸载理解为清除项目设计资料。

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

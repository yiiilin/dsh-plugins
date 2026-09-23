# doc-driven-development 0.3.1

通过文档讨论重要设计，再把已授权方案落实到实际运行行为。文档面向人阅读，工具自动采证；减少重复说明和结果抄写，不减少验证覆盖、方法、真实性及原文保护。

## 1. 项目安装或升级

将完整新包解压到项目之外，**不要直接覆盖旧 skill 目录**。脚本需要 Node.js 22 或更新版本，无第三方包、API 密钥或联网要求；具体宿主入口见 [INSTALL.md](INSTALL.md)。

```sh
NEW_SKILL="/实际新包位置/doc-driven-development"
PROJECT="/实际项目位置"

node "$NEW_SKILL/scripts/check.mjs" --no-tests
# 首次采用用 install；已有项目用 upgrade。默认只预览。
node "$NEW_SKILL/scripts/install.mjs" "$PROJECT"
node "$NEW_SKILL/scripts/install.mjs" "$PROJECT" --apply
# 升级时改为：
# node "$NEW_SKILL/scripts/upgrade.mjs" "$PROJECT"
# node "$NEW_SKILL/scripts/upgrade.mjs" "$PROJECT" --apply
node "$NEW_SKILL/scripts/doctor.mjs" "$PROJECT" --json
```

默认根据已有规则选择入口，必要时显式指定 `--host agents|codex|claude|both|custom`（auto 为默认）。已有规范只追加/更新受管区块，区块外逐字节保留；不覆盖配置、业务代码和设计正文。手改本工具区块/发行文件时停止，没有 force。重复执行不重复追加，修改前备份。卸载用 `uninstall.mjs` 预览/apply，保留项目设计、配置和个人内容。

`enabled: true` 只是启用意愿。doctor 的 `activation: ready` 表示静态接入齐全，`runtime: not-run` 表示尚未验证真实会话加载；用 `doctor --probe` 在新会话核对。缺包或规则时对原项目运行完整 install，不删除配置。旧 init 仅转发完整安装，不能单独生成启用状态。明确临时/只读使用时不安装。

升级的 agent 先读新包 [UPGRADE.md](UPGRADE.md)，在已有升级授权和无冲突范围内继续 apply，然后重读项目实际新入口。升级不会运行项目测试，也不迁移文档、改批准、重绑旧证据。

## 2. 日常只走一条主线

```text
[当前目标与事实] -> [必要讨论并即时记录] -> [已授权实现/接线]
                                                 |
                                                 v
[可用结果及限制] <- [文码双向核对] <- [实际验证与运行记录]
```

正常开发可直接说：“实现这个功能，先查当前文档与代码，有重要选择带场景和推荐讨论；已经确认的继续做，决定及时保存，最终验证实际入口。”明确只讨论时加“先不改业务代码”。无需每次重复整份 skill。

已有项目可以选择：

- **渐进接管：**先恢复本次功能及必要上下游的实际需求/设计，再维护；无关未知不阻断本次工作。
- **全量恢复：**完成约定整库范围，分批保存实际阅读进度、代码快照、事实/推断/未知；不是扫描过就算读过，不悄悄缩小目标。细则见 [ADOPTION.md](ADOPTION.md)。

需求说明、概要设计、详细设计是当前规格的阅读骨架，不是每次修改都重新提交三份作业。沿已确认契约修 BUG，不重审原需求或重画未变流程；本次回归、异常、边界和真实路径验证仍须完成。共同设计见 [DESIGN.md](DESIGN.md)，实施见 [EXECUTION.md](EXECUTION.md)。

## 3. 运行事实保存一次

先按 [VERIFICATION.md](VERIFICATION.md) 从验收场景建立 [执行计划](FORMATS/verification-plan.md)，不得靠减少必测或放宽断言精简流程。以下命令在项目根执行，SKILL_DIR 指向实际已安装包：

```sh
SKILL_DIR=".agents/skills/doc-driven-development"
# 预览，不执行。
node "$SKILL_DIR/scripts/verify.mjs" . --plan docs/changes/task.verify.json --json
# 读取真实命令/环境，并在已有授权内执行预览中的 planHash。
node "$SKILL_DIR/scripts/verify.mjs" . --plan docs/changes/task.verify.json --run --expect-plan <planHash>
# 只读显示自然名称、场景、限制及一行固定运行记录引用。
node "$SKILL_DIR/scripts/verify.mjs" . --report <实际run.json路径> --summary
# REF 是真实 Git 比较基线；先完成实现、实际验证和核对。
node "$SKILL_DIR/scripts/check-doc-set.mjs" . --base REF --design --release
```

新 runner 规格头保存 `Verification-Format: runner-v1`、实际 `Verification-Plan` 和 `Verification-Receipt: 路径#SHA256`；文档原有确认、实现、验证状态分别维护。运行器已含计数/方法/版本/产物，不再复制完整 E。历史 `--evidence` 与 E 引用仍兼容；实际设计评审或人工结果不是执行记录，继续独立记录。

只把摘要输出中的引用行放在文档头；人读的摘要直接显示或链接运行记录，不把每次运行报告贴进契约正文。详细结果核对仍包含规格、计划、代码、测试/配置输入、工具、命名必测及原始输出。简单记录去重不改变失效规则；未声明依赖或真实业务覆盖完整性仍需审阅。

跨模块/正式入口接线/多 agent 的 [交付单元](FORMATS/delivery.md) 只需引用 `runs`：从记录推导执行覆盖与最终基线，不要求重复 E 和 codeBaseline。若旧字段仍提供，照常核对矛盾，不能拿摘要或手填 passed 绕过运行验证。旧版 v0.3.0 工具不认识新单行路径，须先升级再使用。

## 4. 找到资料，而不是全部加载

| 任务 | 文档与工具 |
|---|---|
| 入口、路由与边界 | [SKILL.md](SKILL.md) |
| 讨论、图示、定稿/评审 | [DESIGN.md](DESIGN.md)、[COMMUNICATION.md](COMMUNICATION.md)、[功能模板](FORMATS/feature.md)、[模块模板](FORMATS/module.md) |
| 配置、字段、旧 E、代码优先 | [REFERENCE.md](REFERENCE.md)、[CONTEXT.md](CONTEXT.md)；context、index、check-doc-set |
| 领域归属与安全迁移 | [LAYOUT.md](LAYOUT.md)；默认 docs/domains/<domain>/features/ 与同领域 modules/ |
| 接管与进度 | [ADOPTION.md](ADOPTION.md)；inventory、check-doc-set --progress … --full |
| 实施、集成、委托 | [EXECUTION.md](EXECUTION.md)、[ORCHESTRATION.md](ORCHESTRATION.md)；delivery |
| 实际验证与 CI | [VERIFICATION.md](VERIFICATION.md)、[CI 示例](examples/verification-ci.md)；verify |
| 安装、检查、升级 | [INSTALL.md](INSTALL.md)、[UPGRADE.md](UPGRADE.md)；install、doctor、upgrade、uninstall |

只有维护 skill 本身才默认读取 [EVALUATION.md](EVALUATION.md)、[ENGINEERING.md](ENGINEERING.md)、[TESTING.md](TESTING.md) 和测试目录。测试与评测材料不删除，只退出日常阅读路径；fixtures 不能冒充真实 agent 效果。全部命令支持 `--help`。工具缺失时说明未执行，不能伪造结果。

## 5. 配置与兼容

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

schemaVersion/enabled 必填。旧配置没有 layout 时按 preserve 读取，不写回；新接入按实际已有受管文档选择 domain/preserve，见 LAYOUT。docsRoots 只能表示实际文档区域，不能拿它隐藏源码分析范围。glob 支持 `*`、`?`、`**`，不支持复杂扩展；源码指针 optional 只核已有指针，off 关闭，不强加注释。

盘点排除版本库、依赖、构建、已安装 skill、潜在密钥文件，Git 下遵循忽略规则；无 Git 不假称解析 .gitignore。超过 2 MiB 或二进制文件不标文本已读；符号链接、子模块和其他排除项明确披露，需另行纳入子范围。普通 Markdown 与文档目录不进入代码阅读分母，但仍按任务阅读。文件名过滤不是全面脱敏，验证显式输入的范围及资源权限见 VERIFICATION。

普通检查允许旧区域未补齐；`--base` 限定本次实质改动，`--design` 不自动修改正文，`--review` 只核真实评审记录。只记录现状不跑 release。退出码通常为 0 所选检查通过、1 不满足、2 调用/配置错误；disabled/未执行不能作为验证成功。

## 6. 边界与发行资料

本地自动采证不提供防恶意篡改、沙箱、真实批准认证或语义完整性保证。组件绿不能替代实际入口，人工验收不能靠命令自动批准。高风险交付仍需受保护 CI 与对测试/验收修改的审阅。安装不自动开 CI、调用模型或批量重写旧文档。

历史变动只放 [CHANGELOG.md](CHANGELOG.md)；实际测试与未验证范围只放 [TESTING.md](TESTING.md)。许可和来源保留在 [LICENSE](LICENSE)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

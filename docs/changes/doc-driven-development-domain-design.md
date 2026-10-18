# 文档驱动开发：精简布局与领域模块设计

Doc-ID: CHANGE-DOC-DRIVEN-DOMAIN-DESIGN
Type: change
Revision: 2
Status: accepted
Baseline: unknown
Owns: —
Affects: .agents/skills/doc-driven-development/**
Implementation: complete
Verification: partial
Approval: 本轮用户明确认可此前简化建议，并要求 skill 提供 example 供 AI 参考；授权修改本仓库 skill 源码，不包含部署、提交、发布或现有项目文档迁移。
Approved revision: 2

## 为什么改

现有 v0.3.1 能记录实现、验证与批准，但缺少具体模块划分依据和持续维护示例。用户反馈产物耦合较高；尚未审计代表性业务产物，不能认定文档布局是耦合根因。

## 决定与继续入口

### 统一布局与格式
<!-- ddd:item D-DOC-DESIGN-001 -->

沿用根 docs 下的 domains/<domain>/features 与 modules。人和 AI 共用可读正文，代码归属和可重建索引用于定位。领域是稳定责任分区，不凭目录认定限界上下文。保留 feature/module 三层阅读骨架及 runner-v1；旧配置与正文不自动迁移。

### 最小文档与腐化处理
<!-- ddd:item D-DOC-DESIGN-002 -->

用户确认来源：“你这几点我都认可，而且，skill本身也需要提供example供AI参考”。

- 项目 README 合并薄系统概览；领域 README 合并职责、关键概念和模块关系。单领域小项目可以只用项目概览。
- 复杂模块或长期独立功能才创建独立契约，薄架构与词表按需提取；不生成空文件套装。
- 文档负责稳定职责、业务不变量、写入权限和外部行为；准确类型/schema由源定义维护，测试与实际验证记录分别保存。
- 业务行为、状态所有权、公开入口或依赖方向变化触发对应契约更新；内部重构通常不改语义正文，但修复路径/归属并重新核对证据。
- 发现偏差后修复实现、按真实决定修订契约，或记录具体待核实项；不能用代码自动覆盖已认可规则。
- 增加完整可读及可运行示例，展示模块设计、局部变更和偏差反例。示例检查不冒充真实项目验收或真实 agent 效果。

三轮 Mentor 咨询已完成，建议基于提供的源码事实，不能代替行为验证。本次实施复用用户认可的范围，不重新请求同一批准。

## 方案与代价

局部修改现有入口、布局、设计/执行/维护规则、模板及必要的安装默认导航；复用既有格式、检查器和验证机制。增加示例及必要回归，不引入新依赖或通用架构平台。不增加版本、不安装到用户技能目录或线上 profile。

## 验收与兼容

修改前完整 skill 自检实际通过：602 项测试，0 失败、0 跳过。后续检查包清单哈希、链接、语法、安装原文保护及新增示例正反例，并运行根项目 build/check/test。新规则必须兼容 layered-v1、现有 managed index、唯一代码归属与保守证据失效；真实 agent 长期耦合改善仍未评测。

## 合入结果

已落实统一精简布局（现 [FORMATS.md 第 4 节](../../.agents/skills/doc-driven-development/FORMATS.md#4-文档落点与布局)）、模块划分依据（现 [WORKFLOW.md](../../.agents/skills/doc-driven-development/WORKFLOW.md)）、事实归属/更新触发/腐化处理（现 [FORMATS.md](../../.agents/skills/doc-driven-development/FORMATS.md) 与 [WORKFLOW.md](../../.agents/skills/doc-driven-development/WORKFLOW.md)）和模块/功能/架构模板；同步执行/接管/安装入口。默认索引由同一正文来源生成，保留人工区与受管块。

> 本条目写于 v0.3.1 之后、v0.4.0/v0.5.0 之前：当时被引用的是 `LAYOUT.md`、`DESIGN.md`、`REFERENCE.md` 三篇独立文档。v0.5.0 把 35 篇合并为 12 个文件，上述正文已并入 FORMATS.md 与 WORKFLOW.md，原路径不再存在；此处链接已改指合并后的落点，正文未改。

新增 AI 可读示例（现 [examples/feature.md](../../.agents/skills/doc-driven-development/examples/feature.md)）与八项行为回归，默认 check 已纳入。实际完整 skill 自检 612 通过；根项目 build/check 与 271 项测试通过，均无失败或跳过。独立只读复核报告本范围无阻塞。

> 同一说明：原 `examples/module-boundaries.md` 与配套的可运行示例 `examples/module-boundaries.mjs` 已随 v0.4.0「skill 不再附带任何脚本」一并删除，八项回归与默认 check 同批移除。上段的测试数字是当时的事实，不是当前可复现的命令，保留以如实记录当时证据。

[验证记录](../../.agents/skills/doc-driven-development/README.md#5-验证-skill-自身) 保存命令、结果与限制。Verification 为 partial：本次源码/示例回归已完成，尚未进行正式项目 runner 验收或真实 agent 长期效果试点；不据此宣称业务耦合已降低。没有部署、迁移现有正文、提交或发布。

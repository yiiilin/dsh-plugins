# 工程依据、裁剪与未验证假设

本版将下列公开的一手材料用于流程设计，核对日期为 2026-09-22。只借用适用思想，不声称符合 NASA、ISO 或任何认证，也不承诺这个 skill 已获得这些机构验证。软件工程的落实方式是小批量、可追溯设计与分层验证，不是加大量管理文档。

| 参考 | 采用的机制 | 本 skill 的裁剪与限制 |
|---|---|---|
| [NASA：系统设计过程](https://www.nasa.gov/reference/4-0-system-design-processes/) | 明确使用场景、期望来源、双向追踪；开发者真实承诺对应明确范围 | 以自然名称讨论、内部稳定 ID 追踪；不复制航天项目审批层级 |
| [NASA：产品实现、集成、验证与确认](https://www.nasa.gov/reference/5-0-product-realization/) | 集成是独立的工程活动；组件满足规格不等于系统在目标场景满足使用者需求 | 三层设计对接组件/集成/场景验收；把入口/消费者接线纳入完成条件，在隔离环境验证，不擅动生产 |
| [DORA：小批量工作](https://dora.dev/capabilities/working-in-small-batches/) | 小且可测试的变更加快反馈，避免大批积累到最后才集成 | 以一个可观察行为切片，不按文档篇数/函数数量汇报；不机械要求任何固定时间尺度 |
| [Google：代码评审看什么](https://google.github.io/eng-practices/review/reviewer/looking-for.html) | 关注设计、功能、适当测试及过度工程；测试需要能在实现损坏时失败 | 定向只读评审、主 agent 查证；按风险做反例，不要求凑问题数量 |
| [Anthropic：构建有效 agent](https://www.anthropic.com/engineering/building-effective-agents) | 简单可组合工作流、主持者/执行者、明确评价标准的反馈 | 宿主无关角色协议；不强加模型 SDK，不把角色文字当运行过的子 agent |
| [Anthropic：多 agent 研究系统](https://www.anthropic.com/engineering/multi-agent-research-system) | 明确委托、持久化产物和成本权衡；紧耦合任务不一定适合并行 | 两种可选主持模式、单写入者、有限并行/返工；该报告的研究任务 token 数据不是软件开发省钱保证 |
| [Anthropic：上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 当前相关上下文、外部笔记、隔离职责 | 复用已有提案即时记录；子 agent 回读具体版本，不让摘要覆盖原文 |
| [Docker：清理未使用对象](https://docs.docker.com/engine/manage-resources/pruning/) | 删除数据需要谨慎，卷不因匿名就无价值 | 资源有所有权/授权边界；不自动执行全局 prune 或猜测匿名卷可以删除 |

说明：这些实践为改造提供依据，不证明本版已经减少真实项目成本或错误。若使用特定宿主/模型的最新能力，需要另查其官方文档；本版不硬编码价格、模型排名或虚构支持的子 agent API。

## 真正需要观察的效果

除了脚本回归，应在真实 agent 上检查：已批准的实施是否不再重复问；已授权要求漏项率；使用者是否能复述讨论方案；真实入口是否跑通；必测跳过是否被如实报告；升级是否保留原文并重读新入口；不同分工总成本/返工是否下降。场景在 [examples/evaluation.md](examples/evaluation.md)。

自动测试只能证明解析/保护/版本/覆盖检查等确定性行为。图是否正确、来源是否真实、子 agent 是否理解边界、报告是否易读，需要实际行为评估；不能用增加测试数量代替它。没有可用模型执行环境时明确这些测试未运行。

## v0.3 增补

[VERIFICATION.md](VERIFICATION.md) 将可判定事实交给执行器：实际命令、结构化用例、环境缺口与版本；[EVALUATION.md](EVALUATION.md) 将 skill 行为交给隔离多轮任务与实际宿主评测。不要把本地采证称为不可篡改证明，也不要把工具自测数量当作真实开发质量或成本改善。

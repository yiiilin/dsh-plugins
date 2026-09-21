# 功能文档模板

落点：`<docsRoot>/domains/<domain>/features/<feature>.md`，归属见 [LAYOUT.md](../LAYOUT.md)。先按 [DESIGN.md](../DESIGN.md) 主动调查、讨论并画草图，再整理结论；不要只填模板后让人批准。

**摘要和三层 H2 骨架保留**；小节按适用性调整。已有正文局部补齐，不整篇覆盖。新功能 proposed，逆向 observed；所有占位、路径、原因都必须替换为实际内容。完整填写形态见 [假设示例](../examples/import-design.md)。

````markdown
# 功能名称

Doc-ID: FEAT-EXAMPLE
Type: feature
Revision: 1
Status: proposed
Baseline: unknown
Owns: src/example/**
Implementation: missing
Verification: not-run
Evidence-Format: bound-v1
Design-Format: layered-v1

## 摘要
目标、整体方案、文档覆盖边界。这是候选设计还是观察记录？
本次关键结论、需人裁决的问题及影响；未知不伪装成事实。

## 1. 需求说明
<!-- ddd:section requirements -->

### 1.1 使用者、目标与范围
需求来源、前提、参与方、明确不做的事。推断意图标来源和未知。

### R-EXAMPLE-001 可观察行为
前提、输入、结果，以及失败/重复/边界等实际相关行为。
不得提前夹带尚未讨论的技术方案。

### 1.3 其他业务规则与质量约束
与本次有关的权限、兼容性、性能或资源要求；无数值来源不编造。

### 1.4 验收条件
逐项列出可判断的“场景/输入/期望结果”，关联上面的要求。
测试计划不是测试已通过，实际结果在最后单列。

## 2. 概要设计
<!-- ddd:section overview -->

### 2.1 职责、边界和协作
模块各做什么、不做什么、依赖谁、状态/数据由谁拥有。
引用全局架构和共享模块；理由未知时不要编造历史决定。

### 2.2 端到端处理流程
<!-- ddd:diagram flow -->
```text
[请求] --满足前提--> [关键处理] --完成--> [结果]
   |
   +--不满足前提--> [拒绝及原因]
```
以上仅示意。改为实际正常和重要失败路径，解释条件、调用边界。

### 2.3 数据流与归属
<!-- ddd:diagram data -->
```text
[调用方] --输入数据--> [处理器] --结果数据--> [结果接收方]
```
替换为实际数据名、转换、存储、查询与清理关系；解释可见性。

### 2.4 关键方案与取舍
已讨论的选择、理由、代价和依赖；候选与已确认结论明确分开。

## 3. 详细设计
<!-- ddd:section detail -->

### 3.1 接口与数据契约
入口/协议、输入输出、字段含义、校验规则、错误语义及兼容边界。

### 3.2 业务状态流转
<!-- ddd:diagram state pending: 请先调查对象生命周期；绘制真实状态，确为无状态时改为带具体理由的 not-applicable。 -->
说明哪个对象的状态、存储位置、谁能修改；转换事件、守卫条件和副作用。
复杂时附转换表；这是业务状态，不是文档审批状态。

### C-EXAMPLE-001 关键处理与不变量
沿正常/失败路径写关键步骤、前后置条件及必须始终成立的规则。
按适用性展开事务、锁、重试、幂等、取消、清理与恢复。
图中每个重要转换都应能找到实现依据或明确的设计机制。

### 3.4 实现自由和待决问题
哪些局部组织可以自主？哪些选择还需讨论/实验？阻塞哪部分？
D-EXAMPLE-001：具体场景、选项、推荐、理由、代价、影响、确认来源。
没有真实选择时删掉这个 D 示例，不制造选项或重复确认。

## 4. 实现与验证

| 要求/约束 | 实现入口 | 证据 |
|---|---|---|
| R-EXAMPLE-001 | 实际路径与符号 | E-EXAMPLE-001 |
| C-EXAMPLE-001 | 实际接口或配置 | E-EXAMPLE-001 |

### E-EXAMPLE-001 核对记录
Covers: R-EXAMPLE-001, C-EXAMPLE-001
Kind: verification
Spec-Refs: unknown
Environment: unknown
Method: 待替换为实际测试命令、人工步骤或测量方法
Result: not-run
Baseline: unknown
Detail: 尚未执行，不宣称通过。

## 5. 偏差、未知和继续入口
已观察到的冲突、疑似问题、尚未完成的阅读/实验、讨论下一步。
````

pending 是真实草稿缺口，不能原样作为完成设计；定稿前沿图走查并运行定稿检查。无状态说明依据，复用图用 ref。获批后补真实 Approval/Approved revision；实现、验证分别更新。字段见 [REFERENCE.md](../REFERENCE.md)。

每轮明确决定立即小范围记入当前提案/草稿，不等定稿。实施前真实评审并按 [REFERENCE.md](../REFERENCE.md) 保存 `Kind: design-review` 的 E 记录；这不是批准或测试。新通过证据须绑定真实规格修订/指纹与代码基线，并说明环境；上下文刷新见 [CONTEXT.md](../CONTEXT.md)。不要让旧 passed 自动沿用新正文。

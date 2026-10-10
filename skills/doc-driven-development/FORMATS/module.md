# 模块文档模板

落点：`<docsRoot>/domains/<domain>/modules/<module>.md`。模块拥有完整能力与明确契约，即使仅一个调用方也可独立；简单局部规则留在所属功能或模块表，独立状态、不变量或复杂契约值得单独阅读时才建文件。划分先按 [DESIGN.md](../DESIGN.md)，完整写法见 [模块与维护示例](../examples/module-boundaries.md)。

保留三层，第一层引用上层目标并定义本模块约束；不复制需求、精确字段或私有函数清单。Owns 只认领自身源码，不与使用它的功能重复；状态写入权在正文说明。

````markdown
# 模块名称

Doc-ID: MOD-EXAMPLE
Type: module
Revision: 1
Status: observed
Baseline: unknown
Owns: src/example/**
Implementation: unknown
Verification: not-run
Verification-Format: runner-v1
Verification-Plan: pending
Design-Format: layered-v1

## 摘要
模块提供的能力、调用方、不承担的职责；现状恢复或候选设计。

## 1. 需求与模块约束
<!-- ddd:section requirements -->

### 1.1 目标与划分理由
链接上层需求，说明共同变化的规则与应保持局部的变化；不重新定义已有 R。

### 模块契约
<!-- ddd:item C-MODULE-001 -->
调用前提、公开结果与关键失败语义；本模块统一保证的不变量。

### 1.3 验收条件
通过公开入口可观察的正常、失败和相关边界场景，引用上层标准。

## 2. 概要设计
<!-- ddd:section overview -->

### 2.1 职责、状态所有权与依赖
说明哪些状态只能由本模块修改，调用方如何请求变更。
列公开入口、允许依赖及其契约、禁止访问的私有实现；依赖规则的检查位置。
用一次规则或存储变化解释应影响哪些模块，不按目录推断责任。

### 2.2 处理流程
<!-- ddd:diagram flow -->
```text
[公开调用] --符合前提--> [执行规则] --成功--> [返回结果]
```
替换为真实正常与失败路径；解释关键条件和异常去向。

### 2.3 数据流
<!-- ddd:diagram data -->
```text
[调用方] --输入--> [模块] --结果快照--> [调用方]
```
解释权威状态、修改入口与可见性；存储或内部对象如何被隐藏。

## 3. 详细设计
<!-- ddd:section detail -->

### 3.1 公开契约与源定义
操作、前后置条件、结果与错误的业务含义；准确类型/schema链接其源定义。
调用方无需知道私有对象或内部写入顺序。

### 3.2 状态转换
<!-- ddd:diagram state pending: 需调查本模块拥有的状态，或明确说明为何不存在持久或跨调用状态。 -->
写清对象、修改者、守卫、非法转换与副作用。

### 3.3 关键机制
解释 C-MODULE-001 如何成立；只展开相关事务、并发、算法、恢复和 I/O 分工。

### 3.4 实现自由与待核实项
保持契约的内部变化可自主；未知或文码偏差写具体行为、影响及调查入口。

## 4. 实现与验证

| 契约 | 实现/源定义入口 | 验证来源 |
|---|---|---|
| 模块契约 | 公开入口与实际调用方 | 文档头的 Verification-Receipt |
| 依赖约束 | 项目已有可执行规则 | 对应实际检查 |

未运行保持 not-run；真实 runner 完成后在头部引用实际记录。
设计评审和人工验收独立；依赖检查不代替行为验收。
````

每类图沿真实正常/失败场景核对，允许解释性 ref 或具体 not-applicable，未知保持 pending。更新触发与腐化处理见 [REFERENCE.md](../REFERENCE.md)，采证及失效见 [VERIFICATION.md](../VERIFICATION.md)。不复制动态结果，不为内部重构重写未变契约。

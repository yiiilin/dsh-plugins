# 共享模块文档模板

落点：`<docsRoot>/domains/<domain>/modules/<module>.md`，按主要责任领域归属；跨领域通过引用。仅在稳定共享契约或复杂机制有独立阅读价值时创建，不按篇幅随意拆文档。

保留三层：第一层说明上层需求来源与模块约束，不复制上层需求；概要解释协作，详细说明具体机制。先使用 [DESIGN.md](../DESIGN.md) 讨论隐含假设。下面的候选图/占位必须替换。

````markdown
# 模块名称

Doc-ID: MOD-EXAMPLE
Type: module
Revision: 1
Status: observed
Baseline: unknown
Owns: src/shared/example/**
Implementation: unknown
Verification: not-run
Evidence-Format: bound-v1
Design-Format: layered-v1

## 摘要
模块目的、调用方、不承担的职责；这是现状恢复还是待确认设计。

## 1. 需求与模块约束
<!-- ddd:section requirements -->

### 1.1 上层需求与边界
链接功能需求，解释本模块承担哪部分，不重新定义已有 R 条目。

### C-MODULE-001 模块契约
调用前提、可观察结果、错误语义、兼容性或本模块不变量。
观察到的行为与上层期望有冲突时分开记录并主动讨论。

### 1.3 验收条件
调用方可核对的输入/结果/异常场景，引用上层标准而不重复存一份。

## 2. 概要设计
<!-- ddd:section overview -->

### 2.1 内部职责与依赖
组件、接口边界、状态所有者和引用的其他模块。

### 2.2 处理流程
<!-- ddd:diagram flow -->
```text
[调用] --符合契约--> [模块处理] --结束--> [返回]
```
展开真实失败分支，说明是否同步、异步及异常如何传播。

### 2.3 数据流
<!-- ddd:diagram data -->
```text
[调用方] --输入对象--> [模块] --输出对象--> [调用方]
```
实际字段/数据名、内部存储、写读可见性、资源生命周期。

## 3. 详细设计
<!-- ddd:section detail -->

### 3.1 接口和数据结构
输入输出、字段含义、校验和错误类型；不机械罗列私有函数。

### 3.2 状态转换
<!-- ddd:diagram state pending: 需调查本模块负责的持久或跨调用状态，或明确说明为何不存在此类状态。 -->
写清对象、修改者、事件、守卫条件、合法/非法转换与副作用。

### 3.3 关键实现机制
解释 C-MODULE-001 如何在关键路径上保持；按适用性说明算法、事务、并发、重试、幂等、失败恢复和清理。

### 3.4 可自主部分与待决事项
局部实现自由、需人裁决的技术取舍、未知假设及影响。

## 4. 实现与验证
C-MODULE-001 对应的实际实现路径/符号和 E-MODULE-001。

### E-MODULE-001 核对记录
Covers: C-MODULE-001
Kind: verification
Spec-Refs: unknown
Environment: unknown
Method: 待填写实际方法
Result: not-run
Baseline: unknown
Detail: 未执行。
````

原文局部补齐，不整篇重建；独立图按 ref 复用，不能复制形成两个主契约。定稿检查只核结构，模块行为仍需真实审阅与测试。

每轮明确决定立即小范围记入当前提案/草稿，不等定稿。实施前真实评审并按 [REFERENCE.md](../REFERENCE.md) 保存 `Kind: design-review` 的 E 记录；这不是批准或测试。新通过证据须绑定真实规格修订/指纹与代码基线，并说明环境；上下文刷新见 [CONTEXT.md](../CONTEXT.md)。不要让旧 passed 自动沿用新正文。

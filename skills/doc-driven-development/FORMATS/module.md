# 共享模块 / 关键详细设计模板

默认落点：`<docsRoot>/domains/<domain>/modules/<module>.md`，领域是主要责任归属；被跨域调用不等于应散放文档根 modules。遵循 [布局规则](../LAYOUT.md)，已有位置先映射。

仅在模块具有稳定共享契约，或复杂机制值得独立阅读时创建。不因功能文档行数到某个阈值就随意切断设计。

```markdown
# 模块名称

Doc-ID: MOD-EXAMPLE
Type: module
Revision: 1
Status: observed
Baseline: unknown
Owns: src/shared/example/**
Implementation: unknown
Verification: not-run

## 摘要与调用方
模块职责、不承担的职责、谁使用它，链接到上层功能。

## 1. 对外契约
输入、输出、错误、兼容性、配置字段或事件名。

## 2. 内部概要
主要组件、依赖、状态所有权和运行流程。

## 3. 必须统一的详细约束

### C-MODULE-001 关键规则
前后置条件、不变量，以及适用的算法/状态转换/锁/事务/重试/清理。
复杂时写伪代码；不复刻每个函数。

## 4. 实现自由与未知
可以等价替换的内部细节；未确认假设及其影响。

## 5. 实现与验证
C-MODULE-001 对应的实现路径、符号与 E-MODULE-001。

### E-MODULE-001 核对记录
Covers: C-MODULE-001
Method: 待填写实际方法
Result: not-run
Baseline: unknown
Detail: 未执行。
```

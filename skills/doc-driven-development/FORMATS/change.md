# 短变更提案模板

这是本次确认单位，不是永久当前规格。已有生效文档保持可读，提案只写差异。一个变更可涉及多篇当前文档；相互依赖的变化一起确认，不强按包拆分。

```markdown
# 本次变更标题

Doc-ID: CHANGE-EXAMPLE-001
Type: change
Revision: 1
Status: proposed
Baseline: unknown
Owns: —
Targets: docs/domains/example-domain/features/example.md@1
Affects: src/example/**
Implementation: missing
Verification: not-run
Approval: none

## 为什么改
问题、目标与明确不做的事。

## 契约差异
指出原有 R-/C- 条目以及将变成什么，不复制整篇现有文档。

## 方案与代价
主要流程、关键细节、真实取舍及风险。
已有授权覆盖什么、还需确认什么；高风险选择逐项明确。

## 验收与回退
受影响测试/测量、兼容或迁移检查、回退边界。

## 合入结果
尚未实现。完成后链接当前文档的新修订与实际证据。
```

新建目标用 `@new`，并明确计划的路径。`Targets` 中的修订号锁定评审基线；目标变更后应重新对比，不能悄悄覆盖。

确认后在本提案记录 `Approval` 与 `Approved revision`。实现及核对后更新当前文档，保留真实批准来源；本提案标 `superseded`，用 `Superseded by` 指向当前文档，并在正文列出全部合入结果。不要让当前文档只能靠读一串历史提案才能理解。

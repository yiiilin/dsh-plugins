---
name: feature-upgrade
description: 功能升级：已有代码要改形状或加能力时，先扫加深机会再 grill，动代码前先预重构。不用于从零做新东西（用 /new-feature），也不用于排查故障（用 /bug-fix）。
disable-model-invocation: true
---

# 功能升级

起点不是想法，是已有代码。差别在这里：新功能问「要做成什么样」，升级先问「现有结构撑不撑得住」。

**记号**：`/x` 是只能你亲手敲的 skill；不带斜杠的 `x` 模型会自己调用。

**先读原文。** 走到哪一步，就加载那一步的 skill（或直接读它的 `SKILL.md`），照它执行，不要凭摘要复述。

## 路线

1. **定范围** —— 让你运行 `/improve-codebase-architecture`。它按提交历史找热区、出 HTML 报告、给出加深机会，你从中挑一个。
   *完成判据*：选定一个候选；用户已指明方向时直接用那个方向，跳过推断。
   这一步让设计长在现有结构上。跳过它直接 grill，出来的是叠加式设计：新代码贴着旧结构长，缝越堆越浅。

2. **定设计** —— 让你运行 `/grill-with-docs`，就选定的候选访谈。它内部调用 `grilling` 与 `domain-modeling`。
   *完成判据*：深化的模块边界、缝在哪、哪些测试能活下来，都有明确答复。

3. **先预重构** —— make the change easy, then make the easy change。把预重构排进票里，排在功能改动之前。

4. **切片** —— 让你运行 `/to-tickets`。
   - 普通改动 → tracer bullet 垂直切片。
   - **大范围机械改动**（改字段、改类型、改共享符号）→ 走 expand–contract：先加新形式与旧形式并存，再分批迁移调用点，最后删旧形式。

5. **做与审** —— 让你运行 `/implement`（内部调用 `tdd`），收尾时它会调用 `code-review`。

6. **收** —— 让你运行 `/retro`。

## 岔路

- **只是想清掉架构债、没有具体功能**：第 1 步之后就够，选定的候选本身就是一个想法，接 `/new-feature`。
- **升级范围大到跨 session**：第 4 步之后按 `/new-feature` 的第 3 步补 spec。
- **改动会推翻一条 ADR**：在 grill 里正面处理它，别绕开；理由成立就更新 ADR。

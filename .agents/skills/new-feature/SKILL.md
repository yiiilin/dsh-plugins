---
name: new-feature
description: 新功能开发：代码里还没有这东西时，从想法走到可合并的改动，串起 grill-with-docs / to-spec / to-tickets / implement。不用于改已有代码的形态（用 /feature-upgrade），也不用于排查故障（用 /bug-fix）。
disable-model-invocation: true
---

# 新功能开发

想法已经有了，代码里还没有它。这条路把 Matt 的 skill 按顺序串起来。

**记号**：`/x` 是只能你亲手敲的 skill；不带斜杠的 `x` 模型会自己调用。

**先读原文。** 走到哪一步，就加载那一步的 skill（或直接读它的 `SKILL.md`），照它执行。不要凭记忆复述它的步骤：`/ask-matt` 的文档记着一次真实事故——它只凭一行摘要推荐，跳过了 `/to-spec`，少做了一次接缝检查，出来的票低估了工作量。

## 路线

1. **定问题** —— 让你运行 `/grill-with-docs`，跟它的访谈走到底。它内部会调用 `grilling` 和 `domain-modeling`（两次调用，一次一个）。
   *完成判据*：每个关键决策都有你的明确答复；新词进了 `GLOSSARY.md`，难回退的决策进了 ADR。

2. **定粒度** —— 只问一件事：这个活会不会跨 session？
   - 不会 → 跳到第 4 步。
   - 会 → 第 3 步。

3. **落规格** —— 让你运行 `/to-spec` 产出 spec，再运行 `/to-tickets` 切成 tracer bullet。
   *完成判据*：每张票都是能独立做完的垂直切片，且 blocking edges 能排出开工顺序。

4. **做** —— 让你运行 `/implement`。它内部调用 `tdd`，一票一轮红绿。
   *完成判据*：该票的测试先红后绿，全套测试在最后跑过一次。

5. **收** —— `/implement` 收尾时会调用 `code-review`。要开 PR 就调用 `pr`；最后让你运行 `/retro`。

## 岔路

- **纸面说不清的**（状态模型、要看的 UI）：让你运行 `/handoff` 出去 → 调用 `prototype` 跑出答案 → 把答案带回原来的访谈。让能跑的代码回答，别在访谈里硬猜。
- **大到一次想不完**：让你运行 `/wayfinder` 出决策地图，雾散后再回到第 3 步。
- **想并行推进整份 spec**：第 4 步换成 `/implement-spec`。
- **还没进仓库的第一次**：让你先运行 `/setup-matt-pocock-skills`，配好 tracker 与标签。

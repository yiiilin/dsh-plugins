# collective-deliberation · 聚合思考

一个平台无关的委员会流程：父/default agent 只创建主席，主席分发问题、收集委员临时结果、冻结合并板、发起投票、运行确定性计分并交付最终 handoff。委员和主席都是宿主创建的原生子 agent；父/default agent 不参与委员会判断。

## 使用

明确点名该 skill，并提供议题、约束、材料、委员数量、模型路由和预算：

> 使用 collective-deliberation 评审下面这个方案。父 agent 只创建一个主席；主席创建 4 个可继续的独立委员。委员只能读项目，结果只能写指定临时目录；全部结果收齐后生成冻结合并板，原委员读取合并板并写 CSV 投票，程序确定性计分，最后交给独立摘要 agent。不要让父/default agent 自己总结委员会。议题是：……

## 角色

- 父/default agent：只创建主席并交付主席返回值。
- 主席 agent：只负责派发、收集、屏障、编号、计分和 handoff。
- 委员 agent：独立提出结果、读取冻结合并板并投票；失败时在原会话/原环境有界重试。
- 确定性程序：只解析 JSON/CSV、计算均值和状态，不调用模型。
- 摘要 agent：单独创建，使用 default agent 的模型，只整理程序 handoff。

## 核心规范

- [SKILL.md](SKILL.md)：完整执行指引。
- [原生子 agent 适配](references/adapters.md)：会话、屏障、重试、文件交接和 handoff。
- [委员会主席协议](references/protocol.md)：JSON、combine、CSV 和确定性计分规则。
- [设计审计](references/audit.md)：适用场景、风险和评测限制。

## 文件协议

主席生成：

```text
/tmp/.collective-deliberation-<uuid>/
```

委员结果使用严格 JSON：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-<dispatch-id>.json
```

主席生成 canonical 合并文件和可读视图：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.json
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.md
```

委员投票使用无表头两列 CSV：

```text
/tmp/.collective-deliberation-<uuid>/vote-<dispatch-id>.csv
```

每行是 `resultNo,score`，score 为 0 到 5 的整数。普通失败在原可继续子会话中重试，默认最多重试 2 次；未知状态先核对，不能用新请求覆盖。

## 确定性程序

skill 本体不执行脚本。仓库保留的 [`scripts/council.mjs`](scripts/council.mjs) 是可选的无模型文件/CSV 计算器；它不创建 agent、不选择模型、不替主席做判断。没有计算器时，不能把主席或父/default agent 的手算当作程序核验结果。

## 限制

提示词约束不等于宿主权限隔离。记录实际可用的项目读写权限，但不要从“不能写项目”的文字推断系统已经强制执行。程序结果中的 `candidate` 仍须保留不确定性；父/default agent 不得改写主席 handoff 或替代独立摘要。

## 验证

效果评测使用 [evals/README.md](evals/README.md)：题目与校验标准保留在 `evals/`，每次运行产生的文件和报告写入 `/tmp/.collective-deliberation-<uuid>/`。

确定性程序和测试不调用模型。运行回归测试：

```bash
node --test tests/council.test.mjs
```

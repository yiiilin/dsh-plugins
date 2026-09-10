---
name: collective-deliberation
description: 当用户要求用委员会独立讨论、汇总候选、匿名投票和程序计分时使用。父 agent 只创建主席 agent；主席负责编排委员、临时文件、屏障和确定性结果，另有独立摘要交付规则。
---
# 聚合思考

这是一个由父/default agent 启动的委员会流程。父 agent 不参与观点形成、投票或委员会总结；它只启动主席并转交最终结果。

## 0. 角色与硬边界

- **父/default agent**：固定议题、约束和材料，创建恰好一个主席 agent，等待主席返回，然后原样交付主席的最终结果。
- **主席 agent**：独立子会话；不提出观点、不参加投票、不替委员判断正确性。它只分发材料、收集文件、生成合并材料、触发投票、运行确定性计分并返回结果。
- **委员 agent**：独立子会话；只读项目内容，独立分析议题并投票。委员只能把结果写到主席指定的临时目录，不能修改项目文件、测试、依赖或 git 状态。
- **确定性计算程序**：只解析 JSON/CSV、分配编号、计算均值/门槛/状态和生成最终 JSON/Markdown；不调用模型、不补写委员结果、不选择候选观点。
- **主席摘要**：主席的最终结果是程序计算的结构化结果和文件索引，不是主席的主观总结。需要自然语言摘要时，另创建一个不参与讨论的 default-model summarizer；它只能整理程序 handoff。

skill 是编排指引；仓库保留的 `scripts/council.mjs` 和对应测试只负责通用、确定性的文件校验/合并/计分，不承担模型派发。使用计算器或准备 manifest 时，先读 [计算器协议](references/calculator-protocol.md)。任何模型调用都必须通过宿主原生、可继续的子 agent 能力；旧 HTTP runner 不属于本流程，也不能作为失败回退。

## 1. 权限约束

委员任务必须明确以下操作约束：

- 项目工作区只读；
- 临时结果只能写入 `/tmp/.collective-deliberation-<run-uuid>/`；
- 主席可以创建该目录、收集委员文件和运行确定性计算；
- 委员可以读项目、读冻结合并文件、写自己的结果/CSV，但不能写项目文件、测试、依赖或 git 状态；
- 委员不能读取其他委员的会话或尚未公开的结果。

这些是本 skill 的行为约束。若运行平台能够提供更强的权限隔离，应记录实际策略；若只能提供提示词约束，也只能报告“按指引要求”，不能把它表述为已完成的系统级隔离。

## 2. 父 agent 创建主席

父 agent 从用户请求固定以下材料：

- 一个议题和清晰的问题；
- 硬约束、可接受输出和判断标准；
- 事实、假设和待核验事项；
- 委员人数、模型路由、并发预算和超时。

父 agent 创建一个独立主席子 agent。主席使用父 agent 的默认模型路由，除非用户明确指定另一条主席路由；父 agent 不把自己的候选结论、偏好或答案键放进主席之外的委员材料。

主席必须生成一个新的 UUID `run-uuid`，创建并固定：

```text
/tmp/.collective-deliberation-<run-uuid>/
```

目录使用最小必要文件权限；同一 OS 身份的会话仍可能互相访问，目录名或 `0700` 不能证明会话间硬隔离。主席把本轮 UUID、委员 dispatch ID、题目版本和实际权限状态写入 `manifest.json`，但不把委员模型或可识别作者身份的信息放入之后给委员读取的合并板。

父 agent 同时提供自己的默认 `provider`、`model` 及可核验来源，供独立 summarizer 绑定；若无法查明，记录未知。并发预算默认 32，含义是本轮主席允许同时在途的委员派发数，受宿主实际额度进一步限制。记录请求预算、实际预算和作用域；它不提供跨会话或全宿主的 admission control，也不能绕过宿主限额。

## 3. 主席分发独立议题

主席为每名委员分配唯一、不可复用且匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$` 的 `dispatch-id`，通过宿主原生能力创建可继续的独立委员会话，并记录 `sessionId` 与 `environmentId`。创建前必须核验该能力支持稍后继续同一会话；不支持则明确报告本轮 `unavailable` 并停止。所有委员收到同一份冻结议题和约束；可以使用不同模型，但必须记录请求路由和可核验的实际路由，不能只在提示词中声称模型已切换。

委员任务必须明确：

- 独立阅读项目和题目，不能读取其他委员的结果；
- 只读项目，所有临时写入仅限主席给出的 run 目录；
- 完成后写结果文件并把文件路径/完成状态告知主席；
- 不把未核验推测写成确定事实；
- 不执行其他委员的建议，不修改项目，不修改测试。

主席等待所有委员进入终态。运行中的委员不能被当成失败，缺失结果不能由主席补写。同一委员在当前环境中失败、超时或输出无效时，按第 9 节在原会话有界重试；原会话无法继续则明确报告连续性失败并停止本轮，不能创建新委员替代或把新会话标作原会话。

## 4. 委员结果文件

委员完成后写入：

```text
/tmp/.collective-deliberation-<run-uuid>/tmp-result-<dispatch-id>.json
```

文件扩展名是 `.json`，内容必须是一个完整的 JSON 对象，不得带 Markdown 围栏、前后解释或多个 JSON。建议结构：

```json
{
  "dispatchId": "member-a",
  "results": [
    {
      "title": "一个原子结论或行动",
      "claim": "可被题目材料支持或反驳的单一主张",
      "evidence": ["材料中的依据"],
      "uncertainties": ["尚未核验的前提或反例"],
      "verification": "最小核验办法"
    }
  ]
}
```

主席只接受 `dispatchId` 与派发记录一致、JSON 可解析、`results` 数量和字段合法的文件。失败、超时、空文件、重复 dispatch ID、越权写入或结构错误都要保留为失败记录，不能转换成“没有意见”。

## 5. 合并结果屏障

全部委员结果文件收齐并通过结构校验后，由确定性程序分配 `result-no`：先按 `dispatch-id` 的 ASCII 字节升序排列（区分大小写，前缀较短者优先；禁止使用受 locale 影响的排序），再按委员文件内的结果顺序，从 1 开始递增。程序生成两个文件：

```text
/tmp/.collective-deliberation-<run-uuid>/tmp-result-combine.json
/tmp/.collective-deliberation-<run-uuid>/tmp-result-combine.md
```

合并文件必须同时方便人读和程序解析。推荐包含固定的 JSON 区段：

```text
# Combined Results
<!-- BEGIN COLLECTIVE RESULTS JSON -->
[
  {
    "resultNo": 1,
    "sourceDispatchId": "member-a",
    "title": "...",
    "claim": "...",
    "evidence": [],
    "uncertainties": [],
    "verification": "..."
  }
]
<!-- END COLLECTIVE RESULTS JSON -->
```

合并 `.json` 是唯一机器事实源；`.md` 是确定性程序从同一 JSON 生成的可读视图。两者只公开不含模型/会话身份的匿名 dispatch ID；作者身份映射留在 manifest。委员投票前读取冻结的 `.md` 或 `.json` 视图，两者的编号、顺序和各字段原文必须一致；不得改写 claim、删除异议、按偏好排序或暗示可信度。记录冻结文件的内容哈希；投票后若内容改变，本轮失败。

## 6. 原委员读取合并板并投票

合并文件冻结后，主席通过宿主消息/继续机制向 manifest 记录的**原委员 `sessionId`**派发投票，保持原 `environmentId` 和 `dispatch-id`。宿主只能新建会话、原会话丢失或无法继续时，明确报告连续性失败并停止本轮；不得用新会话、新委员或一次性调用替代。

每名委员为合并板中的每个 `resultNo` 给出一个整体分数，写入：

```text
/tmp/.collective-deliberation-<run-uuid>/vote-<dispatch-id>.csv
```

CSV 不带表头。每行严格两列：

```text
1,5
2,3
3,0
```

第一列是正整数 `resultNo`，第二列是 `0` 到 `5` 的整数分数。委员必须为每个结果写一行；不能重复编号、漏编号、写未知编号、写小数、写额外列或夹带文字。委员对自己产生的结果仍可以写分数，但主席计分时排除作者自己的票。

由于 CSV 只保存数值，委员在初始结果 JSON 的 `uncertainties` 和 `verification` 中保留发现的限制；CSV 不承载新的事实或理由。投票文件结构错误、缺失或越权写入都必须作为该委员的失败/无效投票记录。

## 7. 主席确定性计分

主席把完整 manifest 和所有预期票文件路径交给确定性计算程序，由程序识别合法、无效和缺失 CSV；不能先过滤失败记录。程序不得调用模型或依赖主席的自然语言判断。`N` 始终是冻结 manifest 的委员总数，不能因失败缩小分母。对每个 `resultNo`：

1. 根据 manifest 排除该结果作者自己的票；
2. 检查有效票数，默认要求 `max(3, ceil(0.75 × (N−1)))`；
3. 计算有效分数的算术平均值，比较时不先舍入；
4. 默认严格要求 `mean > 3.5`；等于 3.5 不通过；
5. 记录 `validVotes`、`requiredVotes`、`mean`、`min`、`max`、`spread`、所有票文件和失败记录；
6. 按顺序判定：票数不足为 `insufficient_votes`；票够但未严格过线为 `below_threshold`；过线但分差至少 2、存在无效/缺失投票或结构/权限异常为 `needs_review`；其余为 `candidate`。无效 CSV 整份拒收，不从中择取有效行；达到法定票数不能抹去缺票或失败。

程序生成：

```text
/tmp/.collective-deliberation-<run-uuid>/final-result.json
/tmp/.collective-deliberation-<run-uuid>/final-result.md
```

`final-result.json` 是权威机器结果，至少包含 run UUID、题目版本、委员终态、每个 result-no 的原文引用、有效票数、均值、状态、异议/不确定性和全部临时文件路径。`final-result.md` 只是同一 JSON 的可读渲染，不得增加未出现在输入文件中的事实。

## 8. 主席返回父 agent

主席只向父/default agent 返回：

- `final-result.json` 的结构化内容或受控副本；
- `final-result.md` 路径；
- run UUID 和题目版本；
- 委员/投票/计分失败；
- `candidate`、`needs_review`、`below_threshold` 和 `insufficient_votes` 的数量。

父/default agent 不重新阅读并重写委员会观点，不自行替换票数或状态，不把 `candidate` 改写成“已确认正确”。需要自然语言摘要时，主席另外创建一个不参与讨论、投票或计分的 `summarize-default` 子 agent，只让它读取冻结的 `final-result.json`。

创建 summarizer 前，必须把第 2 节冻结的父 default `provider` **和** `model` 绑定到实际工具支持的路由参数；若工具没有这些参数，只能采用已由宿主说明/实现及本次记录核验的继承链，且证明继承结果确实等于父 default 路由。提示词写“使用 default model”、子 agent 名称或仅省略参数都不是证明；主席若使用其他模型，不能把主席的默认继承当作父 default。

把请求路由、实际路由、核验证据、summarizer 会话 ID、输入哈希和终态写入独立 `summary-handoff.json`；实际路由未知时明确记为未知。无法保证绑定、无法验证实际路由或实际路由不匹配时，摘要状态为 `unavailable`，只交付程序结果并说明原因，不冒称已完成 default-model 摘要。summarizer 自身执行失败记为 `failed`。摘要只整理 handoff 中已有内容并保持数值、状态和不确定性；父/default agent 原样交付可用摘要与审计路径。这个后续审计文件不回写已冻结的计分输入。

## 9. 屏障与失败规则

- 提案屏障未结束，不生成合并板。
- 合并板未冻结，不发起投票。
- 投票未全部进入终态，不生成“完整”最终结果；缺失投票只能进入失败/待核验状态。
- 普通失败、超时、权限错误或结构无效必须在原委员子 agent、原工作环境和原 `dispatch-id` 上重试；主席通过继续消息说明失败原因和修复动作，保持原权限边界。将 `maxRetryAttempts` 在 manifest 中冻结，默认最多重试 2 次（首次尝试之外），每次保留 attempt 状态、时间和错误。达到上限后才标为 `failed`，不能静默转成空结果或 `null`。原会话/环境无法继续或权限策略禁止重试时，立即输出明确失败报告并停止本轮，保留实际已发生的 attempts；不得伪造重试耗尽来通过计算器校验。
- `started_unknown` 表示调用结果尚未确定：先核对原 child 状态、文件和宿主记录，再决定继续消息或将该尝试标为失败；不能用一个新请求覆盖未知尝试。
- 委员原始 JSON、合并板、CSV、计分脚本输出和主席返回值都要保留，确保父 agent 可以审计但不能改变。
- 程序计算结果与主席/父 agent 的自然语言描述冲突时，以机器 JSON 和原始文件为准，并报告冲突。

## 完成条件

主席返回一个可解析的 `final-result.json`，其中每名委员和每份投票都有终态；所有 result-no 的编号、票数、均值和状态可由临时文件重算；独立 summarizer（若启用）有单独终态；父/default agent 未参与内容判断、投票或委员会总结。

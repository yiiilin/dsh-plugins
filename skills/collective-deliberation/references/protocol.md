# 委员会主席协议

## 目的与角色

本协议用于把一个议题交给多个独立委员，再用冻结结果和数值投票筛选候选。父/default agent 不参与委员讨论、投票或委员会总结；它只创建主席、等待主席终态并交付最终结果。

- **主席 agent**：唯一的编排者。生成 run UUID，创建委员、收集临时文件、生成合并板、触发投票、调用确定性计分程序和返回 handoff。
- **委员 agent**：只读项目，独立产出结果和分数；临时写入只能落在本轮 `/tmp/.collective-deliberation-<uuid>/`。
- **计算程序**：只解析固定 JSON/CSV，分配编号、排除自票、计算均值/门槛/状态和渲染最终文件。
- **摘要 agent**：可选的独立 default-model 子 agent，只整理程序 handoff，不参与提案或评分。
- **父/default agent**：只接收和交付主席返回的结果，不改变结果内容。

模型调用必须通过宿主原生子 agent。协议程序不得直接调用模型 API，也不得把一次普通 HTTP 对话包装成委员。

## 运行顺序

流程严格有两个全局屏障和一个可选摘要阶段：

```text
父/default agent -> 主席 agent
主席 -> 全部委员：独立提案
主席等待全部委员终态
主席 -> tmp-result-combine.json / tmp-result-combine.md
主席 -> 原委员：读取冻结合并板并投票
主席等待全部投票终态
确定性程序 -> final-result.json / final-result.md
可选：主席 -> 独立 summarize-default agent
主席 -> 父/default agent
```

提案阶段的委员互不可见。投票阶段所有委员读取完全相同的合并板；合并板一旦生成不得修改。

## 文件契约

主席使用 `crypto.randomUUID()` 生成本轮 UUID，并创建：

```text
/tmp/.collective-deliberation-<uuid>/
```

主席应在 `manifest.json` 保存题目版本、委员 `dispatch-id`、结果编号规则、权限状态和阶段终态。每名委员的提案文件为：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-<dispatch-id>.json
```

文件内容必须是单个可解析 JSON 对象，扩展名和内容一致：

```json
{
  "dispatchId": "member-a",
  "results": [
    {
      "title": "原子结论",
      "claim": "单一可判断主张",
      "evidence": ["材料依据"],
      "uncertainties": ["未核验限制"],
      "verification": "最小核验方式"
    }
  ]
}
```

主席收集全部合法文件后，按 `dispatch-id` 固定排序，再按文件内结果顺序分配从 1 开始的 `resultNo`。合并板的 canonical 文件为：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.json
```

主席同时生成可读视图：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.md
```

`.json` 是唯一机器事实源，`.md` 必须由同一 JSON 确定性渲染。合并 JSON 数组中的每个元素包含 `resultNo`、`sourceDispatchId` 和结果字段。合并视图可以包含固定的机器区段：

```text
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

委员投票文件为：

```text
/tmp/.collective-deliberation-<uuid>/vote-<dispatch-id>.csv
```

CSV 不带表头，每行严格两列：

```text
1,5
2,3
3,0
```

第一列是 `resultNo`，第二列是 0 到 5 的整数分数。重复、遗漏、未知编号、小数、额外列和解释文字都会使该投票无效。主席计分时排除结果作者自己的票。

## 确定性计分

对每个结果：

```text
requiredVotes = max(3, ceil(0.75 × (委员数 - 1)))
mean = 有效非作者分数的算术平均值
```

比较均值时不先舍入。默认规则是 `mean > 3.5` 才具备资格；等于 3.5 不通过。状态如下：

- `insufficient_votes`：有效票不足；
- `below_threshold`：票数足够但均值未严格超过 3.5；
- `needs_review`：均值过线但存在分差至少 2、无效/越权文件、阶段不完整或其他明确核验触发；
- `candidate`：票数和均值达标，且没有机器侧核验触发。

计分程序不得根据 claim 的语言风格、委员模型、主席偏好或未写入文件的上下文调整分数。程序输出：

```text
/tmp/.collective-deliberation-<uuid>/final-result.json
/tmp/.collective-deliberation-<uuid>/final-result.md
```

JSON 至少包含 run UUID、题目版本、委员终态、投票终态、每个 `resultNo` 的来源、均值、有效票数、状态、文件路径、失败和不确定性。Markdown 只能是 JSON 的可读渲染。

## 独立摘要

如果用户需要自然语言总结，主席在确定性计分完成后单独创建 `summarize-default` 子 agent：

- 不传显式 `provider/model`，由宿主使用 default agent 的默认模型；
- 不属于委员 quorum；
- 只读 `final-result.json` 和 handoff；
- 不重新提案、不重新投票、不修改均值和状态；
- 必须保留 `needs_review`、失败和未核验信息。

父/default agent 只能接收该摘要并交付，不得用自己的总结替换它。摘要失败必须保留为失败状态。

## 权限与失败

项目只读、临时目录可写和委员互不可见是本 skill 对委员的行为约束。宿主如果能够提供更强隔离，可以记录实际策略；如果只能提供提示词约束，主席只报告“按 skill 要求执行”，不推断系统级隔离已经存在。

普通失败、超时、权限错误或结构无效必须由主席通过继续消息发回同一个委员子 agent，在原环境和原 `dispatch-id` 上重试。`maxRetryAttempts` 在 manifest 中冻结，默认最多重试 2 次；每次保留 attempt 状态、时间和错误，达到上限后才标为 `failed`，不能静默转成空结果或 `null`。`started_unknown` 先核对原 child 状态、文件和宿主记录，不能用新请求覆盖未知尝试。

提案、投票和摘要均需有明确终态。程序不能用空文件、缺失投票或模型自报内容伪造成功结果。

## 审计

父/default agent至少收到：

- `final-result.json` 或受控副本；
- `final-result.md` 路径；
- run UUID、题目版本和权限状态；
- 委员/投票/摘要失败；
- 每个结果的原始文件、投票文件、有效票、均值、状态和不确定性。

所有机器结果可从临时文件重算。自然语言摘要与 JSON 冲突时，以 JSON、CSV 和原始委员文件为准。

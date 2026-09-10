# 原生子 agent 适配

本适配层只说明宿主需要提供的通用能力，不绑定任何特定产品、平台或模型服务。skill 通过宿主的原生子 agent、继续消息、文件读取/写入和任务终态能力运行。

## 角色映射

- 父/default agent 只创建一个主席子 agent，并等待主席 handoff。
- 主席创建可继续的委员子 agent，保存每个真实 child handle 与 `dispatch-id` 的映射，维护本轮 UUID 和阶段屏障。
- 委员只读项目，写自己的结果 JSON；投票时读取同一份冻结 combine 视图并写自己的 CSV。
- 主席只做材料分发、文件收集、编号、确定性计分和 handoff，不参与内容判断。
- 需要自然语言交付时，主席另创建一个不参与讨论和投票的摘要子 agent；父/default agent 只接收并交付该摘要。

## 主席任务包

父/default agent 给主席的任务包应包含议题、约束、材料、委员 roster、模型路由、并发预算、重试预算和结果目录规则。主席自行生成新的 UUID，并创建：

```text
/tmp/.collective-deliberation-<uuid>/
```

主席保存 `manifest.json`，至少记录题目版本、委员 dispatch ID、child handle 映射、结果/投票路径、重试策略和阶段终态。父/default agent 不向委员直接派题，也不把自己的候选结论塞进委员材料。

## 委员会话与重试

委员优先使用可继续的子会话，而不是一次性子 agent。主席在 proposal 或 vote 失败后，向同一个 child handle 发送失败原因、原路径和修复要求，让它在同一环境继续执行；重试复用原 `dispatch-id`，不创建新的逻辑委员。`maxRetryAttempts` 在 manifest 中固定，默认首次尝试之外最多重试 2 次，每次保存 attempt 记录。

运行中的 child 不算失败。普通失败、超时、权限错误和结构无效都必须先原地重试；达到预算后才记录 `failed`。`started_unknown` 先核对 child 状态、临时文件和宿主终态，不能让新请求覆盖未知尝试。

## 权限指引

委员任务明确要求项目只读、只写自己的临时文件、不能读其他委员未公开的结果。它们是 skill 约束；宿主可以额外施加工具或路径限制，但本适配层不假设某种权限系统或工作区实现，也不从提示词推断权限已经被系统强制执行。

## 阶段屏障

主席必须按以下顺序等待：

1. 全部委员 proposal 尝试进入终态，失败者已完成有界原地重试；
2. 全部成功委员结果 JSON 通过校验，失败/未知记录已单独保存；
3. `tmp-result-combine.json` 与 `tmp-result-combine.md` 写完并冻结；
4. 全部原委员读取合并板并投票，失败者已完成有界原地重试；
5. 全部可接受的投票 CSV 通过校验，缺失/无效投票保留状态；
6. 确定性程序完成计分并写最终文件；
7. 可选摘要子 agent 完成。

前一阶段未达到屏障条件，不能静默进入下一阶段。若协议允许带失败继续，最终结果必须明确标为不完整或待核验。

## 文件交接

委员 proposal 文件使用 JSON：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-<dispatch-id>.json
```

内容是单个 JSON 对象，不带 Markdown 围栏：

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

主席按固定 `dispatch-id` 顺序和文件内顺序分配从 1 开始的 `resultNo`，写 canonical：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.json
```

再由同一数据确定性渲染：

```text
/tmp/.collective-deliberation-<uuid>/tmp-result-combine.md
```

`.json` 是机器事实源，`.md` 只是委员阅读视图。投票文件使用：

```text
/tmp/.collective-deliberation-<uuid>/vote-<dispatch-id>.csv
```

CSV 不带表头，每行严格两列 `resultNo,score`，其中 score 是 0 到 5 的整数。禁止重复/遗漏/未知编号、小数、额外列和解释文字。

## 失败记录与 handoff

每个阶段记录至少包含：

```json
{
  "dispatchId": "member-a",
  "stage": "proposal",
  "attempt": 1,
  "status": "ok",
  "path": "/tmp/.collective-deliberation-.../tmp-result-member-a.json"
}
```

失败、取消、超时、权限错误、无效结构和 `started_unknown` 都保留原状态以及每次 attempt，不转换成空意见或 `null`。主席返回 `final-result.json`、`final-result.md`、run UUID、题目版本、文件路径、委员/投票/摘要终态和确定性计分结果。

父/default agent 只能交付主席 handoff 或独立摘要，不重新排序候选、不改写分数、不删除不确定性、不用自己的模型补出失败结果。

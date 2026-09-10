# 计算器协议

准备 `manifest.json` 或使用通用 `scripts/council.mjs` 时读取本文件。计算器只处理本地数据；主席通过宿主原生能力管理原委员会话。命令行参数和精确字段校验以当前 `scripts/council.mjs` 的帮助与 validator 为准，修改实现由维护者处理，运行委员会不需要生成另一套 runner。

## Manifest 与屏障

开始派发前冻结 run UUID、非空 `topicVersion`、委员身份、权限状态和非负整数 `maxRetryAttempts`（默认 2）。`members` 按完整委员名册登记，不因失败删除成员。计算输入至少保留：

- `runId`：本轮 UUID 字符串；`dispatchIds`：非空、无重复的完整委员 ID 数组。ID 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$`，长度 1–96，首字符为 ASCII 字母或数字，之后只允许 ASCII 字母、数字、下划线、连字符。
- `resultFiles`、`voteFiles`：必填对象，键集合分别与 `dispatchIds` 完全一致。每个 ID 的值必须严格等于 `tmp-result-<dispatch-id>.json` 和 `vote-<dispatch-id>.csv`；填写文件名，不接受绝对路径、子目录或其他别名，即使预期投票缺失也保留映射。
- `permissionStatus` 对象：声明是行为约束还是宿主实际强制策略，并记录证据；不能用临时目录位置证明硬隔离。
- `members[]`：唯一 ASCII `dispatchId`、宿主原 `sessionId`、原 `environmentId`，以及 `proposal`、`vote` 的阶段记录。
- 阶段记录：终态 `status` 为 `ok` 或 `failed`；`attempts[]` 中每次包含 `status`（`ok` 或 `failed`）、`startedAt`、`endedAt`，失败时包含非空 `error`。时间必须可解析且结束时间不早于开始时间；阶段状态等于最后一次尝试状态，之前的尝试均为失败。真实尝试总数为 1 至 `1 + maxRetryAttempts`；正常失败阶段必须先耗尽预算。
- `failures[]`：必填数组，每项为对象且 `error` 必须为非空、非纯空白字符串；可附 `dispatchId`、`phase`、`path` 等上下文。保存全部阶段失败、权限异常和数据异常；恢复成功也保留先前失败记录，没有失败时填 `[]`。

下面是投票阶段已结束的最小格式示例，所有身份、UUID、时间与状态都必须替换为本轮真实记录。单委员仅用于展示结构：其自票被排除，有效票为 0、最低票数为 3，结果必为 `insufficient_votes`，不能用来声称委员会有效通过。

```json
{
  "runId": "7d70aa17-0dca-4d6b-8e8f-4a126abf6b8e",
  "topicVersion": "v1",
  "dispatchIds": ["member-a"],
  "resultFiles": {"member-a": "tmp-result-member-a.json"},
  "voteFiles": {"member-a": "vote-member-a.csv"},
  "permissionStatus": {
    "mode": "behavioral",
    "evidence": "仅通过任务指令约束工作区只读和临时写入范围"
  },
  "maxRetryAttempts": 2,
  "members": [
    {
      "dispatchId": "member-a",
      "sessionId": "actual-original-session-id",
      "environmentId": "actual-original-environment-id",
      "proposal": {
        "status": "ok",
        "attempts": [
          {
            "status": "ok",
            "startedAt": "2026-01-01T00:00:00Z",
            "endedAt": "2026-01-01T00:01:00Z"
          }
        ]
      },
      "vote": {
        "status": "ok",
        "attempts": [
          {
            "status": "ok",
            "startedAt": "2026-01-01T00:02:00Z",
            "endedAt": "2026-01-01T00:03:00Z"
          }
        ]
      }
    }
  ],
  "failures": []
}
```

把该文件保存为 run 目录下的 `manifest.json`，原始提案和 CSV 保存到映射中的对应文件。`combine` 校验提案终态，不要求尚未发生的投票有终态；`score` 才校验 `vote`，因此不能在合并前照抄示例中的成功投票记录。

运行时的 pending/running/started_unknown 等状态可以保存在主席工作记录中；只有满足阶段屏障的 manifest 才提交给相应计算步骤。合并要求全部 proposal 为 `ok`，计分要求全部 vote 进入终态；vote 为 `failed` 的委员即便留有 CSV 也不能计票。若连续性丢失或权限禁止重试，保留真实尝试并交付失败报告，停止后续计算，不能制造 attempts 满足 validator。

主席审计另保留请求/实际模型路由及证据、父 default provider/model 的来源、请求/实际并发预算和作用域。默认并发 32 只控制主席本轮委员派发，实际受宿主额度限制，不是全局 admission。不要把运行时未知信息补成推测值。

## 确定性输入与输出

1. 从完整 manifest 枚举 `tmp-result-<dispatch-id>.json`；校验作者 dispatch ID 和原子结果字段。按 dispatch ID 的 ASCII 字节升序、文件内数组顺序编号。不得使用 `localeCompare`；例如 `A` 在 `a` 前，`member-10` 在 `member-2` 前。
2. `tmp-result-combine.json` 是 canonical 机器输入；Markdown 仅从其字段确定性渲染。保留原文、作者匿名 dispatch ID 和内容哈希，冻结后才发投票。
3. 从完整名册枚举 `vote-<dispatch-id>.csv`。每份无表头、每行严格两列 `resultNo,score`：第一列匹配 `^[1-9][0-9]*$` 且为 JavaScript 安全整数，第二列匹配 `^[0-5]$`。仅接受 ASCII 十进制数字和逗号；不接受空白、前导零、正负号、小数、指数写法、引号或 BOM。覆盖所有编号恰好一次，行顺序不限。LF、CRLF 均可（解析器也将单独 CR 归一为 LF），文件末尾可有一个换行；空行及多余末尾换行会使整份 CSV 无效。文件整体无效或缺失均保留错误，不能只把已通过校验的票交给计分。
4. 排除作者自己的票；`N` 取完整名册。有效票最低数为 `max(3, ceil(0.75 × (N−1)))`。均值严格大于 3.5 才过线，比较前不舍入；可以用整数比较 `2 × sum > 7 × validVotes`。
5. 按主文第 7 节的优先级产生状态。无效/缺失投票、结构/权限异常或分差至少 2 会把票数足够且过线的结果降为 `needs_review`。票数不足仍为 `insufficient_votes`，未过线仍为 `below_threshold`。
6. `final-result.json` 保留完整 manifest 审计、输入路径和哈希、读取/校验错误、阈值、计数与每条结果的原文和统计。`final-result.md` 只渲染同一 JSON。相同冻结输入必须产生相同编号、票数、状态和内容；时间等运行元数据使用既有记录，不在重算时生成新的事实。

## 摘要交付审计

计分完成后才创建独立摘要。`summary-handoff.json` 与计分 manifest 分开，至少记录：

- `parentDefaultRoute: {provider, model, evidence}`；
- `requestedRoute: {provider, model}`、`actualRoute: {provider, model}` 或明确未知值；
- `routeEvidence`：实际工具路由参数与执行记录，或核验过的继承链及实际执行记录；
- `sessionId`、`inputPath`、`inputHash`、`status`、`error`（失败/不可用时）及可用的摘要路径。

`status` 使用 `completed`、`failed` 或 `unavailable` 终态。只有实际路由已核验等于父 default provider/model，且摘要忠实于最终 JSON，才可标为 `completed`。路由不能保证或验证时报告 `unavailable`，不会阻止交付确定性程序结果，也不能由主席或父 agent 代写摘要冒充成功。

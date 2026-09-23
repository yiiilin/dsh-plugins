# 交付单元附录：给 agent 检查，不要求用户理解字段

用于多单元、跨模块、正式入口接线或多 agent 的实际实施任务，附在已有变更提案内，不另建事实数据库。小修可以只用简短正文核对。正文先用自然名称说明目标、授权来源、当前可用性与下一步，再放此附录。协议见 [EXECUTION.md](../EXECUTION.md)。

下面是**未填写模板**，不是已授权任务，直接执行检查应提示缺真实版本和来源。交付检查不创建或审批任务、不自带模型运行器；v0.3 的 verify 是独立、显式授权的项目验证执行器。

<details>
<summary>交付包字段模板（agent 维护）</summary>

<!-- ddd:delivery -->
```json
{
  "kind": "ddd-delivery-v1",
  "schemaVersion": 1,
  "title": "消息领域 / 消息派发 / 正式入口能够消费队列",
  "verification": {"mode": "runner-v1", "plan": "docs/changes/actual.verify.json"},
  "authorization": {
    "mode": "design-only",
    "source": "unknown",
    "specRefs": ["unknown"]
  },
  "units": [
    {
      "name": "消息领域 / 派发模块 / 后台派发",
      "outcome": "正式后台入口启动后，已提交的消息被消费并产出约定结果",
      "covers": ["R-DISPATCH-001"],
      "writePaths": ["src/dispatch/**", "tests/dispatch/**"],
      "state": "queued",
      "integration": "required",
      "entryPoints": ["src/main.mjs"],
      "runtimePath": "实际入口 -> 后台循环 -> 队列读取 -> 消费者 -> 可观察结果；路径待核对",
      "requiredLevels": ["integration", "acceptance"],
      "runs": []
    }
  ]
}
```

</details>

将路径和名称替换为真实项目，不为了符合示例新增入口/行为。机器身份从当前规格读取，版本来自 `context.mjs --doc <实际路径> --bindings`；取得哈希不是批准。authorization.source 引用已存在的原始实施指令及方案确认，不让用户为了填字段再批一次。仅设计保持 design-only，要求暂停用 hold；实际授权实施才用 implement。

默认要求覆盖 specRefs 绑定文档全部 R/C。原任务仅涉及部分规则时，加入 `selectedItems` 数组及 `scopeSource`，引用真实范围；不能把已授权漏项删成范围外。经真实批准延期可加 `deferred: [{"item":"真实条目", "reason":"具体原因", "source":"延期批准来源"}]`，交付必须披露排除项。

每个 unit 从 queued、implementing、integrating、verifying 到 done；受阻用 blocked，并写 `blocker: {"kind":"decision|environment|dependency|permission", "reason":"具体条件", "nextAction":"谁继续做什么"}`。已经批准的功能缺实现不是新的 decision。并行任务仍由指定集成人核对最终版本。

标 done 后：entryPoints 存在且实际调用链已核对；runs 引用当前计划下真实 `run.json#sha256`。检查器从运行记录判定最终代码基线、每个 covers × requiredLevels 的真实命名测试覆盖及产物；无有效运行、跳过、失败、过期均拒绝。纯函数可显式 integration=not-applicable 并解释，不以此掩盖缺消费者。

新 runner 路径不要求 unit.evidence 或 codeBaseline 重复字段；提供旧字段时仍核对，不能容忍矛盾。旧 records-only 包仍按原规则要求版本绑定 E、方法/环境、必测 executed/skipped/failed 和非空工件，不能冒充 runner 采证。设计评审不能代替执行。

在同一提案正文可附一段委托约定：主持/写入者、执行者、集成人、允许路径、输入版本、禁止改变、验收前提、预算和停止条件。不强制更多 JSON 字段，也不要求用任意模型 API 执行。

机器字段只维护范围、分工、入口、所需验证层与实际 runs，不复制执行事实。计划/采证/限制的唯一详细规则见 [VERIFICATION.md](../VERIFICATION.md)。

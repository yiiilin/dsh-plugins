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
      "evidence": [],
      "runs": [],
      "codeBaseline": "unknown"
    }
  ]
}
```

</details>

将路径和名称替换为真实项目，不为了符合示例新增入口/行为。机器身份从当前规格读取，版本来自 `context.mjs --doc <实际路径> --bindings`；取得哈希不是批准。authorization.source 引用已存在的原始实施指令及方案确认，不让用户为了填字段再批一次。仅设计保持 design-only，要求暂停用 hold；实际授权实施才用 implement。

默认要求覆盖 specRefs 绑定文档全部 R/C。原任务仅涉及部分规则时，加入 `selectedItems` 数组及 `scopeSource`，引用真实范围；不能把已授权漏项删成范围外。经真实批准延期可加 `deferred: [{"item":"真实条目", "reason":"具体原因", "source":"延期批准来源"}]`，交付必须披露排除项。

每个 unit 从 queued、implementing、integrating、verifying 到 done；受阻用 blocked，并写 `blocker: {"kind":"decision|environment|dependency|permission", "reason":"具体条件", "nextAction":"谁继续做什么"}`。已经批准的功能缺实现不是新的 decision。并行任务仍由指定集成人核对最终版本。

标 done 后：entryPoints 文件存在（仍须人/agent 检查实际调用），codeBaseline 是最终集成代码快照；每个 covers 对每个 requiredLevels 均有本版有效的通过 E。纯函数/纯局部库没有装配入口时可以 `integration: "not-applicable"` 并写具体 `integrationReason`，不把缺失消费者当不适用。

证据写在原规格的验证区或独立共享验证文档，以自然标题 + 隐藏 E 标识组织。除既有字段外：

```text
Level: integration
Executed: 1
Skipped: 0
Failed: 0
Artifact: .doc-driven/runs/dispatch-integration.log
```

这些是字段形态而非真实执行声明。实际记录必需用例的数量、具体环境、方法、结果及非空本地工件；一个 E 只有一个 Level。多个级别可引用同一实际测试产物但需各自说明覆盖，不把同一运行谎称为多次独立验证。设计评审不代替执行证据。保存工件须脱敏；脚本只核路径/版本/非空，不认证它确实来自测试。

在同一提案正文可附一段委托约定：主持/写入者、执行者、集成人、允许路径、输入版本、禁止改变、验收前提、预算和停止条件。不强制更多 JSON 字段，也不要求用任意模型 API 执行。

新版完成单元在 runs 填实际 `run.json#sha256`；runner 会检验其当前计划、命名场景、所需验证层与产物，不仅核 E 字段。`--evidence` 可生成对应 E 片段；每个引用来自实际记录，不由执行者任意改状态。计划与边界见 [VERIFICATION.md](../VERIFICATION.md)。

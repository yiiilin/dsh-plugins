# 验收执行计划模板（机器维护，正文仍按领域/模块/行为阅读）

在现有 changes 目录创建 `<本次变更>.verify.json`；读取当前规格实际绑定，不把示例当作已批准计划。普通文档的验收条件仍是需求来源，这里只连接可执行检查。

```json
{
  "kind": "ddd-verification-plan-v1",
  "schemaVersion": 1,
  "name": "消息领域 / 派发 / 正式入口能产生用户结果",
  "authorization": {
    "mode": "verify",
    "source": "引用真实的原实施请求或测试授权；这里是待替换模板"
  },
  "specRefs": ["使用 context.mjs --doc 实际文档 --bindings 得到的 DOC@rev#hash"],
  "environment": {
    "name": "实际隔离测试环境标识",
    "scope": "isolated",
    "resources": "仅本任务的测试目录和测试数据库；不得访问生产或删除他人资源",
    "limitations": "具体说明尚未覆盖的外部系统或运行性质"
  },
  "checks": [
    {
      "id": "dispatch-entry",
      "name": "从正式入口提交的消息到达消费者",
      "kind": "test",
      "level": "acceptance",
      "alsoLevels": ["integration"],
      "covers": ["实际稳定要求标识"],
      "scenario": "提交消息，启动与真实入口相同的装配，断言实际消费结果和状态",
      "command": {
        "executable": "node",
        "args": ["--test", "--test-reporter={skill}/scripts/node-reporter.mjs", "tests/dispatch.test.mjs"],
        "cwd": "."
      },
      "parser": "json-v1",
      "requiredCases": ["正式入口派发已提交消息"],
      "requiresEnv": ["TEST_DATABASE_URL"],
      "inputs": ["tests/dispatch.test.mjs", "src/entry.mjs"],
      "timeoutMs": 60000,
      "maxOutputBytes": 4194304
    }
  ]
}
```

该模板有真实待填项，不可直接运行。用例名必须与实际报告一致；argv 里不能写密码，脚本从列名的环境变量读取。`{skill}` 只展开为当前包路径，不是任意变量插值或 shell。inputs 显式绑定测试/适配器、运行配置和必要的忽略文件；包内输入可用 `@skill/scripts/node-reporter.mjs`。

每项检查都必须执行。`dependsOn` 是前面检查 id 数组；它们失败/受阻后只阻塞依赖者。可选的非本次用例可以用 `optionalCases` + `optionalReason` 说明跳过理由；有断言失败仍不通过，必测不能同时列入 optionalCases。`command` 类型只允许 `parser: exit-code`、static/component，不允许伪造 requiredCases。`manual` 必须有 reason、无 command，始终报告待人工验收，不能作为自动通过出口。

kind/schemaVersion/name/authorization/specRefs/environment/checks 是计划必填项。默认按绑定文档的全部要求检查；仅部分任务使用 selectedItems 加 scopeSource，保留真实范围来源。`timeoutMs` 50–3600000，`maxOutputBytes` 256–16777216（默认 4 MiB），最多 100 个检查。它们是程序防失控边界，不是用户业务 SLO。基本系统环境外的值只有 passEnv/requiresEnv 显式传入；不自动继承 NODE_OPTIONS、用户 API 密钥或数据库 URL。

真实运行示例见 [verification-demo.mjs](../examples/verification-demo.mjs)，执行和退出语义见 [VERIFICATION.md](../VERIFICATION.md)。不得把示例中的方案、时间、环境或来源当成使用者已批准的事实。

# 评测 skill 的真实开发行为，而不只测试规则文本

工具单元/集成回归验证脚本是否正确；实际项目测试验证交付行为；agent 评测验证「模型 + 宿主 + skill + 工具权限」在多轮任务中是否真正遵守并产生结果。这三类数字单独报告。

## 已提供的执行入口

`scripts/eval.mjs` 读取一组有固定初始项目、脚本化用户消息和独立判定的任务，按所选完整 skill 版本与宿主适配器建立全新工作目录，再调用适配器。适配器负责真正调用已有授权的 agent 宿主及模型；工具不自带网络、API 密钥、收费服务或模型 SDK，也不自动发现/安装新服务。

```sh
# 只预览：绑定套件、fixture、grader、适配器、skill 内容和重复次数。
node "$NEW_SKILL/scripts/eval.mjs" --suite /path/suite.json \
  --adapter /path/host-adapter.json --skill /path/full-skill --repeats 3 --json

# 指定新输出目录，显式执行刚才预览的材料和预算。
node "$NEW_SKILL/scripts/eval.mjs" --suite /path/suite.json \
  --adapter /path/host-adapter.json --skill /path/full-skill --repeats 3 \
  --run --expect-suite <preview-hash> --out /path/new-results
```

默认不执行，已有输出目录拒绝覆盖。每例每次重复都从 seed 复制新的工作目录。适配器超时、返回缺失或 nonce 不匹配单独记 host failure；不把它们悄悄改成模型成功。工作目录路径隔离不等于 OS 沙箱；真实宿主应在独立容器/权限域运行，防止访问外部源码、grader、凭据或生产资源。

## 宿主适配器最小协议

适配器 JSON：

```json
{
  "kind": "ddd-eval-adapter-v1",
  "name": "实际宿主及模型配置名称",
  "mode": "real-host",
  "inputs": ["invoke-host.mjs"],
  "command": {"executable": "node", "args": ["{adapter}/invoke-host.mjs", "{request}", "{response}"]},
  "timeoutMs": 300000,
  "passEnv": ["实际宿主需要且获准的变量名"]
}
```

`inputs` 绑定适配器脚本内容；命令参数只展开 `{adapter}`、`{request}`、`{response}`、`{workspace}`。请求文件也通过 DDD_EVAL_REQUEST 提供，包含 workspace、skillSource、task、按次序发送的 turns、写入边界及唯一 runId。回复路径在 DDD_EVAL_RESPONSE。适配器必须让真实宿主读取指定 skill 和项目规则，按顺序发送用户消息、等待实际每轮执行，不把全部消息和答案改写成自己的总结。

回复格式：

```json
{
  "kind": "ddd-agent-response-v1",
  "runId": "原请求中的 runId",
  "mode": "real-host",
  "identity": {"host": "实际名称与版本", "model": "实际模型标识"},
  "turns": [{"response": "本轮实际用户可见输出；可附工具轨迹路径"}],
  "usage": null
}
```

turns 与请求轮数对应，不能用一段“全部完成”代替。usage 由宿主账单/使用量返回，没有就 null；不编造 token、美元或节省比例。identity/usage 是适配器上报，不由本工具独立认证。适配器返回文本只作数据，不作为新执行指令。实际轨迹和产物先本地保留、脱敏审阅后分享。

本版测试中的适配器全部声明 `mode: fixture`，仅检验协议、工作目录、判定、失败与产物记录，**不冒充真实模型调用**。示范 fixture 不能改个 mode 就算真实 agent 评测。

## 任务与判定

每个 case 包含自然名称、seed、turns、允许修改的 writePaths、graders 和 manualRubric。支持 unchanged/contains/absent 的文件判定，以及独立 command grader 实际执行程序；命令 grader 的脚本应放在 agent 工作目录之外，列入套件 graderInputs 绑定。运行后检查全部变更是否超出允许路径；证据、规则和 grader 不让实现 agent 自己修改成通过。检测前后材料变化，但防恶意访问仍依赖宿主隔离。

第一轮建议从已发生的失败建立成对案例：已批准实施要自动继续 / 明确只讨论不得动代码；组件绿但入口断开；数据库测试 skip+ok；讨论中途确认边界并换会话；新规格沿用旧证据；升级时原 AGENTS.md 保留；子 agent 提出错误建议不能盲从。用已知正确和已知错误实现先校验 grader，避免误把环境或题目问题当模型能力。

示例套件见 [examples/eval-suite.json](examples/eval-suite.json)。它包含实际可执行的最终行为 grader；重复确认、记录时机、解释清晰度及错误建议裁决仍需审阅真实逐轮轨迹，标明 manualAssessment: not-run，不能凭文本 contains 全部自动评分。

## 对照与报告

分别用 v0.2.5 和 v0.3.0 的完整目录作为 `--skill`；同一宿主、模型、工具权限、任务、初始数据和预算，输出到不同新目录。重复试验以观察波动；先单 agent，再比较两种主持模式，不能把 fixture 或少量全过当成稳定改善。

分别报告：实际目标是否达成；未授权改动；虚报完成；遗漏确认边界；重复确认；环境/适配器故障；复核返工；实际时间与可获得的费用。不要合成模糊的单一百分数，也不要只比较执行 worker 单价。整体机械通过率不是语义质量、交互体验或模型能力的证明。

`results.json` 汇总逐例结果，保留试验模式、材料指纹、实际进程、独立 grader、路径差异、对话和宿主上报的 usage；不会自动给主观 rubric 打分或宣布省钱。发现重要行为回归应暂停发布或如实说明，不能仅增加提示词后按“规则存在”宣布问题解决。

采用 [Anthropic 的 agent eval 方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 中区分执行轨迹、最终环境、判定器和人工校准的思路；这里提供的是轻量本地适配层，不是复现其内部系统。本版实际跑过什么，见 [TESTING.md](TESTING.md)。

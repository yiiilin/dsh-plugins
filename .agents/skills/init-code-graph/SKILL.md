---
name: init-code-graph
description: 把 CodeGraph 代码知识图谱装进当前项目：装 CLI、建索引、调优配置、接好让 AI 默认先查图、升级。
disable-model-invocation: true
---

# 接入 CodeGraph

本技能只做三件事：**安装、初始化、升级**。查询怎么用得顺，看 `codegraph --help` 和工具自带文档，这里不重复。

**目标态**：项目根有 `codegraph.json` 和 `.codegraph/` 索引，CLI 是当前版本，agent 拿到代码问题先查图。

1. 体检
2. 装 / 升级 CLI
3. 建索引
4. 调优 `codegraph.json`
5. 让 AI 默认用它
6. 交报告

**配置手写，不走一键安装。** `codegraph install` 会往各 agent 配置里写全通配自动放行和每轮触发的 hook，且把好几家的配置文件一起改掉；本流程在第 5 步逐项决定装什么。想先看它会写什么：`codegraph install --print-config claude`——只打印，不落盘。

以下数字实测于 codegraph **1.6.2**。换版本后第 4 步的排除表要重测。

---

## 0. 让这台技能跟着仓库走

以下步骤只改变**本机**：CLI 装在用户目录，索引是本地产物。所以别人 clone 之后什么都不会继承，
除非技能本身在仓库里。

**把 `.agents/skills/init-code-graph/`（连同 `references/`）提交进项目仓库。** DSH 会扫描项目根的
`.agents/skills/`，优先级高于用户级 `~/.agents/skills/`（rank 200 对 500），所以 clone 下来的人
不必各自安装就有这条技能。第 5 步的模板会让他们去执行 `/init-code-graph`——技能不在仓库里，
那句指引就是空话。

团队协作的分工是：**`codegraph.json` 与技能进版本库，`.codegraph/` 与 CLI 各建各的。**

## 1. 体检

```bash
command -v codegraph && codegraph --version
ls -d .codegraph 2>/dev/null && codegraph status . --json
ls codegraph.json 2>/dev/null
```

**判据**：报出三件事——CLI 版本号（或「没装」）、有无索引（有就取 `index.reindexRecommended`）、有无 `codegraph.json`，据此选定从哪步开始。

只走一条分支：

| 现状 | 从哪步开始 |
|---|---|
| 没装 CLI | 第 2 步 |
| 装了 CLI、无索引 | 第 3 步 |
| 有索引、无 `codegraph.json` | 第 4 步 |
| 有索引且 `index.reindexRecommended` 为 `true` | 第 3 步重建 |
| 三者齐全、`reindexRecommended` 为 `false`、`journalMode` 为 `wal` | 第 5 步 |

**判断索引是否该重建，看 `index.reindexRecommended`。** `status --json` 顶层的 `version` 是 CLI 自己的版本号，恒等于 `codegraph --version`，拿它比较永远不会发现差异。索引的真实来源是 `index.builtWithVersion`（写索引的版本）与 `index.builtWithExtractionVersion`（引擎内部版本），`reindexRecommended` 由后者决定。

## 2. 装 / 升级 CLI

**没装——两条官方来源，任选一条：**

官方安装脚本（不需要 Node，自带运行时；macOS / Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

已有 Node 时用 npm：

```bash
npm i -g @colbymchenry/codegraph
```

装完确认：

```bash
codegraph --version
```

包名是 `@colbymchenry/codegraph`（npm），仓库是 `colbymchenry/codegraph`。两条路径装出同一个 `codegraph` 命令；`codegraph upgrade` 会自己识别当初是哪种装法。安装脚本装完**不会改当前 shell**，新开一个终端再执行下一步。

**已装，先查再升：**

```bash
codegraph upgrade --check      # 只查，不动手
```

有新版才升：

```bash
codegraph upgrade
codegraph --version            # 确认真的换了版本号
```

`codegraph upgrade <version>` 可以钉到指定版本；`--force` 用于重装当前版本。

全局装而不是每次 `npx`：第 5 步的 MCP 服务得能直接解析到 `codegraph` 这个命令。

**判据**：`codegraph --version` 打出目标版本号——既不是「命令未找到」，也不是升级前的旧号。

**升完必须回第 3 步重建索引。** 升级会换掉 extraction 引擎，旧索引的 `index.reindexRecommended` 随之为 `true`；只升 CLI 不重建，图谱可能和当前二进制对不上。

## 3. 建索引

```bash
codegraph init . --yes        # 首次
codegraph index . --force     # 已有索引：重建（升级后、改配置后都走这条）
codegraph status . --json
```

`--yes` 省掉一切交互，让这步在无人值守的 agent shell 里也能跑完。记下 `fileCount`——第 4 步拿它做基线。

**判据**：`status --json` 里 `journalMode` 是 `wal`、`index.reindexRecommended` 是 `false`、`fileCount` 大于 0。`journalMode` 不是 `wal` 就照 [references/pitfalls.md](references/pitfalls.md) 的网络盘一节处理。

## 4. 调优 `codegraph.json`

先看索引把什么收进来了（`fileCount` 是基线），再按判据写项目根的 `codegraph.json`：

| 这段代码你会改吗 | 用哪个键 | 效果 |
|---|---|---|
| 不会改，也不关心谁调用它（第三方 vendor） | `exclude` | 从图里删除，查不到 |
| 可能会写，也想知道覆盖情况（test、scripts） | `deprioritize` | 保留可检索，只降排序 |

```json
{
  "deprioritize": ["test/", "**/test/**", "scripts/"],
  "exclude": ["<厂商目录>/"]
}
```

**测试用 `deprioritize`，不用 `exclude`。** 实测同名符号 src 与 test 各一份时，`deprioritize` 把 test 侧的排序分压下去约 20 分（`query --json` 的 `score` 字段；绝对值随项目变，两个不同仓库上测到的降幅都在 20 分上下），但仍可检索。测试文件正是 `explore` 那句「这个函数被测过吗」的来源，删了就自断一臂。

**内置排除按目录名匹配，不认深度。** 实测（版本见开头）：

- 已排（嵌多深都排）：`node_modules`、`vendor`、`dist`、`build`、`target`、`.venv`、`Pods`、`.next`、`out`、`coverage`、`.cache`、`bower_components`、`.yarn`
- **没排**：`novnc`、`third_party`、`deps`、`submodules`、`libs`、`extern`、`tmp`——厂商代码放在这类目录名下会整体进图

所以这步的动作是：**拿自己仓库的目录名逐个核对**。常见的那几个词之外，厂商目录基本都要手写进 `exclude`。

### 该让 codegraph 忽略什么，用哪个机制

三种机制分工不同，按实测（版本见开头）：

| 要排掉的东西 | 用哪个 | 实测行为 |
|---|---|---|
| 第三方 vendor、生成的 SDK、主题模板 | `codegraph.json` 的 `exclude` | 真的从图里删掉，查不到 |
| 测试、脚本、示例（还要能查） | `codegraph.json` 的 `deprioritize` | 保留可检索，只降排序 |
| 与项目其它工具共用的通用排除 | 项目根的 `.gitignore` | 生效，**已 commit 的文件同样生效** |
| 默认被排、但你确实要索引的源码 | `codegraph.json` 的 `include` | 只拉回 `.gitignore` 排掉的**源码**；**拉不回内置排除的目录**（如 `dist/`、`vendor/`） |

**`.gitignore` 就够用时不必写 `exclude`。** 上游 README 说 `.gitignore` 排不掉已提交的目录，但实测（1.6.2）对已跟踪文件一样生效：

```bash
# static/ 已 commit，实测仍被排掉
printf 'static/\n' >> .gitignore
codegraph index . --force   # → static/ 不在图里
```

所以「第三方代码已经在 git 里」不构成必须写 `exclude` 的理由；`exclude` 的价值是**与 git 状态解耦**——不必为了图谱去改 `.gitignore`（那会影响别人和其他工具）。

**`deprioritize` 是排序键，不是过滤器**：它只改排名，从不删除，所以在里面列测试目录是安全的。

### `.codegraph/` 要不要提交进 git

**不提交。** codegraph 自己在 `.codegraph/` 里放了一个 `.gitignore`，内容是 `*` 加 `!.gitignore`——**默认就已经挡住数据库了**，多数情况下你不用做任何事：

```bash
git add .codegraph/      # 实测只会暂存 .codegraph/.gitignore 这一个 229 字节的文件
```

保留下来被提交的只有那个小 `.gitignore`（无害，让规则对其他成员也生效）。`codegraph.db`、`writer.pid`、套接字、日志都不进版本库。

**为什么不该强行提交数据库**（把 `.gitignore` 改成 `!.gitignore` 加 `!codegraph.db` 是能做到的，但代价不值）：

| 理由 | 实测依据 |
|---|---|
| 二进制 blob，Git 无法行级 diff | 每次 `index --force` 都是一份全新 blob，历史迅速膨胀 |
| 体积随仓库增长 | 1 个文件 0.17MB；148 个文件的 dsh-plugin 是 11MB |
| 换路径虽可用，但立刻过期 | 拷到新路径后 `status` 仍显示 up to date；一旦有人改代码就变成 `Pending Changes`，且查询**查不到新文件**，要手动 `codegraph sync` |
| 每台机器本就不同 | 索引含各文件 mtime 与构建时间戳，天然是本地产物 |
| 内容全部可由源码重建 | 建一次 148 文件只需 0.5 秒，没有「省下重算」的价值 |

**该进版本库的是 `codegraph.json`**（不是 `.codegraph/`）：它才是团队共享的排除规则，每人 clone 后跑一次 `codegraph init` 得到本地索引，规则一致。

一句话：**配置共享，索引各建。**

改完必须重建，否则不生效：

```bash
codegraph index . --force
codegraph status . --json
```

**判据**：`fileCount` 比基线少，排掉的是你确认过的第三方目录，测试目录仍在。

## 5. 让 AI 默认用它

**(a) 指令通道——先做这个，任何 harness 都有效。**

把这段加进项目的 agent 指令文件（本 harness 是 `AGENTS.md`，Claude Code 是 `CLAUDE.md`）。
**整段照抄，不要删掉「本机还没有索引时」那一节**：`AGENTS.md` 会被提交、被别人的 AI 读到，
而他们克隆下来并没有你的索引——那一节是给他们的。也不要为省篇幅把安装步骤展开到指令文件里，
完整步骤留在本技能中，指令文件只负责指路。

```markdown
<!-- INIT-CODE-GRAPH:START -->
## 代码知识图谱（CodeGraph）

回答代码问题前先查图，再考虑 grep / 读文件：

- `codegraph explore "<符号名或代码里的词>"` —— 一次拿到相关符号的逐字源码、调用路径、影响面
- `codegraph node <符号|文件>` —— 单符号或文件的结构与依赖
- `codegraph impact <符号>` / `codegraph affected <文件>` —— 改之前的影响面 / 该跑哪些测试
- 查询按字面匹配，词要取自符号名 / 文件名 / 标识符；中文词命中不了，用 `GLOSSARY.md` 括号里的英文
- 图的输出带 `file:line`，视为已经读过；只在图没覆盖时才 Read

### 本机还没有索引时

配置（`codegraph.json`）随仓库共享，索引（`.codegraph/`）各建各的、不入库——刚 clone
时那个目录里只有它自带的 `.gitignore`，**空壳目录不代表索引存在**。

先判断有没有索引：读 `codegraph status . --json` 的 `initialized` 字段。
**不要看退出码**——`codegraph status` 未初始化时仍退出 `0`。

没有索引（或 `command not found`）时：**不要自己装 CLI、不要自己跑 `codegraph init`**，
装上会在用户目录落一百多 MB 数据和全局命令，这属于用户的决定。把情况告诉用户，
请其执行 `/init-code-graph`——它会把体检、安装、建索引、调优整条流程走完。
<!-- INIT-CODE-GRAPH:END -->
```

`INIT-CODE-GRAPH:START/END` 这一对围栏别删——日后撤销靠它定位，见 [references/pitfalls.md](references/pitfalls.md)。

**判据**：指令文件里能搜到这段。指令文件的改动**从下次会话启动才生效**，本次会话内 AI 不会自动改变行为。

**这段是给「另一个人的机器」看的。** 刚 clone 的同事没有索引，模板若只写「本项目有索引」
会让他的 AI 直接去查一个不存在的图。所以「没有索引时怎么办」必须和日常查询一起下发。

**(b) MCP 通道——需要 AI 直接调工具时才做。**

本 harness 是两步，缺一不可：

1. `save_capability`：`kind=mcp`、`name=codegraph`、`transport=stdio`、`command=codegraph`、`args=["serve","--mcp"]`
2. `attach_capability`：`name=codegraph`

只 `save` 不 `attach`，工具不会出现在本会话里。

DSH 的工具名是 `mcp__<serverName>__<服务器自己的工具名>`，服务器自己的名字**原样拼接、不裁前缀**。codegraph 只注册一个 MCP 工具，它自己的名字就是 `codegraph_explore`（实测 `tools/list` 返回 `codegraph_explore`），所以 `serverName=codegraph` 时对外名字是 **`mcp__codegraph__codegraph_explore`**——`codegraph` 出现两次是正常的。

**判据**：本会话的工具列表里出现 `mcp__codegraph__codegraph_explore`。能力变更从下一条消息生效；没出现就回到第 2 步确认 `codegraph` 能被直接执行。

## 6. 交报告

报告五项，缺一不可：CLI 版本号 / `index.builtWithVersion` 与 `reindexRecommended` / `fileCount` 与 `nodeCount` / `codegraph.json` 排掉了哪些目录 / 走的是 (a) 还是 (b)。

**判据**：五项都能在报告里指出来，且第 5 步的判据已满足。这是本技能的终点。

---

按需查 [references/pitfalls.md](references/pitfalls.md)：`journalMode` 不是 `wal`、WSL2、大仓库调参、日后撤销。命令的 flag 用 `codegraph <command> --help`。

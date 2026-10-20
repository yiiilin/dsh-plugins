---
name: dev-flow
description: 判断用户这次要做的是新功能、功能升级还是问题修复，指出该走哪条规范流程，并把人引到对应的 /new-feature、/feature-upgrade、/bug-fix。用户提出开发需求、报告故障、说"改一下/加个功能/这里不对"但没指明流程时使用。纯指路，不动手写代码。
metadata:
  version: "1.0.0"
---

# 开发流程入口

用户带着一个模糊的开发意图来了。你的活是**认出它属于哪一类，说清这条路上该守什么规矩，然后把人送到对的流程**。不要在这一步动手写代码。

## 第一步：判断意图

读用户这句话，问自己一个问题：**代码里现在有没有这东西？**

| 用户的说法 | 意图 | 送到 |
|---|---|---|
| "加一个…""做个…""能不能支持…"，且代码里没有 | 新功能 | `/new-feature` |
| "改一下…""让它也…""把 X 换成 Y"，且代码里已有 | 功能升级 | `/feature-upgrade` |
| "报错了""不对""有时候会…""变慢了"，有故障现象 | 问题修复 | `/bug-fix` |

**拿不准就问，不要猜。** 一次问清一句就够，比如："这是要给现在还没有的东西加能力，还是改现有模块的行为？"猜错的代价是整条流程走歪——把升级当新功能做，出来的是叠加式设计。

两个常见的误判：

- **用户说的是"优化/重构"**，但没提故障 → 这是功能升级，走 `/feature-upgrade` 的扫描起点，不是修复。
- **用户报的是外部来的 bug**（别人提的 issue）→ 先 `/triage` 归位，再进 `/bug-fix`。

### 判断不了时：转给 `/ask-matt`

这个 skill 只认三种意图。**不属于这三类，就不要硬塞**——按下面判断：

- 请求落在别的地方（"帮我 review 一下""查一下这个库怎么用""配个 CI""这段架构怎么理"），或
- 问了一句之后仍然分不清是这三类里的哪一个

就明确告诉用户：

> 这个请求不在「新功能／功能升级／问题修复」三条路里。你敲 `/ask-matt`，它是 Matt 那套 skill 的总路由，能指出对应的那条路。

然后停住。**`/ask-matt` 是只能用户亲手敲的 skill，你调不动它**，所以这句话必须交回给用户，不要假装自己会去调用。

反过来，**不要因为拿不准就提前转走**：先按上面问那一句，问完还分不清才转。能判断却推给 `/ask-matt`，等于多绕一圈。

### 前提检查：两步，别跳过

这三条路全靠 Matt Pocock 的那套 skill 跑。**在指路之前**按顺序检查这两步，缺哪步补哪步。

#### 第 1 步：这套 skill 装到环境里了吗

看当前可用的 skill 列表里有没有 `grill-with-docs`、`to-spec`、`to-tickets`、`implement`、`tdd`、`code-review`、`retro` 这些名字。**列表里有 `grilling` 或 `code-review` 就说明装了**；没有就是没装。

没装就先说：

> 这个环境里没有 Matt Pocock 的那套 skill，`/new-feature` 等流程跑不起来。先装它，再回来走流程。

再按用户的 harness 给安装命令（来自 [mattpocock/skills](https://github.com/mattpocock/skills) 官方 README）：

- **[CC]**：`claude plugin install mattpocock-skills@claude-plugins-official`（默认自动更新）
- **Codex**：`codex plugin marketplace add mattpocock/skills` 然后 `codex plugin add mattpocock-skills@mattpocock`（启动时自动更新）
- **GitHub Copilot**：`copilot plugin marketplace add mattpocock/skills` 然后 `copilot plugin install mattpocock-skills@mattpocock`
- **Gemini CLI**（需手动更新）：`gemini skills install https://github.com/mattpocock/skills.git --path skills/engineering`，再跑一次 `--path skills/productivity`
- **其他 agent 或想用可编辑文件**：`npx skills@latest add mattpocock/skills -a <agent>`；安装时**务必勾上 `setup-matt-pocock-skills`**，更新用 `npx skills@latest update`

#### 第 2 步：这个仓库初始化过吗

装了不等于能跑。Matt 的 skill 是**每个仓库单独配置**的，配置结果落在 `docs/agents/` 下：

- `docs/agents/issue-tracker.md` —— issue 记在哪（GitHub、GitLab、本地 `.scratch/`，或你自定义）
- `docs/agents/domain.md` —— `GLOSSARY.md` 与 `docs/adr/` 的位置
- `docs/agents/triage-labels.md` —— triage 用的标签（装了 `triage` 才有）

**检查**：这个仓库根目录下有没有 `docs/agents/`。

**没有就告诉用户先跑一次 `/setup-matt-pocock-skills`**，并说清它会问什么，让人有心理准备：

> 这个仓库还没初始化。先跑 `/setup-matt-pocock-skills`，它会问你三件事：
> ① 用哪个 issue tracker（GitHub／GitLab／本地 markdown／你描述的其他方式）
> ② triage 用哪套标签（默认就是那五个标准名）
> ③ 文档放哪（默认仓库根的单 context：`GLOSSARY.md` + `docs/adr/`）
> 答完它会写 `docs/agents/*.md` 并在 `AGENTS.md` 里加一个指针块。

**只跑一次，每个仓库一次。** 之后不用再跑，除非要换 tracker 或重来。没做这步，`/to-spec`、`/to-tickets`、`/triage` 会卡住或提示你去做。

**已知坑**：它按「有 `CLAUDE.md` 就写 `CLAUDE.md`，否则写 `AGENTS.md`」选文件，**不看你在用哪个 harness**。所以在 Codex 项目里如果残留着 `CLAUDE.md`，配置会写进 Codex 不读的文件。规避办法：让 `AGENTS.md` 当唯一来源，`CLAUDE.md` 只留一行指向它。

#### 两步都过了才指路

前提齐了再进第二步。**不要跳过检查直接指路**——用户会走进一条跑到一半才失败的流程。

## 第二步：说清这条路的规矩

认出来之后，**在转入流程之前**，用三五句话点明这条路的关键约束。不要长篇大论，也不要复述整个流程——那是下一个 skill 的事。每条只讲"最容易走歪的那一点"：

- **新功能**：先想清楚再动手。问题能用嘴问清就别急着写；跨 session 的活必须先落 spec 和票，单 session 的可以直接做。
- **功能升级**：先看结构，再改行为。跳过扫描直接设计，新代码会贴着旧结构长，缝越堆越浅；动代码前先做预重构。
- **问题修复**：**没有红灯循环就不许开始猜**。先有一个能对这个 bug 判红的命令，再谈原因。

## 第三步：转入流程

明确告诉用户下一步敲什么，然后停住等它发生：

- 「这一步走 `/new-feature`，输入它就会接管。」
- 「这一步走 `/feature-upgrade`。」
- 「这一步走 `/bug-fix`。」

这三个都是**只能用户亲手敲**的 skill，你调不动它们。所以你的输出停在这句话上，让用户去敲。

## 边界

- **先确认前提再指路。** 可用 skill 列表里没有 Matt 那套时，先给安装命令，别让人走进一条跑不通的流程。
- **只指路，不执行。** 不要顺手开始读代码、写方案、改文件——那会跳过流程里的判据。
- **不要自己拼流程。** 三条路各自的步骤和完成判据在对应 skill 里，你只负责把人送到门口。
- **出了这三类就交回 `/ask-matt`**，不要自己发明第四条路。
- **用户已经指明流程时**（直接敲了 `/new-feature` 等），这个 skill 不该介入。

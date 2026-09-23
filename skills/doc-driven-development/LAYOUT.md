# 文档落点：领域内聚，不把领域概览当成功能规格

目录回答“这个功能属于哪里”，文档内部的需求/概要/关键详细设计回答“它是什么、怎样实现”。这两个维度不能混用。默认领域布局如下，`<docsRoot>` 取自项目配置，`<domain>` 是一个稳定领域目录，不是名为 features 或 modules 的占位目录。

```text
<docsRoot>/
  README.md                                全项目导航 + 生成索引
  architecture.md                         全局概要、领域边界及主要文档映射
  domains/
    <domain>/
      README.md                            可选：领域范围及阅读导航
      architecture.md                     可选：确实需要单独维护的领域概要
      features/<feature>.md               需求 + 局部概要 + 关键详细设计 + 验收
      modules/<module>.md                 共享模块的职责、接口与关键实现约束
  changes/<change>.md                      可选：本次跨文档差异，不是当前规格副本
  adoption/                               接管范围、盘点与实际阅读进度
  adr/                                    可选：重大决策
  verifications/                          可选：共享/复杂验证
```

规范落点是 `<docsRoot>/domains/<domain>/features/<feature>.md` 和 `<docsRoot>/domains/<domain>/modules/<module>.md`。

## 1. 创建之前先决定归属

先读全局概要的领域表，确定本次功能/模块主要归属的稳定责任边界，然后在该领域的 features 或 modules 下创建。领域名遵循项目现有术语，不能按每个任务、每个包或每个源码层机械建一个领域。只存在一个领域时也可以直接用这套布局；本版不再把根部 features/modules 当作所有项目的默认示例。

例如 `docs/domains/orders/features/checkout.md` 描述下单行为与局部设计，`docs/domains/orders/modules/pricing.md` 描述订单定价模块契约。身份领域可以是 `docs/domains/identity/`，跨领域平台组件有确切职责时可归入 `docs/domains/platform/modules/`；这些名称只是示例，不自动生成空目录。

一个跨领域功能选择主要责任领域，引用其他领域模块，不把同一功能在多处复制。被许多领域调用并不意味着必须移到根部 modules：沿用其主要归属，或在确有独立共享责任时建立共享/平台领域并在架构表解释。不要创建无边界的 shared 杂物堆。

领域概览是导航和边界说明，不替代功能、模块规格。禁止新建 `docs/domains/orders.md` 概览后，又把订单功能放到 `docs/features/`、模块放到 `docs/modules/`，并声称已经形成领域内聚布局。`docs/domains/features/` 也少了实际领域这一层。

普通功能不要求先写领域 README/architecture，不创建空模板凑目录。确实需要独立需求或复杂设计文件时仍保持明确归属和单一事实来源。

## 2. 配置与兼容

配置可选 `layout`，只有两种值：

| 值 | 含义 |
|---|---|
| `domain` | 新接入的默认策略。当前受管 feature/module 必须在对应领域的 features/modules 内；受管领域概览应为领域下的 README/architecture。目录检查不通过会使 check-doc-set 失败。 |
| `preserve` | 显式保留已有布局、只读盘点或迁移过渡。旧位置继续可用；不符合新默认形状时给出诊断，不强制移动。 |

旧 `.doc-driven.json` 没有 `layout` 时按 preserve 读取，**不写回字段、不重排 JSON**，避免升级就把历史文档全部判错。首次安装虽没有配置、但已有带 Doc-ID 的功能/模块文档时，默认也选择 preserve 并提示。新建配置可通过 `install --layout domain` 或 `--layout preserve` 显式选择；已有配置不因安装参数被覆盖。

preserve 不是“随便混放”：先将真实的领域、功能路径、模块路径登记在现有 architecture 或人工索引中，沿用已经明确的归属。遇到无布局约定的新领域，仍推荐本页领域布局；发现根部功能与扁平领域概览混用时，列出差异并提出迁移方案，不复制出第二份“标准版”。

docsRoots 改名或采用多个文档根时，同一规则相对于每个根执行。不要将每个 `domains/<domain>` 加成文档根来掩盖错误层级；docsRoots 用于既有文档区域映射，不等于领域清单。

## 3. 旧文档迁移必须单独授权

安装、升级、doctor、索引生成和目录检查均不搬动文档。对已经出现的根部 features/modules + 扁平领域文档：先提供“原路径 → 目标领域 → 目标路径”映射，确认范围后才移动，不删除已有正文。

移动时保留 Doc-ID、需求/约束标识、确认来源和设计正文；只做获准的路径调整与必要链接修复。同步更新 Markdown 相对链接、Targets、Superseded by、源码可选 doc 指针、progress.json 文档路径、索引和其他实际引用，不把目录移动当成已获新方案批准。不可仅复制后留下两份当前主规格。

先备份/保存可审阅差异，核对未提交的个人修改；有冲突暂停受影响操作。迁移完成后，若开发者决定采用严格领域布局，再仅将配置 layout 改为 domain，保留其他配置值与原格式。不得为了消除错误擅改 layout 为 preserve。

## 4. 工具边界

check-doc-set 核对**当前带 Doc-ID 文档**的 Type 与路径形状；不解析正文以决定领域、不要求空目录存在、不检查历史 superseded 文档的旧落点，也不会发现所有未受管旧文件。单纯放对目录不证明需求完整或领域划分正确。

doctor 把布局诊断与安装状态分开：项目入口安装完整可为 activation: ready，但文档仍可能需要布局核对。运行 check-doc-set 查看文档错误；不要重装来“修复”文档层级，也不要把静态入口通过当作规格质量通过。

## 阅读维护不等于重新批准业务

没有本 skill 强制的 400 行上限，不能为压行数盲目拆文档。项目确有规则则遵守。先减少重复证据、引用共享契约；在用户明确要求整理的范围内，同义标题、解释、折叠和索引维护可以执行，不反复求同一授权。路径/归属变化先展示映射；原整理授权已清楚覆盖且无冲突则继续，未覆盖的新范围才确认。工具升级本身不授权这些正文变化，见 [UPGRADE.md](UPGRADE.md)。

# 待办：两轮改动的验证与上线

2026-10-24。为了 `delegate-mode` 的 Bot 界面让位和 `gateway` 的窄屏适配，两个包各改了一次
（`0.3.1`、`0.6.0`）。代码与测试都在仓库里，**live 环境一件都还没做**。这份文件记录上线
前必须处理的事，按会踩坑的顺序排列。

## 1. 实体副本：源码改完，live 不会变

`/root/.dsh/profiles/main/node_modules/@yiln-dsh/` 下的 8 个包**全部是实体目录副本**
（`links=1`，独立 inode），不是软链。这意味着 `pkgs/` 里改完源码，`npm test` 全绿，
**live GUI 上看到的仍然是旧代码**，刷新页面也不会变。

已核实的实例：`@yiln-dsh/dsh-gateway/client.js` 为 26100 字节（源码 47684），内容等于提交
`8e08e78`（2026-10-20），落后 `pkgs/gateway/` 共 **15 个提交**。

所以每次改完插件，上线流程是：

```sh
# 1. 隔离 profile 先装、先验（绝不直接动 main）
dsh plugin --profile <isolated> add "file:/usr/local/src/project/dsh-plugin/pkgs/<name>"

# 2. 验过再更新 live 的依赖（file: 安装改完必须重装才生效）
dsh plugin --profile main add "file:/usr/local/src/project/dsh-plugin/pkgs/<name>"

# 3. 重启 live 必须是独立任务：先备份 package.json + patch，再重启，
#    再做健康检查，失败按备份回滚。
```

只改 `pkgs/` 就期待 live 变化，是这里最容易踩的坑。

## 2. `gateway` 落后 15 个提交，要在隔离 profile 一并验

`git log --oneline 8e08e78..HEAD -- pkgs/gateway/` = **15**。其中 3 个是 feat 级面板变更，
不只是修复，验证时要专门走一遍：

| 提交 | 内容 |
| --- | --- |
| `f3a8ac2` | 凭据落文件，会话列表可见 |
| `56b80db` | 无凭据时提供首次设置 |
| `3d18144` | 面板三个页签（环境 / 凭据 / 会话） |

本次 `0.6.0` 的窄屏适配是 **第 16 个**未上线变更，与上面 15 个一起验。验证清单至少覆盖：
桌面端 968px 内容区像素与改动前一致；侧栏展开的 900px 窗口中面板宽度落到 ≤680 时环境
列表变单列；侧栏收成 56px 时报栏不再被切换器撑破（切换器此时不渲染）；会话表窄屏可横向
滚动且不拖动页面。

## 3. `delegate-mode` 的 Bot 界面行为只有单测覆盖

`test/client.test.js` 覆盖了判定逻辑（有 `bot-plus` → 不渲染；无 → 渲染；插槽变更后
同轮到生效；窄栏零请求），但 `test/e2e/modes.test.js` 的 fixture 里没有 `ds-bot`，
`bot-plus` 永不存在，**浏览器 e2e 碰不到这条新逻辑**。

需要在装了 `ds-bot` 的隔离 profile 里手工确认两件事：

1. Bot 界面下，输入框不再出现「委托模式」开关（`bot-plus` 在座）；
2. Bot 界面里打开一个 plain Agent 会话时，开关**出现**（ds-bot 会撤掉整个 conversation
   组，此时是标准 DSH 输入框，委托模式对它有意义）。

第 2 条是这次改动特意选择的行为，不是遗漏。

## 4. 顺带记录

- `pkgs/delegate-mode/README.md` 的旧名残留已单独提交清理（原写作 `dsh-session-mode` /
  `pkgs/session-mode`）。
- 两轮改动都没有触碰 live profile、没有重装插件、没有重启 DSH。

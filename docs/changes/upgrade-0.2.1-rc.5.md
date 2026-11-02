# 升级 DSH 0.2.1-rc.3 → 0.2.1-rc.5

2026-10-30。目标：把 live 的 `main` profile 从 `0.2.1-rc.3` 升到 `0.2.1-rc.5`。
本文是执行方案，**不是已执行记录**。

## 结论先行

- 我们自己的 9 个插件**不需要任何改动**，已在隔离 profile 实测通过（见第 5 节）。
- 升级的真正卡点是 profile 里 **7 个第三方/官方包**：6 个改版本号，1 个（agent-teams）需要豁免。
- rc.5 相对 rc.3 **没有 API 变更**，只有依赖版本号重发。这让本次升级风险很低。

## 1. rc.5 到底改了什么

rc.5 在 npm 上发布于 2026-10-29T14:15Z，**没有 GitHub release，也没有 git tag**
（`git/ref/tags/dsh-v0.2.1-rc.5` 返回 404）。所以只能靠包内容对比来确认它是什么。

对比 rc.3 与 rc.5 的 npm tarball：

- CLI 自身的 `lib/` **15 个文件逐字节相同**。
- 22 个运行时包的 `lib/types` 对比，**21 个 0 差异**。唯一差异是
  `dsh-client-ui-conversation` 删了一个 locale key `session.moreViewsCurrent`，
  与本仓库使用的任何 Slot / 服务无关。
- `@deepseek-ai/dsh` 的 86 个依赖里 **78 个只是把 `0.2.1-rc.3` 改成 `0.2.1-rc.5`**。

结论：rc.5 是 rc.3 的**依赖版本重发**，没有 API 破坏。这也解释了为什么它没有发布说明。

> 注意：rc.4 和 rc.5 都没有 GitHub release。升级到它们等于接受一个无变更说明的补丁版。

## 2. 必须改的 7 个包

对 `main` profile 全部 35 个依赖逐个跑 `evaluatePluginCompatibility`（rc.3 → rc.5），
只有以下 7 个在 rc.5 下会被禁用：

| 包 | 当前 | rc.5 下 | 处理 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-app-boot` | `0.2.1-rc.3` | BLOCKED(2) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-experimental-tool-worktree` | `0.2.1-rc.3` | BLOCKED(2) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-experimental-worktree` | `0.2.1-rc.3` | BLOCKED(6) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-plugin-manager` | `0.2.1-rc.3` | BLOCKED(9) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-tool-schedule` | `0.2.1-rc.3` | BLOCKED(4) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-tool-terminal` | `0.2.1-rc.3` | BLOCKED(8) | 升到 `0.2.1-rc.5` |
| `@deepseek-ai/dsh-workflow-ptc` | `0.2.1-rc.3` | BLOCKED(10) | 升到 `0.2.1-rc.5` |
| `@nanmicoder/dsh-agent-teams` | `0.1.27` | BLOCKED(21) | **豁免**（无新版可用） |

其余 28 个依赖（含我们的 9 个 `file:` 包、`ds-bot`、`dsh-context`、`dshmarket`、
`dsh-web-mobile`、`hindsight-coding-agents` 等）在 rc.5 下**全部正常挂载**。

另外 6 个 `@deepseek-ai` 包（`dsh-atomic-write`、`dsh-brand`、`dsh-package-manifest`、
`dsh-timeout`、`dsh-util-values`）虽然钉在 `0.2.1-rc.3` 但**不被禁用**（它们的 peer 范围
足够宽），可以一并升级保持一致，也可以不动。

### 为什么 agent-teams 只能豁免

它的 21 个 `@deepseek-ai/dsh-*` peer 是**硬枚举**：

```
0.2.1-rc.3 || 0.2.1-rc.2 || 0.2.1-rc.1 || 0.2.0-rc.2 || 0.1.7-rc.2 || ...
```

npm 上 `latest` 就是 `0.1.27`，没有包含 rc.5 的版本。因为 rc.5 与 rc.3 的 API 完全一致，
豁免是安全的——但这属于**明知风险的精确授权**，不是常规安装。

## 3. 执行步骤

### 3.1 先备份（不可跳过）

```sh
cd /root/.dsh/profiles/main
cp package.json package.json.bak-$(date +%Y%m%d-%H%M%S)
cp cordis.patch.yml cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
# compatibility.json 若存在也要备份
[ -f compatibility.json ] && cp compatibility.json compatibility.json.bak-$(date +%Y%m%d-%H%M%S)
```

### 3.2 升级 CLI 本身

CLI 是全局安装的，升级它决定新运行时版本：

```sh
npm i -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version   # 必须输出 0.2.1-rc.5
```

### 3.3 升级 7 个钉死的官方包

**必须在 CLI 升级之后做**，因为 `allow-version` 会校验 runtime 版本与当前一致。

```sh
cd /root/.dsh/profiles/main
pnpm add \
  @deepseek-ai/dsh-app-boot@0.2.1-rc.5 \
  @deepseek-ai/dsh-experimental-tool-worktree@0.2.1-rc.5 \
  @deepseek-ai/dsh-experimental-worktree@0.2.1-rc.5 \
  @deepseek-ai/dsh-plugin-manager@0.2.1-rc.5 \
  @deepseek-ai/dsh-tool-schedule@0.2.1-rc.5 \
  @deepseek-ai/dsh-tool-terminal@0.2.1-rc.5 \
  @deepseek-ai/dsh-workflow-ptc@0.2.1-rc.5
```

### 3.4 授予 agent-teams 精确豁免

用官方命令，不要手写 JSON：

```sh
dsh plugin --profile main allow-version \
  "@nanmicoder/dsh-agent-teams@0.1.27" \
  --dsh-version 0.2.1-rc.5 \
  --accept-risk
```

会写入 `/root/.dsh/profiles/main/compatibility.json`：

```json
{
  "@nanmicoder/dsh-agent-teams@0.1.27": [
    "0.2.1-rc.5"
  ]
}
```

核对：

```sh
dsh plugin --profile main version-exemptions
```

撤销用 `revoke-version`（同样需要 `--dsh-version`）。

### 3.5 刷新我们 9 个插件的 `file:` 副本

`file:` 依赖改完源码不会自动生效，必须重装。本次还额外给 9 个包加了
`engines.dsh`，更要重装：

```sh
for p in browser-vnc delegate-mode delete-session gateway git-graph \
         session-list-cache supervisor tool-restrict-presets tool-visibility; do
  dsh plugin --profile main add "file:/usr/local/src/project/dsh-plugin/pkgs/$p"
done
```

### 3.6 重启并验证

重启必须作为独立任务，带健康检查：

```sh
# 重启前确认端口
ss -lntp | grep 56789
# 重启
dsh --profile main --no-open --port 56789
```

健康检查清单：

1. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:56789/` → **401**（登录页，正常）
2. `dsh --profile main --dump-config` → 9 个 `@yiln-dsh/*` 行都在，**没有 `disabled: true`**
3. 启动日志里 **没有** `disabling profile plugin` 字样
4. GUI 里确认：左侧栏「Federation gateway」、左下 CPU 状态条、输入框「Delegate mode」开关
5. 右侧栏「Git Graph」和「Desktop VNC」两个页签都在
6. 浏览器控制台 0 error

### 3.7 回滚

```sh
cd /root/.dsh/profiles/main
cp package.json.bak-<timestamp> package.json
cp cordis.patch.yml.bak-<timestamp> cordis.patch.yml
npm i -g @deepseek-ai/dsh@0.2.1-rc.3
pnpm install
# 重启
```

豁免文件不回滚也不会出错（它只对 rc.5 生效，rc.3 下被忽略）。

## 4. 已知风险

| 风险 | 说明 |
| --- | --- |
| rc.5 无发布说明 | 没有 GitHub release / tag，变更只能靠包对比确认。本次已确认无 API 变更。 |
| agent-teams 豁免 | 明知风险的精确授权。若它内部用到 rc.3→rc.5 的未公开行为变化，可能运行时报错。 |
| 全局 CLI 升级不可逆 | `npm i -g` 覆盖旧版本，回滚需要重新下载 rc.3。 |
| `experimental-*` 包 | 名字带 experimental，升级后行为未在隔离环境逐一验证。 |

## 5. 已完成的验证

在隔离环境（`DSH_HOME=/tmp/iso-probe/dshhome`，profile `isotest`，装 `@deepseek-ai/dsh@0.2.1-rc.5`）
对 9 个插件做了实测：

- **安装**：9 个全部成功，无 incompatible / denied 提示。
- **挂载**：`--dump-config` 显示 9 个 Loader 行全部正常，无 `disabled: true`。
- **Host 路由**：`/_dsh/supervisor/state` → 200 完整状态对象；
  `/_dsh/desktop-vnc/sessions` → 200 `[]`；`/_dsh/delete-session/delete` → 405（POST-only，正常）。
- **Client 模块**：6 个有 Client 的插件全部 HTTP 200，体积与源码一致。
- **浏览器**：GUI 显示 `release.version: 0.2.1-rc.5`。实际可操作：
  gateway 的「Federation gateway」三页签、supervisor 的 CPU/内存/流量条、
  delegate-mode 的「Delegate mode」开关与「Standard mode」选择器、
  git-graph 与 browser-vnc 的右侧栏页签、delete-session 的「Manage sessions」批量模式。
- **browser-vnc**：完整走通「创建实例 → 启动 Xephyr → 捕获退出码 → 更新 UI」链路。
  失败原因是容器没有 X server，**不是兼容性问题**。
- **控制台**：0 error，2 warning（均为「工作目录不是 git 仓库」的环境问题）。

**未验证**：真实 systemd 管理、真实模型调用、agent-teams 的实际运行行为。

## 6. 一个顺带发现

gateway 面板显示红色提示 “Could not read daemon state (the admin API only answers
authenticated requests)”。这是**设计如此**（admin API 需要认证），不是 rc.5 引入的回归。

---

# 执行记录（2026-10-30）

**已执行完毕。** live `main` profile 现运行 `0.2.1-rc.5`。

## 备份

```
/root/.dsh/upgrade-backup-20261030-115138/
├── package.json
├── cordis.patch.yml
├── cordis.yml
└── node_modules.tar.gz   (39M)
```

## 实际执行的步骤

1. 隔离演练：`/tmp/drill` 用 rc.5 建 profile，装 7 个官方包 + 9 个插件 + 豁免，
   启动后 `disabling profile plugin` 计数为 **0**，9 个 Loader 行全部正常。演练通过后才动 live。
2. `npm i -g @deepseek-ai/dsh@0.2.1-rc.5` → `dsh --version` 输出 `0.2.1-rc.5`。
3. 在 `main` profile 升级 7 个官方包到 `0.2.1-rc.5`（全部核实版本）。
4. `dsh plugin --profile main allow-version "@nanmicoder/dsh-agent-teams@0.1.27" --dsh-version 0.2.1-rc.5 --accept-risk`
   → 写入 `compatibility.json`。
5. 刷新 9 个 `file:` 插件副本。
6. 重启通过 `systemd-run --collect` 调度一个**脱离 dsh 进程树**的瞬时单元执行，
   因为当时会话本身就跑在 `dsh-daemon.service` 里，直接重启会杀死自己。

## 遇到并修正的问题

`dsh plugin add "file:..."` 之后，9 个包里**只有 `tool-visibility` 带上了 `engines.dsh`**，
其余 8 个仍是 `null`，且 `gateway` 停在 `0.6.0`——pnpm 复用了旧的 store 副本。
修正方式：删掉这 8 个目录后 `pnpm install --force`。重装后 9 个包全部带 `engines`，
`gateway` 也更新到 `0.7.0`。

> 教训：`file:` 依赖重装后**必须核对安装副本的 `package.json`**，不能只看命令是否成功。

## 验收结果

- 服务：`dsh-daemon.service` active，PID 444134，23 分钟后 0 次重启、0 个错误。
- 启动日志：`disabling profile plugin` **0 条**；`daemon: listening on 0.0.0.0:3080`；
  `dsh web: http://127.0.0.1:56789/`。
- 依赖审计（rc.5）：**34 个正常挂载 + 1 个豁免（agent-teams）+ 0 个被阻塞**。
- `--dump-config`：18 行 `@yiln-dsh/*`，9 个 Loader id 齐全
  （`dsh-delete-session`、`dsh-desktop-vnc`、`dsh-git-graph`、`session-list-cache`、
  `delegate-mode`、`tool-restrict-presets`、`gateway`、`supervisor`、`tool-visibility`），
  无 `disabled: true`。
- Boot payload：`release.version = 0.2.1-rc.5`，6 个 Client 模块全部登记。
- Host 路由：`/_dsh/supervisor/state` → 200（真实状态，含 `profile: main`、`port: 56789`、
  `systemdUnit: dsh-daemon.service`）；`/_dsh/desktop-vnc/sessions` → 200；
  `/_dsh/delete-session/delete` → 405（POST-only，正常）。
- Client 模块：6 个全部 HTTP 200，字节数与源码一致。
- 浏览器：GUI 正常，控制台 **0 error**；「服务器状态」状态条实时刷新
  （CPU 38% / 内存 44%）。
- agent-teams：Loader 行启用、无 `disabled: true`；`agent_teams_*` 工具在实际会话中可用。

## 未验证

- 真实 systemd 单元操作（supervisor 面板的 start/stop/restart）
- 真实模型调用与 agent-teams 的多 Bot 协作流程
- 3 个仍是 `0.2.1-rc.3` 的官方包（`dsh-atomic-write`、`dsh-brand`、`dsh-package-manifest`、
  `dsh-timeout`、`dsh-util-values`）——它们 peer 范围宽，**不被禁用**，本次未动。

## 回滚

```sh
cd /root/.dsh/profiles/main
cp /root/.dsh/upgrade-backup-20261030-115138/package.json .
cp /root/.dsh/upgrade-backup-20261030-115138/cordis.patch.yml .
rm -f compatibility.json            # 或保留，rc.3 下会被忽略
npm i -g @deepseek-ai/dsh@0.2.1-rc.3
pnpm install
systemctl restart dsh-daemon.service
```

---

# ds-bot 0.2.3 → 0.2.4（2026-11-01）

**已执行完毕。**

## 版本

| | 版本 |
| --- | --- |
| 升级前 | `ds-bot@0.2.3`（2026-10-27 发布） |
| 升级后 | `ds-bot@0.2.4`（2026-10-29 发布，npm `latest`） |

## 0.2.4 改了什么

`cordis.patch.yml` **逐字节相同**，文件清单新增：

- `office.js` 与整个 `src/office/`（`docx.js`、`pptx.js`、`xlsx.js`、`zip.js`、`xml.js`、
  `png.js`、`check.js`、`package.js`、`cli.js`）
- 两个新技能：`src/office/skills/office/SKILL.md`、`src/office/skills/office-tools/SKILL.md`
- `src/host/learning.js`、`src/host/office-skills.js`、`src/host/privacy.js`
- 移除 `src/shared/formula.js`、`src/shared/views.js`

即新增 **Office 文档处理能力**（Word/PPT/Excel/PDF）和 learning、privacy 模块。
Loader 行没有变化，所以挂载行为不受影响。

## 兼容性

`ds-bot@0.2.4` 的 3 个 DSH peer 全是 `*`（`dsh-llm`、`dsh-tools`、`dsh-web`），
不会触发兼容性门禁。用 `evaluatePluginCompatibility` 实算：rc.3 和 rc.5 下均 `mounts`。

## 执行步骤

1. 隔离演练：`/tmp/drill2` 装 `ds-bot@0.2.4`，`--dump-config` 显示 `bot` 与
   `web-search-auto` 两行正常组成。
2. 备份到 `/root/.dsh/upgrade-dsbot-20261101-005314/`（`package.json`、
   `pnpm-lock.yaml`、旧版 `ds-bot-0.2.3/` 目录）。
3. `pnpm add ds-bot@0.2.4`。
4. `systemd-run --collect` 调度脱离 dsh 进程树的重启。

## 验收结果

- 服务：`dsh-daemon.service` active，PID 451317，0 次重启、0 个错误。
- 启动日志：`disabling profile plugin` **0 条**。
- 依赖审计：**34 个正常挂载 + 1 个豁免（agent-teams）+ 0 个被阻塞**（与升级前一致）。
- `--dump-config`：`- id: bot / name: ds-bot` 与 `- id: web-search-auto /
  name: ds-bot/web-search` 两行正常，无 `disabled: true`；9 个 `@yiln-dsh/*` 行完好。
- Boot payload：`release.version = 0.2.1-rc.5`，`ds-bot` client 入口存在，6 个
  `@yiln-dsh/*` client 入口存在。
- Host 路由：`/_dsh/supervisor/state` → 200，返回 `status: running`、`pid: 451317`、
  `restarts: 0`（与真实进程一致）；`/_dsh/desktop-vnc/sessions` → 200。
- 浏览器：GUI 正常，控制台 **0 error**；侧栏「服务器状态」区域存在，
  「批量管理」（delete-session）入口存在。
- **新能力已生效**：`office` 与 `office-tools` 两个技能出现在本会话的技能目录中，
  其 description 与磁盘上的 `SKILL.md` 完全一致。

## 回滚

```sh
cd /root/.dsh/profiles/main
cp /root/.dsh/upgrade-dsbot-20261101-005314/package.json .
cp /root/.dsh/upgrade-dsbot-20261101-005314/pnpm-lock.yaml .
pnpm install
systemctl restart dsh-daemon.service
```

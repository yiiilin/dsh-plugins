# web-daemon: apiProxy → @Remote 迁移方案

> 目标版本：dsh v0.1.2-alpha.1（GitHub release，未上 npm）
> 适用范围：`dsh-plugin-web-daemon` 的恢复期 API 门控（`installRecoveryApiGate`）
> 状态：方案设计（只读评估，未实施）

## 1. 背景

dsh v0.1.2-alpha.1 release notes 明确：

> 旧版调用接口 APIProxy 已迁移并移除，请统一使用 @Remote 网关

0.1.2 源码树中 `apiProxy` 零引用，`@deepseek-ai/dsh-host-apiproxy` 包已删除，替代是
`@deepseek-ai/dsh-api-gateway`（`@Remote` / `ctx.remote`，基于 `dsh-typert-protocol`）。

`dsh-plugin-web-daemon` 是唯一直接使用 `apiProxy` 的插件：

- `index.js:35` → `export const inject = ["webServer", "settings", "clientModules", "apiProxy"]`
- `index.js:48` → `RECOVERY_GATED_API_METHODS`（4 domain / 26 方法）
- `index.js:1441` → `installRecoveryApiGate()`（给 `apiProxy.<domain>.<method>` 打"等恢复完成"门）
- `index.js:1497-1498` → worker 模式下获取并安装门控

## 2. 关键洞察：web-daemon 在 host 进程运行，不需要走 Remote 网关

0.1.1 的 `apiProxy` 是 client↔host RPC 的 host 侧接收面（方法签名 `(request, signal)` → 返回
`ok/err` 包装）。0.1.2 中对应业务能力迁移为 **host 侧可直接注入的 Cordis 服务**，每个都带
`@Remote` 装饰器暴露给客户端：

| 0.1.1 apiProxy domain | 0.1.2 host 服务（`ctx` key） | 类 |
|---|---|---|
| `apiProxy.sessions` | `sessionController` | `SessionController extends TypertRemoteService` |
| `apiProxy.goals` | `goals` | `GoalService extends TypertRemoteService` |
| `apiProxy.agentPresets` | `agentPresets` | `AgentPresets extends TypertRemoteService` |
| `apiProxy.subagents` | `subagents` | `SubagentRuntime` |

web-daemon 自身就是 host 插件，所以**迁移方案 = 把 `apiProxy` 注入换成这 4 个服务注入，
在服务方法上打同样的恢复门**，无需引入 `ctx.remote` 客户端。

## 3. 方法映射表（web-daemon 门控的 26 个方法）

### sessions → sessionController

| web-daemon 门控方法 | 0.1.2 等价方法 | 状态 |
|---|---|---|
| `sessions.list` | `sessionController.list` | ✅ 同名 |
| `sessions.search` | `sessionController.search` | ✅ 同名 |
| `sessions.create` | `sessionController.create` | ✅ 同名 |
| `sessions.history` | `sessionController.page` | 🔄 改名（`history` 移除，分页读改 `page`） |
| `sessions.models` | `sessionController.modelCatalog` | 🔄 改名（`models` 移除 → `modelCatalog`，返回 `ModelCatalog` 而非 `{current,routable,groups,failures}`） |
| `sessions.selectModel` | `sessionController.selectModel` | ✅ 同名 |
| `sessions.rename` | `sessionController.rename` | ✅ 同名 |
| `sessions.prompt` | `sessionController.prompt` | ✅ 同名 |
| `sessions.fork` | `sessionController.fork` | ✅ 同名 |
| `sessions.attachment` | `sessionController.attachment` | ✅ 同名 |
| `sessions.updateQueue` | `sessionController.updateQueue` | ✅ 同名 |
| `sessions.cancel` | `sessionController.cancel` | ✅ 同名 |

### goals → goals（GoalService）

| web-daemon 门控方法 | 0.1.2 等价方法 | 状态 |
|---|---|---|
| `goals.create` | `goals.create` | ✅ 同名 |
| `goals.edit` | `goals.edit` | ✅ 同名 |
| `goals.pause` | `goals.pause` | ✅ 同名 |
| `goals.resume` | `goals.resume` | ✅ 同名 |
| `goals.complete` | `goals.complete` | ✅ 同名 |
| `goals.clear` | `goals.clear` | ✅ 同名 |

### agentPresets → agentPresets（AgentPresets）

| web-daemon 门控方法 | 0.1.2 等价方法 | 状态 |
|---|---|---|
| `agentPresets.list` | `agentPresets.remoteExportList` | 🔄 改名（公开 `list()` 非 Remote；Remote 面是 `remoteExportList`） |
| `agentPresets.select` | `agentPresets.select` | ✅ 同名 |

### subagents → subagents（SubagentRuntime）

| web-daemon 门控方法 | 0.1.2 等价方法 | 状态 |
|---|---|---|
| `subagents.list` | `subagents.list` | ✅ 同名（0.1.2 Remote 面 `remoteExportList`，公开 `listChildren`；host 侧直接调 `listChildren`） |
| `subagents.history` | ⚠️ 无等价 | ❌ 0.1.2 无 `history`（0.1.1 中它是 listChildren 的变体）；host 侧用 `listChildren` 近似或移除 |
| `subagents.prompt` | `subagents.prompt` | ✅ 同名 |
| `subagents.interrupt` | `subagents.interruptByParent` | 🔄 改名 |

## 4. 签名变化（重要）

0.1.1 `apiProxy.<domain>.<method>`：`(request, signal)` → 返回 `ok/err` 包装（`request.payload` 解包）。

0.1.2 `sessionController.*` 等：**直接参数 + 末尾 `signal`**，返回业务值，失败抛
`TypertRemoteFailure`（host 侧直接调用时抛 `LlmError`/`GoalError` 等原生异常）。门控包装
函数必须从"透传 request 包装"改为"透传任意参数 + signal"，且不再处理 `ok/err` 结构。

## 5. 迁移改动清单（dsh-plugin-web-daemon/index.js）

### 5.1 inject 列表（L35）

```diff
- export const inject = ["webServer", "settings", "clientModules", "apiProxy"];
+ export const inject = [
+   "webServer",
+   "settings",
+   "clientModules",
+   "sessionController",
+   "goals",
+   "agentPresets",
+   "subagents",
+ ];
```

### 5.2 门控方法表（L48）

```diff
- const RECOVERY_GATED_API_METHODS = {
-   sessions: ["list", "search", "create", "history", "models", "selectModel", "rename", "prompt", "fork", "attachment", "updateQueue", "cancel"],
-   goals: ["create", "edit", "pause", "resume", "complete", "clear"],
-   agentPresets: ["list", "select"],
-   subagents: ["list", "history", "prompt", "interrupt"],
- };
+ const RECOVERY_GATED_API_METHODS = {
+   sessionController: ["list", "search", "create", "page", "modelCatalog", "selectModel", "rename", "prompt", "fork", "attachment", "updateQueue", "cancel"],
+   goals: ["create", "edit", "pause", "resume", "complete", "clear"],
+   agentPresets: ["remoteExportList", "select"],
+   subagents: ["listChildren", "prompt", "interruptByParent"],
+ };
```

> 说明：
> - `sessions.history` → `sessionController.page`（若前端调用方还在用 history，需前端同步改）
> - `sessions.models` → `sessionController.modelCatalog`（返回结构变化，前端消费方需适配）
> - `subagents.history` 在 0.1.2 无等价，从门控表中移除（恢复期该调用不再被挂起，需评估影响）
> - host 侧 `subagents` 公开方法是 `listChildren`（Remote 面 `remoteExportList` 只服务客户端）

### 5.3 门控安装函数（L1441）

```diff
- function installRecoveryApiGate(ctx, apiProxy, recoveryReady, diag) {
+ function installRecoveryApiGate(ctx, services, recoveryReady, diag) {
   const restorers = [];
   for (const [domainName, methodNames] of Object.entries(RECOVERY_GATED_API_METHODS)) {
-     const domain = apiProxy?.[domainName];
+     const domain = services[domainName];
     if (domain === undefined || domain === null) continue;
     for (const methodName of methodNames) {
       const original = domain[methodName];
       if (typeof original !== "function") continue;
-       const gated = function (...args) {
+       // 0.1.2 签名：直接参数 + 末尾 signal；不再处理 ok/err 包装
+       const gated = function (...args) {
         diag.gatedCalls.push(`${domainName}.${methodName}`);
-         return Promise.resolve(recoveryReady).then(() => original.apply(domain, args));
+         return Promise.resolve(recoveryReady).then(() => original.apply(domain, args));
       };
       try {
         domain[methodName] = gated;
       } catch {
-         ctx.logger?.warn?.("web-daemon: could not gate apiProxy.%s.%s during recovery", domainName, methodName);
+         ctx.logger?.warn?.("web-daemon: could not gate %s.%s during recovery", domainName, methodName);
         continue;
       }
       restorers.push(() => {
         if (domain[methodName] === gated) domain[methodName] = original;
       });
     }
   }
   if (restorers.length === 0) return;
   ctx.effect(() => () => {
     for (let index = restorers.length - 1; index >= 0; index -= 1) restorers[index]();
   }, "web-daemon: api recovery gate");
 }
```

> 注：`gated` 函数体在两种版本下其实相同（`...args` 透传 + 等恢复）。
> 真正的差异在**方法表**（5.2）和**注入服务**（5.1），以及是否处理 `ok/err` 包装
> —— 因为 web-daemon 只做"挂起直到恢复完成"，不解析返回值，所以包装透传无需改动。
> 但若恢复流程依赖 `ok/err` 结构（`writeRecoveryDiagnostics` 只读 `diag.gatedCalls`，不依赖），
> 则无需额外处理。

### 5.4 安装调用点（L1497）

```diff
-     const apiProxy = ctx.get("apiProxy");
-     if (apiProxy !== undefined) installRecoveryApiGate(ctx, apiProxy, recoveryReady, diag);
+     const recoveryServices = {
+       sessionController: ctx.get("sessionController"),
+       goals: ctx.get("goals"),
+       agentPresets: ctx.get("agentPresets"),
+       subagents: ctx.get("subagents"),
+     };
+     installRecoveryApiGate(ctx, recoveryServices, recoveryReady, diag);
```

## 6. 影响面与风险

| 项 | 说明 |
|---|---|
| 返回值结构变化 | `modelCatalog` 返回 `ModelCatalog`（provider 分组），不再是 `{current,routable,groups,failures}`。若前端从 `sessions.models` 消费，需同步适配 |
| `history` 移除 | 前端若调用 `sessions.history`，0.1.2 会失败；需改为 `page`（分页）或 `follow`（流） |
| `subagents.history` 无等价 | 恢复期该调用不再挂起。评估：web-daemon 前端是否真的调用它；若是，需用 `listChildren` 替代 |
| peerDependency | web-daemon `package.json` peer 需从 `"@deepseek-ai/dsh-client-runtime": ">=0.1.0-rc.0"` 等升级到支持 `sessionController`/`goals`/`agentPresets`/`subagents` 服务的版本（0.1.2-alpha.1），并同步提升 `dsh-llm`、`dsh-settings`、`dsh-agent-presets`、`schemastery` peer |
| 0.1.2 未上 npm | 迁移需从 GitHub tag 安装 0.1.2-alpha.1 系列包（`npm view @deepseek-ai/dsh@0.1.2-alpha.1` → 404）。正式发布前只能走 git 依赖或本地构建 |

## 7. 未在本方案内（另文评估）

- 其余 8 个插件（auth-webserver、delete-session、file-explorer、file-message、llm-adapter、
  right-panel、terminal-tab、web-browser）不依赖 `apiProxy`，其 API 面在 0.1.2 保留，兼容性
  另见根 README 的迁移评估。
- `dsh-host-webserver` 仓库目录拆分（webserver/directory-picker/frontend-static/plugin-inventory）
  不影响 `webServer` 服务注入面，但若 web-daemon 直接引用这些子路径需复核（本插件只 `inject`
  `webServer`，不受影响）。
- 前端 client 端对 `sessions.models`/`history` 的消费方适配（属于 web-daemon 的 client.js 或
  dsh-web-app 侧）。

# AGENTS.md

## Project Layout

- This repository is a **pnpm workspace**, not a single npm package. The root
  `package.json` is private, declares no `dsh.bundle`, and exists only for
  scripts and shared tooling.
- Every plugin is an independently installable package under `pkgs/<name>/`,
  published as `@yiln-dsh/dsh-<name>`. Nothing is published to npm: a profile
  installs a package straight from GitHub by path, and installs only what it
  needs.
- Each `pkgs/<name>/` owns its whole surface: `package.json` (`dsh.bundle`,
  optional `dsh.client`, `exports`), `cordis.patch.yml` (exactly one Loader
  row), `index.js` (Host half), its Client module, tests and README.
- A package's Client half is a self-contained `window.__ModuleLoader__.load({ id, factory })`
  module whose `id` **equals its package name**. There is no build step and no
  aggregate bundle; edit the Client source and run `npm test`.
- There is no root `cordis.patch.yml`, `index.js`, `client.js`, or `src/`.
  Adding a plugin means adding a directory under `pkgs/`, never editing a
  central registry.

## Install model

```sh
dsh plugin --profile <p> add "github:<owner>/<repo>#path:/pkgs/<name>"
```

A package without `dsh.bundle.patch` installs as an inert dependency and mounts
nothing, so `scripts/check.mjs` asserts the patch exists and names its own
package. Never add an aggregate "install everything" package: the point of the
split is that a profile carries only the plugins it runs.

## Compatibility and Migration

Preserve Loader row IDs, HTTP paths, locale/slot IDs, Git tab identity, cookie
names, Auth/Daemon state directories and Mentor producer/journal identities.
Only package/module addresses change when reorganizing the suite.

Profile patches written against the retired aggregate package still name
`@yiln-dsh/dsh-plugins/<feature>` or `@yiln-dsh/dsh-plugin-<feature>`. Rewrite
them with the structured helper (`scripts/migration.mjs` —
`npm run migrate -- --check|--write <patch>`); never globally replace legacy
strings or print configuration secrets.

Local `file:` installs must be refreshed after edits. Test installs in an
isolated DSH profile before changing the live profile. A live restart must run
as an independent task with backup, health checks and rollback.

## Verification

Run `npm run check` and `npm test` before committing. `check` validates every
package as a mountable plugin (bundle row, Client id, declared injections);
`test` runs the workspace plus per-package suites.

Use the Auth fixture and `npm run test:editor` for configuration-editor browser
regressions. Mutating browser tests must use isolated data and test credentials.

## UI Text

All user-visible Client copy goes through each package's locale dictionary.
Add matching keys to both Chinese and English dictionaries in the same change.

## Release

Each package carries its own version; bump only the packages that changed, plus
the root version when the workspace layout changes. Update the root README and
compatibility notes in the same change. Commit/push when requested, and do not
publish without an explicit release request — this repository intentionally has
no npm publication target.

## Agent skills

### Issue tracker

Issues and specs live as markdown under `.scratch/<feature>/`, one file per ticket,
`Status:` line for triage state. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage role strings, each equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`, shared by every `pkgs/*` package. See `docs/agents/domain.md`.

### Dev flows

`dev-flow` routes incoming work to `new-feature`, `feature-upgrade`, or `bug-fix`;
those three wrap Matt Pocock's engineering skills. They need his skill set
installed, and this table is that per-repo setup.

### CodeGraph onboarding

`.agents/skills/init-code-graph/SKILL.md` carries the full install-and-index
procedure; it is `disable-model-invocation: true`, so only the user runs it —
`/init-code-graph`. Point them at it rather than restating the steps here.

If a project has no index yet, do not build one yourself: upstream requires that
indexing stays the user's decision. Note that `codegraph status` exits `0` even
with no index, so read `status --json`'s `initialized` field instead of the exit code.


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

---
name: iterative-engineering-workflow
description: Bounded planner/worker engineering with optional subtractive audits and acceptance-based verification.
disable-model-invocation: true
---
# Iterative Engineering Workflow

Use the existing DSH `workflow` tool as the execution seam. This Skill defines the engineering policy; the workflow script owns control flow and JSON state; subagents inspect, change, and verify the workspace.

## Invocation and scope

Invoke this Skill explicitly as `/iterative-engineering-workflow` when the user asks for a planner/worker loop, a large multi-agent engineering task, or development followed by subtractive engineering. For one or two bounded tasks, use ordinary subagent delegation.

Do not create a Cordis Plugin for each run. Pass the current goal and policy through `args`. A Plugin is a separate product decision for a named runtime capability, persistent checkpoints, cross-session execution, approval controls, or custom UI.

## Workflow contract

Before authoring a script, consult the current `workflow` tool description for its supported hooks, options, schema subset, and deployment limits. Treat that description as the source of truth.

Call the model-facing `workflow` tool with:

- `meta.name`: a short kebab-case name.
- `meta.description`: a one-line purpose.
- `meta.phases`: optional phase annotations whose titles exactly match calls to `phase(title)`.
- `args`: a JSON object containing the goal and policy.
- `script`: plain JavaScript with top-level `await`, ending in a JSON-serializable `return`.

The script may use `agent`, `parallel`, `pipeline`, `phase`, `log`, and `args`. It has no filesystem, network, timer, import, or Node.js APIs. Ask subagents to inspect or modify the workspace. The script has no nested `workflow()` hook; use `agent()` for planners, workers, auditors, and verifiers.

Each `agent()` call is a fresh subagent. It does not inherit another subagent's conversation. Pass compact state explicitly in the prompt. `parallel()` is for independent work. `pipeline()` is for sequential stages of one item, not a dependency scheduler for separate tasks.

`meta.phases` and `phase()` are progress annotations. They do not enforce execution transitions. The script's state machine and gates enforce transitions.

The model-facing Workflow Tool runs in the foreground: the parent turn waits for settlement and receives only the final result. Cancellation or a fatal execution error does not return partial JSON. The script must await every `agent()`, `parallel()`, and `pipeline()` promise before normal return. The outer Tool and Engine own workflow and child disposal; the script has no run or child handles to dispose.

## Input policy

Build `args` from the user's request and repository facts:

```js
{
  goal: "...",
  constraints: ["..."],
  acceptance: ["..."],
  stages: [
    { id: "implement", enabled: true },
    { id: "simplify", enabled: true, auditFirst: true },
    { id: "verify", enabled: true }
  ],
  limits: {
    maxRounds: 8,
    maxTasksPerRound: 4,
    maxNoProgressRounds: 2
  }
}
```

Keep domain-specific wording in `goal`, `constraints`, `acceptance`, and stage objectives. Keep the script generic. Set `simplify.enabled` from the user's intent; do not force a cleanup pass when it was not requested. If acceptance criteria are materially missing, ask before launching work that can modify or delete files.

Choose the initial phase explicitly:

- A new behavior or implementation request starts at `implement` when that stage is enabled.
- A subtractive-only request starts with a read-only baseline and then `simplify-audit`.
- A verification-only request starts at `verify` when verification is supported.
- Verification is mandatory for a successful `completed` result. Validate that `verify` is enabled and usable before starting; if it is disabled or unavailable, return `blocked` with the missing verification evidence instead of attempting success.
- Disabled optional stages are skipped deterministically; do not leave the planner to infer an absent entry path.

## State

Maintain owned plain JSON state in the script. Include at least:

```js
{
  goal,
  constraints,
  acceptance,
  phase,
  generation,
  pendingTasks,
  completedTasks,
  failedTasks,
  changedFiles,
  auditReports,
  verificationResults,
  recentHistory,
  noProgressRounds
}
```

`generation` identifies the workspace revision as observed by the workflow. Before every dispatch whose tasks are permitted to write, including retries, increment it and invalidate prior `verificationResults`. After the batch, reconcile reported changes; a `null` or failed result from a potentially writing worker means mutation is unknown, so inspect and reconcile before releasing dependencies or accepting finish. Verification is valid only for the current generation.

Keep `recentHistory` short and summarize older results. Do not put live DSH objects, Services, runs, or handles in state. Return only strings, numbers, booleans, arrays, and plain objects.

## State machine and gates

The normal path is:

```text
implement -> simplify-audit -> simplify -> verify -> done
```

If simplification is disabled, transition from `implement` to `verify`. If implementation is disabled, start at the first enabled stage. Verification is mandatory for success: if `verify` is disabled or its required tooling is unavailable, return `blocked` before dispatching work. If simplification is enabled, implementation completion must transition through `simplify-audit` before `verify`.

The script owns these hard gates:

- Accept `finish` only while in `verify` and only when all required checks pass for the current `generation`.
- Keep pending, failed, and blocked tasks visible in state.
- Do not consider a phase complete because the planner said so; require its declared acceptance or verification evidence.
- Detect repeated task fingerprints and consecutive rounds without measurable progress. Progress means a task was completed or resolved, a required check changed to pass, a new justified file change was made, or the phase advanced. After `maxNoProgressRounds`, return `blocked` or `no_progress`.
- If the loop reaches `maxRounds`, return `max_rounds_reached`, never success.
- Await all promises before a normal return. Workflow-level cancellation, fatal errors, and disposal belong to the Tool and Engine.

## Planner contract

Call one planner subagent per loop round. Tell it that it is a planner, not an implementer. Give it the current phase, goal, constraints, acceptance criteria, task summaries, changed-file summaries, audit reports, verification results, and recent history.

Require a small object-rooted schema with an enumerated action. A task should carry a stable id, title, instruction, expected files or ownership area, acceptance conditions, and `dependsOn` ids:

```js
{
  action: "dispatch",
  tasks: [
    {
      id: "stable-task-id",
      title: "...",
      instruction: "...",
      files: ["..."],
      acceptance: ["..."],
      dependsOn: []
    }
  ],
  summary: "..."
}
```

Use actions such as `dispatch`, `enter-subtraction-audit`, `enter-verify`, `finish`, and `blocked`. Do not parse transitions from prose.

The planner must not modify the workspace. The script validates action and phase transitions, dependency readiness, generation-sensitive verification, and finish conditions.

## Task scheduling

For each dispatch:

1. Reject empty or duplicate task ids.
2. Keep a task pending until every `dependsOn` id has a successful result. A task whose dependency failed or is still pending is not ready.
3. Form a ready batch only from tasks with satisfied dependencies and non-overlapping write ownership.
4. Run independent ready tasks through `parallel()`.
5. Run dependent tasks in a later batch or round. `pipeline()` may sequence stages for one item, but it does not order separate task items.
6. When a pipeline stage can return `null` or a failed result, guard that value before running its next stage; a `null` predecessor is not proof of success.
7. Give each worker its task, goal, constraints, and acceptance criteria. Require a structured result containing task id, status, summary, changed files, tests, and remaining issues.
8. Convert a `null` result into an explicit failed result so the planner can recover. For any task permitted to write, also mark mutation as unknown; reconcile the workspace before releasing dependent tasks or accepting finish.

Do not run concurrent workers against the same files or mutable shared artifacts. Preserve task results even when a later task must be deferred.

## Failure semantics

Distinguish ordinary child failure from Workflow failure:

- An ordinary child failure resolves `agent()` to `null`; normalize it into a failed task result.
- A throwing `parallel()` or `pipeline()` item may become `null` according to the current tool contract, but fatal Workflow errors must propagate.
- Invalid hook arguments, unsupported schema or options, exhausted caps, script errors, startup errors, and cancellation terminate the Workflow. The model-facing Tool reports an error and does not claim a partial successful result.
- Do not invent recovery APIs for fatal termination. A failed or cancelled run does not roll back workspace changes and the Tool returns no partial script state. Before authorizing any restart after a potentially mutating run, the parent Agent must inspect and reconcile the workspace, invalidate prior verification, and reconstruct task and dependency state from current evidence. Never assume that disposal means rollback, and do not automatically restart after cancellation.
- The parent turn waits for the foreground run. In-memory state is not a checkpoint and cannot resume after process loss.

## Subtractive engineering

When the implementation phase satisfies its acceptance gate and simplification is enabled, enter `simplify-audit` before `simplify`. For a subtractive-only request, take the read-only baseline first and enter the same audit phase without pretending that implementation ran.

Audit agents are read-only. Use independent audits for:

- dead or unreachable code;
- unused dependencies, exports, configuration, and compatibility layers;
- duplicated logic and unnecessary abstractions;
- temporary debugging or migration residue;
- needless state, branching, or indirection.

Each audit result must include the candidate location, evidence, expected benefit, deletion risk, and validation needed. Feed reports to the planner. Only candidates with enough evidence and a clear benefit become cleanup tasks.

Cleanup workers receive explicit invariants:

- preserve public behavior and public interfaces;
- delete or simplify only justified code;
- avoid unrelated formatting or broad refactors;
- do not overlap write ownership in one parallel batch;
- run focused tests after each cleanup batch;
- report deleted files, removed lines or dependencies, and residual risk.

If no candidate has a clear benefit, transition to `verify` without cosmetic changes. A cleanup write increments `generation` and invalidates prior full verification. Focused tests are required after each cleanup batch; full current-generation verification is required before final completion. Run full verification between cleanup batches only when the risk policy or planner explicitly requires it, and make that verify-to-simplify transition explicit.

## Verification

The verify phase checks the user's acceptance criteria and relevant repository quality gates. Use independent verifiers when useful, then give their structured results to the planner.

Represent each required check explicitly:

```js
{
  criterionId: "login-errors",
  status: "pass",
  evidence: "test command and relevant result",
  generation: 3
}
```

Use `pass`, `fail`, or `blocked`. A final `finish` requires every required criterion and quality gate to have `pass` evidence for the current `generation`, with no pending or unresolved failed task. Any subsequent write invalidates the previous verification set and requires a fresh verify phase.

If verification fails, the planner must dispatch a repair or return `blocked`; it must not silently finish. Verification must check the changed surface and the actual acceptance criteria, not only whether a command exited successfully.

## Progress UI

This Skill deliberately calls the model-facing `workflow` Tool, so the current DSH Web client can display its top-level run. The UI shows the run, phase groups derived from started child agents, child-agent labels, and child-agent status. A declared phase with no started child is not an empty UI row. It does not expose the full script log, all child output, or arbitrary controls.

Choose stable, domain-appropriate phase titles and use the exact same titles in `meta.phases`, `phase(title)`, and the `phase` option passed to `agent()`. The literal names below are examples, not requirements:

```js
meta: {
  name: "iterative-engineering",
  description: "Implement, simplify, and verify a repository change",
  phases: [
    { title: "Planning" },
    { title: "Implementation" },
    { title: "Subtraction audit" },
    { title: "Simplification" },
    { title: "Verification" }
  ]
}
```

Use `log()` for observer narration, but put important facts in the final JSON because logs are not the stable result surface. Keep the result below the configured rendering limit.

## Final result

Return a compact JSON value such as:

```js
{
  status: "completed",
  summary: "...",
  rounds: 3,
  generation: 4,
  changedFiles: ["..."],
  tests: ["..."],
  remainingIssues: []
}
```

Use `blocked`, `failed`, `max_rounds_reached`, or `no_progress` for normal script returns. Runtime cancellation is reported by the outer Workflow Tool and does not produce a normal script status. If policy intentionally stops without runtime cancellation, return `blocked` with a reason. Do not report success with unresolved tasks, stale verification, failed required checks, or an unverified cleanup change.

## Completion checklist

Before the script returns normally:

- The stop condition is a verified finish, an explicit block, an ordinary child failure that cannot be recovered, or the configured round/progress limit.
- Every dispatched task has a recorded result or an explicit pending/deferred status.
- Dependency failures did not accidentally release dependent tasks.
- Required checks map to current-generation evidence.
- Subtraction was audited before cleanup when enabled.
- No live handles or non-JSON values are returned.
- The parent Agent receives a concise summary, residual risks, and the next action when blocked.

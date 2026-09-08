---
name: iterative-engineering-workflow
description: Use for planner/worker loops, large multi-agent engineering tasks, or development followed by subtractive engineering; provides bounded repairs, selective escalation, and acceptance-based verification.
---
# Iterative Engineering Workflow

Use the existing DSH `workflow` tool as the execution seam. This Skill defines the engineering policy; the workflow script owns control flow and JSON state; subagents inspect, change, and verify the workspace. The Workflow engine does not enforce policy fields placed inside `args`, so the script must implement every budget and transition as a fail-closed check. Treat an unimplemented check as a blocker, not as a promise that the engine will enforce it.

## Invocation and scope

Invoke this Skill explicitly as `/iterative-engineering-workflow` when the user asks for a planner/worker loop, a large multi-agent engineering task, or development followed by subtractive engineering. For one or two bounded tasks, use ordinary subagent delegation.

Do not create a Cordis Plugin for each run. Pass the current goal and policy through `args`. A Plugin is a separate product decision for a named runtime capability, persistent checkpoints, cross-session execution, approval controls, or custom UI.

## Workflow contract

Before authoring a script, consult the current `workflow` tool description for its supported hooks, options, schema subset, and deployment limits. Read [`controller-template.md`](controller-template.md) before writing the controller; it provides the fail-closed budget, reconciliation, and repair guards. Treat the tool description as the source of truth.

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

## Cost-aware model routing

Treat model selection as an explicit budget. Build role-specific routes in `args.models`; the complete input shape appears in the Input policy and the controller guard is in [`controller-template.md`](controller-template.md).

Resolve an unassigned low-cost role to `models.default`, and make that default the low-cost route when cost matters. Require every high-capability role to have an explicit route; a missing high-capability route is `blocked` rather than silently downgraded. Declare both `modelPolicy.lowCostRoles` and `modelPolicy.highCapabilityRoles` explicitly; count calls by role rather than guessing from a model name. Use the low-cost route for planning, implementation, reconciliation, read-only audits, first-pass review, and verification. Reserve the high-capability route, for example `gpt-6-astra max`, for a selective semantic review or an escalation trigger: ambiguous acceptance, security/data/concurrency risk, a required check that remains failed after one repair, a repeated finding, or an ownership/scope conflict. A low-risk task may finish without a high-capability call when deterministic checks and the declared acceptance criteria provide sufficient evidence.

Keep a hard `maxHighCapabilityCalls` budget. Record every such call in `modelUsage`; a null result still consumes the budget and requires workspace reconciliation. When the budget is exhausted, return `blocked` with the missing evidence instead of retrying the same route or silently substituting another high-cost call. A high-capability escalation receives authority to diagnose, implement the bounded repair, add regression tests, and verify its current-generation change in one call. This is the preferred handoff for a difficult issue; it prevents an expensive review from bouncing vague feedback back to a low-cost worker.

The default is one combined high-capability gate: it reviews the final evidence and directly fixes a bounded blocker when necessary. A parent may explicitly raise the limit to two for high-risk work, but the controller never increases it automatically.

The workflow script has no timer, so call, round, batch, and repair budgets are the in-script deadline. A wall-clock deadline, when required, belongs to the host or parent Agent and must be treated as a cancellation requiring reconciliation.

Keep `reviewer` in `lowCostRoles` for the first pass. Add it to `highCapabilityRoles` only when a read-only high-capability review is explicitly required; otherwise use `escalator` as the combined review-and-repair role.

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
  models: {
    default: { provider: "...", model: "..." },
    planner: { provider: "...", model: "..." },
    worker: { provider: "...", model: "..." },
    audit: { provider: "...", model: "..." },
    verifier: { provider: "...", model: "..." },
    reviewer: { provider: "...", model: "..." },
    reconciler: { provider: "...", model: "..." },
    escalator: { provider: "...", model: "..." }
  },
  modelPolicy: {
    lowCostRoles: ["planner", "worker", "audit", "verifier", "reviewer", "reconciler"],
    highCapabilityRoles: ["escalator"],
    requireHighCapabilityReview: false
  },
  limits: {
    maxRounds: 4,
    maxTotalAgentCalls: 20,
    maxConcurrentAgents: 2,
    maxTasksPerRound: 3,
    maxNoProgressRounds: 2,
    maxTaskNoProgressRounds: 1,
    maxAttemptsPerTask: 2,
    maxRepairAttemptsPerFinding: 1,
    maxReviewRejections: 1,
    maxHighCapabilityCalls: 1,
    maxAuditAgents: 2,
    maxCleanupBatches: 1,
    maxReconcileAttempts: 1
  }
}
```

The `limits` object is controller policy carried in `args`; it does not configure the Workflow engine. The deployment separately enforces `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`, and the ordinary model-facing tool exposes no script hook to read or raise them. `maxTotalAgentCalls` is controller-only and must stay within the known engine ceiling; an engine `AGENT_CAP` or `ITEM_CAP` is fatal, not a retry signal.

Keep domain-specific wording in `goal`, `constraints`, `acceptance`, and stage objectives. Keep the script generic. Set `simplify.enabled` from the user's intent; do not force a cleanup pass when it was not requested. Resolve missing low-cost role routes to `models.default`, and keep that route low-cost when cost matters. Require explicit routes for high-capability roles; a missing route is `blocked`. Use the conservative limits above by default; a larger budget for a high-risk task requires an explicit parent decision recorded in `constraints`. If acceptance criteria are materially missing, ask before launching work that can modify or delete files.

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
  specRevision,
  dependencyGraph,
  pendingTasks,
  completedTasks,
  failedTasks,
  attemptsByTask,
  taskNoProgressRounds,
  seenFingerprints,
  lastEvidence,
  lastDiffHash,
  changedFiles,
  workspaceSnapshot,
  auditReports,
  reviewFindings,
  repairAttempts,
  reviewRejections,
  verificationResults,
  modelUsage,
  escalations,
  reconcileAttempts,
  recentHistory,
  noProgressRounds
}
```

Set `specRevision` once after precheck from the frozen goal, constraints, and acceptance criteria; a planner or reviewer cannot silently change it. `generation` is a logical workspace revision, while `workspaceSnapshot` and `lastDiffHash` hold the latest evidence gathered by `reconcile`. A generation counter alone is not proof that the workspace is unchanged. Before every dispatch whose tasks are permitted to write, including retries, increment `generation` and invalidate prior `verificationResults`. After every write batch, run the bounded `reconcile` step and verify actual changed paths, ownership, and a new relevant diff or criterion result. A `null` or failed result from a potentially writing worker means mutation is unknown; do not release dependencies, retry, or accept finish until reconciliation resolves it. Verification is valid only for the current generation. A model call, a new plan, a changed task id, a changed prompt, or unrelated formatting is not progress; progress requires a resolved task, a related behavior diff with evidence, a passing required check, or a phase transition.

Keep `recentHistory` short and summarize older results. Do not put live DSH objects, Services, runs, or handles in state. Return only strings, numbers, booleans, arrays, and plain objects. Because the workflow script has no filesystem API, use one low-cost `reconciler` agent after each write batch. A host diff/snapshot service may replace that call only when the parent or deployment supplies it outside the Workflow hooks. The reconciler result must be schema-validated and include actual changed paths, an evidence digest, ownership violations, and whether mutation is known. The parent Agent must inspect the workspace after a cancelled or fatal run before authorizing a restart; an in-memory state object is not a checkpoint.

## State machine and gates

The normal path is:

```text
implement -> simplify-audit -> simplify -> verify -> done
```

`verify` is a two-tier gate: run deterministic checks first, then perform a selective semantic review when the risk policy requires it. Its bounded subpath is:

```text
deterministic checks -> cheap review -> [repair_low (at most once per finding)] -> [escalate_high when triggered (at most budget)] -> final current-generation verification
```

A low-risk task can skip the semantic review when its acceptance evidence is executable. Review and repair consume explicit finding and model budgets; they do not create an unbounded extra loop.

If simplification is disabled, transition from `implement` to `verify`. If implementation is disabled, start at the first enabled stage. Verification is mandatory for success: if `verify` is disabled or its required tooling is unavailable, return `blocked` before dispatching work. If simplification is enabled, implementation completion must transition through `simplify-audit` before `verify`. A high-capability review is optional for low-risk work, but skipping it never skips deterministic verification or acceptance checks.

The script owns these hard gates:

- Accept `finish` only while in `verify` and only when all required checks pass for the current `generation`.
- Keep pending, failed, blocked, and unresolved review findings visible in state.
- Do not consider a phase complete because the planner or reviewer said so; require its declared acceptance or verification evidence.
- Give every review finding a stable id and count repairs per finding. A repair must have a bounded scope, an exit condition, and focused evidence.
- Detect repeated task or finding fingerprints and consecutive rounds without measurable progress. Progress means a task was completed or resolved, a related behavior diff has evidence, a required check changed to pass, or the phase advanced. A new plan, model call, changed task id, unrelated formatting, or a changed prompt is not progress. After `maxNoProgressRounds`, return `blocked` or `no_progress`.
- Track task-level stagnation separately from global stagnation. When one task or finding reaches `maxTaskNoProgressRounds` without related evidence, stop that task and escalate or block it even if other tasks are progressing.
- After the configured repair budget, or when a finding recurs or the patch oscillates, escalate once to the high-capability route or return `blocked`; do not bounce the same finding through the worker indefinitely.
- Count high-capability calls against `maxHighCapabilityCalls`. A high-capability call that changes the workspace invalidates all prior verification and must leave current-generation evidence.
- If the loop reaches `maxRounds`, return `max_rounds_reached`, never success.
- Await all promises before a normal return. Workflow-level cancellation, fatal errors, and disposal belong to the Tool and Engine.

## Planner contract

Call one low-cost planner subagent at phase entry, after a batch changes dependencies or scope, or after a failed or blocked batch only when recovery needs a new plan and state permits replanning. For a dependency deadlock or exhausted gate, return `blocked` per Task scheduling without another planner call. Reuse the existing plan for a single bounded repair; do not call a planner merely to restate review feedback. Tell it that it is a planner, not an implementer. Give it the current phase, goal, constraints, acceptance criteria, task summaries, changed-file summaries, audit reports, review findings, verification results, model usage, and recent history.

Require a small object-rooted schema with an enumerated action, and pass that schema to `agent()` so invalid planner output is rejected before state changes. A task should carry a stable id, title, instruction, expected files or ownership area, acceptance conditions, and `dependsOn` ids:

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

Use this closed action set: `dispatch`, `enter-subtraction-audit`, `enter-verify`, `review`, `escalate`, `finish`, and `blocked`. Do not parse transitions from prose. Permit only these transitions:

- `implement`: `dispatch`, `enter-subtraction-audit`, `enter-verify`, or `blocked`.
- `simplify-audit`: `dispatch`, `enter-verify`, or `blocked`.
- `simplify`: `dispatch`, `enter-verify`, or `blocked`.
- `verify`: `review`, `dispatch` for a bounded repair, `escalate`, `finish`, or `blocked`.
- `review` and `escalate` are one-shot gates inside `verify`; after their result, return to `verify` only after reconciliation and current-generation checks.

The planner must not modify the workspace or the frozen acceptance contract. If it discovers a requirement change, return `blocked` with the proposed contract change for the parent Agent. The script validates action and phase transitions, dependency readiness, generation-sensitive verification, model budgets, and finish conditions.

## Review and repair contract

Run deterministic checks before semantic review. The first-pass reviewer uses the low-cost route and receives the frozen `specRevision`, current diff, current-generation check results, and prior findings. Invoke the high-capability `escalator` only when a configured risk trigger fires or the bounded worker path cannot resolve a finding.

Require a small object-rooted result with a closed verdict, pass its schema to `agent()`, and reject invalid output before it can alter state:

```js
{
  verdict: "fail",
  action: "repair",
  findings: [
    {
      id: "F-03",
      criterionId: "cache-expiry",
      severity: "blocker",
      risk: "stale data can be returned",
      location: "src/cache.js:42",
      evidence: "...",
      rootCause: "...",
      requiredChange: "...",
      regressionTest: "...",
      exitCondition: "..."
    }
  ],
  summary: "..."
}
```

Allow `verdict` values `pass`, `fail`, and `uncertain`, and `action` values `pass`, `repair`, `escalate`, and `blocked`. Keep finding ids stable across rounds and bind each id to its first canonical finding fingerprint; reserve/increment that counter before each repair. Let one bounded repair task address one finding unless a shared root cause is explicit. Every repair adds or updates a regression test, runs focused checks, and records its exit evidence. A `fail` after the allowed repair increments `reviewRejections`; when that count reaches `maxReviewRejections`, enter `escalate`. `uncertain` enters the configured high-capability gate once. Minor suggestions are follow-up data and do not block completion.

After a low-cost repair, rerun focused checks and then the current-generation verification. Reuse the existing finding rather than asking a reviewer to rediscover it. A repeated finding, an oscillating patch, a scope expansion, or an exhausted repair budget enters `escalate`. The high-capability escalation owns the bounded diagnosis, patch, regression test, and validation; its result is not handed back to the low-cost worker for another open-ended attempt.

## Task scheduling

For each dispatch:

1. Reject empty or duplicate task ids. A retry reuses the original task id and declares `attempt`; a replacement declares `supersedes` and keeps the old task linked through `resolvedBy`.
2. Normalize and freeze a canonical fingerprint on first observation from ownership, acceptance conditions, and the repair target; key attempt/retry counters by that fingerprint and the canonical finding fingerprint, not by caller-supplied task or finding ids. A changed id, prompt wording, or model route does not create a new attempt; a replacement must link with `supersedes`.
3. Validate every `dependsOn` id, reject dependency cycles, and reject a dispatch that exceeds `maxTasksPerRound`, `maxConcurrentAgents`, or `maxTotalAgentCalls`.
4. Keep a task pending until every `dependsOn` id has a successful result, known mutation, and required focused checks. A failed dependency is not ready. If pending tasks exist but no task is ready, return `blocked` with the dependency chain; do not call the planner again.
5. Form a ready batch only from tasks with satisfied dependencies and non-overlapping declared write ownership.
6. Run independent ready tasks through `parallel()` only when the batch is within the configured concurrency and item limits.
7. Run dependent tasks in a later batch or round. `pipeline()` may sequence stages for one item, but it does not order separate task items.
8. When a pipeline stage can return `null` or a failed result, guard that value before running its next stage; a `null` predecessor is not proof of success.
9. Give each worker its task, goal, constraints, acceptance criteria, relevant review finding, attempt number, stable fingerprint, and repair budget. Pass the worker-specific low-cost model options to `agent()` explicitly.
10. Require a structured, schema-validated result containing task id, attempt, fingerprint, status, failure class, summary, changed files, diff or evidence digest, tests, and remaining issues. A repair result must identify the finding id and the criterion it is expected to improve.
11. Convert a `null` result into an explicit failed result so the planner can recover. For any task permitted to write, mark mutation as unknown and run the bounded `reconcile` step plus focused checks before releasing dependencies, retrying, or accepting finish.
12. Reconcile actual changed paths against ownership after every write batch. A path outside ownership, an unexpected overlap, an unknown mutation, or a missing evidence digest is `blocked` until resolved.

Preserve task results even when a later task must be deferred. A single bounded repair can use the existing task directly; replan only when dependencies, ownership, scope, or acceptance evidence changed.

## Failure semantics

Distinguish ordinary child failure from Workflow failure:

- An ordinary child failure resolves `agent()` to `null`; normalize it into a failed task result.
- A throwing `parallel()` or `pipeline()` item may become `null` according to the current tool contract, but fatal Workflow errors must propagate.
- Invalid hook arguments, unsupported schema or options, exhausted caps, script errors, startup errors, and cancellation terminate the Workflow. The model-facing Tool reports an error and does not claim a partial successful result.
- Do not invent recovery APIs for fatal termination. A failed or cancelled run does not roll back workspace changes and the Tool returns no partial script state. Before authorizing any restart after a potentially mutating run, the parent Agent must inspect and reconcile the workspace, invalidate prior verification, and reconstruct task and dependency state from current evidence. Never assume that disposal means rollback, and do not automatically restart after cancellation.
- The parent turn waits for the foreground run. In-memory state is not a checkpoint and cannot resume after process loss.

## Subtractive engineering

When the implementation phase satisfies its acceptance gate and simplification is enabled, enter `simplify-audit` before `simplify`. For a subtractive-only request, take the read-only baseline first and enter the same audit phase without pretending that implementation ran.

Audit agents are read-only and use the low-cost route. Select only categories relevant to the changed surface, cap the total at `maxAuditAgents`, and run each category at most once per audit phase. Use independent audits for:

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

If no candidate has a clear benefit, transition to `verify` without cosmetic changes. Limit cleanup writes to `maxCleanupBatches`; a cleanup write increments `generation` and invalidates prior full verification. Focused tests are required after each cleanup batch, and full current-generation verification is required before final completion. When more than one cleanup batch is explicitly authorized, run full verification between batches; the planner cannot waive that gate.

## Verification

The verify phase checks the user's acceptance criteria and relevant repository quality gates in this order:

1. Run deterministic checks first: tests, type checks, lint, static analysis, and other repository gates relevant to the changed surface.
2. Map every acceptance criterion to explicit evidence with a low-cost verifier. Use one independent low-cost verifier when a second perspective adds value; parallel high-capability verifiers are opt-in and budgeted.
3. Run selective semantic review only for a configured risk trigger or an explicit `requireHighCapabilityReview` policy. The high-capability call should review the current diff and, when it finds a blocker, own the bounded patch and its validation instead of handing vague feedback to the worker.

Represent each required check explicitly:

```js
{
  criterionId: "login-errors",
  status: "pass",
  evidence: "test command and relevant result",
  generation: 3
}
```

Use `pass`, `fail`, or `blocked`. A final `finish` requires every required criterion and quality gate to have `pass` evidence for the current `generation`, no pending or unresolved failed task, and no unresolved blocker or major review finding. When policy requires a high-capability review, its pass or repair-and-verify result must also belong to the current generation. Any subsequent write invalidates the previous verification set and requires a fresh verify phase.

If verification fails, dispatch the smallest bounded repair, or enter `escalate` when the finding is repeated, high-risk, or outside the worker's ownership. The planner must not silently finish. Verification must check the changed surface and the actual acceptance criteria, not only whether a command exited successfully.

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
  modelUsage: {
    totalCalls: 8,
    highCapabilityCalls: 1
  },
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
- Every repair maps to a stable finding id, stays within its attempt budget, and has focused evidence.
- High-capability calls are role-routed, counted, and within budget; an escalation that writes leaves current-generation verification evidence.
- Subtraction was audited before cleanup when enabled.
- No live handles or non-JSON values are returned.
- The parent Agent receives a concise summary, residual risks, model usage, and the next action when blocked.

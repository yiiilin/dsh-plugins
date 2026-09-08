# Cost-aware controller template

Read this reference before authoring the workflow script. It is a controller core to adapt, not a replacement for the task-specific planner, worker prompts, or verification commands.

The Workflow engine does not interpret `args.limits`, task fingerprints, generations, review findings, or mutation state. The script must reject work before dispatch when a budget or state gate fails. A missing gate is a `blocked` result. The engine separately enforces deployment-level `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`; `args.limits` cannot inspect or raise those caps. Keep controller budgets below the known engine ceilings, and treat an engine `AGENT_CAP` or `ITEM_CAP` as fatal rather than retryable.

## Required policy

Use these conservative defaults unless the parent Agent records a larger budget in `constraints`:

```js
const limits = {
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
};

const modelPolicy = {
  lowCostRoles: ["planner", "worker", "audit", "verifier", "reviewer", "reconciler"],
  highCapabilityRoles: ["escalator"],
  requireHighCapabilityReview: false
};
```

The caller maps `models.escalator` to the selected high-capability model, such as `gpt-6-astra max`, and maps `models.default` to a low-cost model. Low-cost roles may use the default fallback; every high-capability role must have an explicit route, and a missing route must block before dispatch. Count by role, not by model-name substring. When `requireHighCapabilityReview` is true, schedule exactly one high-capability gate before final verification; it consumes the same budget as an escalation.

## Controller core

Keep counters and fingerprints in plain JSON state. Reserve a call before starting it; a `null` result still consumes the reservation.

```js
const state = {
  round: 0,
  generation: 0,
  specRevision: "frozen-acceptance-id",
  modelUsage: { totalCalls: 0, highCapabilityCalls: 0 },
  attemptsByTask: {},
  taskNoProgressRounds: {},
  repairAttempts: {},
  seenFingerprints: {},
  reviewRejections: 0,
  workspaceSnapshot: null,
  lastDiffHash: null,
  verificationResults: [],
  unresolvedFindings: [],
  escalations: [],
  reconcileAttempts: {}
};

const lowRoles = new Set(modelPolicy.lowCostRoles);
const highRoles = new Set(modelPolicy.highCapabilityRoles);

function beginRound() {
  if (state.round >= limits.maxRounds) {
    return { ok: false, reason: "maxRounds reached" };
  }
  state.round += 1;
  return { ok: true };
}

function routeOptions(role) {
  if (!lowRoles.has(role) && !highRoles.has(role)) return null;
  const route = args.models?.[role] ?? (highRoles.has(role) ? null : args.models?.default);
  if (!route) return null;
  return { ...route, label: role };
}

function reserve(role) {
  const reservation = reserveBatch([role]);
  return reservation;
}

function reserveBatch(roles) {
  if (state.modelUsage.totalCalls + roles.length > limits.maxTotalAgentCalls) {
    return { ok: false, reason: "maxTotalAgentCalls reached" };
  }
  const highCount = roles.filter((role) => highRoles.has(role)).length;
  if (state.modelUsage.highCapabilityCalls + highCount > limits.maxHighCapabilityCalls) {
    return { ok: false, reason: "maxHighCapabilityCalls reached" };
  }
  for (const role of roles) {
    if (!routeOptions(role)) return { ok: false, reason: `missing model route: ${role}` };
  }
  state.modelUsage.totalCalls += roles.length;
  state.modelUsage.highCapabilityCalls += highCount;
  return { ok: true };
}

async function invokeReserved(role, prompt, phaseName) {
  const result = await agent(prompt, {
    ...routeOptions(role),
    phase: phaseName
  });
  if (result === null) {
    return { status: "failed", role, mutation: "unknown" };
  }
  return result;
}

async function call(role, prompt, phaseName) {
  const reservation = reserve(role);
  if (!reservation.ok) return { status: "blocked", reason: reservation.reason };
  return invokeReserved(role, prompt, phaseName);
}

async function runWorkerBatch(tasks, phaseName) {
  if (tasks.length === 0) return { status: "blocked", reason: "empty batch" };
  if (tasks.length > limits.maxTasksPerRound || tasks.length > limits.maxConcurrentAgents) {
    return { status: "blocked", reason: "batch limit exceeded" };
  }
  const reservation = reserveBatch(tasks.map(() => "worker"));
  if (!reservation.ok) return { status: "blocked", reason: reservation.reason };
  return parallel(tasks.map((task) => () => invokeReserved("worker", workerPrompt(task), phaseName)));
}
```

Call `beginRound()` before each planner/dispatch cycle and return `max_rounds_reached` when it fails. The real script must validate the planner's closed action set and transition matrix before calling these helpers. It must also validate the dependency DAG and return `blocked` when pending tasks exist but no task is ready.

## Write and reconcile gate

Every write batch, including a retry or high-capability escalation, follows this sequence:

```text
reserve -> dispatch -> reconcile -> focused checks -> release dependencies
```

Increment `state.generation` and clear `state.verificationResults` before dispatch. Set `state.reconcileAttempts[batchId]` before the reconcile call and allow at most `maxReconcileAttempts`; an unknown mutation after that limit is `blocked`. Reconciliation must inspect the actual workspace, not only worker claims. Within the model-facing script, use the low-cost `reconciler` role once per write batch; a host diff/snapshot service may replace that call only when the parent or deployment supplies it outside the Workflow hooks. Require this result:

```js
{
  status: "pass",
  mutation: "known",
  changedFiles: ["..."],
  diffHash: "...",
  ownershipViolations: [],
  evidenceDigest: "..."
}
```

A failed or `null` writer result is mutation-unknown. Until reconciliation returns `status: "pass"`, `mutation: "known"`, an evidence digest, changed paths within declared ownership, and focused checks pass, keep dependencies locked and stop retry dispatch. An unexpected overlap or changed path outside ownership is `blocked`.

## Repair guard

A repair references the original task and finding. It keeps the original linkage and an immutable semantic fingerprint; it does not get a fresh id to evade limits.

```js
function findingFingerprint(task) {
  return JSON.stringify({
    criterionId: task.criterionId ?? null,
    location: task.location ?? null,
    rootCause: task.rootCause ?? null
  });
}

function taskFingerprint(task) {
  return JSON.stringify({
    ownership: [...(task.ownership ?? task.files ?? [])].sort(),
    acceptance: [...task.acceptance].sort(),
    repairTarget: task.findingId ? findingFingerprint(task) : (task.repairTarget ?? null)
  });
}

function canRepair(task) {
  const fingerprint = taskFingerprint(task);
  const findingFingerprintValue = task.findingId ? findingFingerprint(task) : null;
  const attempts = state.attemptsByTask[fingerprint] ?? 0;
  const findingAttempts = findingFingerprintValue
    ? state.repairAttempts[findingFingerprintValue] ?? 0
    : 0;
  if (attempts >= limits.maxAttemptsPerTask) return { ok: false, reason: "task attempts exhausted" };
  if (findingAttempts >= limits.maxRepairAttemptsPerFinding) return { ok: false, reason: "finding attempts exhausted" };
  if (state.seenFingerprints[fingerprint]) return { ok: false, reason: "repeated fingerprint" };
  state.seenFingerprints[fingerprint] = true;
  // Reserve counters before dispatch; callers do not increment them again.
  state.attemptsByTask[fingerprint] = attempts + 1;
  if (findingFingerprintValue !== null) {
    state.repairAttempts[findingFingerprintValue] = findingAttempts + 1;
  }
  return { ok: true, fingerprint, findingFingerprint: findingFingerprintValue };
}
```

The semantic fingerprint deliberately excludes task/finding ids, prompt wording, and model route, so changing any of them cannot reset a limit. Freeze the first fingerprint for the task and finding; a changed ownership, acceptance, or repair target is a scope/contract change and is `blocked`, not a new attempt. A repair is meaningful only when it produces a related behavior diff, a new passing criterion, or a resolved task with evidence. Formatting or an unrelated file change does not reset the guard. A repeated finding, unchanged relevant diff, review rejection beyond the configured count, or scope expansion enters `escalate` or `blocked` without another planner call.

The high-capability escalator receives the complete frozen contract, current diff evidence, finding history, and remaining budget. It owns the bounded patch, regression test, reconciliation, and final verification. Its result is the last repair handoff, not another request for the low-cost worker to try indefinitely.

## Restart rule

The workflow has no durable checkpoint. After cancellation or a fatal error, the parent Agent first inspects and reconciles the workspace, then starts a new run with a reduced external budget or an explicit new authorization. The new run must not assume that the old `generation`, verification, or high-model reservations survived.

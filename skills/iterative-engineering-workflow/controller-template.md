# Cost-aware controller template

Read this reference before authoring the workflow script. It is a controller core to adapt, not a replacement for the task-specific planner, worker prompts, or verification commands.

The Workflow engine does not interpret `args.limits`, task fingerprints, generations, review findings, or mutation state. The script must reject work before dispatch when a budget or state gate fails. A missing gate is a `blocked` result. The engine separately enforces deployment-level `maxConcurrentAgents`, `maxTotalAgents`, and `maxItemsPerCall`; `args.limits` cannot inspect or raise those caps. Keep controller budgets below the known engine ceilings, and treat an engine `AGENT_CAP` or `ITEM_CAP` as fatal rather than retryable.

Use the schema rules in `SKILL.md`: root `type: "object"`; compatible typed constraints at every node; nested `oneOf` with at least two branches and no sibling `type` or constraint keywords. `enum` must be nonempty with type-matching scalar values, `const` must match its scalar type (and enum when present), and `required` may name only declared properties. `additionalProperties` is boolean; type arrays and schema-valued `additionalProperties` are unsupported.

Before launch, the parent must preflight every role schema with the installed DSH `assertObjectJsonSchema` validator (from `@deepseek-ai/dsh-tools`), or a recursively equivalent check when that export is unavailable. This is a parent-side check, not an import or hook available inside Workflow. Freeze the validated schemas; dynamic schemas need the same check before any child dispatch. Syntax-only JavaScript checks do not validate schema compatibility.

Use a helper when several result schemas share enum fields:

```js
const stringEnum = (values) => ({ type: "string", enum: values });
const taskStatus = stringEnum(["completed", "failed", "blocked"]);
const reviewAction = stringEnum(["pass", "repair", "escalate", "blocked"]);
```

The helper must return plain JSON data before it is passed as `agent()`'s `schema`; do not pass functions, class instances, or live schema objects through `args`.

## Compact workflow input

For a large run, create one immutable manifest before launching the Workflow. Put repository paths and branches, the frozen goal and constraints, acceptance criteria with stable ids, stages, ownership map, risk triggers, and validation commands in that file. Use an absolute `manifestPath` reachable by every child, and a `sha256:<hex>` digest of the exact file bytes; bind `specRevision` to that digest for the run. Keep `args` to this locator plus model routes and controller policy. The example below is an abbreviated input: omitted policy fields receive the Required policy defaults before validation.

```js
{
  manifestPath: "/absolute/workspace/.dsh/workflows/task.json",
  manifestDigest: "sha256:...",
  specRevision: "sha256:...",
  models: { default: { provider: "...", model: "..." }, escalator: { provider: "...", model: "..." } },
  modelPolicy: { requireHighCapabilityReview: false },
  limits: { maxRounds: 4, maxTotalAgentCalls: 20, maxHighCapabilityCalls: 1 }
}
```

Use a counted, read-only low-cost `reconciler` call for precheck. It hashes the manifest, checks repository access and verification tooling, and returns only the matching digest/revision, enabled stages, criterion ids, and bounded readiness evidence. The controller compares those fields to the frozen input and blocks on missing or mismatched evidence before any writer. Every child must hash the same file before using it and return that observed digest; reconciliation and final verification recheck it. A changed path or digest is `blocked`, never an automatic revision update. Exclude the manifest from all write ownership. These checks detect changes; actual immutability requires the parent or host to protect the file from concurrent writers.

Pass the locator and task/criterion ids in prompts. Keep state and final output bounded: large diffs, reports, and task catalogs stay in separately named artifacts referenced by path plus digest, never by overwriting the manifest. Load only the next bounded task batch into JSON. Precheck must not echo the full manifest.

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
  maxReconcileAttempts: 1,
  ...args.limits
};

const modelPolicy = {
  lowCostRoles: ["planner", "worker", "audit", "verifier", "reviewer", "reconciler"],
  highCapabilityRoles: ["escalator"],
  requireHighCapabilityReview: false,
  ...args.modelPolicy
};
```

The parent verifies actual configured provider/model ids and their cost classification: `models.default` and low-cost overrides must be low-cost, and every high-capability role needs an explicit route. Role labels alone do not prove model cost. Keep role sets disjoint; move `reviewer` between sets only for an explicitly requested high-capability read-only review. Model routes contain only nonempty `provider` and `model` strings. Freeze routes, merged policy, and limits before calls; invalid fields block before dispatch. The default high-capability allowance is at most one call, explicitly raised to at most two by the parent for high-risk work. A zero allowance is valid unless policy requires a high-capability gate.

When `requireHighCapabilityReview` is true, require a current-generation high-capability pass before completion. A triggered escalation can satisfy that gate, so do not schedule a redundant second review; subsequent writes invalidate it. Give every high-capability call a recorded trigger or explicit review requirement. All roles, including precheck and post-write checks, consume the total budget. Child prompts must prohibit delegation and model switching to prevent uncounted descendant spending; host restrictions are needed for enforcement beyond prompts.

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

const roleLists = [modelPolicy.lowCostRoles, modelPolicy.highCapabilityRoles];
if (roleLists.some((roles) => !Array.isArray(roles) || roles.some((role) => typeof role !== "string" || !role.trim()))
    || typeof modelPolicy.requireHighCapabilityReview !== "boolean"
    || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0)
    || ["maxRounds", "maxTotalAgentCalls", "maxConcurrentAgents", "maxTasksPerRound", "maxReconcileAttempts"].some((key) => limits[key] < 1)
    || limits.maxHighCapabilityCalls > 2
    || (modelPolicy.requireHighCapabilityReview && limits.maxHighCapabilityCalls === 0)) {
  return { status: "blocked", reason: "invalid controller policy" };
}
const lowRoles = new Set(modelPolicy.lowCostRoles);
const highRoles = new Set(modelPolicy.highCapabilityRoles);
if (lowRoles.size !== modelPolicy.lowCostRoles.length
    || highRoles.size !== modelPolicy.highCapabilityRoles.length
    || [...lowRoles].some((role) => highRoles.has(role))
    || [...lowRoles, ...highRoles].some((role) => !routeOptions(role))) {
  return { status: "blocked", reason: "invalid role classification or model route" };
}

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
  if (!route || typeof route !== "object" || Array.isArray(route)
      || Object.keys(route).some((key) => key !== "provider" && key !== "model")
      || [route.provider, route.model].some((value) => typeof value !== "string" || !value.trim())) return null;
  return { provider: route.provider, model: route.model, label: role };
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

async function invokeReserved(role, prompt, phaseName, schema) {
  const result = await agent(prompt, {
    ...routeOptions(role),
    phase: phaseName,
    schema
  });
  if (result === null) {
    return { status: "failed", role, mutation: "unknown" };
  }
  return result;
}

async function call(role, prompt, phaseName, schema) {
  if (!schema || schema.type !== "object") return { status: "blocked", reason: "missing preflighted role schema" };
  const reservation = reserve(role);
  if (!reservation.ok) return { status: "blocked", reason: reservation.reason };
  return invokeReserved(role, prompt, phaseName, schema);
}

async function runWorkerBatch(tasks, phaseName, workerSchema) {
  if (!workerSchema || workerSchema.type !== "object") return { status: "blocked", reason: "missing preflighted worker schema" };
  if (tasks.length === 0) return { status: "blocked", reason: "empty batch" };
  if (tasks.length > limits.maxTasksPerRound || tasks.length > limits.maxConcurrentAgents) {
    return { status: "blocked", reason: "batch limit exceeded" };
  }
  // Keep at least one reconciliation and one verifier call available after writes.
  if (state.modelUsage.totalCalls + tasks.length + 2 > limits.maxTotalAgentCalls) {
    return { status: "blocked", reason: "insufficient post-write call budget" };
  }
  const reservation = reserveBatch(tasks.map(() => "worker"));
  if (!reservation.ok) return { status: "blocked", reason: reservation.reason };
  return parallel(tasks.map((task) => () => invokeReserved("worker", workerPrompt(task), phaseName, workerSchema)));
}
```

These helpers require preflighted role schemas; their root checks do not replace recursive schema validation. Bind each result to the dispatched task/attempt, manifest digest, and generation before accepting its semantics. Call `beginRound()` before each planner/dispatch cycle and return `max_rounds_reached` when it fails. Before any writer (including `call("escalator", ...)`), the task-specific controller must reserve enough remaining capacity for its required post-write gates; the batch helper's two-call headroom is only the minimum when focused checks fit the verifier call. Keep that headroom unavailable to intervening optional calls. Validate the planner's closed action set, transitions, dependency DAG, write ownership, repair/progress guards, and write/reconcile sequence before using these dispatch helpers; pending tasks with no ready task return `blocked`. These guards are integration requirements, not implemented by the call wrapper.

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
  // A known fingerprint preserves counters; recurrence/stagnation is a separate evidence gate.
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

The high-capability escalator receives the manifest locator (or the inline frozen contract), current diff evidence, finding history, and remaining budget. It owns the bounded patch, relevant regression coverage, and validation in one call. The controller then runs the separate low-cost reconciliation and current-generation verification gates; the escalator's self-report does not replace them. Its result is the last repair handoff, not another request for the low-cost worker to try indefinitely.

## Restart rule

The workflow has no durable checkpoint. After cancellation or a fatal error, the parent Agent first inspects and reconciles the workspace, then starts a new run with a reduced external budget or an explicit new authorization. The new run must not assume that the old `generation`, verification, or high-model reservations survived.

# DSH core support for resuming SUBAGENT (child) sessions after a daemon restart

Scope: installed DSH **0.1.5-rc.2** built JS at
`/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
(abbreviated below as `$P/`). Every claim carries `path:line`. Anything not established is marked **unverified**.

> Line numbers under `$P/` are bound to the DSH build named above and stay valid
> until DSH is upgraded. Line numbers into *this repository's*
> `dsh-plugin-web-daemon/index.js` were taken at **0.7.4** and have since moved:
> the 0.8.0 subagent-recovery work added lines above them, so treat those as
> stale and re-anchor on symbol names (`createInterruptedResumeMessage`,
> `turnNeedsContinuation`, `agents.resume`, `handle.agent.followup`).
> The recommended delivery shape below is likewise superseded: the shipped
> implementation delivers through `subagents.prompt(...)`, not
> `subagents.sendMessage(...)` — see `lib/subagent-recovery.js:12`.

---

## Q1 — How subagent (child) sessions are represented and persisted

### Stored session header

`SessionHeader` — `$P/dsh-session/lib/types/types.d.ts:58-95`:

| field | line | note |
|---|---|---|
| `version` | 63 | `SESSION_FORMAT_VERSION = 3` (`types.d.ts:54`) |
| `id: SessionId` | 65 | |
| `createdAt: number` | 67 | |
| `cwd?: string` | 69 | |
| `parentSession?: SessionId` | 71 | "The session this one was **forked from** (seed lineage), if any." |
| `isSeeded: boolean` | 76 | fork-inherited prefix marker |
| `origin?: 'subagent'` | 81 | "Coarse product classification for a session created as a subagent child." |
| `delegationDepth?: number` | 87 | "absent (zero) for a top-level session, parent depth + 1 for a subagent child." |
| `agentPreset?: string` | 94 | preset the session's agent was composed from |

There is **no** field named `parent`, `parentSessionId`, `kind`, or `spawnedBy`, and no `rootSessionId`.
(`$P/dsh-session/lib/types/types.d.ts` contains `parentSession?` only at 71 and 116.)

### The durable parent ↔ child link — YES, and it is in the CHILD's header

Written by `childSessionMeta(parent: Agent, childDepth: number, isSeeded: boolean)` —
`$P/dsh-subagent/lib/types/child-agent.d.ts:70`, implementation
`$P/dsh-subagent/lib/types/child-agent.js:111-125`:

```js
export function childSessionMeta(parent, childDepth, isSeeded) {
    const parentHeader = parent.session.header;
    const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx);
    return {
        ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
        ...agentPreset === undefined ? {} : { agentPreset },
        parentSession: parentHeader.id,   // child-agent.js:117
        isSeeded,                          // child-agent.js:118
        origin: 'subagent',                // child-agent.js:121
        delegationDepth: childDepth,       // child-agent.js:123
    };
}
```

`isSeeded` is `seed !== undefined`, so **both** in-process backends write the same link:

- one-shot driver: `$P/dsh-subagent-in-process-driver/lib/index.js:183` — `meta: childSessionMeta(parent, childDepth, seed !== void 0)`
- continuable manager: `$P/dsh-subagent/lib/types/continuation.js:162` — `meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined)`

So `header.parentSession` is the direct parent for spawn children too, **not** only forks.
Proof that the core itself treats it as the durable parent pointer (not merely fork lineage):
`$P/dsh-subagent/lib/types/list-children.js:98-99` and `:176` and `:228` — see Q4.

**⚠ Ambiguity: `parentSession` alone does NOT mean "subagent".** Plain `ctx.sessions.fork()` also sets it,
without `origin`: `$P/dsh-session/lib/index.js:1579` `fork(source, boundary, childSessionId) {` and `:1588`
`parentSession: liveSource.id,` next to `isSeeded: true`. Always require **both** `origin === 'subagent'`
**and** `parentSession === <parent>`, exactly as core does (`list-children.js:98-99`).

**Physical JSONL header (for a raw-file reader).**
`HEADER_REQUIRED_KEYS = ["type","version","id","createdAt","isSeeded","delegationDepth"]`
`$P/dsh-session-persistence-jsonl/lib/index.js:776-783`; `HEADER_OPTIONAL_KEYS = ["cwd","parentSession","origin","agentPreset"]`
`:784-789`; guard `isHeaderLine` `:838-839`.
`toHeaderLine()` `:807-818` writes `delegationDepth: header.delegationDepth ?? 0` (`:813`), so a **top-level** header
on disk has no `parentSession`/`origin` but *does* carry `"delegationDepth":0` — test `>= 1` (or `origin`), never
key membership. Absent optionals are omitted, never `null` (`:807-812`).

Observed on this machine (read-only), child header line 1 of
`/root/.dsh/sessions/--usr-local-src-project-dsh-plugin--/1fa60ce8-3dc3-4862-b6dd-f5891ed69325/session.v3.jsonl.zstd`:
```json
{"type":"session","version":3,"id":"1fa60ce8-3dc3-4862-b6dd-f5891ed69325","cwd":"/usr/local/src/project/dsh-plugin","parentSession":"session-95eb55cf-f610-4b29-b3c6-a541b9dbb7a8","isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"yiln"}
```

### Two durable log events (beyond the header)

1. **Child side** — `subagent/descriptor`, `SessionEventMap` entry
   `$P/dsh-subagent/lib/types/descriptor.d.ts:26-37`.
   `SUBAGENT_DESCRIPTOR_VERSION = 3` (`descriptor.d.ts:44`).
   Payload `SubagentDescriptorData` (`descriptor.d.ts:45-81`):
   `{ version, mode: 'one-shot'|'continuable', provider, label? }` plus, for `continuable`
   only, `agentProvider?`, `agentModel?`, `agentReasoningEffort?`, `persona?`, `toolFilter?`
   (`descriptor.d.ts:64-79`).
   "Log-only: it carries no `surfaceOp`, never enters model history, and survives compaction"
   (`descriptor.d.ts:32-34`). Appended once in the child's initial turn (`descriptor.d.ts:6`).
   Folded by `foldSubagentDescriptor(events): SubagentDescriptorData | undefined`
   (`descriptor.d.ts:142`).

2. **Parent side** — `subagent/catalog`, `SessionEventMap` entry
   `$P/dsh-subagent/lib/types/catalog.d.ts:24-32`.
   `SUBAGENT_CATALOG_VERSION = 0` (`catalog.d.ts:11`).
   Payload `SubagentCatalogEvent` (`catalog.d.ts:13-23`):
   `{ version, childId: SessionId, childCreatedAt: number, mode, label? }`.
   Appended by `establishCatalogChild(parent, child, descriptor)` (`catalog.d.ts:69`).
   Parent-side projection key `subagentCatalog` (`catalog.d.ts:50-51`;
   value type `SubagentCatalogEntry[]`, `$P/dsh-subagent/lib/types/projection-types.d.ts:56-59`,
   entry shape at `:8-17`).

### Same store? Yes, and how a caller distinguishes

- One session per session-owned directory, same root for parents and children:
  `--<normalized-cwd>--/<encoded-id>/session.vN.jsonl[.zstd]`
  (`$P/dsh-session-persistence-jsonl/README.md:60-67`; root is the single required config, `:43-47`).
- The backend's `list()` has **no origin filter** — it enumerates every artifact:
  `$P/dsh-session-persistence-jsonl/lib/index.js:2454-2481`
  (`const pending = [...this.tracker.pendingEntries()]` :2458; `for (const artifact of await this.listArtifacts(signal))` :2459;
  `snapshots.push({ header: artifact.header, revision: fileRevision(identity), sizeBytes: ... })` :2465-2469).
- Distinguishing a child from a top level session is done **only** by header fields:
  `header.origin === 'subagent'` (identity of a child) and `header.parentSession` (its parent).
  This is exactly what core does: `$P/dsh-subagent/lib/types/list-children.js:98-99`.

---

## Q2 — Host services for subagents and their exact signatures

### Service name

`ctx.subagents` → `SubagentRuntime`.
Declaration: `$P/dsh-subagent/lib/types/index.d.ts:58-61`
(`declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime; } }`;
class declared at `:98`, `export default SubagentRuntime` at `:315`).

### Complete public method list (from `$P/dsh-subagent/lib/types/index.d.ts`)

| line | signature |
|---|---|
| 117 | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>` |
| 132 | `sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>` |
| 161 | `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void` |
| 172 | `drainContinuableDescendants(parents: readonly Agent[]): Promise<void>` |
| 183 | `drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>` |
| 201 | `listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>` |
| 217 | `listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>` |
| 231 | `remoteExportList(parentSessionId: SessionId, signal: AbortSignal): Promise<SubagentCatalog>` |
| 249 | `prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>` |
| 264 | `interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable'): SubagentInterruptReceipt` |
| 272 | `registerProvider(provider: SubagentProvider): () => void` |
| 278 | `getProvider(name: string): SubagentProvider \| undefined` |
| 283 | `list(): string[]` — **registered provider names**, not children (`:283` "List registered provider names in insertion order") |
| 296 | `start(name: string, request: SubagentStartRequest): Promise<SubagentRun>` |

Private: `prepareContinuable` (:302), `expectProvider` (:304), `requireContinuations` (:306), `observeActivation` (:311), `assertCapabilities` (:313), and the symbol-keyed `[deliverSubagentPrompt]` (:145).

Supporting types: `ContinuableStartSpec` `$P/dsh-subagent/lib/types/types.d.ts:26-44`;
`ContinuableStart = { childId, messageId }` `:46-51`;
`SubagentInterruptAuthority` `:57-63`;
`SubagentSendMessageOptions = { signal: AbortSignal }` `:64-68` (**required** param of `sendMessage`);
`SubagentStartRequest` `:136-175`.

### Entry shapes returned by listing

`SubagentListEntry` — `$P/dsh-subagent/lib/types/control-types.d.ts:30-70`:
`{ kind: 'child', id: SessionId, activity: 'running'|'inactive', hasChildren: boolean }`
intersected with `{ mode: 'one-shot', label?: string }` (`:45-49`) or `{ mode: 'continuable', label: string }` (`:50-54`),
or the diagnostic arm `{ kind: 'diagnostic', id, reason: 'corrupt'|'unsupported'|'unavailable' }` (`:55-70`).

`SubagentDescendantListEntry` — `$P/dsh-subagent/lib/types/list-children.d.ts:28-33`:
`SubagentListEntry & { parentId: SessionId; depth: number }` — "`parentId` is the durable direct parent from the
enumerated header, and `depth` counts edges from the root" (`:24-27`, direct children are `depth: 1` at `:32`).

`SubagentCatalog = { entries: readonly SubagentListEntry[]; parentAvailable: boolean }`
(`control-types.d.ts:72-75`).
`SubagentPromptRequest` (`:86-103`) / `SubagentPromptReceipt = { messageId }` (`:105-107`) /
`SubagentInterruptReceipt = { accepted: true }` (`:109-111`).

### Is there a method that resumes/creates an agent from an already-persisted child id?

- **On `ctx.subagents`: NO.** Searched
  `grep -nE "^\s{4}(resume|restore|open|wake|ensure|recover|reattach)[A-Za-z]*\(" $P/dsh-subagent/lib/types/index.d.ts`
  → exit 1, no matches. Cold resume is `private coldResume(...)`:
  `$P/dsh-subagent/lib/types/continuation.d.ts:107-111`
  ("Cold-resume a persisted child and submit the waiting turn. The descriptor supplies every reconstruction input;
  no subagent provider is dispatched."). Its **only** call site in the whole install is
  `$P/dsh-subagent/lib/types/continuation.js:255` (bundled `$P/dsh-subagent/lib/index.js:1796`).
- **There is no `history()` method** on the subagent surface. Searched
  `grep -n "history" $P/dsh-subagent/lib/types/index.d.ts $P/dsh-subagent/lib/types/types.d.ts` → only prose/docs
  (index.d.ts:252, types.d.ts:206/211/363). Session event history comes from `ctx.sessionQuery` / persistence (Q4).
- The **public** cold-recovery entries are `sendMessage` (:132), `prompt` (:249) and `interruptByParent` (:264).
  `sendMessage` doc, `:121-122`: "an idle target starts a turn, and **an absent direct child cold-resumes from
  persistence**." `prompt` doc, `:249`: "Deliver one browser-authored message to a continuable child **through the
  exact live direct parent**"; failures include `subagent/parent-unavailable` and `subagent/not-resumable`
  (`:244-247`).
- Explicit README statements: `$P/dsh-subagent/README.md:51` — "only a **direct child** can be cold-resumed";
  `:97` — "An absent direct-child Activation cold-resumes from the persisted session";
  `:106` — "a continuable descriptor records the resolved child provider, model, and reasoning effort explicitly for
  cold resume"; `:176` — "**No replay of accepted-but-unlogged messages** — a crash can lose an accepted prompt that
  never reached the child's session log; the lost message is not replayed automatically."
  `$P/dsh-subagent/lib/types/list-children.d.ts:12-13` — "Absent persistence, enumeration is live-only: a cold child
  is unreachable for resume anyway."

### Drivers

- `$P/dsh-subagent-spawn-in-process/README.md:48` — registers on `ctx.subagents` as provider `spawn`
  (`provider` default `spawn`); the package is a **one-shot** provider: "Makes a fresh child" per call.
- `$P/dsh-subagent-in-process-driver/README.md:166` — "**Runs expose no `sendMessage`/`resume`** — the optional
  runtime capabilities are absent on in-process one-shot runs."
- These drivers contribute **no** public service of their own; they only `registerProvider` on `ctx.subagents`.

---

## Q3 — Cold recovery semantics

### Nothing automatically resumes a child at process start

- `coldResume` is reachable only from `deliverToChild` → `deliverFollowup`, when
  `this.activations.get(childId) === undefined`:
  `$P/dsh-subagent/lib/types/continuation.js:238-255` (the residency test is `:253`).
- Install-wide search: `grep -rn "coldResume" $P --include=*.js` returns only
  `continuation.js:255`, `continuation.js:338`, and their bundled twins `lib/index.js:1796`, `:1870`.
  There is no boot/startup scan for children anywhere.
- The listing entry point `request` (`$P/dsh-subagent/lib/types/index.d.ts:217`) explicitly "without loading or
  resuming an Agent" (`:203-204`), and `$P/dsh-subagent/lib/types/list-children.d.ts:56` — "no Agent is loaded or
  resumed."
- **Conclusion:** a child comes back only when a live parent (or a host acting through the parent) delivers a
  message to it. Nothing runs at startup.

### Preconditions for cold-resuming a child

1. **Exact live direct parent.** `authorizeLineage(parent, childId, parentSession)` —
   `$P/dsh-subagent/lib/types/continuation-activation.js:293-300`:
   `if (this.ctx.agents.get(parent.id) !== parent) throw SubagentError(..., 'UNAUTHORIZED')` (:294-296);
   `if (parentSession !== parent.id) throw SubagentError(..., 'UNAUTHORIZED')` (:297-299).
   Called from `coldResume` as `authorizeLineage(parent, childId, source.header.parentSession)`
   (`continuation.js:354`) — i.e. adjacency is checked against the child's persisted `header.parentSession`.
2. **A `continuable` descriptor.** `continuation.js:355-358`:
   `const descriptor = foldSubagentDescriptor(source.events.slice(source.inheritedEventCount));`
   `if (descriptor === undefined || descriptor.mode !== 'continuable') throw new SubagentError('subagent "..." has no
   supported continuation state and cannot be resumed; choose a different target', 'NOT_RESUMABLE')`.
   One-shot children are permanently non-resumable (`descriptor.d.ts:54`).
3. The child's persisted composition is replayed by the **manager**, including `applyChildComposition`:
   `continuation-activation.js:404-434` — cold resume is `create === undefined` → `agents.resume({ resumeSessionId:
   childId, parentAgent: parent, agentOptions, signal, setup })` (`:417-424`) with `setup` running
   `applyChildComposition(childCtx, parent, inputs.composition)` (`:414`), and `agentOptions` rebuilt from the
   descriptor (`continuation.js:365-373`). `maxTokens`/`outputSchema` are deliberately **not** restored
   (`descriptor.d.ts:14-19`).

### Interrupted-turn continuation notice

- **The core does not queue a model-visible "continue" notice.** Core crash repair is log-level synthetic closing:
  `interruptedTurnClosers(events): SessionEvent[]` — `$P/dsh-session/lib/types/repair.d.ts:21`
  ("Return deterministic synthetic events that close an open tail turn. Unmatched calls receive error results first,
  followed by an open `step/end` and an interrupted `turn/end`").
  Applied on the generic agent resume path: `$P/dsh-agent-loop/lib/index.js:1905-1906`
  (`const closers = interruptedTurnClosers(persisted); if (closers.length > 0) await handle.append(closers);`)
  and on cold reads: `$P/dsh-session-query/lib/index.js:51`
  (`events: [...events, ...interruptedTurnClosers(events)]`).
  Recovery codes `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` — `repair.d.ts:9-11`; the literal user-visible text of
  those synthetic tool results is in `$P/dsh-session/README.md:152`.
- The "continue the interrupted turn after a restart" user message is authored by the **plugin**, not core:
  `dsh-plugin-web-daemon/index.js:347-357` (`createInterruptedResumeMessage`, `source.form: 'notice'`) and
  `:812` (`handle.agent.followup(createInterruptedResumeMessage())`).
- Therefore: for a child there is **no** equivalent notice unless the plugin authors one. Cold resume attaches the
  waiting inbox message; the child's log gets the synthetic closers when it is resumed/read.

### What happens to the parent's tool-side handles for children it had spawned

- **One-shot children: lost.** `$P/dsh-subagent-in-process-driver/README.md:32` — "the caller owns the returned run",
  `dispose()` "stops the loop, removes the agent and session"; `:64` — after fulfillment "provider unload does not
  revoke it". Only the **process-local** `AgentHandle` owns the child; the handle is not persisted
  (`$P/dsh-agent/lib/types/index.d.ts:144-147`, `handle.agent` + `dispose()`).
  On restart the parent's outstanding `subagent` tool call has no durable result, so the resume-time repair emits a
  synthetic tool result (`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`, `repair.d.ts:9-11`) — the child is not re-bound.
- **Continuable children: re-bindable, but only by a new delivery.** The parent's durable knowledge is the child id
  (`ContinuableStart`, `types.d.ts:46-51`) plus the parent-side `subagentCatalog` entries
  (`catalog.d.ts:48-51`, `projection-types.d.ts:58-59`). Nothing re-materializes the child automatically; a later
  `sendMessage` to that id triggers `coldResume`.

### How to tell, after a restart, that a child was mid-turn

No service answers "was this child mid-turn at crash" directly. Two durable inputs exist:

- The child's own log tail: a turn that never reached `turn/end` is exactly what `interruptedTurnClosers` detects
  (`$P/dsh-session/lib/types/repair.d.ts:12-21` — "A balanced or empty log returns no events", i.e. non-empty
  closers ⟺ an open tail turn). This is the same test the plugin already applies to top-level sessions
  (`turnNeedsContinuation(inspected.events)`, `dsh-plugin-web-daemon/index.js:777`).
- The registered `subagentTiming` projection: `SubagentTimingProjection.active?: { since, through }` is present only
  while a turn has not reached `turn/end` (`$P/dsh-subagent/lib/types/projection-types.d.ts:18-29`; fold state
  `TimingState` `$P/dsh-subagent/lib/types/projection.d.ts:11-23`). Read it via `observeSession(...).projections`.

### Ordering constraint for a tree restore

`authorizeLineage` requires `parentSession === parent.id` for the **immediate** parent
(`continuation-activation.js:297-299`), so a `delegationDepth: 2` grandchild can only be cold-resumed after its
depth-1 parent is itself live. Restore depth-ordered, shallowest first.

### Hazard if a host plugin resumes a child directly with `ctx.agents.resume()`

- Residency for delivery is `this.activations.get(childId)` — an **Activation**, not the agent registry
  (`continuation.js:252-255`). A plugin-resumed child would therefore have **no Activation**, so a subsequent
  `sendMessage` would take the `coldResume` branch and call `agents.resume({ resumeSessionId: childId, ... })` a
  second time (`continuation-activation.js:417-424`), which goes through
  `persistence.open(id, 'write', ...)` (`$P/dsh-agent-loop/lib/index.js:1899`) — and `open` with `write` throws
  `SessionAlreadyOwnedError` when ownership is already taken
  (`$P/dsh-session-persistence/lib/types/index.d.ts:113-121`).
  **Recommended:** cold-resume children through `ctx.subagents.sendMessage(...)` / `ctx.subagents.prompt(...)`, never
  by calling `ctx.agents.resume()` on a child id yourself. (`SessionAlreadyOwnedError` per the cited contract;
  not empirically reproduced from this session.)

---

## Q4 — Enumerating sessions (top-level **and** children) to rebuild the tree after restart

Highest-value, already-used-by-the-plugin path (public persistence service):

- `ctx.sessionPersistence` (`$P/dsh-session-persistence/lib/types/index.d.ts:74-77`).
  - `list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>` — `:155`
    ("List **every stored session** visible to this process, in no promised order"; `:150-154`).
  - `stat(id, options?): Promise<SessionPersistenceSnapshot | undefined>` — `:149`.
  - `open(id, access: 'read'|'write', options?): Promise<SessionHandle>` — `:122`.
  - `SessionPersistenceSnapshot = { header: SessionHeader; revision; eventCount?; sizeBytes? }` — `:22-31`.
  - `SessionPersistenceListOptions = { signal?: AbortSignal }` — `:70-73`.
  - **The returned `header` is the full `SessionHeader`, so `header.parentSession` and `header.origin` are present
    for children** → the whole parent/child tree is rebuildable with no core change.
- `ctx.sessionQuery` (`$P/dsh-session-query/lib/types/index.d.ts:25`, doc `:33`):
  - `listSessions(signal?: AbortSignal): Promise<SessionRecord[]>` — `:67`. **No origin/parent predicate anywhere**:
    the corpus merge is `$P/dsh-session-query/lib/index.js:94-114` (persistence + live, newest-first per `:306-308`).
  - `readSession(sessionId): Promise<SessionLogSnapshot>` — `:74` — "without making it live".
  - `observeSession(sessionId, options?): Promise<SessionObservation>` — `:47`; its
    `projections?: ProjectionSnapshot` (`$P/dsh-session-query/lib/types/observation.d.ts:25`) is how you read a **cold**
    child's `subagent` mode/label.
  - `filterSessions(filters, signal?): Promise<SessionRecord[]>` — `:81`, with a purpose-built parent arm
    `{ kind: 'parent'; values: readonly (SessionId | null)[] }` (`$P/dsh-session-query/lib/types/types.d.ts:179-180`),
    implemented as `filter.values.includes(record.header.parentSession ?? null)`
    (`$P/dsh-session-query/lib/index.js:753`). Pass `null` to select top-level sessions.
  - `SessionRecord = { header: SessionHeader; live: boolean; persisted: boolean }` —
    `$P/dsh-session-query/lib/types/types.d.ts:14-21` (cloned header "selected from the live-preferred corpus").
- Projection-backed subagent listing (needs three services):
  - `ctx.subagents.listChildren(parentSessionId, signal?)` — `index.d.ts:201`;
    filter is `record.header.parentSession === parentSessionId && record.header.origin === 'subagent'`
    (`$P/dsh-subagent/lib/types/list-children.js:98-99`).
  - `ctx.subagents.listDescendants(rootSessionId, signal?)` — `index.d.ts:217`; builds the tree from
    `const parentId = record.header.parentSession` (`list-children.js:228`) and returns
    `{ ...row, parentId: position.parentId, depth: position.depth }` (`:125`).
  - Required services, with exact failure text: `ctx.get('sessionProjections')` (`list-children.js:132-138`),
    `ctx.get('sessions')` (`:142-145`), `ctx.get('sessionQuery')` (`:147-150`); optional
    `ctx.get('sessionProjectionCache')` (`:154`).
  - These are `ctx.get(...)` (global) deliberately, "never the `ctx.sessions` property proxy" (`:139-141`).
- Live-only alternatives (useless after a restart): `ctx.agents.list(): Agent[]` and `ctx.agents.roots(): Agent[]`
  (`$P/dsh-agent/lib/types/index.d.ts:355`, `:362`) — both return only live agents.
  Likewise `ctx.sessions` (`SessionStore`) is the in-memory store (`$P/dsh-session/lib/types/index.d.ts:311`) —
  `list()`/`get(id)` there miss every cold child.

### Exact service registration sites (proof of the names)

| service | registration |
|---|---|
| `sessionQuery` | `super(ctx, "sessionQuery");` — `$P/dsh-session-query/lib/index.js:1040` |
| `sessions` | `super(ctx, "sessions");` — `$P/dsh-session/lib/index.js:1315` |
| `sessionPersistence` | `super(ctx, "sessionPersistence");` — `$P/dsh-session-persistence/lib/index.js:263` |
| `subagents` | `super(ctx, "subagents");` — `$P/dsh-subagent/lib/index.js:2853` |
| `sessionProjections` | `super(ctx, "sessionProjections");` — `$P/dsh-session-projection/lib/index.js:52` |
| `sessionProjectionCache` | `super(ctx, "sessionProjectionCache");` — `$P/dsh-session-projection-cache/lib/index.js:146` |
| `agents` | `super(ctx, "agents");` — `$P/dsh-agent/lib/index.js:299` |

There is **no** `ctx.persistence` and no `ctx.sessionStore` service name. There is no `includeSubagents`
list option and no `header.isSubagent` field — searched install-wide, both absent; do not design around them.

**Do child records expose their parent id?** Yes — `header.parentSession` in every persistence/query record
(`$P/dsh-session/lib/types/types.d.ts:71`), and `parentId` on each descendant listing entry
(`$P/dsh-subagent/lib/types/list-children.d.ts:30`).

### Scale (measured, read-only, this machine)

`/root/.dsh/sessions` — of 1238 stored sessions scanned, **1188 carry `"origin":"subagent"`**; in
`--usr-local-src-project-dsh-plugin--` alone, 340 of 376. A top-level-only resume loop therefore leaves the large
majority of sessions unrestored, which matches the reported symptom.

---

## Q5 — Public/host API vs. core work

### Achievable with public host APIs today (no core edits)

- Read any stored session's header after restart, including children:
  `ctx.sessionPersistence.list()` / `stat()` / `open()` (`dsh-session-persistence/lib/types/index.d.ts:155`, `:149`, `:122`);
  `ctx.sessionQuery.listSessions()` / `observeSession()` (`dsh-session-query/lib/types/index.d.ts:67`, `:47`).
- Rebuild the parent/child tree from `header.parentSession` + `header.origin` + `header.delegationDepth`
  (`dsh-session/lib/types/types.d.ts:71`, `:81`, `:87`).
- Detect which child is **continuable** vs one-shot, from persisted data: fold the child's own
  `subagent/descriptor` (`foldSubagentDescriptor`, `dsh-subagent/lib/types/descriptor.d.ts:142`), or ask the service:
  `ctx.subagents.listChildren()` / `listDescendants()` (`index.d.ts:201`, `:217`) with the
  `subagentCatalog` / `subagent` projections (`catalog.d.ts:50-51`, `projection.d.ts:83-84`).
- Resume **top-level** sessions from an id: `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`
  (`$P/dsh-agent/lib/types/index.d.ts:287`, options `:110-129`).
- Cold-resume a **child** through the service: `ctx.subagents.sendMessage(parentAgent, childId, content, { signal })`
  (`index.d.ts:132`) or `ctx.subagents.prompt(request, signal)` (`:249`) — but only while the child's exact direct
  parent Agent is live (`continuation-activation.js:293-300`).
- Observe child lifecycle: `subagent/start` / `subagent/end` events (`index.d.ts:68`, `:85`, `:94`).

### Requires touching core packages, or is simply unsupported

- **No public "enumerate the children that were mid-turn at crash" API.** The set must be reconstructed by the plugin
  from persisted events (the child's log tail) — nothing exposes "was mid-turn" as a query.
- **No public cold-resume-by-id that bypasses parent adjacency.** `coldResume` is private
  (`continuation.d.ts:111`); `authorizeLineage` enforces `ctx.agents.get(parent.id) === parent`
  (`continuation-activation.js:294-300`). Resuming a child therefore requires first resuming its direct parent as a
  live Agent, and doing so in the child's own order (parent first).
- **No `history()` / `list()/children` "resume" verb** on `ctx.subagents` (searched, Q2).
- **No durable parent mailbox / cross-process coordination.** `$P/dsh-subagent/README.md:175` — "**Process-local
  residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to
  one persistence store needs a durable mailbox and cross-process lease protocol." `:177` — "**No durable parent
  mailbox**".
- **No automatic child resume and no automatic interrupted-turn notice for children** — the plugin must author both
  (Q3). Resuming children by calling `ctx.agents.resume()` on a child id directly is **not** supported: delivery
  residency is the Activation graph (`continuation.js:253`), so the child would be live but unreachable/resumable
  through `ctx.subagents` without conflicting with the plugin's own write handle
  (`SessionAlreadyOwnedError`, `dsh-session-persistence/lib/types/index.d.ts:120`).
- **Two other layers deliberately refuse children** — relevant because they are *not* your plugin's route today, but
  will bite if a child is ever resumed through them:
  ACP resume: `if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0)
  throw invalidParams(\`session is not resumable: ${sessionId}\`)` — `$P/dsh-acp/lib/index.js:1215`;
  ACP session list excludes them at `$P/dsh-acp/lib/index.js:1266`;
  API-layer ownership gate `hasApiSessionSubagentOwner` — `$P/dsh-api-session-controller/lib/types/agent.js:107-109`,
  and `if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) throw new
  RemoteError('subagent/unauthorized', ...)` — `$P/dsh-api-session-controller/lib/types/history.js:352-356`.
  There is no `readHeader` session-listing API: `readHeader` is only the **physical** header decoder of the format
  catalog (`$P/dsh-session-format/lib/index.js:294`).

### Practical shape for the extension

1. On boot, `persistence.list()` → partition by `header.origin === 'subagent'` / `header.parentSession`
   (require `origin` — see the fork ambiguity in Q1). `ctx.sessionQuery.filterSessions([{ kind: 'parent', values:
   [id] }])` is a purpose-built alternative for direct children (`$P/dsh-session-query/lib/index.js:753`).
2. Resume **parents first, depth-ordered** (`header.delegationDepth` ascending) via
   `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` — `$P/dsh-agent/lib/types/index.d.ts:287`,
   options `:110-129` — exactly what the plugin already does (`dsh-plugin-web-daemon/index.js:802-806`).
   `parentAgent?` (`:114`) is only needed when the resumed agent should be a runtime child; a resumed child passed
   through this path instead of the service is the hazard documented in Q3.
3. For each resumed parent's continuable children that were running, deliver through the service:
   `ctx.subagents.sendMessage(parentAgent, childId, content, { signal })` — the service cold-resumes and re-applies
   the descriptor's composition. Filter to `mode: 'continuable'` (`descriptor.d.ts:64-79`); one-shot children are
   deliberately non-resumable (`descriptor.d.ts:54`).
4. Author the interrupted-turn notice yourself, as the plugin already does for top-level sessions
   (`index.js:347-357`). Nothing in core does this for children.

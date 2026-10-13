# work-journal

Internal module of `@yiln-dsh/dsh-plugins`. Install and release the root package;
this module has no separate npm package or version. Loader row: `dsh-work-journal`.

Records what this deployment was actually used for and reports it over a
calendar range. Three consumers share one runtime: the `work_journal` model
tool, the `/journal` command, and a Web panel on the left rail (also exposed
as a right-Sidebar tab).

## Why the session store, not new instrumentation

The journal's input is `~/.dsh/sessions`. Every turn, tool call, and prompt is
already durably written there by `dsh-session-persistence-jsonl`, so the module
adds nothing to the agent loop. That choice buys three properties and costs one:

- It cannot drift from reality, because it is a projection of the same log the
  conversation is replayed from.
- It needs no cooperation from tools, presets, or the model.
- History before the plugin was installed is included — this deployment's store
  already held two months of work on first run.
- **The cost**: reading a log to count it. The session store is too large to
  re-read per question. The incremental index exists to pay that cost once.

## The incremental index

`sessionPersistence.list()` returns one opaque `revision` per stored session,
comparable within a process. The collector stores that token beside each
activity record and skips any session whose revision is unchanged, so a pass
opens only the logs that actually moved.

The collector uses the store's revision token to skip unchanged logs and scans
changed sessions in bounded passes. The first query after a restart builds the
whole index; later passes read only what changed. A report that could not be built
from the whole store says so instead of quietly under-counting.

### Live sessions are re-read every pass

The revision guard has one deliberate hole. The durable backend buffers a live
session's newest events and reports a *constant* in-memory revision for it until
its first flush, so a revision-only guard would keep skipping the session the
user is working in right now — exactly the one "what did I do today" is about.

The runtime therefore asks `ctx.sessions` which ids are live in this process and
re-projects those on every pass, reading them through `ctx.sessionQuery` (which
is live-preferred) rather than the store. Both services are optional: with
persistence alone the journal still works, just without mid-turn visibility.

### Refresh policy

A query never blocks on a cold store more than once, and a cold build runs to
**completion**, not to one pass.

That second part is load-bearing. `maxSessionsPerScan` bounds one pass so a scan
yields instead of monopolising the process; on a store larger than the budget a
single pass therefore indexes only part of it. Answering from that would be
*wrong*, not merely stale — measured on this store, a one-pass answer for a
single day reported 3 root sessions, 19 turns and 3,183 tool calls where the
complete answer is 5 root sessions, 86 turns and 5,691 tool calls. The cold path
therefore loops passes until `remaining` reaches 0, bounded by a wall-clock
budget (120 s) so a pathologically large store still returns something.

When that budget does bite, the answer says so: the tool's canonical value
carries `complete` and `pendingSessions`, and the rendered Markdown gains an
explicit "索引尚未建完" line. A partial report must never read as "nothing else
happened".

An existing index is answered immediately while a refresh runs behind the
caller, bounded by `refreshTtlMs`. `work_journal`'s `refresh: true` and the
command's `status`/`rebuild` are the explicit ways to wait.

Concurrent scans join the in-flight one rather than starting a second walk.

## What the projection counts

The store's event vocabulary is wider than its documentation suggests, and the
differences matter for a work log.

**Only a human prompt counts as a request.** `user/message` carries ten
different `source.kind` values in this store; `agent-instructions`,
`skill-catalog`, `plugin`, `agent-message`, `goal`, `loopx-continuation`,
`skill-invocation`, `subagent-report`, and `subagent-settled` are all harness
plumbing. Counting them would report the skill catalog as something the user
asked for.

**A delegated child's prompt is its parent's task description, not a request.**
Child sessions receive their instructions on the same `user/message` type, so
they are counted separately (`delegated`) and never listed as the user's words.
The parent-agent handshake paragraph is stripped for the same reason.

**Fork-inherited history is excluded.** A fork child's log physically contains
its parent's entire history. On this deployment one heavily forked session
carried 52,947 events of which 51,302 were inherited; counting them reported 88
prompts and 9,599 tool calls where the session's own work was 3 prompts and 341
tool calls. The `session/end-seed` marker carrying `inherited: true` is the
exact cut, with the storage handle's `inheritedEventCount` as a cross-check.

**Time is unioned, not summed.** Fifteen delegated agents running at once are
one afternoon of work. Summing their spans reported 15,154 hours of tool time
for a month; the union of the observed intervals reports the wall-clock time
something was actually running. The same reasoning drops the summed
model/tool wall times from the report's headline: under parallelism they are
meaningless, and only "active time" answers "how long did I work".

**Only structural facts are retained.** Per-day counters, a bounded prompt list,
bounded command lines, and the set of written files. No tool result body, no
assistant message body, no image payload — the largest session log here is
21 MB compressed and must not become a 21 MB index entry.

## Report contents

- Overview: active days, active time, root versus sub-agent sessions, turns,
  steps, requests, delegated tasks, tool calls and failures, output tokens.
- What I asked for: the user's prompts in time order, with project and clock.
- Per day: active window, active duration, sessions, requests, tool calls.
- Per project: sessions, requests, turns, tool calls, output tokens.
- Files changed, tools used, commands run.
- Session list with title, project, window, and counters.

Day bucketing uses an explicit UTC offset (`tzOffsetMinutes`) rather than the
process timezone, so the same store read from another machine produces the same
days. Changing the offset invalidates the index, because day buckets are stored
as absolute dates.

## Configuration

```yaml
- id: dsh-work-journal
  name: '@yiln-dsh/dsh-plugins/work-journal'
  inject:
    - tools
    - commands
    - sessionPersistence
  config:
    indexDir: ''
    refreshTtlMs: 60000
    maxSessionsPerScan: 400
```

| Field | Default | Meaning |
| --- | --- | --- |
| `indexDir` | `''` | Absolute directory for `index.json`; empty selects `$DSH_HOME/work-journal/<hash>`, scoped by profile and offset. |
| `tzOffsetMinutes` | host offset | UTC offset in minutes for day bucketing. `480` is UTC+8. |
| `refreshTtlMs` | `60000` | Reuse window before a query triggers a background refresh. |
| `maxSessionsPerScan` | `400` | Sessions one pass may read before yielding. A cold build loops passes until complete; this bounds how long the process is held, not how much is indexed. |

`indexDir` must be absolute; a relative value fails the row rather than
silently degrading, because a misconfigured path is an operator error.

## The index is derived data
`index.json` can always be rebuilt from the session store, so it has no
migration, backup, or transaction story. It is written whole through
`writeFileAtomic`, so a reader sees either the previous complete document or the
next one, and a truncated or unknown-version document is discarded and rebuilt
rather than repaired in place. Files are owner-only (`0600`/`0700`): the index
quotes the user's own prompts.

One unreadable session is recorded in `errors` and skipped; its revision is
deliberately *not* recorded, so a later pass retries it instead of freezing the
failure forever. A store that cannot be listed at all does not advance
`lastScanAt`, so it cannot masquerade as a store that was read and found empty.

## Generated reports

The module has two surfaces that share one directory:

- **Live query** — the `work_journal` tool and `/journal` command project the
  session store on demand, exactly as described above. This is the original
  contract and needs nothing but `sessionPersistence`.
- **Generated reports** — with `schedule: true`, an agent reads the session logs
  for a closed period and writes a Markdown report that the panel lists and
  searches. This spends model tokens unattended, so it is off by default.

### Schedule

| Report | Fires | Covers |
| --- | --- | --- |
| `day` | every day 00:00 local | the previous day |
| `week` | every Saturday 00:00 local | the completed Saturday–Friday week |
| `month` | the 1st, 00:00 local | the previous calendar month |

A slot always names the period it owns, never "now", so a late timer, a suspended
host, and an in-process catch-up all resolve the same range. Each kind's watermark
is a *contiguity* record: a failed run freezes it, so the next boot re-runs
everything after the hole rather than orphaning it. `maxCatchUp` bounds a long
downtime, and always reserves the newest period of every kind first — a month
offline must still produce a monthly report rather than spending the whole budget
on daily ones.

### Self-contamination

The report agent is itself a DSH session in the store it scans. Left alone, each
day's report would include yesterday's report as material. Two guards:

1. `agents.create({ meta: { agentPreset: 'yiln-work-journal' } })` stamps the
   session, and the scan skips any session carrying that preset.
2. The handle is disposed after each run, which removes the session outright.

`agentPreset` is the durable half: it survives a crash between generation and
disposal, which the removal does not.

### Storage

`<DSH_HOME>/work-journal/<profile-key>/reports/` holds, per period, a `.md` body
and a `.json` metadata record carrying `startTime`/`endTime` (the span the panel
shows), `status`, the model route, and `sessionCount`. An `index.sqlite` beside
them mirrors every report into three tables: the rows themselves, an FTS5 trigram
index for keyword search, and a `vec0` table of 512-dimension embeddings for
semantic search.

Keyword search splits by term length: FTS5's trigram tokenizer cannot match a
term shorter than three characters, so two-character Chinese words such as 修复
are answered by a `LIKE` scan instead. Without that split they would silently
return nothing. Hybrid mode fuses the two rankings with RRF, because a bm25 score
and a cosine similarity are not comparable numbers.

Reports are kept permanently.

### Search degradation

Semantic search needs both the `sqlite-vec` extension and a local embedding
model, and neither is required:

- Without `sqlite-vec`, the store opens, keyword search works, and the vector
  table is skipped.
- Without `@huggingface/transformers` or a cached model, reports are still
  written and keyword search still works.
- A client asking for `semantic` on a deployment that cannot serve it is answered
  with `keyword` hits and a `mode` field naming what actually ran, rather than an
  error.

The model is `onnx-community/bge-small-zh-v1.5-ONNX` (q8, 512 dims, ~24 MB). It
was chosen over `Qwen3-Embedding-0.6B` on measured grounds: on this deployment's
own Chinese session logs the larger model scored 86.7% vs 79.2% self-retrieval
Top-1, but at 8x the latency, 25x the download, and a first-write cost of 9.7 s
against 0.1 s. At a few thousand reports, hybrid keyword+vector search closes the
accuracy gap, and the Chinese technical vocabulary in these logs (tool names,
hostnames, version strings) favours the keyword half anyway.

### Memory

Embedding runs in batches and concurrent calls are serialized: ONNX activation
memory scales with batch size, and a single 120-text batch has already OOM-killed
a host. Do not raise `batchSize` casually.

## Boundaries

- Host-side. The panel is the only Client contribution.
- Reads only. The module never writes to the session store.
- Hard service dependencies: `sessionPersistence` and `connection`.
  `sessionPersistence` carries the log; `connection` is what registers the panel's
  `/api/work-journal` route, so the Loader row declares it too. `sessionQuery` and
  `sessions` are read optionally — each improves the result (mid-turn visibility)
  without being required.
- The tool is available to every session on this deployment, including subagent
  children; the journal is deployment-wide history, not per-session state.
- `work_journal` clips its Markdown to 24,000 characters; use `project` or a
  narrower range rather than asking for everything.
- The first query after a restart builds the whole index; later passes read only
  what changed. Cold-start time depends on the session store and host performance.
- A report built from an incompletely indexed store is labelled in both the
  tool value (`complete`, `pendingSessions`) and the rendered Markdown.
- Commands are attributed per project as well as per day, so a project-filtered
  report cannot show another project's shell history.

## Tests

```bash
npm test
```

| Suite | Pins |
| --- | --- |
| `test/extract.test.js` | Human-prompt filtering, handshake stripping, fork-seed exclusion, tool pairing, failure and usage counting. |
| `test/period.test.js` | ISO weeks, calendar months and leap years, day stepping, range floors and caps. |
| `test/report.test.js` | Interval unioning, range scoping, project grouping, Markdown contract. |
| `test/collector.test.js` | Revision reuse, deletion, per-pass budget, failure isolation and retry. |
| `test/store.test.js` | Profile scoping, first run, corrupt-document recovery, atomic owner-only writes. |
| `test/runtime.test.js` | Cold-versus-warm query policy, cold build to completion, partial-answer labelling, live-session reads, project filtering, rebuild, scan joining. |
| `test/plugin.test.js` | Tool, command, and route registration; tool output envelope; command and panel responses; the shared `/api/work-journal` envelope and its guards. |
| `test/schema.test.js` | The definition through the real `dsh-tools` boundary: compiled JSON Schema, argument rejection, and canonical-value validation. |
| `test/client.test.js` | Left-rail button and `main` page registration, load cancellation (the blank-page regression), locale parity, RPC error mapping, report-list ordering and spans, search, detail loading. |
| `test/report-store.js` | Frozen schema, FTS5 trigram plus short-term LIKE fallback, `vec0` KNN with a similarity floor, RRF fusion, atomic writes, degradation without `sqlite-vec`. |
| `test/scheduler.test.js` | Calendar alignment across month/year/leap boundaries, catch-up enumeration and its per-kind quota, watermark freezing on failure, timer cleanup. |
| `test/reporter.test.js` | The self-contamination guard, range filtering, prompt material bounds, failed-report recording, timeout on a wedged turn. |
| `test/embedding.test.js` | Batching, normalization, abort, serialized concurrency. Model-dependent cases skip without a cache. |

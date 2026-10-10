# work-journal

Internal module of `@yiln-dsh/dsh-plugins`. Install and release the root package;
this module has no separate npm package or version. Loader row: `dsh-work-journal`.

Records what this deployment was actually used for and reports it over a
calendar range. Three consumers share one runtime: the `work_journal` model
tool, the `/journal` command, and a right-sidebar Web panel.

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

## Boundaries

- Host-side. The panel is the only Client contribution.
- Reads only. The module never writes to the session store.
- Hard service dependency: `sessionPersistence`. `sessionQuery`, `sessions`, and
  `connection` are read optionally — each improves the result (mid-turn
  visibility, the panel channel) without being required.
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
| `test/plugin.test.js` | Tool, command, and route registration; tool output envelope; command and panel responses. |
| `test/schema.test.js` | The definition through the real `dsh-tools` boundary: compiled JSON Schema, argument rejection, and canonical-value validation. |
| `test/client.test.js` | Tab and guide registration, locale parity, RPC error mapping, panel filtering, stylesheet lifetime. |

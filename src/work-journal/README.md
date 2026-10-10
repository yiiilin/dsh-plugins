# work-journal

Internal implementation of `@yiln-dsh/dsh-plugins`.
See [module notes](../../docs/modules/work-journal.md) and the [root README](../../README.md).

Records what this DSH deployment was actually used for, and reports it as a
daily, weekly, or monthly summary. The source of truth is the harness's own
session store: no instrumentation is added to the agent loop, so the journal can
never disagree with what happened.

## Consumers

| Consumer | Entry point |
| --- | --- |
| Model tool | `work_journal` — ask the harness what you did |
| Slash command | `/journal [day\|week\|month\|recent\|all\|status\|rebuild] [YYYY-MM-DD]` |
| Web panel | "工作日志" tab in the right Sidebar |

All three read one runtime, so a report cannot differ by how it was asked for.

## Layout

- `lib/extract.js` — pure projection from one session log to an activity record.
- `lib/collector.js` — incremental scan keyed by the store's own revision token.
- `lib/period.js` — local calendar range arithmetic.
- `lib/report.js` — aggregation and Markdown rendering.
- `lib/store.js` — atomic, profile-scoped index storage.
- `lib/runtime.js` — index ownership, refresh policy, query answering.
- `index.js` — plugin entry: tool, command, and RPC route.
- `client.js` — right-sidebar panel.

## Tests

```bash
npm test
```

The suite covers the projection rules (human prompts versus harness plumbing,
fork-seed exclusion, tool pairing), the range arithmetic, the aggregation and
Markdown contract, the incremental scan (revision reuse, deletion, per-pass
budget, failure isolation), the index store, the runtime query policy, and the
plugin's registration contract.

# Reference

Procedures behind [`SKILL.md`](SKILL.md): the writing standard, status mechanics, the reconcile procedure, takeovers, failure modes, and the block that enforces this workflow in a repo. Document *shapes* live in [`FORMATS/`](FORMATS/); this file owns *procedure*.

## The writing standard

**The transcription test.** Every function-level section must be implementable by someone who has never seen the code and cannot ask you a question. Signature, inputs, outputs, steps, edge cases, error paths, budget. Prose that gestures at behavior fails the test.

Write for two readers at once: the human who confirms it, and the agent that transcribes it. Tables for interfaces and edge cases, numbered steps for algorithms, one short sentence per rule.

**What belongs:** the reason behind a choice, the constraint it satisfies, the interface, the invariants, the numbers, the alternative you rejected and why. None of that is recoverable from the code.

**What never belongs:** a line-by-line restatement of the code (the code is the transcription — the doc is the source), commit history (that is `git log`), aspirations without a budget ("should be scalable"), and facts that live in config (`package.json` scripts, the directory layout). Cache what a reader cannot look up: the unwritten convention, the gotcha, the reason.

**Rejected alternatives get one line each.** This is what stops the next session — human or agent — from re-litigating a settled choice: `Rejected: Redis cache — adds an operational dependency for a workload under 100 QPS.`

**A doc nobody can find does not exist.** Every doc appears in `docs/README.md`, and every doc names the paths it owns.

## Ports: glossary and ADR formats

Two formats this skill needs but does not own. **`domain-modeling` owns both** — use its `CONTEXT-FORMAT.md` and `ADR-FORMAT.md`. Adapters name this port rather than a concrete skill, so a repo whose tooling differs still has one place to look. Without it installed, these minimum shapes are enough:

```markdown
# CONTEXT.md — one entry per term, nothing else
**Term**:
One or two sentences defining what it IS, not what it does.
_Avoid_: synonym, synonym

# docs/adr/NNNN-slug.md — numbered from the highest existing number
# Short title of the decision

One to three sentences: the context, what was decided, and why.
```

A glossary entry is a definition plus its rejected synonyms. An ADR records *that* a decision was made and *why* — it can be a single paragraph, and most are.

A repo whose `docs/adr/` was written by another tool keeps what it has — takeover maps, it does not migrate — and its new ADRs follow the shape above.

## Status mechanics

The status lives in two places, and they must agree: the doc's header and its row in `docs/README.md`.

| Status | Means |
|---|---|
| `draft` | Being written; nobody has reviewed it |
| `awaiting confirmation` | Presented to the human, with its open decision points listed |
| `confirmed` | The human approved this version. **The only state that authorizes code** |
| `implemented` | Transcribed, reconciled item by item, evidence recorded |
| `superseded` | Replaced; the header reads `Status: superseded by docs/<name>.md` |

`confirmed` requires no open decision points. An unanswered point is recorded `D5 — deferred, answer pending` rather than silently dropped, and the doc stays `awaiting confirmation` until it is answered or the point is withdrawn.

A doc's **contract** is frozen once confirmed: changing the interface, design, decision points, boundaries, or budgets bumps the version and returns the changed part to `awaiting confirmation` — from `confirmed` and `implemented` alike; the change log gains one line: `v2 — D5 dropped the legacy column (2026-09-17)`.

**Bookkeeping is not a contract change.** Recording evidence, setting `Reconciled`, and moving the status line never reopen a doc — otherwise step 5 would unfreeze the very doc it is closing out. A reconcile that finds the doc wrong (`divergent`) *is* a contract change and goes back through the gate like any other.

**Direction of transcription.** Forward is the default: a contract change re-enters at `awaiting confirmation`, and the code follows the confirmation. The exception is the human saying to change the code directly — authorized by that instruction rather than by a doc review, so it is not an unconfirmed change; only the direction differs:

| Path | Who leads | What the doc is | Change log |
|---|---|---|---|
| default | the doc | a contract the code follows | — |
| `code-first` | the code | a record of what was built | `code-first` |

A `code-first` doc keeps its `implemented` status.

`implemented` is a claim about evidence, not about effort. If a reconcile has not been run, the doc stays `confirmed`.

## Reconcile procedure (step 5)

1. **Extract the checkable items** from the doc: interface entries, decision points, edge-case rows, budget numbers, named tests.
2. **Locate the code** that realizes each — file and symbol.
3. **Classify** each item: realized / missing / divergent.
4. **Resolve**: `missing` on a confirmed interface, edge case, or budget is a contract breach — the code is wrong, fix the code. `missing` on a backfilled `draft` doc is the doc's error — fix the doc. `divergent` means the doc wins unless the human says otherwise; either way the doc is edited first, then the code.
5. **Record evidence** per item in the doc's Reconcile evidence table: the command that proves it (test name, benchmark, curl), its result, and the date.
6. **Close out**: status `implemented`, `Reconciled` date set, index row updated.

Then run the doc-set check over the repo — it catches the five mechanical failures nothing else sees: an unknown status, a broken link, a doc missing from the index, an index row whose status drifted from the header, and an `Owns:` glob whose files lack their `// doc:` line.

```
node <this skill>/scripts/check-doc-set.mjs .
```

Report the three lists. "Looks consistent" is not a reconcile.

## Takeover: an existing codebase

Document **just in time** — the code you are about to change plus one level of its neighbors. Documenting a legacy repo up front produces a doc set nobody trusts, and it delays the work that would have proved the docs useful.

**The unit is the package.** Ten independent packages become ten feature docs as their work happens — not one per repo, and not one per file.

1. Create `docs/README.md` and a thin `docs/architecture.md`: boundaries and dependency direction only, status `draft`.
2. Backfill a feature doc from the code as it stands, in the format for that type.
3. Mark what is an accident of history rather than a decision: `Open: is the 30 s timeout intentional?` becomes a decision point for the human.
4. The first real change after takeover is what promotes the doc to `confirmed` — the backfill itself is never confirmed, because nobody has actually agreed to it.

A repo that already has its own `docs/` layout is mapped onto, not migrated: keep the existing files where they are, retrofit the header fields, and build the index over the existing structure.

## Failure modes

| Symptom | Fix |
|---|---|
| Doc reads like a feature announcement ("supports X, Y, Z") | Rewrite as interface + steps + edge cases; a doc must let someone build the thing |
| Doc restates the code line by line | Delete the restatement; keep the reason, the constraint, the number |
| Every decision point is "recommended: as described" | You are not surfacing choices; list the alternatives you actually rejected and what each costs |
| Implementation "mostly matches" the doc | That is drift. Reconcile item by item, and edit the doc before the code |
| Every tiny change demands a doc | Check the tier table; T0 work needs none |
| Docs pile up unconfirmed | The confirmation list is too long — split the work and confirm in smaller units |
| Doc set grows, trust does not | A `confirmed` doc was edited without re-confirmation, or a doc was marked `implemented` without evidence |
| The index drifts from the docs | Nothing reads the index. Step 1 and step 5 both do. The map may run long — it is grepped, not read; what has to stay short is its Open decision points section. The doc-set check catches the drift mechanically |
| A doc points at a file that does not exist | Nothing validates pointers. Re-check every relative link whenever a doc is renamed, moved, or split |

## Enforcing it in a repo

Pasting this is how a repo opts in: it is what makes the workflow fire on its own, and it is what the skill's trigger looks for. Every session then starts under the workflow, whether or not the skill is loaded.

```markdown
## Development workflow

This repo develops doc-first: `docs/` is the contract, code is its transcription.
Where this repo already has a rule — releases, i18n, verification — that rule stands;
this adds the doc workflow, it replaces nothing.

- Find the owning doc before changing code — `docs/README.md` indexes them by owned path.
- Decisions land in the doc as numbered decision points before they land in code.
- Implement only from a doc marked `confirmed`; edit the doc before changing confirmed behavior.
- Reconcile item by item and record evidence before marking a doc `implemented`.
- Owned files name their doc in the header, where the language has comments: `// doc: docs/domains/<domain>/features/<name>.md`.
- The doc-set check runs before any doc is called `implemented`.

Full workflow, formats, and the check: the `doc-driven-development` skill.
```

## Splitting

- Split a feature doc into `domains/<domain>/modules/<name>.md` when it stops fitting one sitting, or when two people would confirm it separately.
- Split `docs/architecture.md` per subsystem once it covers more than one deployable or more than roughly five modules.
- `docs/README.md` stays the only map. When a doc moves, its index row moves in the same change.

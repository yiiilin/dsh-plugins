# Feature doc format — `docs/<feature>.md`

The doc that carries one unit of work: its design, its verification, and the function detail for anything complex. It spans as many modules as the work needs. When it stops fitting one sitting (≤ ~400 lines), move the function-level detail into `docs/modules/<name>.md` and leave a pointer.

This is the layer between `architecture.md` above it and module docs below it.

## Header

```markdown
Status: awaiting confirmation
Version: v1
Tier: T2
Owns: src/import/**
Depends on: docs/architecture.md
Reconciled: —
```

| Field | Rule |
|---|---|
| Status | `draft` · `awaiting confirmation` · `confirmed` · `implemented` · `superseded by <doc>` |
| Version | `v1`, `v2`, … — bumped every time a `confirmed` doc is edited |
| Tier | `T1` · `T2` · `T3` — sets the depth this doc is expected to reach |
| Owns | the code paths this doc is the contract for, as globs; `—` for a doc that owns no code |
| Depends on | docs that must be read first |
| Reconciled | date of the last item-by-item reconcile; `—` until then |

## Sections

1. **Goal** — what becomes true for the user, one paragraph. Then **Non-goals**: what this deliberately does not do. Non-goals are load-bearing: they are how scope stays closed.
2. **Interface** — every symbol this unit exposes or consumes, as `symbol | signature | notes`, plus data shapes as a type block. This is what the code and the other docs will reference.
3. **Design** — how it works: data structures, the numbered flow, state machines, invariants. State invariants as checks: `byteOffset never points past a committed batch`.
4. **Verification** — the assumption table and the test plan (below).
5. **Function detail** — one subsection per complex function, in the `module.md` shape, or a pointer: `→ docs/modules/import.md`.
6. **Edge cases and errors** — table of `case | expected behavior | test`.
7. **Budgets** — numbers, with the box.
8. **Decision points** — see `decision-point.md`.
9. **Change log** — one line per version. A version built code-first says so: `v2 — retry budget, code-first (2026-09-17)`.

## The verification section

| Assumption | Cheapest test | Evidence | Verdict |
|---|---|---|---|
| `csv-parse` streams without buffering the file | 20-line spike on a 1 GB file, watch RSS | spike 2026-09-12: RSS flat at 48 MB | holds |
| a 1000-row upsert stays under 50 ms | benchmark on staging | 38 ms p95 | holds |

- **Assumptions are the ones that would sink the design**, not the ones you already know.
- **Cheapest test first**: read the dependency's source, a spike, a benchmark, the vendor's docs, one question to the human.
- **Evidence is a command and a result, with a date.** "Tested" is not evidence.
- **A failed assumption returns to Design.** Implementing on an `open` assumption needs the human's explicit acceptance, recorded as a decision point.
- **The test plan names its seams** — which test covers which section, at the highest seam that works.

## Rules

- **A reader who has never seen the code builds this from the doc alone.** That is the whole test.
- **Anything the human would want a say in is a decision point**, never a sentence buried in Design.
- **Restating the code is not documentation.** Keep the reason, the constraint, the number.
- **`implemented` is claimed only after an item-by-item reconcile with recorded evidence.**

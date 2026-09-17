---
name: doc-driven-development
license: MIT
description: "Doc-driven development: the repo's docs/ set is the contract; code is its transcription. Use when a repo carries a doc set (docs/README.md indexing per-doc status), or when asked to write design docs before coding, implement from a confirmed doc, reconcile code that drifted from its doc, or onboard an existing repo. Covers the architecture, design, verification, and function-level pseudocode layers plus the confirmation gate. Skip repos with no doc set unless asked to adopt it."
---

# Doc-Driven Development

The repo's `docs/` set is the **contract**. Code is its **transcription**: architecture, design, verification, and function-level detail are defined in the contract first, and a human confirms the definition before any of it becomes code.

A doc is an abstraction of the code, closer to pseudocode than to prose. Correcting a doc costs the human a fraction of reading a diff, and it happens *before* the decision hardens into a diff: every choice you would otherwise make silently becomes a numbered line the human can cross out.

Adopt this workflow when the user asks for it or when `docs/README.md` already exists. In a repo with no doc set, offer it in one line and continue with the user's actual request.

## The loop

Steps 1–3 produce documents only; code begins at step 4. Keep step 3 and step 4 apart — the human's answer *is* the gate.

1. **Locate** — read the code you are about to change, then find the doc that owns it. `docs/README.md` indexes every doc by the paths it `owns`. No owning doc → step 2 creates one.
   *Done when:* every path you will touch is covered by a doc, or you have named the doc you will create.
2. **Write the contract** — write or amend that doc at the layer the change belongs to, following the format for that document type. Every choice the human would want a say in becomes a **decision point**: numbered, with options, a recommendation, and the recommendation's cost.
   *Done when:* each decision point carries options + recommendation + cost, the doc carries a status line, and its open points are listed in `docs/README.md`.
3. **Present the confirmation list** — one line per open decision point, high-stakes ones marked `⚠`, then a short statement of what the doc now defines and what implementing it will change. Stop there.
   *Done when:* every open point appears with its recommendation and cost, the `⚠` ones are marked, the list matches the index's Open section, and the human has answered.
4. **Transcribe** — implement from a doc whose status is `confirmed`. The doc is the specification, not a hint. A gap, contradiction, or better idea found while coding returns you to step 2: amend the doc, confirm the delta, then code it.
   *Done when:* every item in the doc exists in code, and every path in the diff maps to an item in the doc — a path with no item is a gap, and gaps return you to step 2.
5. **Reconcile** — walk the doc against the code item by item, record the verification evidence in the doc, set the status to `implemented`, and update `docs/README.md`.
   *Done when:* the doc reads `implemented`, its evidence is recorded, and the index row matches.

## The doc set

One doc per **unit of work a human can confirm in one sitting** — a feature, a fix, a migration. It may span modules; it may not span two unrelated intentions.

| Artifact | Holds | Format |
|---|---|---|
| `docs/README.md` | Index: conventions, one row per doc, open decision points, reading order | [`FORMATS/index.md`](FORMATS/index.md) |
| `docs/architecture.md` | Why the system is shaped this way: boundaries, dependency direction, data flow, budgets | [`FORMATS/architecture.md`](FORMATS/architecture.md) |
| `docs/features/<name>.md` | Design, the verifications it rests on, function detail for one unit of work | [`FORMATS/feature.md`](FORMATS/feature.md) |
| `docs/modules/<name>.md` | Function-level detail, when a feature doc outgrows one sitting | [`FORMATS/module.md`](FORMATS/module.md) |
| `docs/verifications/<method>.md` | A premise the design rests on: the cheapest test, the evidence, the verdict | [`FORMATS/verification.md`](FORMATS/verification.md) |
| `CONTEXT.md` | Glossary: one definition and its rejected synonyms per term | [`REFERENCE.md`](REFERENCE.md), or `domain-modeling` when installed |
| `docs/adr/NNNN-slug.md` | Decisions meeting all three ADR conditions | [`REFERENCE.md`](REFERENCE.md), or `domain-modeling` when installed |

Decision points live in the doc that owns the work (see [`FORMATS/decision-point.md`](FORMATS/decision-point.md)); escalate one to an ADR only when it is hard to reverse, surprising without context, *and* the result of a real trade-off.

**Traceability is what makes "every change has a doc" checkable.** A doc names the paths it owns as repo-relative globs — code, config, CI, manifests, anything (`Owns: src/cache/**, .github/workflows/ci.yml`). An owned source file names its doc back in its header where the language has comments (`// doc: docs/cache.md`). Two greps reconcile the whole repo.

**Language:** docs are written for the human who confirms them, so they follow the repo. Detect it from the existing docs or `AGENTS.md`, ask once if unclear, and record the answer in the index conventions block — never re-ask, never switch mid-repo.

## Depth scales with risk, never with line count

| Tier | What it is | What it requires |
|---|---|---|
| T0 | Typo, copy, formatting | Just do it — unless it touches behavior a confirmed doc describes, which makes it T1 |
| T1 | Ordinary feature or fix | Design + verification sections, key functions detailed, one confirmation pass |
| T2 | New subsystem, perf-critical path, migration, concurrency, external protocol, auth | Full four layers in their own doc, decision points confirmed individually |
| T3 | New dependency, layer change, cross-cutting concern | `docs/architecture.md` first, then the feature doc |

The tier scales the *depth* of the doc. Every change that alters behavior still has an owning doc: a T0 edit to confirmed behavior is T1 work.

## Hard rules

1. **Code begins at `confirmed`.** A doc authorizes implementation only in that state; `draft` and `awaiting confirmation` authorize nothing.
2. **The doc changes first.** When code and doc disagree, amend the doc, confirm the delta, then change the code. Drift is resolved in the doc's favor or by the human, never by quietly editing code.
3. **No silent decisions.** Library, data structure, algorithm, retry and cache policy, schema, public naming, error surface — each becomes a decision point. If you would otherwise choose it alone, it is a decision point.
4. **Numbers, not adjectives.** `fast` → `P99 ≤ 50 ms at 1k QPS`. `robust` → `survives a kill mid-write and resumes from the last committed offset`. `clean` → `no module imports upward, enforced by <check>`.
5. **Pseudocode, not prose.** A function-level section transcribes directly — if two engineers could implement it differently, it is not done. The checklist is the transcription test in [`REFERENCE.md`](REFERENCE.md).
6. **A contract edit goes back through the gate.** Changing a doc's contract — interface, design, decision points, boundaries, budgets — bumps its version and returns the changed part to `awaiting confirmation`, from `confirmed` and `implemented` alike. Closing a doc out is not a contract edit; [`REFERENCE.md`](REFERENCE.md) draws that line.

## Changing implemented work

**The direction is forward by default.** Changing work an `implemented` doc governs means that doc re-enters the loop — back to `awaiting confirmation`, the human confirms, the code follows. Doc first, always: the human sees the change as a decision, not as a diff.

The one exception is the human saying to change the code directly. That instruction **is** the authorization, so the change is not unconfirmed; only the direction differs — see the transition table in [`REFERENCE.md`](REFERENCE.md). Obey, then update that doc's content **in the same session** so it describes what the code now does, mark the changed part `code-first` in its change log, and record the choices made while coding as decision points settled in code.

## Status lifecycle

`draft` → `awaiting confirmation` → `confirmed` → `implemented` → `superseded`

Only `confirmed` authorizes code. `implemented` is claimed only after step 5, and `superseded` names the doc that replaced it. A contract change re-enters at `awaiting confirmation` from `confirmed` or `implemented`; bookkeeping does not. Full transitions are in [`REFERENCE.md`](REFERENCE.md).

## The confirmation list

The list is the human's entire review surface, so keep it skimmable — one line per decision point:

```
D2   Eviction policy — recommend: in-process LRU (cost: misses rise once we run >1 replica)
D3   Retry budget — recommend: 3 tries, exponential to 2 s, then dead-letter
⚠ D5 Drop the legacy `mode` column — irreversible; needs an explicit answer
```

Mark a decision point `⚠` when it needs an explicit answer — the criteria are in [`FORMATS/decision-point.md`](FORMATS/decision-point.md). Everything unmarked clears in bulk with "go with the recommendations".

## Verification layer

A design is believable once the premises it rests on are named and each has been tested as cheaply as possible. Each premise gets its own doc, and the design doc links to it — the shape is in [`FORMATS/verification.md`](FORMATS/verification.md): one question, the cheapest method that settles it, the evidence with a date, the verdict.

## Driving it from the human's side

| The human says | You do |
|---|---|
| "write the doc first" · 先出文档 | Steps 1–3 |
| "go with the recommendations" · 按推荐来 | Accept every unmarked recommendation, set the doc `confirmed`, then step 4 |
| "D3 → option B" · D3 改成 B | Amend that decision point, re-present only the changed lines |
| "implement it" · 实现 | Step 4, provided the doc is `confirmed`; otherwise name the decision points still open |
| "check docs vs code" · 核对 | Step 5 |
| "we're changing X" · 要改 X | Step 1 — reopen the owning doc to `draft` |

## Further reference

- [`FORMATS/`](FORMATS/) — how each document type is written: header fields, section skeleton, rules.
- [`REFERENCE.md`](REFERENCE.md) — the writing standard, status mechanics, the item-by-item reconcile procedure, takeover of an existing codebase, failure modes, and a paste-ready `AGENTS.md` block that enforces this workflow in a repo.
- [`docs/`](docs/) and [`CONTEXT.md`](CONTEXT.md) — this skill's own contract, written in its own format. A live example: read it to calibrate how concrete a doc has to be.
- [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — MIT license and the material adapted from `mattpocock/skills`.
- [`scripts/check.mjs`](scripts/check.mjs) — `node scripts/check.mjs` verifies this package: frontmatter, the description cap, every link, and orphan files.

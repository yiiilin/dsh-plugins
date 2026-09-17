# Skill architecture

Status: awaiting confirmation
Version: v1
Owns: `SKILL.md`, `REFERENCE.md`
Depends on: —
Reconciled: —

## 1. Purpose and scope

This skill makes a repo's `docs/` set the authoritative contract and code its transcription: definitions first, a human confirmation gate, implementation second, reconcile last.

Out of scope: what any particular project's docs should say (that is the project's own contract), code review, test frameworks, and project management.

## 2. Context — what crosses the boundary

| Outside | What crosses it |
|---|---|
| The human | Confirms decision points; owns every ⚠ answer |
| The repo under the skill | Supplies `docs/`, `CONTEXT.md`, `docs/adr/`, source headers; receives the contract |
| The harness | Reads only `SKILL.md`; everything else is inert until a pointer fires. It truncates the catalog description at 497 characters and rebuilds the catalog per step, so a change here needs no restart |
| `domain-modeling` skill | An *adapter* for the glossary and ADR formats, not a requirement — `REFERENCE.md` declares the minimum shapes when it is absent |
| `grilling` skill | Owns the interview that sharpens a design before it is written down |
| `code-review`, `tdd` skills | Own the downstream checks; a confirmed doc is the input they review against |

## 3. Dependency direction

`SKILL.md → FORMATS/ + REFERENCE.md + docs/`. `FORMATS/ → REFERENCE.md` for the writing standard and the format ports. `docs/ → FORMATS/` for shape.

Rules, enforced by reading:

- `SKILL.md` never restates a format's sections; it points.
- `FORMATS/` never restates the loop.
- `REFERENCE.md` never restates a format; it owns procedures and ports.
- No adapter depends on another adapter: where a format needs something external, it names a port in `REFERENCE.md`, never a concrete skill.
- `docs/` may cite anything. `SKILL.md` cites it once, as the example pointer; nothing else shipped cites it, and `docs/` is never load-bearing for the workflow.

## 4. Data ownership

One fact, one owner. When two files disagree, the owner wins and the other is fixed.

| Fact | Owner |
|---|---|
| The loop and its completion criteria | `SKILL.md` |
| Tier boundaries | `SKILL.md` |
| Status vocabulary and transitions | `REFERENCE.md` |
| Glossary and ADR formats (the ports) | `REFERENCE.md` |
| Section skeleton per document type | `FORMATS/<type>.md` |
| Decision-point shape, ⚠ rules, ADR escalation | `FORMATS/decision-point.md` |
| This skill's own design record | `docs/` |
| License and attribution | `THIRD-PARTY-NOTICES.md` |
| A target repo's language, layout, per-doc status | that repo's `docs/README.md` |

## 5. Budgets

- `SKILL.md` ≤ 200 lines — loaded on every invocation.
- Each `FORMATS/` file ≤ 120 lines, and only one is loaded at a time.
- The frontmatter description ≤ 497 characters — the catalog truncates at 497, and a truncated pointer loses its trigger branches. Measured: the first draft ran ~620 and was cut mid-sentence.
- A confirmation list the human clears in under two minutes.
- `node scripts/check.mjs` passes before the package is copied anywhere.

## 6. Decision points

D1 Final file tree
- Options: A `SKILL.md` + `FORMATS/` + `REFERENCE.md` + `CONTEXT.md` + `docs/` / B everything folded into one `SKILL.md` / C procedures split one file per procedure alongside `FORMATS/`
- Recommend: A — one always-loaded file, one file per format, one file of procedures
- Cost: an agent must follow two pointers (shape vs procedure) and may load neither
- Affects: `SKILL.md`, `REFERENCE.md`, `FORMATS/**`

D2 Package self-check — **B** (2026-09-17)
- Options: A check by hand / B one dependency-free script for the invariants that broke silently / C B plus a CI hook
- Recommend: B — implemented as `scripts/check.mjs`
- Cost: one more file to keep working; it checks this package only, not a target repo's doc set (that is D11 in `docs/doc-set.md`, still open)
- Affects: `scripts/check.mjs`, `docs/architecture.md` §5
- Evidence: three failures shipped silently before it existed — the 620-char description the catalog truncated, the pointer to a `TEMPLATES/` that never existed, and §3's own invariant that `SKILL.md` violated

## 7. Change log

- v1 — initial; awaiting confirmation

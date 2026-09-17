# Design validation

Status: confirmed
Version: v1
Verifies: docs/features/doc-set.md
Verdict: holds for 3 of 6; 3 open pending the pilot
Date: 2026-09-17

## Question

Does this convention actually reduce the cost of review, and does it survive contact with a real repo?

Why it matters: if the human reads the confirmation list no faster than a diff, the whole gate is overhead.

## Premise 1 — a human clears a decision list faster than they read the equivalent diff

**Method.** This design session: put the open questions to the human as numbered points with recommendations, one round at a time.

**Evidence.** Round 1 — seven decision points answered in one pass, no clarification asked (2026-09-17).

**Verdict.** holds.

## Premise 2 — citing `domain-modeling` for the glossary and ADR formats is enough; no local format is needed

**Method.** Read `CONTEXT-FORMAT.md` and `ADR-FORMAT.md` in full.

**Evidence.** Both are short, opinionated, and complete — they define creation triggers, entry shape, and the escalation test. Their absence is now covered by the port in `REFERENCE.md`.

**Verdict.** holds.

## Premise 3 — one format file per document type is an established shape, not an invention

**Method.** Survey every installed skill for the pattern.

**Evidence.** `domain-modeling` ships two (`CONTEXT-FORMAT.md`, `ADR-FORMAT.md`), `teach` ships four. Nothing auto-loads a side file, so each pointer has to say when to read it.

**Verdict.** holds.

## Open

No method has been run for these yet. The pilot is the method.

| Premise | Method it needs |
|---|---|
| One doc per confirmable intent stays readable | Pilot: write one on a real change and measure its length against the diff |
| `Owns` + file-header pointers keep docs findable without anyone tending the index | Pilot: grep the repo in both directions a month in |
| A central `docs/` does not decay into a write-only folder | Pilot: count docs still `confirmed` or `implemented` after a month |

## If it fails

Premise 1 failing means the gate costs more than it saves — the confirmation list needs fewer, larger points, or the convention is not worth running on small changes. Premises 4–6 failing means the doc set has become a write-only artifact, and the honest response is to cut the layers that are never read.

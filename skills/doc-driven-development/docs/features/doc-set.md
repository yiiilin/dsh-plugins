# Doc-set convention

Status: awaiting confirmation
Version: v1
Tier: T2
Owns: `FORMATS/**`
Depends on: docs/architecture.md
Reconciled: —

## 1. Goal

Make every change in a repo traceable to a doc a human has confirmed, so that implementation is transcription instead of invention: the agent stops deciding architecture, algorithms, and details on its own, and the human reviews decisions in a form that costs a fraction of reading a diff.

**Non-goals.** Not a project manager — no roadmap, backlog, or tickets. Not a doc generator — the docs are written with the human, not for them. Not a substitute for tests or code review: a confirmed doc is the *input* those check against. Not applied to throwaway spikes, which are deleted rather than documented.

## 2. Verification

The premises this convention rests on are recorded as verification docs, by its own rule:

- → [verifications/design-validation.md](../verifications/design-validation.md) — three hold; three open, pending the pilot

## 3. Function detail

None, and that is the convention applied to itself: module docs exist only where there is function-level detail to transcribe, and a convention has no functions. The tier table is what says so.

*Escalation check, worked:* D1 is a real trade-off and mildly hard to reverse, but nothing about it surprises a future reader — two of three conditions, so it stays a decision point and no ADR is written.

## 4. Decision points

D1 Doc-set distribution — **A** (2026-09-17)
- Options: A centralized `docs/` / B colocated next to code / C hybrid
- Recommend: A — one place to read the whole change surface; `Owns` and file headers answer distance
- Cost: docs sit away from the code; a monorepo would need C later

D2 Roster and integration with existing conventions — **a** (2026-09-17)
- Options: (a) reuse `domain-modeling`'s glossary and ADR formats / (b) ship local glossary and ADR formats / (c) route every decision through `docs/adr/`
- Recommend: (a) — one convention per repo, no duplication; `REFERENCE.md` carries the minimum shapes so the skill stands alone
- Cost: `docs/adr/` sits beside `docs/`, so the index must account for two roots

D3 Doc granularity — **A** (2026-09-17)
- Options: A one doc per confirmable intent / B one doc per module / C one doc per change request
- Recommend: A — matches the unit the human actually confirms
- Cost: a single doc grows large and needs a `modules/` split

D4 Format delivery — **A** (2026-09-17)
- Options: A one format file per document type / B one combined templates file / C skeletons only, no rules
- Recommend: A — one spec loaded at a time; C is how templates get filled with prose
- Cost: writing a doc may pull in a second file

D5 Skill ships its own live doc set — **A** (2026-09-17)
- Options: A yes, `docs/` inside the skill / B templates plus a fictional example / C both
- Recommend: A — a real example calibrates depth in a way an empty template cannot
- Cost: changing the skill means changing its own docs, in the same change

D6 Doc language — **A** (2026-09-17)
- Options: A follow the repo, recorded in the index conventions block / B always English / C always Chinese
- Recommend: A — docs are confirmed by a human, so they obey the reader
- Cost: the first session in each repo must detect the language or ask once

D7 Escape hatch — **A** (2026-09-17)
- Options: A obey, then update the owning doc in the same session / B refuse and hold the gate / C skip without updating
- Recommend: A — C rots the doc set; B gets bypassed under real pressure, and a bypassed gate loses authority
- Cost: the doc records a design discovered while coding rather than agreed in advance; the `code-first` marker in the change log is the only thing separating it from a reviewed contract

D8 Takeover of a repo that already has a `docs/` layout
- Options: A map onto the existing layout, retrofitting headers and status / B migrate the existing docs into this layout / C run two sets in parallel, new work in this layout
- Recommend: A — lowest migration cost, keeps existing history and links intact
- Cost: index rows inherit the old structure's unevenness, and headers must be retrofitted onto docs written to other rules

D9 Verification is its own doc — **B** (2026-09-17)
- Options: A a section of the feature doc / B its own file under `docs/verifications/` / C a section for T1, a file from T2 up
- Decided: B — a premise usually outlives the unit that raised it, and the design doc links to it
- Cost: the feature doc's verification section becomes a list of pointers rather than answers in place

D10 One-off evidence artifacts — dissolved by D9 (2026-09-17)
- Options: A none in the repo / B commit under `docs/evidence/<slug>/` / C commit reusable harnesses under `scripts/`
- Decided: evidence lives beside its verification doc, so there is no separate place left to decide about
- Cost: a script worth keeping must be placed deliberately rather than accumulating in one evidence folder

D11 Validation script for a target repo's doc set — **A** (2026-09-17)
- Options: A none / B a script checking header fields, index rows, and `Owns` ↔ file-header agreement / C a CI snippet running it
- Decided: A — step 5's reconcile procedure *is* the check, and the model runs it
- Cost: drift between a doc's header and its index row is caught when step 5 runs, not before
- Note: distinct from `scripts/check.mjs`, which checks *this package*, not a repo's doc set

## 5. Change log

- v2 — verification became its own document type; the target-repo validator dropped
- v1 — initial; round-1 decisions recorded

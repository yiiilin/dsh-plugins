<!-- The ADR escalation test is adapted from the `domain-modeling` skill
     (mattpocock/skills, MIT). See THIRD-PARTY-NOTICES.md. -->

# Decision-point format

A decision point is one choice the human would want a say in, written down before it reaches code. It is the unit that stops an agent from deciding silently.

## Where they live

Inside the doc that owns the work — a feature doc, or `architecture.md` for cross-cutting choices. They are numbered per doc and **never renumbered**: a settled `D5` stays `D5` for the life of the doc, and new points append. Every open point also appears in `docs/README.md`, so the human can clear the whole repo in one pass.

## Open form

```markdown
D3 Retry budget
- Options: A no retry / B 3 tries, exponential to 2 s, then dead-letter / C retry forever
- Recommend: B — the upstream is idempotent and its blips last under 2 s
- Cost: a hard-down upstream costs 3× latency before failing
- Affects: src/queue/**, docs/architecture.md (error budget)
```

| Field | Rule |
|---|---|
| title | the choice in the human's vocabulary, not the implementation's |
| Options | every real alternative, including "do nothing" when it is one; two to four |
| Recommend | one option and the reason in a single clause |
| Cost | what the recommendation makes worse. A recommendation with no cost is not a decision, it is the obvious thing — drop the point |
| Affects | paths, data, deploy topology, other docs |
| Needs | `explicit answer`, only when the point is marked ⚠ |

## The ⚠ mark

Mark a point ⚠ when it is irreversible, expensive to reverse, user-visible, security-relevant, or rests on an `open` assumption. Everything unmarked clears in bulk with "go with the recommendations"; ⚠ points need explicit answers. Marking too much defeats the purpose: the mark exists so bulk approval is safe.

## Decided form

Once the human answers, the point keeps its number and records the answer:

```markdown
D3 Retry budget — **B** (2026-09-17)
- Options: A no retry / B 3 tries, exponential to 2 s, then dead-letter / C retry forever
- Recommend: B — the upstream is idempotent and its blips last under 2 s
- Cost: a hard-down upstream costs 3× latency before failing
- Affects: src/queue/**, docs/architecture.md (error budget)
```

Keep the options after the decision: they are the record of what was rejected, and they stop the next session from reopening a settled choice.

## Escalate to an ADR when all three hold

1. **Hard to reverse** — changing your mind later costs real work.
2. **Surprising without context** — a future reader will ask why on earth it is like this.
3. **A real trade-off** — there were genuine alternatives, and one was picked for specific reasons.

Write `docs/adr/NNNN-slug.md` — the `domain-modeling` skill's format when it is installed, otherwise the minimum shape in [`REFERENCE.md`](../REFERENCE.md) — then leave one line where the point was: `D7 → ADR-0004 (event-sourced write model)`. If any of the three is missing, the decision point stays where it is.

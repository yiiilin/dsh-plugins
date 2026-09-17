<!-- Entry format adapted from the `domain-modeling` skill (mattpocock/skills, MIT).
     See THIRD-PARTY-NOTICES.md. -->

# Doc-Driven Development

The vocabulary this skill runs on. Opinionated: where several words exist for one concept, the others are listed under _Avoid_ so prompts, docs, and code stay aligned.

## Language

**Contract**:
The repo's doc set, taken as the authoritative definition of what gets built.
_Avoid_: spec, requirements doc, wiki

**Transcription**:
Implementing a contract faithfully, item by item, without deciding anything along the way.
_Avoid_: coding, implementation work, development

**Decision point**:
One choice the human would want a say in, written down as `D<n>` before it reaches code.
_Avoid_: open question, TODO, assumption, note

**Confirmation gate**:
The human's answer that turns a doc into an authorization to write code.
_Avoid_: review, sign-off, approval step

**Drift**:
Code and its owning doc disagreeing.
_Avoid_: inconsistency, mismatch, out of sync, stale

**Owning doc**:
The one doc that is the contract for a given code path.
_Avoid_: related doc, parent doc, spec

**Tier**:
How much doc depth a change requires, set by risk rather than size.
_Avoid_: priority, size, complexity, weight

**Evidence**:
A command and its result, with a date, recorded in the doc to settle a claim.
_Avoid_: proof, test result, verification, confirmation

**Reconcile**:
Walking a doc against the code item by item and classifying each item as realized, missing, or divergent.
_Avoid_: sync, audit, review, check

**Takeover**:
Bringing an existing codebase under the contract, just in time rather than all at once.
_Avoid_: migration, onboarding, retrofit, backfill

**Confirmation list**:
The one-line-per-decision-point digest the human actually reads at the gate.
_Avoid_: summary, changelog, review request

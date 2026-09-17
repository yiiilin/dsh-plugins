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
_Avoid_: proof, test result, confirmation

**Verification doc**:
One file recording a premise the design rests on, the cheapest test of it, and the verdict.
_Avoid_: spike report, proof, test doc

**Code-first**:
A version built from code that was changed first, at the human's instruction: the doc is its transcription rather than its contract.
_Avoid_: unconfirmed, undocumented, backfilled

**Reconcile**:
Walking a doc against the code item by item and classifying each item as realized, missing, or divergent.
_Avoid_: sync, audit, review

**Takeover**:
Bringing an existing codebase under the contract, just in time rather than all at once. The two acts within it are backfilling a doc and retrofitting a header.
_Avoid_: migration, onboarding

**Confirmation list**:
The one-line-per-decision-point digest the human actually reads at the gate.
_Avoid_: summary, review request, status update

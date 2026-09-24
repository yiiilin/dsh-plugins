# Mentor TDD / Verification Record

## Source And Scope

Journeys are derived from the supplied `DSH_Mentor_as_Tool_设计包_v0.1` archive. This record covers the plugin implementation and its fake DSH boundary tests; it does not claim a live profile or provider run.

## RED / GREEN

- Before protocol implementation, `npm test` executed 8 protocol tests against the `not implemented` seam; all 8 failed in the intended missing-behavior paths.
- Before the runtime implementation, the 4 Mentor integration tests failed at the `installMentor()` seam.
- Regression RED/GREEN: `node --test --test-name-pattern='recovers a settled result after RC.2 parent repair' test/mentor.test.js` first failed because the new call returned different `thread_id` and `consultation_id`; after the fix, the same command passed 1/1. The reset-boundary case passed separately and prevents replay after an epoch change.
- UI RED/GREEN: `node --test --test-name-pattern='serves the current Session Mentor transcript' test/mentor.test.js` first failed because no Host view RPC was registered; after the fix it passed 1/1 and verifies the selected root Session's question, evidence, reply, delivery state, and rejection of an unavailable Session.
- Global settings RED/GREEN: `node --test --test-name-pattern='reads and writes one global settings row' test/mentor.test.js` drives the plugin's own settings row through the Host settings service; it verifies catalog rejection, removed-limit rejection, revision conflicts, read-only refusal, and that a thread reset leaves the global values untouched.
- Measurement RED/GREEN: `node --test --test-name-pattern='records generation, input, context, and reply measurements without capping them' test/mentor.test.js` proves three consultations in a row all reach the provider and that `newInputBytes`, `contextUpperBoundBytes`, and `replyUtf8Bytes` are journaled while nothing is capped.
- After implementation and subsequent regression additions, `npm test` passed 40 tests with 0 failures. The test suite uses Node's built-in `node:test` runner.

## Guarantees Exercised

| Behavior | Test evidence | Result |
|---|---|---|
| Root-only tool registration; no Mentor Agent is created while idle | `mentor.test.js`: registration and root scope test | Pass |
| The Web `Mentor` tab reads the requested live root Session and rejects unavailable/non-root Session IDs | `mentor.test.js`: root-scoped view RPC with selected and unavailable Session IDs | Pass |
| Mentor has one global settings row (model route, reasoning effort, timeout, concurrency, tool switch); invalid routes/efforts and removed limit keys are rejected, stale revisions conflict, read-only deployments refuse writes, and every Session reads the same values | `mentor.test.js`: global settings read/save, catalog default fallback, conflict, and read-only cases | Pass |
| Unknown routing fields, blank input, duplicate evidence IDs, item counts, character lengths, and UTF-8 request bytes are rejected | `protocol.test.js`: input validation cases | Pass |
| Evidence is JSON-encoded so a supplied Markdown fence cannot escape its data boundary | `protocol.test.js`: JSON evidence boundary case | Pass |
| Parent transcript/runtime context is absent from Mentor requests; only explicitly submitted Mentor messages are admitted | `mentor.test.js`: isolated request and scoped request assertions | Pass |
| DSH request has no tools and an unexpected surviving schema fails before adapter dispatch | `mentor.test.js`: final request fail-closed case | Pass |
| Live-editable config wrappers are unwrapped before the runtime reads them | `mentor.test.js`: plain-config unwrapping and volatile-row cases | Pass |
| Exactly one completed assistant message is correlated to the supplied user-message ID; interrupted, tool-call, and max-token turns are not replies | `protocol.test.js`: turn recovery cases | Pass |
| Parent tool and RC.2 PTC results replay without another generation; canonical journal data recovers when the child or parent result is missing | `mentor.test.js`: host-call replay, PTC replay without child session, and missing-parent-result recovery cases | Pass |
| RC.2 `TOOL_OUTCOME_UNKNOWN` repair followed by a new host `callId` recovers the settled journal result without another generation; explicit reset prevents cross-epoch replay | `mentor.test.js`: parent-repair replay and reset-boundary cases | Pass |
| An undelivered answer is reused only by an exact-input recovery replay; different input never sees it as Mentor history | `mentor.test.js`: parent-repair replay, pending-result block, and post-execute mutation cases | Pass |
| Session ownership, journal reset, generation counting without a budget, and reset-vs-call serialization are enforced | `mentor.test.js`: isolation, generation-recording, reset, and race cases | Pass |
| Parent cancellation reaches the Mentor Agent; an unknown post-dispatch result is recorded and is not transparently retried | `mentor.test.js`: cancellation case | Pass |
| A provider route failure before adapter dispatch is recorded as aborted, does not spend a generation, and does not strand the thread | `mentor.test.js`: pre-dispatch route failure case | Pass |
| Legacy RC.2 handle-based persistence writes contiguous `ignorable` journal entries and flushes them | `mentor.test.js`: handle persistence case | Pass |
| Missing usage remains `null`/`unknown`; oversized replies are delivered and their byte size recorded instead of rejected | `protocol.test.js` and `mentor.test.js`: usage and large-reply cases | Pass |

## Verification Limits

The integration tests use fake Agents, SessionPersistence handles, connection RPC handlers, command handlers, and LLM streams. They do not boot DSH `0.1.5-rc.2`, render the Client Slot in a live Web profile, capture an actual adapter/provider HTTP request, contact a model provider, validate external billing/cancellation, or exercise a live Web slash-command adapter. `node --test --experimental-test-coverage test/*.test.js` reported 85.64% lines, 86.39% functions, and 67.30% branches. Line/function coverage clears 80%; branch coverage remains below 80%, especially for defensive persistence/lifecycle/error branches. These and the live profile/provider/UI checks remain deployment verification tasks, not inferred passes.

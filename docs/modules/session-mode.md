# Session Mode

The Host row `session-mode` provides two policies for each session:

| Mode | Main agent | Delegated worker |
| --- | --- | --- |
| `normal` | Existing tool permissions | Existing tool permissions |
| `delegate-writes` | Audited read/control/delegation tools only | Existing tool permissions |

A single switch sits in the composer toolbar immediately to the right of the
permission control (the read-only / full-access selector). It is rendered in
`conversation.input.left`, so it shares that row's metrics with the host's own
controls (28px tall, host radius and focus ring) and never competes for the
`conversation.input.permission` seat, which is a single-occupant slot.

The switch states a condition — delegated writes on or off — rather than
offering two named modes. Its label and both state words come from the Client
locale dictionary, so the control is translated instead of showing a raw policy
identifier, and its tooltip states the current condition through the locale
service's `{placeholder}` interpolation. The following user-only commands use
the same Host operation:

```text
/agent-mode on
/agent-mode off
/agent-mode status
```

`on`/`off` are the switch states and `yes`/`no` are accepted aliases; the
underlying mode names (`normal`, `delegate-writes`) remain valid for scripts.
Host-side command copy is English, because the locale service is a Client
preference with no Host read face.

Changing a mode requires an idle main agent with no running or stopping jobs
owned by its session. Revision checks reject stale UI saves. A mode change flushes the session identity before acknowledging its
policy, so a previously empty session remains addressable after restart.
Workers cannot switch their own mode and keep the mode captured at their
creation, including after a daemon restart. Top-level forks copy the parent's
current mode when first attached, but remain main agents rather than workers.

## Configuration

Override the `session-mode` row in the profile's user patch:

```yaml
- id: session-mode
  config:
    defaultMode: normal
    normalPrompt: |-
      You implement the user's task directly, verify it, and report the result.
    delegateWritesPrompt: |-
      You coordinate implementation. Read the workspace, clarify requirements,
      and delegate all edits and command execution to subagents. Inspect their
      changes and collect verification evidence before reporting completion.
```

Both prompts have built-in defaults and are independently editable via the
plugin's Config schema. They are additional system sections, not replacements
for sandbox, planning, persona, or other Harness guidance. A worker in
`delegate-writes` receives `normalPrompt` plus a worker-specific instruction,
not the main coordinator prompt. Prompt changes affect the next prompt assembly;
DSH owns recording the assembled system text in the session log. Prompt templates
are literal text, with no variable interpolation.

`defaultMode` applies only to sessions without a saved policy. Existing sessions
retain their selection. `mainAllowedTools` is the complete audited allowlist for
restricted main agents: filesystem read/search, skill loading, user interaction,
todo/goal control, native spawn/fork delegation, child control, job collection,
and tool-less Mentor consultations. Tools absent from a preset are not added.
New tools are denied until explicitly audited and listed. Do not add `bash`,
`pwsh`, arbitrary code execution, runtime configuration, mutating MCP tools, or
network endpoints that can change permissions to this list.

## Persistence And Boundaries

Policies use one versioned JSON sidecar per session, written atomically with
private file permissions, a cross-process writer lock, and compare-and-set
revisions. The default root is `<profileContext.home>/session-modes/<profile-hash>/`,
keyed by the Host's actual profile directory. Outside profile boot it falls back
to `$DSH_HOME` / `~/.dsh` and the available profile environment. Session IDs are
hashed into filenames. `stateDir`
may override the root with an absolute directory. Back up this directory along
with session storage; exporting only a transcript does not export its policy.
Corrupt files fail closed instead of resetting permissions. Deleting a session
currently leaves its small policy sidecar for manual retention management.

Tool schemas remain available to preserve worker inheritance; a monotonic
execution guard rejects disallowed calls before their tool body runs. This is a
workflow boundary, not operating-system isolation. Writable workers share the
workspace and filesystem with the main agent. Existing sandbox and approval
constraints remain authoritative: this plugin never grants permissions beyond
them. It does not constrain an out-of-process worker's independent runtime.
The supported `delegate-writes` setup includes a directly callable native
`subagent` or `subagent_fork`; PTC-only tool presentation is not supported for
restricted main agents.

Because the policy is committed outside the Session log, it is not pushed to
other browsers or tabs: the switch re-reads when the page becomes visible or
regains focus, but a change made elsewhere reaches a page that stays in the
foreground only after a reload.

Disabling or uninstalling this Host row removes its guard. This is an operator
configuration change, not an agent capability. Keep the plugin active for
sessions whose delegation-only workflow must remain enforced.

## Verification

```bash
node --test src/session-mode/test/*.test.js
npm run build
npm run check
npm test
DSH_MODE_QA_URL=http://127.0.0.1:<isolated-port>/?token=<fixture-token> npm run test:modes:browser
```

The browser fixture overlay is `src/session-mode/test/fixtures/web.patch.yml`.
Use a fresh `DSH_HOME`, install a packed artifact into its `web` profile, and
launch with that overlay, `DSH_MODE_TEST_API_KEY=mode-qa-only`, and
`DSH_TELEMETRY_DISABLED=1`. The fixture routes the model to an unused loopback
endpoint; browser mode tests do not send prompts. Never apply the fixture to
production. Browser tests refuse port 3080 and non-loopback hosts.

Tests cover tool denial, worker permissions and persisted depth, independent
prompts, startup/resume snapshots, session isolation, revision conflicts,
corrupt storage, write failures, user commands, authenticated-route envelopes,
client localization, and actual Cordis scope/tool/prompt integration. All
filesystem mutations use temporary test directories; no external model call or
production profile mutation is required.

Verified in this pass: 266 suite tests pass, the scoped session-mode tests hold
100% line coverage, and a packed artifact installed into a fresh isolated `web`
profile passed all four browser journeys, twice in a row from a persisted
`delegate-writes` state: the switch sits in the toolbar row to the right of the
permission control (measured toggle left 707 vs permission right 695, both 28px
tall), blank-session toggling with stale-revision rejection, fit and
clickability at 1440/768/375 widths, and reload persistence. The switch mounts
in `conversation.input.left`; the session-header seat, `conversation.composer.dock`
(hero variant), and the single-occupant `conversation.input.permission` seat are
unavailable to it. Unauthenticated `/api/session-mode` returns 401. No prompt was
sent to any model provider.

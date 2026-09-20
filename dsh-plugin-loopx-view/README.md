# dsh-plugin-loopx-view

The package version is `@yiln-dsh/dsh-plugin-loopx-view@0.1.0`.

Adds a session-scoped `LoopX` tab beside DSH's native `对话` and `轨迹` views.
The page reads the current live DSH Session's exact LoopX binding, then renders
its public-safe Goal status, task graph, blockers, and next action.

The package is a companion to `dsh-loopx-plugin@0.1.1-beta.5` (or a compatible
future release). It reuses the existing `/loopx` GoalBar connection for
Start/Pause and owns only a read-only `loopx.view` projection route. It never
creates a Goal, chooses a binding, or reads a different Session.

## Install

Install the base LoopX plugin and this view package in the same profile:

```bash
dsh plugin --profile web add \
  "https://github.com/loopx-project/loopx/releases/download/dsh-loopx-plugin-v0.1.1-beta.5/dsh-loopx-plugin-0.1.1-beta.5.tgz"
dsh plugin --profile web add file:/path/to/dsh-plugin-loopx-view
```

Restart DSH after changing the profile. Invoke the `loopx` skill in each Session
that should receive a Goal binding; the `LoopX` tab then follows that Session.

## State boundary

The Host receives only the browser-injected Session id. It resolves the live
Agent and its cwd from DSH, runs the fixed-argv LoopX `resolve-agent-thread`
readback, and refuses missing or ambiguous bindings. Only after an exact pair
is admitted does it read `status --include-task-graph` from that project
registry. Local paths, credentials, raw CLI output, and binding candidates do
not cross the browser boundary.

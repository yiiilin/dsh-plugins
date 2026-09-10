# @yiln-dsh/dsh-plugin-session-list-cache

Collapses the repeated full-store session enumerations that the DSH Web GUI
fires concurrently.

## The problem it solves

`sessionQuery.listSessions()` re-reads and re-decodes the header line of every
stored session log on each call. On this deployment's 1480-session / 1.1 GB
store, one call is:

| Cost | Per call |
| --- | --- |
| `openat` | ~6000 (about half of them the guaranteed-`ENOENT` opposite-compression probe) |
| `read` | ~15 000 |
| zstd frame decodes | 1480 |
| time | ~0.5 s, producing only the ~259-byte header of each session |

Both `/api/session/list` and **every** `/api/subagents/list` call it
independently, so one GUI burst pays for the whole store several times over.
The scan is a strictly sequential loop of thread-pool file operations, so
concurrent calls do not overlap — they queue, and each extra concurrent caller
adds its full cost to the slowest one:

| Concurrent calls | Slowest call |
| --- | --- |
| 1 | 0.4 s |
| 5 | 1.3 s |
| 10 | 2.2 s |
| 20 | 4.5 s |

That is why the GUI is occasionally very slow: a burst of session-list and
subagent-list requests, plus a cold page cache, compounds into multi-second
latency for a trivial list.

## Behavior

- Wraps `sessionQuery.listSessions()` with in-flight coalescing: concurrent
  callers share a single scan instead of each starting their own.
- Reuses one completed scan for `ttlMs` (default 1000 ms), which swallows a
  whole GUI burst.
- Invalidates the cached scan on `session/created` and `session/disposed`, so a
  new or closed session is reflected immediately rather than after the window.
- Runs the shared scan **without** the caller's `AbortSignal`, so one cancelled
  request cannot abort work other callers are awaiting; each caller still gets
  its own cancellation, rejecting with `AbortError`.
- Returns a fresh array per caller, so a caller that mutates its result cannot
  corrupt the cached list.
- Never caches a failure: the next caller retries.
- Restores the original method when the plugin is unloaded.
- Fails open. If `sessionQuery.listSessions` is missing or has an unexpected
  shape, the plugin logs a warning and delegates unchanged instead of breaking
  the session list.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `ttlMs` | `1000` | Reuse one completed scan for this many milliseconds. `0` disables the plugin and delegates unchanged. |

```yaml
- id: session-list-cache
  name: '@yiln-dsh/dsh-plugin-session-list-cache'
  inject:
    - sessionQuery
  config:
    ttlMs: 1000
```

## Scope and limitations

- Host-only; it contributes no browser UI.
- It wraps one method on the `sessionQuery` service instance. The service's own
  internal callers go through its private corpus directly and are unaffected.
- It reduces *repeated* enumerations. It does not make a single cold scan
  cheaper; a genuinely first-ever listing of a very large store still pays the
  full cost once.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-plugin-session-list-cache
```

The running daemon loads plugins only at startup, so restart it afterwards.

## Tests

```bash
npm test
```

The suite pins the regression directly: concurrent callers share one scan, the
window is respected, one caller's abort does not fail the others, an
already-aborted caller never starts a scan, and failures are not cached.

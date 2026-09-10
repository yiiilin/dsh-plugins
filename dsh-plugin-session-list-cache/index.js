/**
 * Collapse the repeated full-store session enumerations that the Web GUI fires
 * concurrently.
 *
 * `sessionQuery.listSessions()` re-reads and re-decodes the header line of every
 * stored session log on each call. Measured on a 1480-session store that is one
 * scan of ~6000 `openat`, ~15k `read`, and 1480 zstd frame decodes — about
 * 0.5 s — while producing only the ~259-byte header of each session.
 *
 * `/api/session/list` and *every* `/api/subagents/list` call it independently,
 * so one GUI burst pays for the whole store several times over. Worse, the scan
 * is a strictly sequential loop of thread-pool file operations, so concurrent
 * calls do not overlap: they queue, and each extra concurrent caller adds its
 * full cost to the slowest one (measured: 1 call 0.4 s, 5 calls 1.3 s,
 * 20 calls 4.5 s).
 *
 * This plugin wraps that single service method with a short reuse window plus
 * in-flight coalescing, so a burst of callers shares one scan instead of
 * serialising several. It never changes what a scan returns, and it stays inert
 * (delegating straight through) if the wrapped method is not the expected shape.
 */

/** Stable Cordis plugin name. */
export const name = "session-list-cache";

/** The one service whose enumeration this plugin wraps. */
export const inject = ["sessionQuery"];

/** Default reuse window for one completed scan, in milliseconds. */
const DEFAULT_TTL_MS = 1000;

/** Copy a returned list so a caller cannot mutate the shared cached array. */
function copyList(value) {
  return Array.isArray(value) ? value.slice() : value;
}

/** Preserve the caller's own cancellation without letting it cancel the shared scan. */
function abortReason(signal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Return a promise that settles like `promise` but rejects early when `signal`
 * aborts. The underlying `promise` is never cancelled by one caller's abort,
 * because other callers may be awaiting the same shared scan.
 * @param promise - the shared scan promise.
 * @param signal - the individual caller's cancellation signal.
 * @returns the caller's view of the shared scan.
 */
function withSignal(promise, signal) {
  if (signal === undefined || signal === null) return promise.then(copyList);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(copyList(value));
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Build the caching front end for one enumeration function.
 *
 * Concurrent callers join a single in-flight scan; a scan that already
 * completed is reused for `ttlMs`. The scan itself is always invoked without a
 * caller signal so that one caller's cancellation cannot abort work the others
 * are waiting on.
 *
 * @param load - the enumeration to wrap, called as `load(signal)`.
 * @param options - `ttlMs` reuse window and an injectable `now` clock for tests.
 * @returns the wrapped enumeration plus its invalidation hook and counters.
 */
export function createListCache(load, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  /** @type {{ at: number, value: unknown } | undefined} */
  let cached;
  /** @type {Promise<unknown> | undefined} */
  let pending;
  /**
   * `scans` counts store scans actually started, `hits` counts callers served
   * from the completed scan, and `joins` counts callers that attached to a scan
   * already in flight (the caller that started it is not a join).
   */
  const stats = { scans: 0, hits: 0, joins: 0, invalidations: 0 };

  /** Drop the completed scan; the next caller starts a fresh one. */
  function invalidate() {
    stats.invalidations += 1;
    cached = undefined;
  }

  /** Start the one scan that every waiting caller will share. */
  function start() {
    if (pending !== undefined) return pending;
    stats.scans += 1;
    const run = (async () => {
      const value = await load(undefined);
      cached = { at: now(), value };
      return value;
    })();
    pending = run;
    const settle = () => {
      if (pending === run) pending = undefined;
    };
    run.then(settle, settle);
    return run;
  }

  /**
   * Enumerate with reuse, or join the scan already running.
   *
   * An already-aborted caller is refused before any scan is considered, so it
   * can neither start one nor be counted as a joiner of someone else's.
   * @param signal - optional cancellation for this caller only.
   * @returns the enumerated list.
   */
  function listSessions(signal) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (pending !== undefined) {
      stats.joins += 1;
      return withSignal(pending, signal);
    }
    if (cached !== undefined && now() - cached.at < ttlMs) {
      stats.hits += 1;
      return Promise.resolve(copyList(cached.value));
    }
    return withSignal(start(), signal);
  }

  return { listSessions, invalidate, stats, ttlMs };
}

/**
 * Wrap `sessionQuery.listSessions()` with the shared-scan cache.
 * @param ctx - plugin context carrying the sessionQuery service.
 * @param config - optional `ttlMs` override; `0` disables the plugin.
 */
export function apply(ctx, config) {
  const ttlMs = config?.ttlMs === undefined ? DEFAULT_TTL_MS : Number(config.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    ctx.logger?.info?.("session-list-cache: disabled by configuration; listSessions() delegates unchanged");
    return;
  }

  const service = ctx.sessionQuery;
  const original = service?.listSessions;
  if (typeof original !== "function") {
    ctx.logger?.warn?.("session-list-cache: sessionQuery.listSessions is not a function; the plugin stays inert");
    return;
  }

  const cache = createListCache(
    (signal) => Promise.resolve(original.call(service, signal)),
    { ttlMs },
  );

  const wrapped = function listSessions(signal) {
    return cache.listSessions(signal);
  };
  service.listSessions = wrapped;

  /*
   * A created or disposed Session changes the visible set immediately. A field
   * change on an existing live session (a retitled session, for example) is
   * covered by the short reuse window rather than by an event.
   */
  ctx.on("session/created", () => cache.invalidate());
  ctx.on("session/disposed", () => cache.invalidate());

  ctx.effect(() => () => {
    if (service.listSessions === wrapped) service.listSessions = original;
  }, "session-list-cache.restore");

  ctx.logger?.info?.(
    `session-list-cache: coalescing sessionQuery.listSessions() across a ${ttlMs} ms reuse window`,
  );
}

/**
 * Comparing clocks across machines that do not share one.
 *
 * Two nodes in a federation have no reason to agree about the wall clock. They may be
 * minutes apart — a laptop that slept, a container with a frozen clock, a machine that
 * has never run NTP. Requiring agreement would be a deployment rule nobody enforces;
 * measuring the difference is something this side can do on its own.
 *
 * The estimate is the standard four-timestamp exchange:
 *
 * ```
 * A                              B (clock = A + offset)
 * t1 = now()  ──── request ────▶  t2 = now()
 *                                 t3 = now()
 * t4 = now()  ◀─── response ────
 *
 * offset = ((t2 - t1) + (t3 - t4)) / 2      rtt = (t4 - t1) - (t3 - t2)
 * ```
 *
 * The error in `offset` is bounded by half the round trip, so a fast link gives a better
 * estimate than a slow one. That is why several samples are kept and the one with the
 * smallest round trip wins: under load every sample drifts, but the least delayed one
 * drifts least.
 *
 * **What this is used for, and what it is not.** It exists so a human reading "last seen
 * 3 minutes ago" is not lied to by a skewed clock. It must not decide ordering: two
 * snapshots are newer or older by `seq`, never by timestamp — a timestamp can go
 * backwards when NTP corrects a machine, while a counter cannot.
 *
 * @module @yiln-dsh/dsh-gateway/federation/clock
 */

/** How many samples to keep per link. Small: the best sample is what matters. */
export const MAX_SAMPLES = 16

/**
 * Combine the four timestamps of one exchange into an offset estimate.
 *
 * @param t1 - sender's clock before sending.
 * @param t2 - receiver's clock on arrival.
 * @param t3 - receiver's clock when replying.
 * @param t4 - sender's clock on receiving the reply.
 * @returns `{ offset, rtt }` in milliseconds; `offset` is how far ahead the peer's clock is.
 */
export function measure(t1, t2, t3, t4) {
  const rtt = (t4 - t1) - (t3 - t2)
  const offset = ((t2 - t1) + (t3 - t4)) / 2
  // Two ways a sample can be impossible, both refused rather than folded into the
  // estimate: the reply was stamped before the request arrived (`t3 < t2`), which no
  // clock offset explains; or the round trip went negative, meaning a timestamp moved
  // backwards.
  const consistent = t3 >= t2 && rtt >= 0
  return { offset, rtt: rtt < 0 ? 0 : rtt, valid: consistent }
}

/**
 * Keep the best samples for one link and answer with the current estimate.
 *
 * "Best" is the smallest round trip, not the newest: an old sample taken on an idle link
 * is a better estimate of the offset than a fresh one taken while the machine was busy.
 *
 * @param options.maxSamples - how many to keep.
 * @returns `{ add, offset, rtt, samples, peerNow }`.
 */
export function createClockSync({ maxSamples = MAX_SAMPLES } = {}) {
  const kept = []

  return {
    /**
     * Record one exchange.
     *
     * @returns the current best estimate, or `undefined` when nothing valid is held.
     */
    add(sample) {
      if (sample?.valid !== true) return this.estimate()
      kept.push(sample)
      kept.sort((a, b) => a.rtt - b.rtt)
      if (kept.length > maxSamples) kept.length = maxSamples
      return this.estimate()
    },

    /** The best estimate so far, or `undefined`. */
    estimate() {
      if (kept.length === 0) return undefined
      const best = kept[0]
      return { offset: best.offset, rtt: best.rtt, samples: kept.length }
    },

    /**
     * What the peer's clock reads now, from this node's clock plus the estimate.
     *
     * `undefined` when the offset is unknown, rather than pretending the clocks agree —
     * a caller that cannot convert should say so instead of showing a wrong age.
     *
     * @param now - this node's wall clock; defaults to `Date.now()`.
     */
    peerNow(now = Date.now()) {
      const best = this.estimate()
      return best === undefined ? undefined : now + best.offset
    },
  }
}

/**
 * A monotonic millisecond clock for timeouts.
 *
 * Wall-clock deltas are wrong for timeouts: an NTP correction of an hour mid-flight makes
 * `now - started` jump by an hour and expires everything at once, or jump backwards and
 * expires nothing. `performance.now()` never goes backwards and is unaffected by the
 * system clock being set.
 *
 * @returns milliseconds since an arbitrary origin, monotonic within this process.
 */
export function monotonicNow() {
  return performance.now()
}

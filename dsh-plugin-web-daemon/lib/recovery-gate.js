/**
 * Recovery API gate.
 *
 * While the daemon restores the sessions that were running before a restart,
 * calls that could race that restore wait for recovery to settle. The gate wraps
 * the live service objects, so it must not change their calling convention: the
 * goal service (and most of the session controller) is synchronous, and its
 * callers — the goal tools and slash commands — rely on a synchronous throw for
 * validation errors such as "a goal already exists".
 *
 * A wrapper that always returns a promise turns such a throw into a rejection
 * those callers cannot observe. The rejected promise is then dropped, and the
 * Harness treats an unhandled rejection as fatal: it writes its diagnostic to
 * stderr and exits the process, which stops every session hosted by the daemon.
 * So the gate defers only until recovery settles, then hands the call straight
 * through, and it never leaves a deferred rejection unhandled.
 */

const RECOVERY_GATED_API_METHODS = {
  sessionController: ["list", "search", "create", "page", "follow", "modelCatalog", "selectModel", "rename", "prompt", "fork", "attachment", "updateQueue", "cancel"],
  goals: ["create", "edit", "pause", "resume", "complete", "clear"],
  agentPresets: ["remoteExportList", "select"],
  subagents: ["listChildren", "prompt", "interruptByParent"],
};

const LEGACY_RECOVERY_GATED_API_METHODS = {
  sessions: ["list", "search", "create", "history", "models", "follow", "selectModel", "rename", "prompt", "fork", "attachment", "updateQueue", "cancel"],
  goals: ["create", "edit", "pause", "resume", "complete", "clear"],
  agentPresets: ["list", "select"],
  subagents: ["list", "history", "prompt", "interrupt"],
};

/**
 * Wrap the gated service methods until recovery settles, then restore them.
 * @param ctx - owning context, used for the disposal effect and warnings.
 * @param services - candidate domains; legacy layouts expose them under apiProxy.
 * @param recoveryReady - promise settling when session recovery has finished.
 * @param diag - recovery diagnostics collecting the calls deferred by the gate.
 */
function installRecoveryApiGate(ctx, services, recoveryReady, diag) {
  const legacy = services.apiProxy !== undefined;
  const methodMap = legacy ? LEGACY_RECOVERY_GATED_API_METHODS : RECOVERY_GATED_API_METHODS;
  const restorers = [];
  let recovered = false;
  const markRecovered = () => { recovered = true; };
  void Promise.resolve(recoveryReady).then(markRecovered, markRecovered);
  for (const [domainName, methodNames] of Object.entries(methodMap)) {
    const domain = legacy ? services.apiProxy?.[domainName] : services[domainName];
    if (domain === undefined || domain === null) continue;
    for (const methodName of methodNames) {
      const original = domain[methodName];
      if (typeof original !== "function") continue;
      const gated = methodName === "follow"
        ? async function* (...args) {
          if (!recovered) diag.gatedCalls.push(`${domainName}.${methodName}`);
          await recoveryReady;
          yield* original.apply(domain, args);
        }
        : function (...args) {
          // Recovery is over: the gate has nothing left to wait for, so keep the
          // service's own synchronous return and throw semantics for its callers.
          if (recovered) return original.apply(domain, args);
          diag.gatedCalls.push(`${domainName}.${methodName}`);
          const deferred = Promise.resolve(recoveryReady).then(() => original.apply(domain, args));
          // Deferral cannot be observed by a caller written against the
          // synchronous contract. Leave the rejection for an awaiter, but keep it
          // handled so it can never escalate into a fatal unhandled rejection.
          void deferred.catch(() => {});
          return deferred;
        };
      try {
        domain[methodName] = gated;
      } catch {
        ctx.logger?.warn?.("web-daemon: could not gate %s.%s during recovery", domainName, methodName);
        continue;
      }
      restorers.push(() => {
        if (domain[methodName] === gated) domain[methodName] = original;
      });
    }
  }
  if (restorers.length === 0) return;
  ctx.effect(() => () => {
    for (let index = restorers.length - 1; index >= 0; index -= 1) restorers[index]();
  }, "web-daemon: api recovery gate");
}

export {
  LEGACY_RECOVERY_GATED_API_METHODS,
  RECOVERY_GATED_API_METHODS,
  installRecoveryApiGate,
};

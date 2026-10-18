import { readFileSync, writeFileSync } from "node:fs";

export const SETTINGS_CLIENT_PACKAGE = "@deepseek-ai/dsh-client-ui-settings";
export const REMOTE_SETTINGS_MARKER = "dsh-auth-remote-settings";
export const REMOTE_SETTINGS_GLOBAL = "__DSH_AUTH_REMOTE_SETTINGS__";
export const REMOTE_SETTINGS_HTTP_GLOBAL = "__DSH_AUTH_REMOTE_SETTINGS_HTTP__";
const PATCH_MARKER = "dsh-plugin-auth-webserver remote settings patch";
// A loose pattern rather than a literal: the bundle is minified, so a reformat,
// a quote-style change, or extra spacing must not silently disable this patch.
// It still pins the exact expression, so a real upstream change fails the match
// (and is reported at error level) instead of corrupting the bundle.
const PERSISTENCE_ANCHOR = /const persistence\s*=\s*ctx\.remote\.\$host\.isLoopback\s*\?\s*(["'])host\1\s*:\s*(["'])memory\2\s*;/;
// DSH 0.2.1-alpha.3 removed the client-side Host/process-local gate outright:
// the shipped client always derives writability from the Host describe mirror
// and no longer mentions `persistence` anywhere. A bundle that still names it
// without matching the anchor above is a different, unknown shape and must stay
// a loud failure rather than be mistaken for that retirement.
const PERSISTENCE_CONCEPT = /\bpersistence\b/;

/** Add the authenticated gateway marker to an index document once. */
export function injectRemoteSettingsMarker(html, enabled, allowHttp = false) {
  if (typeof html !== "string" || enabled !== true || html.includes(REMOTE_SETTINGS_MARKER)) return html;
  const httpFlag = allowHttp ? `globalThis.${REMOTE_SETTINGS_HTTP_GLOBAL}=true;` : "";
  const frame = `<script data-${REMOTE_SETTINGS_MARKER}="1">globalThis.${REMOTE_SETTINGS_GLOBAL}=true;${httpFlag}</script>`;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${frame}`);
  return `${frame}${html}`;
}

/**
 * Enable Host-backed settings only for this auth gateway's marked pages.
 *
 * Three shipped shapes are possible, and they must stay distinguishable:
 *
 * - The gate is present and matches {@link PERSISTENCE_ANCHOR} (DSH `0.2.0-rc.2`
 *   through `0.2.1-alpha.2`): rewrite it so a page served by this gateway keeps
 *   Host-backed settings even on a non-loopback origin.
 * - The gate is gone entirely (DSH `0.2.1-alpha.3` onward): upstream derives
 *   writability from the Host describe mirror and no longer offers a
 *   process-local mode. There is nothing to rewrite, and Host-backed settings
 *   are already unconditional, so the source is returned unchanged and the
 *   caller must treat that as success — not as the failure below.
 * - The gate is named but does not match the anchor: an unknown shape. Return
 *   `null` so the caller fails loudly instead of guessing.
 *
 * @param source - the shipped Settings client bundle.
 * @returns the patched bundle, the unchanged bundle when the gate is retired, or
 *   `null` when the bundle names the gate in an unrecognised shape.
 */
export function patchSettingsClient(source) {
  if (typeof source !== "string") return null;
  if (source.includes(PATCH_MARKER)) return source;
  if (!PERSISTENCE_ANCHOR.test(source)) {
    return PERSISTENCE_CONCEPT.test(source) ? null : source;
  }
  const replacement = `const persistence = ctx.remote.$host.isLoopback || (typeof location !== "undefined" && globalThis.${REMOTE_SETTINGS_GLOBAL} === true && (location.protocol === "https:" || (location.protocol === "http:" && globalThis.${REMOTE_SETTINGS_HTTP_GLOBAL} === true))) ? "host" : "memory";\n\t\t/* ${PATCH_MARKER} */`;
  return source.replace(PERSISTENCE_ANCHOR, replacement);
}

/** Patch the Settings bundle snapshot so combo responses carry the same body. */
export function registerRemoteSettingsClientPatch(ctx) {
  const clientModules = ctx.clientModules ?? ctx.get("clientModules");
  if (clientModules === undefined
    || typeof clientModules.clientPath !== "function"
    || typeof clientModules.rebuilt !== "function") {
    ctx.logger?.warn?.("auth-webserver: remote settings patch dependencies are unavailable");
    return false;
  }
  const clientPath = clientModules.clientPath(SETTINGS_CLIENT_PACKAGE);
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("auth-webserver: settings client bundle was not found");
    return false;
  }
  let original;
  let body;
  try {
    original = readFileSync(clientPath, "utf8");
    body = patchSettingsClient(original);
  } catch (error) {
    ctx.logger?.warn?.("auth-webserver: could not read settings client bundle: %s", error);
    return false;
  }
  if (body === null) {
    // The bundle names the removed gate in a shape this patch does not
    // recognise, so remote Settings editing cannot be guaranteed for
    // non-loopback origins. Report at error level and name the artifact to
    // re-check; a warning here is what let this degrade without an actionable
    // symptom before. (A bundle that dropped the gate entirely takes the
    // unchanged path above and is success, not this failure.)
    ctx.logger?.error?.(
      "auth-webserver: the shipped Settings client still names the Host/process-local gate but not in the shape this patch rewrites, so Host-backed settings may NOT be enabled for remote origins on this run. Re-check PERSISTENCE_ANCHOR in settings-client-patch.js against %s, which was read from %s",
      SETTINGS_CLIENT_PACKAGE,
      clientPath,
    );
    return false;
  }
  const ownsPatch = body !== original;
  try {
    ctx.effect(() => {
      if (ownsPatch) writeFileSync(clientPath, body, "utf8");
      const revision = clientModules.rebuilt(SETTINGS_CLIENT_PACKAGE);
      if (revision === undefined) throw new Error("settings client bundle is not registered");
      return () => {
        if (!ownsPatch) return;
        writeFileSync(clientPath, original, "utf8");
        clientModules.rebuilt(SETTINGS_CLIENT_PACKAGE);
      };
    }, "auth-webserver: remote settings client patch");
  } catch (error) {
    if (ownsPatch) {
      try {
        writeFileSync(clientPath, original, "utf8");
        clientModules.rebuilt(SETTINGS_CLIENT_PACKAGE);
      } catch (restoreError) {
        ctx.logger?.warn?.("auth-webserver: could not restore settings client bundle: %s", restoreError);
      }
    }
    ctx.logger?.warn?.("auth-webserver: could not install settings client patch: %s", error);
    return false;
  }
  return true;
}

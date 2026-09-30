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

/** Add the authenticated gateway marker to an index document once. */
export function injectRemoteSettingsMarker(html, enabled, allowHttp = false) {
  if (typeof html !== "string" || enabled !== true || html.includes(REMOTE_SETTINGS_MARKER)) return html;
  const httpFlag = allowHttp ? `globalThis.${REMOTE_SETTINGS_HTTP_GLOBAL}=true;` : "";
  const frame = `<script data-${REMOTE_SETTINGS_MARKER}="1">globalThis.${REMOTE_SETTINGS_GLOBAL}=true;${httpFlag}</script>`;
  if (html.includes("<head>")) return html.replace("<head>", `<head>${frame}`);
  return `${frame}${html}`;
}

/** Enable Host-backed settings only for this auth gateway's marked pages. */
export function patchSettingsClient(source) {
  if (typeof source !== "string") return null;
  if (source.includes(PATCH_MARKER)) return source;
  if (!PERSISTENCE_ANCHOR.test(source)) return null;
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
    // Remote settings exist only inside this patch, so a shape change silently
    // disables Settings editing from every non-loopback origin. Report at error
    // level and name the artifact to re-check; a warning here is what let this
    // degrade without an actionable symptom before.
    ctx.logger?.error?.(
      "auth-webserver: the shipped Settings client no longer matches the anchor this patch rewrites, so Host-backed settings are NOT enabled for remote origins on this run. Re-check PERSISTENCE_ANCHOR in settings-client-patch.js against %s, which was read from %s",
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

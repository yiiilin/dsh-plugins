import { readFileSync } from "node:fs";

/**
 * Everything the login page declares as a PWA asset, and the routes that serve it.
 *
 * The page is served at arbitrary paths — every request without a session gets it —
 * so its asset URLs cannot be relative: `./manifest.webmanifest` would resolve under
 * whatever path the browser happened to ask for. They are prefix-absolute instead,
 * and the prefix is the daemon's configured mount point, so a deployment under
 * `/main/` declares and serves `/main/manifest.webmanifest`.
 *
 * Both sides are built from the same normalized prefix by this module. That is the
 * point: a page that declares one URL and a router that answers another is a silent
 * failure — the browser parses the login page as a manifest and says nothing.
 */

/** Manifest file name, relative to the mount prefix. */
const MANIFEST_FILE = "manifest.webmanifest";
/** Service-worker file name, relative to the mount prefix. */
const SERVICE_WORKER_FILE = "sw.js";

const ICON_180 = readFileSync(new URL("./pwa/icon-180.png", import.meta.url));
const ICON_192 = readFileSync(new URL("./pwa/icon-192.png", import.meta.url));
const ICON_512 = readFileSync(new URL("./pwa/icon-512.png", import.meta.url));

/**
 * Normalize a mount prefix to `""` or `"/segment"`: one leading slash, no trailing one.
 *
 * The daemon's `rootPrefix` is operator input and may arrive with either slash or
 * neither, so it is normalized once here and every URL below is built from the result.
 *
 * @param value - the configured root prefix.
 * @returns the prefix as a path fragment, empty for the origin root.
 */
export function prefixOf(value) {
  const trimmed = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/gu, "") : "";
  return trimmed === "" ? "" : `/${trimmed}`;
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Every public URL this module serves, derived from one prefix.
 *
 * The login page, the service-worker bootstrap and the head markup all read their
 * URLs from here, so a page and its routes cannot drift apart.
 *
 * @param prefix - the daemon's configured root prefix.
 * @returns the prefix-absolute URLs, plus the service worker's scope.
 */
export function pwaAssetUrls(prefix = "") {
  const base = prefixOf(prefix);
  return {
    manifest: `${base}/${MANIFEST_FILE}`,
    icon: `${base}/icons/icon-192.png`,
    appleTouchIcon: `${base}/apple-touch-icon.png`,
    serviceWorker: `${base}/${SERVICE_WORKER_FILE}`,
    // A worker's scope may not exceed the directory its script is served from, so the
    // script and its scope come from the same prefix. Registering `/sw.js` for scope
    // `/main/` is a SecurityError; a scope of `/` would let the login page's worker
    // intercept every mount on the origin.
    scope: `${base}/`,
  };
}

/**
 * The web app manifest for one mount prefix.
 *
 * `id`, `start_url` and `scope` are all the prefix root: a manifest whose scope
 * escaped its own mount would claim every other environment on the origin.
 */
function manifestFor(prefix) {
  return JSON.stringify({
    id: `${prefix}/`,
    name: "DeepSeek Harness",
    short_name: "DSH",
    start_url: `${prefix}/`,
    scope: `${prefix}/`,
    display: "standalone",
    orientation: "any",
    theme_color: "#ffffff",
    background_color: "#ffffff",
    icons: [
      {
        src: `${prefix}/icons/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${prefix}/icons/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  }, null, 2);
}

/* Pass-through only: the gateway remains the auth and session authority. */
function serviceWorkerFor(prefix) {
  return `self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Dynamic plugin APIs are no-store, time-sensitive responses. Let the
  // browser dispatch them directly instead of creating a second request leg
  // through this pass-through worker.
  if (url.origin === self.location.origin && url.pathname.startsWith("${prefix}/_dsh/")) return;
  event.respondWith(fetch(event.request));
});
`;
}

/** Register the worker at `<prefix>/sw.js` with `<prefix>/` as its scope. */
export function pwaBootstrap(prefix) {
  const urls = pwaAssetUrls(prefix);
  return String.raw`(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register(${JSON.stringify(urls.serviceWorker)}, {
      scope: ${JSON.stringify(urls.scope)},
      updateViaCache: "none"
    }).catch(function () {});
  }, { once: true });
})();`;
}

/** The mobile metadata whose one asset is the apple-touch icon at the prefix root. */
export function pwaHeadMarkup(prefix) {
  const icon = escapeAttribute(pwaAssetUrls(prefix).appleTouchIcon);
  return `<link rel="apple-touch-icon" sizes="180x180" href="${icon}"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">`;
}

/**
 * The asset served at one exact request path, or undefined.
 *
 * @param path - the request path, without its query string.
 * @param prefix - the already-normalized mount prefix.
 */
function assetFor(path, prefix) {
  if (path === `${prefix}/${MANIFEST_FILE}`) {
    return {
      body: Buffer.from(manifestFor(prefix), "utf8"),
      contentType: "application/manifest+json; charset=utf-8",
      cacheControl: "public, max-age=300",
    };
  }
  if (path === `${prefix}/${SERVICE_WORKER_FILE}`) {
    return {
      body: Buffer.from(serviceWorkerFor(prefix), "utf8"),
      contentType: "application/javascript; charset=utf-8",
      cacheControl: "no-cache",
    };
  }
  if (path === `${prefix}/icons/icon-180.png`) {
    return { body: ICON_180, contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" };
  }
  if (path === `${prefix}/icons/icon-192.png`) {
    return { body: ICON_192, contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" };
  }
  if (path === `${prefix}/icons/icon-512.png`) {
    return { body: ICON_512, contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" };
  }
  if (path === `${prefix}/apple-touch-icon.png`) {
    return { body: ICON_180, contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" };
  }
  return undefined;
}

/**
 * Write one public PWA asset into a Node HTTP response.
 *
 * Public on purpose: the login page needs these before a session exists, so the
 * route sits ahead of the session gate. Returns false for any other path so the
 * caller can carry on routing.
 *
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param path - the request path, without its query string.
 * @param prefix - the mount prefix the daemon serves its own UI under.
 * @returns true when this wrote the response.
 */
export function sendPwaAsset(req, res, path, prefix = "") {
  const asset = assetFor(path, prefixOf(prefix));
  if (asset === undefined || (req.method !== "GET" && req.method !== "HEAD")) return false;
  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Cache-Control": asset.cacheControl,
    "Content-Length": asset.body.byteLength,
  });
  if (req.method === "HEAD") res.end();
  else res.end(asset.body);
  return true;
}

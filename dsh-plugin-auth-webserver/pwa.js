import { readFileSync } from "node:fs";

export const PWA_MANIFEST_PATH = "/manifest.webmanifest";
export const PWA_SERVICE_WORKER_PATH = "/sw.js";

const PWA_MANIFEST = `{
  "id": "/",
  "name": "DeepSeek Harness",
  "short_name": "DSH",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#ffffff",
  "background_color": "#ffffff",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    }
  ]
}`;

/* Pass-through only: the gateway remains the auth and session authority. */
const PWA_SERVICE_WORKER = `self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (event) {
  if (event.request.method === "GET") event.respondWith(fetch(event.request));
});
`;

export const PWA_HEAD_MARKUP = `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">`;

export const PWA_BOOTSTRAP = String.raw`(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none"
    }).catch(function () {});
  }, { once: true });
})();`;

const PWA_ASSETS = new Map([
  [PWA_MANIFEST_PATH, {
    body: Buffer.from(PWA_MANIFEST, "utf8"),
    contentType: "application/manifest+json; charset=utf-8",
    cacheControl: "public, max-age=300",
  }],
  [PWA_SERVICE_WORKER_PATH, {
    body: Buffer.from(PWA_SERVICE_WORKER, "utf8"),
    contentType: "application/javascript; charset=utf-8",
    cacheControl: "no-cache",
  }],
  ["/icons/icon-180.png", {
    body: readFileSync(new URL("./pwa/icon-180.png", import.meta.url)),
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  }],
  ["/icons/icon-192.png", {
    body: readFileSync(new URL("./pwa/icon-192.png", import.meta.url)),
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  }],
  ["/icons/icon-512.png", {
    body: readFileSync(new URL("./pwa/icon-512.png", import.meta.url)),
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  }],
  ["/apple-touch-icon.png", {
    body: readFileSync(new URL("./pwa/icon-180.png", import.meta.url)),
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  }],
]);

export const PWA_PUBLIC_PATHS = new Set(PWA_ASSETS.keys());

/** Return an immutable asset descriptor for one exact public PWA path. */
export function pwaAsset(path) {
  return PWA_ASSETS.get(path);
}

function spliceBeforeTag(html, expression, markup) {
  const match = expression.exec(html);
  if (match === null) return `${markup}${html}`;
  return `${html.slice(0, match.index)}${markup}${html.slice(match.index)}`;
}

/** Inject mobile-independent manifest metadata and service-worker registration. */
export function injectPwaSupport(html) {
  if (typeof html !== "string" || html.includes("data-dsh-auth-pwa")) return html;
  const boot = `<script data-dsh-auth-pwa="1">${PWA_BOOTSTRAP}</script>`;
  let out = spliceBeforeTag(html, /<\/head>/iu, PWA_HEAD_MARKUP);
  return spliceBeforeTag(out, /<\/body>/iu, boot);
}

/** Write one public PWA asset into a Node HTTP response. */
export function sendPwaAsset(req, res, path, securityHeaders, secure = false) {
  const asset = pwaAsset(path);
  if (asset === undefined || (req.method !== "GET" && req.method !== "HEAD")) return false;
  res.writeHead(200, {
    ...securityHeaders({ secure, noStore: false }),
    "Content-Type": asset.contentType,
    "Cache-Control": asset.cacheControl,
    "Content-Length": asset.body.byteLength,
  });
  if (req.method === "HEAD") res.end();
  else res.end(asset.body);
  return true;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  PWA_MANIFEST_PATH,
  PWA_PUBLIC_PATHS,
  PWA_SERVICE_WORKER_PATH,
  injectPwaSupport,
  pwaAsset,
  sendPwaAsset,
} from "../pwa.js";

const INDEX = `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="root"></div></body>
</html>`;

test("provides an installable manifest with standard PNG icons", () => {
  const asset = pwaAsset(PWA_MANIFEST_PATH);
  assert.ok(asset);
  const manifest = JSON.parse(asset.body.toString("utf8"));
  assert.equal(asset.contentType, "application/manifest+json; charset=utf-8");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.ok(PWA_PUBLIC_PATHS.has(PWA_SERVICE_WORKER_PATH));
  for (const size of [180, 192, 512]) {
    const icon = pwaAsset(`/icons/icon-${size}.png`);
    assert.ok(icon);
    assert.equal(icon.contentType, "image/png");
    assert.ok(icon.body.byteLength > 100);
  }
});

test("provides a pass-through service worker with a fetch handler", () => {
  const asset = pwaAsset(PWA_SERVICE_WORKER_PATH);
  assert.ok(asset);
  const source = asset.body.toString("utf8");
  assert.match(source, /addEventListener\("install"/u);
  assert.match(source, /addEventListener\("activate"/u);
  assert.match(source, /addEventListener\("fetch"/u);
  assert.equal(asset.cacheControl, "no-cache");
});

test("injects iOS metadata and one idempotent service-worker registration", () => {
  const once = injectPwaSupport(INDEX);
  const twice = injectPwaSupport(once);
  assert.equal(twice, once);
  assert.match(once, /rel="apple-touch-icon"[^>]+sizes="180x180"/u);
  assert.match(once, /apple-mobile-web-app-capable/u);
  assert.match(once, /<script data-dsh-auth-pwa="1">/u);
  assert.match(once, /serviceWorker\.register\("\/sw\.js"/u);
  assert.ok(once.indexOf("data-dsh-auth-pwa") < once.indexOf("</body>"));
});

test("serves public PWA assets for GET and HEAD", () => {
  const headers = [];
  const bodies = [];
  const securityHeaders = (options) => ({ "X-Test-Secure": String(options.secure), "X-Test-Store": String(options.noStore) });
  const response = {
    writeHead(status, value) { headers.push({ status, value }); },
    end(body) { bodies.push(body); },
  };
  assert.equal(sendPwaAsset({ method: "GET" }, response, PWA_MANIFEST_PATH, securityHeaders, true), true);
  assert.equal(headers[0].status, 200);
  assert.equal(headers[0].value["Content-Type"], "application/manifest+json; charset=utf-8");
  assert.equal(headers[0].value["Cache-Control"], "public, max-age=300");
  assert.ok(Buffer.isBuffer(bodies[0]));
  assert.equal(sendPwaAsset({ method: "HEAD" }, response, PWA_SERVICE_WORKER_PATH, securityHeaders, false), true);
  assert.equal(headers[1].value["Content-Length"], pwaAsset(PWA_SERVICE_WORKER_PATH).body.byteLength);
  assert.equal(bodies[1], undefined);
  assert.equal(sendPwaAsset({ method: "POST" }, response, PWA_MANIFEST_PATH, securityHeaders), false);
});

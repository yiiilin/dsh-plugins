import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_LAYOUT_STYLE_ID,
  injectMobileLayout,
  mobileLayoutPayload,
} from "../mobile.js";

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>DeepSeek Harness</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

function headOf(html) {
  const match = /<head(?:\s[^>]*)?>/iu.exec(html);
  return html.slice(0, match.index + match[0].length);
}

test("leaves the document untouched when mobileMode is off", () => {
  assert.equal(injectMobileLayout(INDEX, "off"), INDEX);
});

test("injects style after the opening head and script before the closing body", () => {
  const out = injectMobileLayout(INDEX, "auto");
  assert.ok(out.includes(`<style id="${MOBILE_LAYOUT_STYLE_ID}"`));
  assert.ok(out.includes(`<script data-dsh-auth-mobile-boot="1">`));
  assert.ok(out.includes(`<script data-dsh-auth-mobile-layout="1">`));
  assert.ok(out.indexOf(`<style id="${MOBILE_LAYOUT_STYLE_ID}"`) > headOf(out).indexOf("<head"));
  const headIndex = out.indexOf("</head>");
  const bootIndex = out.indexOf(`<script data-dsh-auth-mobile-boot="1">`);
  assert.ok(bootIndex < headIndex);
  const bodyIndex = out.indexOf("</body>");
  const scriptIndex = out.indexOf(`<script data-dsh-auth-mobile-layout="1">`);
  assert.ok(scriptIndex < bodyIndex);
});

test("is idempotent for repeated taps", () => {
  const once = injectMobileLayout(INDEX, "auto");
  const twice = injectMobileLayout(once, "auto");
  assert.equal(twice, once);
});

test("honors a configured breakpoint and falls back to the default", () => {
  const custom = injectMobileLayout(INDEX, "auto", 860);
  assert.ok(custom.includes('"(max-width: "'));
  assert.ok(custom.includes("860"));
  const fallback = injectMobileLayout(INDEX, "auto", 10);
  assert.ok(fallback.includes("760"));
});

test("passes non-string input through unchanged", () => {
  assert.equal(injectMobileLayout(null, "auto"), null);
  assert.equal(injectMobileLayout(undefined, "auto"), undefined);
});

test("appends the script at the end when the document has no closing body", () => {
  const out = injectMobileLayout("<!doctype html><html><head><title>x</title></head></html>", "auto");
  assert.ok(out.endsWith(`</script>`));
});

test("ships the mobile override and drawer markers in the payload", () => {
  const { style, boot, script } = mobileLayoutPayload();
  assert.ok(style.includes("data-dsh-mobile-frame"));
  assert.ok(style.includes("data-dsh-mobile-sidebar-open"));
  assert.ok(style.includes("data-dsh-mobile-details-open"));
  assert.ok(style.includes("data-dsh-mobile-settings-open"));
  assert.ok(style.includes("data-dsh-auth-mobile-nav"));
  assert.ok(style.includes("data-dsh-auth-mobile-right-nav"));
  assert.ok(style.includes("transition: none !important"));
  assert.ok(style.includes("-webkit-text-size-adjust: 100%"));
  assert.ok(style.includes("touch-action: manipulation"));
  assert.ok(style.includes("max-width: 100%"));
  assert.ok(style.includes("VOzbGW_panel"));
  assert.ok(style.includes("VOzbGW_navList"));
  assert.ok(style.includes("VOzbGW_options"));
  assert.ok(boot.includes("dsh_mode"));
  assert.ok(boot.includes("maximum-scale=1"));
  assert.ok(boot.includes("viewport-fit=cover"));
  assert.ok(boot.includes("matchMedia"));
  assert.ok(script.includes("dsh_mode"));
  assert.ok(script.includes("data-shell-overlay"));
  assert.ok(script.includes("data-sidebar-collapsed"));
  assert.ok(script.includes("data-dsh-auth-mobile-original-draggable"));
  assert.ok(script.includes("closeSidebarAfterSelection"));
  assert.ok(script.includes("data-dsh-auth-mobile-right-nav"));
  assert.ok(script.includes("rightPanelExpandSource"));
  assert.ok(script.includes("mobileDetailsOpen"));
  assert.ok(script.includes("onSidebarPointerUp"));
  assert.ok(script.includes("suppressNativeSidebarClick"));
  assert.ok(script.includes("VOzbGW_overlay"));
  assert.ok(script.includes("openRightPanel"));
});

test("keeps mobile controls on the single-tap gesture path", () => {
  const { style } = mobileLayoutPayload();
  assert.match(style, /\[data-dsh-auth-mobile-nav\],[\s\S]*?\[data-dsh-auth-mobile-right-nav\][\s\S]*?touch-action: manipulation/u);
  assert.match(style, /\[data-dsh-mobile-sidebar\],[\s\S]*?\[data-dsh-mobile-details\][\s\S]*?touch-action: manipulation/u);
});

test("keeps session rows on the single-tap path", () => {
  const { style } = mobileLayoutPayload();
  assert.match(style, /\[data-dsh-mobile-sidebar\] \[role='treeitem'\][\s\S]*?touch-action: manipulation/u);
  assert.match(style, /\[data-dsh-mobile-sidebar\] \[role='treeitem'\][\s\S]*?-webkit-user-drag: none/u);
});

test("hides the Session log utility on mobile headers", () => {
  const { style } = mobileLayoutPayload();
  assert.match(style, /header \[class\*='_sessionLogButton'\][\s\S]*?display: none !important/u);
});

test("drawer matches the official sidebar width and hides nav while open", () => {
  const { style } = mobileLayoutPayload();
  assert.ok(style.includes("min(280px, calc(100vw - 24px))"));
  assert.ok(style.includes('html[data-dsh-auth-mobile-sidebar-open] [data-dsh-auth-mobile-nav]'));
});

test("dark theme selects on body where the official theme marker lives", () => {
  const { style } = mobileLayoutPayload();
  assert.ok(style.includes("body[data-ds-dark-theme] [data-dsh-auth-mobile-backdrop]"));
  assert.ok(style.includes("body[data-ds-dark-theme] [data-dsh-auth-mobile-nav]"));
  assert.ok(!style.includes("html[data-ds-dark-theme]"));
});

test("hidden mobile controls remain hidden outside mobile mode", () => {
  const { style } = mobileLayoutPayload();
  assert.ok(style.includes("[data-dsh-auth-mobile-nav][hidden]"));
  assert.ok(style.includes("[data-dsh-auth-mobile-backdrop][hidden]"));
  assert.ok(style.includes("display: none !important"));
});

test("keeps the composer toolbar on one line for sessions that carry history", () => {
  const { style } = mobileLayoutPayload();
  // The card's toolbar row wraps the trailing cluster onto a second line once a
  // session has both a model label and the context ring.
  assert.match(style, /\[data-composer-card\] > :last-child\s*\{[\s\S]*?flex-wrap: nowrap !important/u);
  assert.match(style, /\[data-composer-card\] > :last-child\s*\{[\s\S]*?gap: 8px !important/u);
  // Both clusters may shrink; the leading buttons keep their size and the
  // trailing cluster gives way to the model label.
  assert.match(style, /\[data-composer-card\] > :last-child > \*\s*\{[\s\S]*?min-width: 0 !important/u);
  assert.match(style, /\[data-composer-card\] > :last-child > :first-child\s*\{[\s\S]*?flex: 0 0 auto !important/u);
  assert.match(style, /\[data-composer-card\] > :last-child > :last-child\s*\{[\s\S]*?flex: 0 1 auto !important/u);
});

test("scopes every composer rule to the mobile shell", () => {
  const { style } = mobileLayoutPayload();
  const css = style.replace(/\/\*[\s\S]*?\*\//gu, "");
  const selectors = [...css.matchAll(/([^{}]*\[data-composer-card\][^{}]*)\{/gu)].map((match) => match[1].trim());
  assert.ok(selectors.length >= 5, "expected the composer toolbar rules in the payload");
  for (const selector of selectors) {
    assert.match(selector, /^html\[data-dsh-auth-mobile\] /u, `unscoped composer rule: ${selector}`);
  }
});

test("copies only the official panel icon into the floating mobile button", () => {
  const { script } = mobileLayoutPayload();
  assert.ok(script.includes('svg[class*="panelIcon"]'));
  assert.ok(!script.includes("Array.prototype.forEach.call(source.childNodes"));
});
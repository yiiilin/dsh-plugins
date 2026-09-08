import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const ROOT = resolve(new URL("..", import.meta.url).pathname, "..");
const WIDTH_HANDLE_SELECTOR = "[data-width-handle]";
const WIDTH_GUARD_SELECTOR = "[data-conversation-scroll][data-dsh-terminal-active] ~ [data-width-handle]";

const VIEW_CLIENTS = [
  resolve(ROOT, "dsh-plugin-terminal-tab/client.js"),
  resolve(ROOT, "dsh-plugin-web-browser/client.js"),
];

function extractStyles(source) {
  const match = source.match(/style\.textContent = `([\s\S]*?)`;\n\s*document\.(?:head|body)\.append(?:Child)?\(style\);?/u);
  assert.ok(match, "plugin stylesheet template should be present");
  return match[1];
}

test("terminal and browser views hide the conversation width handles", async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    for (const clientPath of VIEW_CLIENTS) {
      const stylesheet = extractStyles(readFileSync(clientPath, "utf8"));
      await page.setContent(`
        <div data-conversation-body>
          <div data-conversation-scroll data-dsh-terminal-active></div>
          <div data-width-handle="left"></div>
          <div data-width-handle="right"></div>
        </div>
      `);
      await page.addStyleTag({ content: stylesheet });
      assert.deepEqual(
        await page.locator(WIDTH_GUARD_SELECTOR).evaluateAll((handles) => handles.map((handle) => getComputedStyle(handle).display)),
        ["none", "none"],
        `${clientPath} must disable handles while a non-chat view is active`,
      );

      await page.locator("[data-conversation-scroll]").evaluate((element) => element.removeAttribute("data-dsh-terminal-active"));
      assert.deepEqual(
        await page.locator(WIDTH_HANDLE_SELECTOR).evaluateAll((handles) => handles.map((handle) => getComputedStyle(handle).display)),
        ["block", "block"],
        `${clientPath} must leave handles available for the chat view`,
      );
    }
  } finally {
    await browser.close();
  }
});

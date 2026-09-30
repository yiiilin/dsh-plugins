import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const run = promisify(execFile);
const url = process.env.DSH_EDITOR_QA_URL;
const session = `settings-editor-regression-${process.pid}`;

async function browser(...args) {
  const { stdout } = await run("agent-browser", ["--session", session, "--json", ...args], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, response.error ?? "browser command failed");
  return response.data;
}

async function evaluate(source) {
  return (await browser("eval", source)).result;
}

async function clickButton(name) {
  await browser("find", "role", "button", "click", "--name", name, "--exact");
}

before(async () => {
  if (!url) return;
  assert.notEqual(new URL(url).port, "3080", "Use an isolated profile, not the production GUI");
  await browser("open", url);
  if (await evaluate('Boolean(document.querySelector("input[type=password]"))')) {
    await browser("find", "label", "Username", "fill", "admin");
    await browser("find", "label", "Password", "fill", "editor-qa-only");
    await clickButton("Sign in");
  }
  await browser("wait", "--fn", 'document.body.innerText.includes("Preview Notice") || Boolean(document.querySelector("button[aria-label=Settings]"))');
  if (await evaluate('document.body.innerText.includes("Preview Notice")')) await clickButton("Continue");
  await clickButton("Settings");
  await clickButton("Models");
  await browser("wait", "--text", "fixture-one");
}, { timeout: 90000 });

after(async () => {
  if (url) await browser("close");
});

test("configuration editor stays above model cards and fills a usable dialog", { skip: !url, timeout: 60000 }, async () => {
  await clickButton("Edit configuration file");
  await browser("wait", ".daw-settingsEditorInput");
  assert.equal(await evaluate('document.querySelector(".daw-settingsEditorMeta").textContent'), "cordis.patch.yml");
  for (const [width, height] of [[803, 523], [1440, 900], [768, 1024], [375, 812]]) {
    await browser("set", "viewport", String(width), String(height));
    const result = await evaluate(`(() => {
      const editor = document.querySelector(".daw-settingsEditorDialog");
      const input = editor.querySelector("textarea");
      const box = input.getBoundingClientRect();
      const samples = [];
      for (const x of [0.2, 0.5, 0.8]) {
        for (const y of [0.2, 0.5, 0.8]) {
          const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
          samples.push({ covered: !editor.contains(hit), hit: hit?.tagName ?? null });
        }
      }
      const bounds = editor.getBoundingClientRect();
      return { samples, width: bounds.width, height: bounds.height,
        inputHeight: box.height, focused: editor.contains(document.activeElement),
        inViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight };
    })()`);
    assert.equal(result.samples.some((sample) => sample.covered), false,
      `Model content covers the editor at ${width}x${height}: ${JSON.stringify(result)}`);
    assert.ok(result.width >= Math.min(600, width - 48), `Editor is compressed into the action row: ${JSON.stringify(result)}`);
    assert.ok(result.inputHeight >= 180, `Editor input is too short: ${JSON.stringify(result)}`);
    assert.equal(result.inViewport, true);
    assert.equal(result.focused, true);
  }
  await clickButton("Close configuration editor");
});

test("Tab stays in the editor and Escape returns to Settings", { skip: !url, timeout: 30000 }, async () => {
  await browser("set", "viewport", "803", "523");
  await clickButton("Edit configuration file");
  await browser("wait", ".daw-settingsEditorInput");
  for (let index = 0; index < 8; index += 1) {
    await browser("press", "Tab");
    assert.equal(await evaluate('document.querySelector(".daw-settingsEditorDialog").contains(document.activeElement)'), true);
  }
  await browser("press", "Escape");
  assert.equal(await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))'), false);
  assert.equal(await evaluate('document.querySelector("button[aria-label=Settings]").getAttribute("aria-expanded")'), "true");
  assert.equal(await evaluate('document.activeElement.textContent'), "Edit configuration file");
});

test("the editor handles Escape before a document-level consumer", { skip: !url, timeout: 30000 }, async () => {
  await browser("set", "viewport", "803", "523");
  await evaluate('window.__editorEscapeConsumer = event => { if (event.key === "Escape") event.preventDefault(); }; document.addEventListener("keydown", window.__editorEscapeConsumer); true');
  try {
    await clickButton("Edit configuration file");
    await browser("wait", ".daw-settingsEditorInput");
    await browser("press", "Escape");
    assert.equal(await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))'), false);
    assert.equal(await evaluate('document.querySelector("button[aria-label=Settings]").getAttribute("aria-expanded")'), "true");
  } finally {
    await evaluate('document.removeEventListener("keydown", window.__editorEscapeConsumer); delete window.__editorEscapeConsumer; true');
    if (await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))')) await clickButton("Close configuration editor");
  }
});

test("dirty dismissal asks once, cancellation preserves content, and save persists", { skip: !url, timeout: 45000 }, async () => {
  await browser("set", "viewport", "803", "523");
  await clickButton("Edit configuration file");
  await browser("wait", ".daw-settingsEditorInput");
  const original = await evaluate('document.querySelector(".daw-settingsEditorInput").value');
  const next = `${original}\n# settings-editor browser regression\n`;
  await browser("fill", ".daw-settingsEditorInput", next);
  await evaluate('window.__editorConfirmCalls = 0; window.confirm = () => { window.__editorConfirmCalls += 1; return false; }; true');
  await browser("press", "Escape");
  assert.equal(await evaluate('window.__editorConfirmCalls'), 1);
  assert.equal(await evaluate('document.querySelector(".daw-settingsEditorInput").value'), next);
  await clickButton("Save configuration");
  await browser("wait", "--fn", 'document.querySelector(".daw-settingsEditorStatus")?.textContent === "Saved" || document.querySelector(".daw-settingsEditorStatus")?.dataset.kind === "error"');
  assert.equal(await evaluate('document.querySelector(".daw-settingsEditorStatus").textContent'), "Saved");
  assert.equal(await evaluate('document.querySelector(".daw-settingsEditorSave").disabled'), true);
  const saved = await evaluate('fetch("/_dsh/auth-webserver/settings-editor/document").then(r => r.json()).then(data => data.content)');
  assert.equal(saved, next);
  await clickButton("Close configuration editor");
  assert.equal(await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))'), false);
  assert.equal(await evaluate('document.querySelector("button[aria-label=Settings]").getAttribute("aria-expanded")'), "true");
});

test("a failed reload preserves the draft and its dismissal protection", { skip: !url, timeout: 45000 }, async () => {
  await browser("set", "viewport", "803", "523");
  await clickButton("Edit configuration file");
  await browser("wait", ".daw-settingsEditorInput");
  const original = await evaluate('document.querySelector(".daw-settingsEditorInput").value');
  const draft = `${original}\n# unsaved reload draft\n`;
  await browser("fill", ".daw-settingsEditorInput", draft);
  await evaluate('window.confirm = () => true; true');
  const route = "**/_dsh/auth-webserver/settings-editor/document";
  await browser("network", "route", route, "--body", JSON.stringify({ ok: false, error: "Synthetic reload failure" }));
  try {
    await clickButton("Reload configuration file");
    await browser("wait", "--fn", 'document.querySelector(".daw-settingsEditorStatus")?.dataset.kind === "error"');
    assert.equal(await evaluate('document.querySelector(".daw-settingsEditorInput").value'), draft);
    await evaluate('window.__editorConfirmCalls = 0; window.confirm = () => { window.__editorConfirmCalls += 1; return false; }; true');
    await browser("press", "Escape");
    assert.equal(await evaluate('window.__editorConfirmCalls'), 1, "A failed reload must not clear the dirty flag");
    assert.equal(await evaluate('document.querySelector(".daw-settingsEditorInput").value'), draft);
  } finally {
    await browser("network", "unroute", route);
    await evaluate('window.confirm = () => true; true');
    if (await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))')) await clickButton("Close configuration editor");
  }
});

test("a stalled save times out without trapping the application or losing the draft", { skip: !url, timeout: 30000 }, async () => {
  await clickButton("Edit configuration file");
  await browser("wait", ".daw-settingsEditorInput");
  const original = await evaluate('document.querySelector(".daw-settingsEditorInput").value');
  const draft = `${original}\n# stalled save draft\n`;
  await browser("fill", ".daw-settingsEditorInput", draft);
  await evaluate(`(() => {
    window.__editorOriginalFetch = window.fetch;
    window.__editorOriginalTimeout = window.setTimeout;
    window.setTimeout = (callback, ms, ...args) => window.__editorOriginalTimeout(callback, ms === 30000 ? 50 : ms, ...args);
    window.fetch = (path, options) => {
      if (String(path).endsWith("/_dsh/auth-webserver/settings-editor/document") && options?.method === "POST") {
        return new Promise((resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      }
      return window.__editorOriginalFetch(path, options);
    };
    return true;
  })()`);
  try {
    await clickButton("Save configuration");
    const recovered = await evaluate(`new Promise(resolve => {
      const until = performance.now() + 1000;
      const check = () => {
        const status = document.querySelector(".daw-settingsEditorStatus");
        if (status?.dataset.kind === "error" || performance.now() >= until) {
          resolve({ message: status?.textContent,
            saveDisabled: document.querySelector(".daw-settingsEditorSave").disabled,
            closeDisabled: document.querySelector('[aria-label="Close configuration editor"]').disabled,
            reloadDisabled: document.querySelector('[aria-label="Reload configuration file"]').disabled });
        } else window.__editorOriginalTimeout(check, 10);
      };
      check();
    })`);
    assert.match(recovered.message, /timed out/i);
    assert.equal(recovered.closeDisabled, false);
    assert.equal(recovered.reloadDisabled, false);
    assert.equal(recovered.saveDisabled, true);
    assert.equal(await evaluate('document.querySelector(".daw-settingsEditorInput").value'), draft);
    await evaluate('window.confirm = () => true; true');
    await clickButton("Close configuration editor");
    assert.equal(await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))'), false);
  } finally {
    await evaluate('window.fetch = window.__editorOriginalFetch; window.setTimeout = window.__editorOriginalTimeout; true');
  }
});

test("other Settings pages open the same editor and backdrop closes only the editor", { skip: !url, timeout: 45000 }, async () => {
  await browser("set", "viewport", "803", "523");
  for (const section of ["General", "Built-in plugins"]) {
    await clickButton(section);
    await clickButton("Edit configuration file");
    await browser("wait", ".daw-settingsEditorInput");
    await browser("press", "Shift+Tab");
    assert.equal(await evaluate('document.querySelector(".daw-settingsEditorDialog").contains(document.activeElement)'), true);
    await browser("mouse", "move", "8", "8");
    await browser("mouse", "down");
    await browser("mouse", "up");
    assert.equal(await evaluate('Boolean(document.querySelector(".daw-settingsEditorDialog"))'), false);
    assert.equal(await evaluate('document.querySelector("button[aria-label=Settings]").getAttribute("aria-expanded")'), "true");
  }
});

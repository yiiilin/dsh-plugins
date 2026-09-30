import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Load the browser half with the stubs it needs, and hand back its exports. */
function loadClient() {
  let factory;
  const window = { __ModuleLoader__: { load(spec) { factory = spec.factory; } } };
  new Function("window", SOURCE)(window);
  return factory((id) => {
    if (id === "react") return { createElement: () => null };
    throw new Error(`unexpected require(${id})`);
  });
}

/** Run `apply` against a stub context and collect what it registers. */
function applyClient() {
  const locales = [];
  const slots = [];
  const slotsService = {
    inject: (slot, register) => void slots.push([slot, register]),
    register: (spec) => void slots.push([spec.name, spec]),
  };
  const ctx = {
    slots: slotsService,
    get(name) {
      if (name === "slots") return slotsService;
      if (name === "timer") return { interval: () => () => {}, timeout: () => {} };
      if (name === "locale") {
        return {
          register: (ns, dicts) => void locales.push([ns, dicts]),
          bind: () => (key) => key,
        };
      }
      if (name === "configForms") return undefined;
      return undefined;
    },
    effect(factory) {
      return factory();
    },
  };
  loadClient().apply(ctx);
  return { locales, slots };
}

test("the Settings card carries the start command copy in both locales", () => {
  const { locales } = applyClient();
  const entry = locales.find(([ns]) => ns === "web-daemon");
  assert.ok(entry !== undefined, "the web-daemon locale namespace is registered");
  const [, dicts] = entry;
  for (const language of ["zh", "en"]) {
    for (const key of ["startCommand", "startCommand.hint"]) {
      assert.equal(
        typeof dicts[language]?.[key],
        "string",
        `${language} dictionary carries ${key}`,
      );
    }
  }
});

test("the card edits startCommand and shows the generated line as its placeholder", () => {
  // The field is the unit's whole ExecStart, so it is one full-width input and
  // its placeholder is the command an empty value falls back to.
  assert.match(SOURCE, /update\("startCommand", event\.target\.value\)/u);
  assert.match(SOURCE, /placeholder: customCommand \? "" : \(snapshot\.command \|\| ""\)/u);
  // While a command is written, profile and port no longer feed the unit.
  assert.match(SOURCE, /const customCommand = String\(config\?\.startCommand \?\? ""\)\.trim\(\) !== ""/u);
  assert.equal(
    [...SOURCE.matchAll(/disabled: disabled \|\| customCommand/gu)].length,
    2,
    "profile and port are disabled while a custom command is in effect",
  );
});
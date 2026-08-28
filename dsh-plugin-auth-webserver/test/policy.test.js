import assert from "node:assert/strict";
import test from "node:test";
import {
  hostMatches,
  originMatches,
  parseAllowedHost,
  parseAllowedOrigin,
  parseList,
  parseRequestHost,
} from "../policy.js";

test("matches only configured Host authorities", () => {
  const allowed = [parseAllowedHost("dsh.yiln.de")];
  assert.equal(hostMatches("dsh.yiln.de", allowed), true);
  assert.equal(hostMatches("DSH.YILN.DE:443", allowed), true);
  assert.equal(hostMatches("other.yiln.de", allowed), false);
  assert.equal(hostMatches("dsh.yiln.de/path", allowed), false);
  assert.equal(hostMatches("dsh.yiln.de", [parseAllowedHost("dsh.yiln.de:443")], true), true);
  assert.equal(hostMatches("dsh.yiln.de", [parseAllowedHost("dsh.yiln.de:443")], false), false);
  assert.equal(hostMatches("dsh.yiln.de", [parseAllowedHost("dsh.yiln.de:80")], false), true);
});

test("rejects unsafe configured Host spellings", () => {
  for (const value of ["", "dsh.yiln.de/path", "user@dsh.yiln.de", "dsh.yiln.de:0080", "dsh.yiln.de "]) {
    assert.throws(() => parseAllowedHost(value));
  }
});

test("matches configured and same-Host Origins", () => {
  const host = "dsh.yiln.de";
  assert.equal(originMatches("https://dsh.yiln.de", "dsh.yiln.de:443", []), true);
  assert.equal(originMatches("https://dsh.yiln.de", "dsh.yiln.de:8443", []), false);
  assert.equal(originMatches("null", host, []), false);
  assert.equal(originMatches("https://dsh.yiln.de", host, [parseAllowedOrigin("https://dsh.yiln.de")]), true);
  assert.equal(originMatches("http://dsh.yiln.de", host, [parseAllowedOrigin("https://dsh.yiln.de")]), false);
  assert.equal(originMatches("https://dsh.yiln.de", "other.yiln.de", [parseAllowedOrigin("https://dsh.yiln.de")]), false);
});

test("parses comma-separated policy environment lists", () => {
  assert.deepEqual(parseList(undefined), undefined);
  assert.deepEqual(parseList(" dsh.yiln.de, https://dsh.yiln.de ,, "), ["dsh.yiln.de", "https://dsh.yiln.de"]);
  assert.deepEqual(parseRequestHost("dsh.yiln.de:3080"), {
    hostname: "dsh.yiln.de",
    port: "3080",
    host: "dsh.yiln.de:3080",
  });
});

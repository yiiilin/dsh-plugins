import assert from "node:assert/strict";
import test from "node:test";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
} from "../totp.js";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("matches RFC 6238 SHA-1 vectors", () => {
  const vectors = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totpCode(RFC_SECRET, seconds * 1000), expected);
  }
});

test("accepts one adjacent 30-second step, rejects two", () => {
  const timestamp = 90 * 1000;
  const code = totpCode(RFC_SECRET, timestamp);
  assert.equal(verifyTotp(RFC_SECRET, code, timestamp - 30 * 1000), true);
  assert.equal(verifyTotp(RFC_SECRET, code, timestamp + 30 * 1000), true);
  assert.equal(verifyTotp(RFC_SECRET, code, timestamp + 60 * 1000), false);
});

test("preserves leading zeroes and accepts formatted secrets/codes", () => {
  const code = totpCode(RFC_SECRET, 1111111109 * 1000);
  assert.equal(code, "081804");
  assert.equal(verifyTotp("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", "081-804", 1111111109 * 1000), true);
});

test("rejects malformed secrets and codes", () => {
  assert.equal(base32Decode("not-valid-0"), null);
  assert.equal(totpCode("", 0), null);
  assert.equal(verifyTotp(RFC_SECRET, "12345", 0), false);
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", 0), false);
});

test("base32 round-trips generated 160-bit secrets", () => {
  const secret = generateTotpSecret();
  assert.equal(secret.length, 32);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  assert.equal(base32Decode(secret).length, 20);
});

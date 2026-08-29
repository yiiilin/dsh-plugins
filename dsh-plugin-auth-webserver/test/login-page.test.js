import assert from "node:assert/strict";
import test from "node:test";
import {
  loginErrorMessage,
  renderLoginPage,
  selectLoginLocale,
} from "../login-page.js";

function request(url = "/", headers = {}) {
  return { url, headers };
}

test("selects an explicit URL locale before Accept-Language", () => {
  assert.equal(selectLoginLocale(request("/?lang=zh", { "accept-language": "en-US,en;q=0.9" })), "zh");
  assert.equal(selectLoginLocale(request("/?lang=zh-CN", { "accept-language": "en-US" })), "zh");
  assert.equal(selectLoginLocale(request("/?lang=en", { "accept-language": "zh-CN" })), "en");
});

test("selects the best supported browser language", () => {
  assert.equal(selectLoginLocale(request("/", { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" })), "zh");
  assert.equal(selectLoginLocale(request("/", { "accept-language": "fr-FR, en-US;q=0.8" })), "en");
  assert.equal(selectLoginLocale(request("/", { "accept-language": "en-US;q=0.4, zh;q=0.8" })), "zh");
  assert.equal(selectLoginLocale(request("/", { "accept-language": "zh;q=0" })), "en");
});

test("renders Chinese and preserves the language/mode query on the login page", () => {
  const html = renderLoginPage("网关 & 主机", true, "zh", "/?dsh_mode=mobile");
  assert.match(html, /<html lang="zh-CN">/u);
  assert.match(html, /<title>DeepSeek Harness - 登录<\/title>/u);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">/u);
  assert.match(html, /用户名/u);
  assert.match(html, /<label for="otp">验证码<\/label>/u);
  assert.match(html, /id="otp" name="totp" type="text"[^>]*autocomplete="one-time-code"/u);
  assert.match(html, /otp: document\.getElementById\("otp"\)/u);
  assert.match(html, /id="login" method="post" action="\/api\/auth\.login\?lang=zh" autocomplete="on"/u);
  assert.match(html, /href="\/\?dsh_mode=mobile&amp;lang=zh"/u);
  assert.match(html, /href="\/\?dsh_mode=mobile&amp;lang=en"/u);
  assert.match(html, /网关 &amp; 主机/u);
  assert.match(html, /data-default-error="用户名、密码或验证码无效"/u);
});

test("renders an English login form without the optional OTP field", () => {
  const html = renderLoginPage("DeepSeek Harness Authentication", false, "en", "/");
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /<label for="username">Username<\/label>/u);
  assert.match(html, /<label for="password">Password<\/label>/u);
  assert.doesNotMatch(html, /id="otp"/u);
  assert.match(html, /action="\/api\/auth\.login\?lang=en"/u);
  assert.match(html, /autocomplete="on"/u);
});

test("renders a passkey login action only when credentials are enrolled", () => {
  const enabled = renderLoginPage("Auth", false, "en", "/", true);
  assert.match(enabled, /id="passkey"[^>]*>Use a passkey<\/button>/u);
  assert.match(enabled, /api\/auth\.passkey\.login\.options/u);
  assert.match(enabled, /api\/auth\.passkey\.login\.verify/u);
  assert.match(enabled, /navigator\.credentials\.get/u);

  const disabled = renderLoginPage("Auth", false, "en", "/", false);
  assert.doesNotMatch(disabled, /id="passkey"/u);
});
test("localizes login endpoint error messages", () => {
  assert.equal(loginErrorMessage("zh", "invalid"), "用户名、密码或验证码无效");
  assert.equal(loginErrorMessage("en", "rateLimited"), "Too many login attempts");
});

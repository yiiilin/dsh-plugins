import { PWA_BOOTSTRAP, PWA_HEAD_MARKUP } from "./pwa.js";

const LOGIN_TEXT = Object.freeze({
  en: Object.freeze({
    htmlLang: "en",
    title: "DeepSeek Harness - Sign in",
    heading: "DeepSeek Harness",
    username: "Username",
    password: "Password",
    otp: "Authenticator code",
    submit: "Sign in",
    invalid: "Invalid username, password, or authenticator code",
    networkError: "Unable to sign in. Please try again.",
    methodNotAllowed: "Method not allowed",
    contentType: "Content-Type must be application/json",
    invalidBody: "Invalid request body",
    language: "Language",
    chinese: "中文",
    english: "English",
    rateLimited: "Too many login attempts",
    passkey: "Use a passkey",
    passkeyBusy: "Waiting for passkey...",
    passkeyUnsupported: "Passkeys require a supported browser and HTTPS.",
    passkeyCancelled: "Passkey sign-in was cancelled.",
    passkeyError: "Unable to sign in with a passkey. Please try again.",  }),
  zh: Object.freeze({
    htmlLang: "zh-CN",
    title: "DeepSeek Harness - 登录",
    heading: "DeepSeek Harness",
    username: "用户名",
    password: "密码",
    otp: "验证码",
    submit: "登录",
    invalid: "用户名、密码或验证码无效",
    networkError: "登录失败，请稍后重试。",
    methodNotAllowed: "请求方法不被允许",
    contentType: "请求内容类型必须是 application/json",
    invalidBody: "请求内容无效",
    language: "语言",
    chinese: "中文",
    english: "English",
    rateLimited: "登录尝试次数过多",
    passkey: "使用通行密钥",
    passkeyBusy: "正在等待通行密钥...",
    passkeyUnsupported: "通行密钥需要支持的浏览器和 HTTPS。",
    passkeyCancelled: "通行密钥登录已取消。",
    passkeyError: "通行密钥登录失败，请重试。",  }),
});

function languageOfTag(value) {
  const tag = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tag === "zh" || tag.startsWith("zh-")) return "zh";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return undefined;
}

function requestUrl(req) {
  return typeof req?.url === "string" && req.url !== "" ? req.url : "/";
}

/** Select an explicit URL language before the browser's language preference. */
export function selectLoginLocale(req) {
  let url;
  try {
    url = new URL(requestUrl(req), "http://dsh.internal");
  } catch {
    url = new URL("http://dsh.internal/");
  }
  const explicit = languageOfTag(url.searchParams.get("lang"));
  if (explicit !== undefined) return explicit;

  const rawHeader = req?.headers?.["accept-language"];
  const header = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader;
  const preferences = String(header ?? "")
    .split(",")
    .map((part, order) => {
      const pieces = part.trim().split(";");
      const locale = languageOfTag(pieces[0]);
      const qualityPart = pieces.slice(1).find((piece) => /^\s*q\s*=/iu.test(piece));
      const quality = qualityPart === undefined ? 1 : Number(qualityPart.replace(/^\s*q\s*=\s*/iu, ""));
      return { locale, quality: Number.isFinite(quality) ? quality : 0, order };
    })
    .filter((entry) => entry.locale !== undefined && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order);
  return preferences[0]?.locale ?? "en";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function languageHref(rawUrl, locale) {
  let url;
  try {
    url = new URL(rawUrl || "/", "http://dsh.internal");
  } catch {
    url = new URL("http://dsh.internal/");
  }
  url.searchParams.set("lang", locale);
  return `${url.pathname}${url.search}`;
}

function loginMessages(locale) {
  return LOGIN_TEXT[locale] ?? LOGIN_TEXT.en;
}

export function loginErrorMessage(locale, key) {
  return loginMessages(locale)[key] ?? LOGIN_TEXT.en[key] ?? key;
}

/** Render the self-contained, password-manager-friendly login document. */
export function renderLoginPage(realm, twoFactorEnabled = false, locale = "en", rawRequestUrl = "/", passkeyAvailable = false) {
  const language = LOGIN_TEXT[locale] === undefined ? "en" : locale;
  const text = loginMessages(language);
  const safeRealm = escapeHtml(realm ?? "DeepSeek Harness Authentication");
  const loginAction = `/api/auth.login?lang=${encodeURIComponent(language)}`;
  const zhHref = escapeHtml(languageHref(rawRequestUrl, "zh"));
  const enHref = escapeHtml(languageHref(rawRequestUrl, "en"));
  const otpField = twoFactorEnabled ? `
    <label for="otp">${text.otp}</label>
    <input id="otp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" pattern="[0-9]{6}" maxlength="6" required>
  ` : "";
  return `<!doctype html>
<html lang="${text.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  ${PWA_HEAD_MARKUP}
  <title>${text.title}</title>
  <style>
    :root { color-scheme: dark; --bg: #0a0d14; --panel: #121826; --line: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; padding: 20px; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    form { width: 100%; max-width: 360px; padding: 28px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 0 0 22px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    label { display: block; margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
    input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: #0b1120; color: var(--text); outline: none; }
    input:focus { border-color: var(--accent); }
    button { width: 100%; height: 42px; margin-top: 20px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .65; cursor: default; }
     button.passkey { margin-top: 10px; border: 1px solid var(--line); background: transparent; color: var(--text); }
     button.passkey:hover { border-color: var(--accent); }
    .language { display: flex; justify-content: flex-end; gap: 10px; margin: 0 0 18px; font-size: 12px; }
    .language a { color: var(--muted); text-decoration: none; }
    .language a:hover, .language a[aria-current="page"] { color: var(--text); text-decoration: underline; }
    #error { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px; background: rgba(239, 68, 68, 0.15); color: #f87171; font-size: 13px; }
  </style>
</head>
<body>
  <form id="login" method="post" action="${escapeHtml(loginAction)}" autocomplete="on">
    <nav class="language" aria-label="${text.language}">
      <a href="${zhHref}" lang="zh-CN"${language === "zh" ? " aria-current=\"page\"" : ""}>${text.chinese}</a>
      <a href="${enHref}" lang="en"${language === "en" ? " aria-current=\"page\"" : ""}>${text.english}</a>
    </nav>
    <h1>${text.heading}</h1>
    <p>${safeRealm}</p>
    <label for="username">${text.username}</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required>
    <label for="password">${text.password}</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${otpField}
    <button type="submit">${text.submit}</button>
    ${passkeyAvailable ? `<button id="passkey" class="passkey" type="button">${text.passkey}</button>` : ""}
    <div id="error" data-default-error="${escapeHtml(text.invalid)}" data-network-error="${escapeHtml(text.networkError)}" data-passkey-error="${escapeHtml(text.passkeyError)}" data-passkey-cancelled="${escapeHtml(text.passkeyCancelled)}">${text.invalid}</div>
  </form>
  <script data-dsh-auth-pwa="1">${PWA_BOOTSTRAP}</script>
  <script>
    const form = document.getElementById("login");
    const error = document.getElementById("error");
    const defaultError = error.dataset.defaultError;
    const networkError = error.dataset.networkError;
    const passkeyButton = document.getElementById("passkey");
    const passkeyError = ${JSON.stringify(text.passkeyError)};
    const passkeyBusy = ${JSON.stringify(text.passkeyBusy)};
    const passkeyUnsupported = ${JSON.stringify(text.passkeyUnsupported)};
    const passkeyCancelled = ${JSON.stringify(text.passkeyCancelled)};

    function decodeBase64url(value) {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    }

    function encodeBase64url(value) {
      const bytes = new Uint8Array(value);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
    }

    function requestOptions(value) {
      return {
        ...value,
        challenge: decodeBase64url(value.challenge),
        allowCredentials: value.allowCredentials?.map((entry) => ({
          ...entry,
          id: decodeBase64url(entry.id),
        })),
      };
    }

    function serializeAssertion(credential) {
      const response = credential.response;
      return {
        id: encodeBase64url(credential.rawId),
        rawId: encodeBase64url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: encodeBase64url(response.clientDataJSON),
          authenticatorData: encodeBase64url(response.authenticatorData),
          signature: encodeBase64url(response.signature),
          ...(response.userHandle ? { userHandle: encodeBase64url(response.userHandle) } : {}),
        },
        clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
        ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
      };
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.style.display = "none";
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const response = await fetch(${JSON.stringify(loginAction)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("username").value,
            password: document.getElementById("password").value,
            otp: document.getElementById("otp")?.value ?? ""
          })
        });
        const data = await response.json();
        if (data.ok) {
          window.location.reload();
        } else {
          error.textContent = data.error || defaultError;
          error.style.display = "block";
          button.disabled = false;
        }
      } catch {
        error.textContent = networkError;
        error.style.display = "block";
        button.disabled = false;
      }
    });

    passkeyButton?.addEventListener("click", async () => {
      error.style.display = "none";
      if (typeof window.PublicKeyCredential !== "function" || !navigator.credentials?.get) {
        error.textContent = passkeyUnsupported;
        error.style.display = "block";
        return;
      }
      const submitButton = form.querySelector("button[type=submit]");
      passkeyButton.disabled = true;
      passkeyButton.textContent = passkeyBusy;
      submitButton.disabled = true;
      try {
        const optionsResponse = await fetch("/api/auth.passkey.login.options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const optionsData = await optionsResponse.json();
        if (!optionsResponse.ok || !optionsData.ok) throw new Error(optionsData.error || passkeyError);
        const credential = await navigator.credentials.get({ publicKey: requestOptions(optionsData.options) });
        if (!credential) throw new Error(passkeyCancelled);
        const verifyResponse = await fetch("/api/auth.passkey.login.verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challenge: optionsData.challenge, response: serializeAssertion(credential) }),
        });
        const verifyData = await verifyResponse.json();
        if (!verifyResponse.ok || !verifyData.ok) throw new Error(verifyData.error || passkeyError);
        window.location.reload();
      } catch (cause) {
        error.textContent = cause?.name === "NotAllowedError" ? passkeyCancelled : passkeyError;
        error.style.display = "block";
        passkeyButton.disabled = false;
        passkeyButton.textContent = ${JSON.stringify(text.passkey)};
        submitButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

export const loginLocales = Object.freeze(Object.keys(LOGIN_TEXT));

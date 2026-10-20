import { prefixOf, pwaAssetUrls, pwaBootstrap, pwaHeadMarkup } from "./pwa.js";

const LOGIN_TEXT = Object.freeze({
  en: Object.freeze({
    htmlLang: "en",
    title: "DeepSeek Harness - Sign in",
    heading: "DeepSeek Harness",
    credential: "Pairing credential",
    submit: "Sign in",
    invalid: "That pairing credential is not correct.",
    networkError: "Unable to sign in. Please try again.",
    methodNotAllowed: "Method not allowed",
    contentType: "Content-Type must be application/json",
    invalidBody: "Invalid request body",
    language: "Language",
    chinese: "中文",
    english: "English",
  }),
  zh: Object.freeze({
    htmlLang: "zh-CN",
    title: "DeepSeek Harness - 登录",
    heading: "DeepSeek Harness",
    credential: "配对凭据",
    submit: "登录",
    invalid: "配对凭据不正确。",
    networkError: "登录失败，请稍后重试。",
    methodNotAllowed: "请求方法不被允许",
    contentType: "请求内容类型必须是 application/json",
    invalidBody: "请求内容无效",
    language: "语言",
    chinese: "中文",
    english: "English",
  }),
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

/**
 * Render the self-contained login document.
 *
 * One field, because there is one credential: the pairing credential is posted in
 * the `password` member of the JSON body, which is the wire format `login()` reads.
 *
 * The PWA assets are declared at the daemon's mount prefix, not at the origin root:
 * the page is served at whatever path the visitor asked for, so only a
 * prefix-absolute URL is stable. `pwaAssetUrls` is the same function the routes are
 * built from, which is what keeps the declaration and the served asset in agreement.
 *
 * @param realm - realm shown under the heading.
 * @param locale - `en` or `zh`; anything else falls back to English.
 * @param rawRequestUrl - the URL the page was requested at, kept by the language links.
 * @param rootPrefix - the daemon's configured mount prefix.
 */
export function renderLoginPage(realm, locale = "en", rawRequestUrl = "/", rootPrefix = "") {
  const language = LOGIN_TEXT[locale] === undefined ? "en" : locale;
  const text = loginMessages(language);
  const safeRealm = escapeHtml(realm ?? "DeepSeek Harness Authentication");
  // The form must post where the daemon actually answers, which is inside its own
  // mount: a root-absolute action would leave the prefix and reach whatever sits at
  // the origin, taking the pairing credential with it.
  const loginAction = `${prefixOf(rootPrefix)}/api/auth.login?lang=${encodeURIComponent(language)}`;
  const zhHref = escapeHtml(languageHref(rawRequestUrl, "zh"));
  const enHref = escapeHtml(languageHref(rawRequestUrl, "en"));
  const pwa = pwaAssetUrls(rootPrefix);
  const manifestHref = escapeHtml(pwa.manifest);
  const iconHref = escapeHtml(pwa.icon);
  return `<!doctype html>
<html lang="${text.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <link rel="manifest" href="${manifestHref}">
  <link rel="icon" type="image/png" sizes="192x192" href="${iconHref}">
  ${pwaHeadMarkup(rootPrefix)}
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
    <label for="credential">${text.credential}</label>
    <input id="credential" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">${text.submit}</button>
    <div id="error" data-default-error="${escapeHtml(text.invalid)}" data-network-error="${escapeHtml(text.networkError)}">${text.invalid}</div>
  </form>
  <script data-dsh-auth-pwa="1">${pwaBootstrap(rootPrefix)}</script>
  <script>
    const form = document.getElementById("login");
    const error = document.getElementById("error");
    const defaultError = error.dataset.defaultError;
    const networkError = error.dataset.networkError;

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
            password: document.getElementById("credential").value
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
  </script>
</body>
</html>`;
}

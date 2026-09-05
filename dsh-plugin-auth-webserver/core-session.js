import { request } from "node:http";

const CORE_COOKIE_PREFIX = "dsh-auth-";
const CORE_COOKIE_NAME_PATTERN = /^dsh-auth-[A-Za-z0-9_-]+$/u;
const BOOTSTRAP_TOKEN_PARAM = "token";
const COOKIE_REFRESH_SKEW_MS = 5_000;

function unbracketHost(value) {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

/**
 * Normalize and constrain the proxy target before a process launch token is
 * ever sent to it. The token must never be sent to a network destination.
 */
export function createLoopbackTarget(host, port) {
  const hostname = unbracketHost(String(host ?? "").trim()).toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("auth-webserver: core-authenticated upstream must be a loopback address");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("auth-webserver: core-authenticated upstream port is invalid");
  }
  const urlHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  const url = new URL(`http://${urlHost}:${String(port)}`);
  return {
    hostname,
    port,
    authority: url.host,
    origin: url.origin,
  };
}

function cookieName(value) {
  const first = String(value).split(";", 1)[0];
  const equals = first.indexOf("=");
  if (equals <= 0) return "";
  return first.slice(0, equals).trim();
}

function cookieValue(value) {
  const first = String(value).split(";", 1)[0];
  const equals = first.indexOf("=");
  if (equals <= 0) return "";
  return first.slice(equals + 1).trim();
}

function isCoreCookieName(name) {
  return typeof name === "string" && name.startsWith(CORE_COOKIE_PREFIX);
}

export function isCoreSetCookie(value) {
  return isCoreCookieName(cookieName(value));
}

/** Remove all DSH core cookies supplied by the public browser. */
export function stripCoreCookies(header) {
  if (typeof header !== "string") return header;
  const kept = header.split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !isCoreCookieName(part.slice(0, part.indexOf("=")).trim()));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** Replace public core cookies with the gateway-owned upstream session. */
export function attachCoreCookie(header, session) {
  const stripped = stripCoreCookies(header);
  const kept = typeof stripped === "string" && stripped.length > 0 ? [stripped] : [];
  kept.push(`${session.name}=${session.value}`);
  return kept.join("; ");
}

/** Prevent a loopback bearer cookie from being emitted by the public gateway. */
export function stripCoreSetCookies(headers) {
  const value = headers["set-cookie"];
  if (value === undefined) return headers;
  const values = Array.isArray(value) ? value : [value];
  const kept = values.filter((entry) => !isCoreSetCookie(entry));
  if (kept.length === 0) delete headers["set-cookie"];
  else headers["set-cookie"] = Array.isArray(value) ? kept : kept[0];
  return headers;
}

/** Remove the process launch token without rewriting special combo URLs. */
export function stripLaunchToken(rawUrl) {
  const value = String(rawUrl ?? "/");
  const question = value.indexOf("?");
  if (question === -1) return value;
  const path = value.slice(0, question);
  const queryAndHash = value.slice(question + 1);
  const hashAt = queryAndHash.indexOf("#");
  const query = hashAt === -1 ? queryAndHash : queryAndHash.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : queryAndHash.slice(hashAt);
  const kept = query.split("&").filter((part) => {
    const equals = part.indexOf("=");
    const rawName = equals === -1 ? part : part.slice(0, equals);
    try {
      return decodeURIComponent(rawName.replace(/\+/g, " ")) !== BOOTSTRAP_TOKEN_PARAM;
    } catch {
      return true;
    }
  });
  return `${path}${kept.length > 0 ? `?${kept.join("&")}` : ""}${hash}`;
}

function parseCoreSetCookie(value) {
  const name = cookieName(value);
  const rawValue = cookieValue(value);
  if (!CORE_COOKIE_NAME_PATTERN.test(name) || rawValue === "" || /[\s;]/u.test(rawValue)) return null;
  const maxAgeMatch = /(?:^|;)\s*max-age\s*=\s*([0-9]+)\s*(?:;|$)/iu.exec(String(value));
  if (maxAgeMatch === null) return null;
  const maxAgeSeconds = Number(maxAgeMatch[1]);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  return {
    name,
    value: rawValue,
    expiresAt: Date.now() + maxAgeSeconds * 1000,
  };
}

function bootstrapRequest(connection, target, timeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    let bootstrapUrl;
    try {
      bootstrapUrl = new URL(connection.authenticatedUrl(target.origin));
      const tokens = bootstrapUrl.searchParams.getAll(BOOTSTRAP_TOKEN_PARAM);
      if (bootstrapUrl.origin !== target.origin || bootstrapUrl.pathname !== "/"
        || tokens.length !== 1 || bootstrapUrl.searchParams.size !== 1
        || bootstrapUrl.hash !== "" || bootstrapUrl.username !== "" || bootstrapUrl.password !== "") {
        throw new Error("auth-webserver: core authentication URL is invalid");
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error("auth-webserver: core authentication URL is invalid"));
      return;
    }

    const upstream = request({
      hostname: target.hostname,
      port: target.port,
      method: "GET",
      path: `${bootstrapUrl.pathname}${bootstrapUrl.search}`,
      headers: {
        host: target.authority,
        accept: "text/html",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const location = response.headers.location;
        const setCookies = response.headers["set-cookie"];
        const cookie = Array.isArray(setCookies) && setCookies.length === 1
          ? parseCoreSetCookie(setCookies[0])
          : null;
        if (response.statusCode !== 303 || location !== "/" || cookie === null) {
          reject(new Error("auth-webserver: core authentication exchange was rejected"));
          return;
        }
        resolve(cookie);
      });
    });
    onRequest(upstream);
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("core authentication exchange timed out")));
    upstream.once("error", reject);
    upstream.end();
  });
}

/**
 * Own one memory-only core session and collapse concurrent HTTP/WS exchanges.
 * The bridge uses the public core URL exchange; it never manufactures a
 * cookie or persists the bearer value.
 */
export function createCoreSessionBridge(connection, target, { timeoutMs = 30_000 } = {}) {
  if (connection === undefined || typeof connection.authenticatedUrl !== "function") {
    throw new Error("auth-webserver: DSH client-connection service is required");
  }
  let session;
  let pending;
  let activeRequest;
  let disposed = false;

  const ensure = () => {
    if (disposed) return Promise.reject(new Error("auth-webserver: core session bridge is disposed"));
    if (session !== undefined && session.expiresAt > Date.now() + COOKIE_REFRESH_SKEW_MS) return Promise.resolve(session);
    if (pending !== undefined) return pending;
    const next = bootstrapRequest(connection, target, timeoutMs, (requestValue) => {
      activeRequest = requestValue;
    }).then((value) => {
      if (disposed) throw new Error("auth-webserver: core session bridge is disposed");
      session = value;
      return value;
    }).finally(() => {
      activeRequest = undefined;
    });
    pending = next;
    next.then(() => {
      if (pending === next) pending = undefined;
    }, () => {
      if (pending === next) pending = undefined;
    });
    return next;
  };

  return {
    ensure,
    invalidate() {
      session = undefined;
    },
    dispose() {
      disposed = true;
      session = undefined;
      activeRequest?.destroy(new Error("auth-webserver: core session bridge is disposed"));
      activeRequest = undefined;
    },
  };
}

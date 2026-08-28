/** Host and Origin policy helpers for the auth gateway. */

function parseAuthority(value, label, strict) {
  if (typeof value !== "string" || value === "" || value.trim() !== value || /\s/u.test(value)) {
    throw new Error(`auth-webserver: ${label} must be a bare host[:port] authority`);
  }

  let http;
  let https;
  try {
    http = new URL(`http://${value}`);
    https = new URL(`https://${value}`);
  } catch {
    throw new Error(`auth-webserver: ${label} is not a valid host[:port] authority`);
  }
  if (http.username !== "" || http.password !== "" || http.pathname !== "/" || http.search !== "" || http.hash !== "") {
    throw new Error(`auth-webserver: ${label} must be a bare host[:port] authority`);
  }

  const hostname = http.hostname.toLowerCase();
  const port = http.port || https.port;
  const canonical = port === "" ? hostname : `${hostname}:${port}`;
  if (strict && value.toLowerCase() !== canonical) {
    throw new Error(`auth-webserver: ${label} must use canonical host[:port] spelling`);
  }
  return { hostname, port, host: canonical };
}

/** Parse and validate one configured Host authority. */
export function parseAllowedHost(value, index = 0) {
  return parseAuthority(value, `allowedHosts[${String(index)}]`, true);
}

/** Parse and validate one request Host header. */
export function parseRequestHost(value) {
  try {
    return parseAuthority(value, "request Host", false);
  } catch {
    return undefined;
  }
}

/** Whether a request Host matches one configured authority. */
export function hostMatches(requestHost, allowedHosts, secure = false) {
  const request = parseRequestHost(requestHost);
  if (request === undefined) return false;
  const requestPort = request.port || (secure ? "443" : "80");
  return allowedHosts.some((allowed) => allowed.port === ""
    ? allowed.hostname === request.hostname
    : allowed.hostname === request.hostname && allowed.port === requestPort);
}

function parseOrigin(value, label, strict) {
  if (typeof value !== "string" || value === "" || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new Error(`auth-webserver: ${label} must be an absolute http(s) origin`);
  }
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`auth-webserver: ${label} must be an absolute http(s) origin`);
  }
  if ((origin.protocol !== "http:" && origin.protocol !== "https:")
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== "") {
    throw new Error(`auth-webserver: ${label} must be an absolute http(s) origin`);
  }
  if (strict && origin.origin !== value.replace(/\/$/u, "")) {
    throw new Error(`auth-webserver: ${label} must be a canonical origin`);
  }
  return origin;
}

/** Parse and normalize one configured browser Origin. */
export function parseAllowedOrigin(value, index = 0) {
  return parseOrigin(value, `allowedOrigins[${String(index)}]`, false).origin;
}

/** Whether an Origin header is one of the configured browser origins. */
export function originMatches(originValue, requestHost, allowedOrigins) {
  if (originValue === undefined) return true;
  let origin;
  try {
    origin = parseOrigin(originValue, "request Origin", false);
  } catch {
    return false;
  }
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin.origin)) return false;
  const request = parseRequestHost(requestHost);
  if (request === undefined) return false;
  if (request.host === origin.host) return true;
  if (request.port === "") return false;
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  return request.hostname === origin.hostname && request.port === (origin.port || defaultPort);
}

/** Parse a comma-separated environment list, preserving an absent value. */
export function parseList(value) {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries;
}

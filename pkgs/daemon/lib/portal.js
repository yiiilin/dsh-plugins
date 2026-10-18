/**
 * The portal: one page listing every profile this daemon serves.
 *
 * Rendered server-side and dependency-free, because it must render before any
 * client bundle is reachable and because a broken client build must not take the
 * front door with it.
 *
 * @module @yiln-dsh/dsh-daemon/portal
 */

const COPY = {
  en: {
    title: 'Development daemon',
    tagline: 'One origin, every profile. Each prefix is its own machine.',
    id: 'Prefix',
    kind: 'Kind',
    workspace: 'Workspace',
    status: 'Status',
    action: 'Action',
    local: 'local',
    ssh: 'ssh',
    running: 'running',
    stopped: 'stopped',
    open: 'Open',
    offline: 'not running',
    empty: 'No profiles yet. Add one under Admin.',
    admin: 'Admin',
    signOut: 'Sign out',
  },
  zh: {
    title: '开发守护',
    tagline: '一个入口，多个 profile。每个前缀就是一台机器。',
    id: '前缀',
    kind: '类型',
    workspace: '工作区',
    status: '状态',
    action: '操作',
    local: '本地',
    ssh: '远程',
    running: '运行中',
    stopped: '已停止',
    open: '打开',
    offline: '未运行',
    empty: '还没有 profile。在管理页添加。',
    admin: '管理',
    signOut: '退出登录',
  },
}

/**
 * Select the copy for a request.
 *
 * @param acceptLanguage - the `Accept-Language` header.
 * @returns the copy table.
 */
export function selectCopy(acceptLanguage) {
  const value = String(acceptLanguage ?? '').toLowerCase()
  return value.startsWith('zh') ? COPY.zh : COPY.en
}

/**
 * Render the portal page.
 *
 * @param options - render inputs.
 * @param options.profiles - every registered profile.
 * @param options.running - ids with a live process.
 * @param options.urls - launch URL per running profile, carrying its token.
 * @param options.acceptLanguage - the request's `Accept-Language`.
 * @returns the HTML document.
 */
export function renderPortal({ profiles, running, urls, acceptLanguage }) {
  const copy = selectCopy(acceptLanguage)
  const rows = profiles
    .map((profile) => {
      const up = running.has(profile.id)
      const status = up ? copy.running : copy.stopped
      // A bare `/<id>/` lands on the profile's own auth challenge, because the
      // token lives in the query string `dsh web` printed. Prefer that URL.
      const query = launchQuery(urls?.get(profile.id))
      const action = up
        ? `<a class="open" href="/${escapeHtml(profile.id)}/${query}">${escapeHtml(copy.open)}</a>`
        : `<span class="offline">${escapeHtml(copy.offline)}</span>`
      return `<tr>
      <td class="name">${escapeHtml(profile.label ?? profile.id)}<span class="id">/${escapeHtml(profile.id)}/</span></td>
      <td><span class="kind kind-${escapeHtml(profile.kind)}">${escapeHtml(profile.kind === 'ssh' ? copy.ssh : copy.local)}</span></td>
      <td class="path">${escapeHtml(profile.workspace ?? '')}</td>
      <td><span class="status status-${up ? 'up' : 'down'}">${escapeHtml(status)}</span></td>
      <td class="action">${action}</td>
    </tr>`
    })
    .join('\n')

  const body = profiles.length === 0
    ? `<p class="empty">${escapeHtml(copy.empty)}</p>`
    : `<table>
    <thead><tr>
      <th>${escapeHtml(copy.id)}</th><th>${escapeHtml(copy.kind)}</th>
      <th>${escapeHtml(copy.workspace)}</th><th>${escapeHtml(copy.status)}</th>
      <th>${escapeHtml(copy.action)}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`

  return `<!doctype html>
<html lang="${copy === COPY.zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
:root{color-scheme:light dark;--line:#8883;--dim:#8888}
body{margin:0;padding:2rem;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:64rem;margin-inline:auto}
h1{font-size:1.25rem;margin:0 0 .25rem}
p.tagline{margin:0 0 1.5rem;color:var(--dim)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);font-weight:600}
td.name{font-weight:600}
td.name .id{display:block;font-weight:400;font-size:.8rem;color:var(--dim);font-family:ui-monospace,monospace}
td.path{font-family:ui-monospace,monospace;font-size:.85rem;color:var(--dim);word-break:break-all}
.kind,.status{font-size:.8rem;padding:.1rem .5rem;border-radius:999px;border:1px solid var(--line)}
.status-up{color:#2a7a3f}
.status-down{color:var(--dim)}
.offline{color:var(--dim);font-size:.85rem}
.open{display:inline-block;padding:.3rem .9rem;border-radius:.4rem;border:1px solid var(--line);text-decoration:none;color:inherit}
.open:hover{border-color:currentColor}
.empty{color:var(--dim)}
nav{margin-top:1.5rem;display:flex;gap:1rem;font-size:.9rem}
nav a{color:inherit}
</style>
</head>
<body>
<h1>${escapeHtml(copy.title)}</h1>
<p class="tagline">${escapeHtml(copy.tagline)}</p>
${body}
<nav><a href="/admin">${escapeHtml(copy.admin)}</a><a href="/api/auth.logout">${escapeHtml(copy.signOut)}</a></nav>
</body>
</html>
`
}

/**
 * The query string a profile's launch URL carries, prefixed with `?`.
 *
 * @param launchUrl - the URL the profile printed, or undefined.
 * @returns `?token=…` or an empty string.
 */
function launchQuery(launchUrl) {
  if (typeof launchUrl !== 'string' || launchUrl === '') return ''
  const at = launchUrl.indexOf('?')
  if (at === -1 || at === launchUrl.length - 1) return ''
  return escapeHtml(launchUrl.slice(at))
}

/**
 * Escape text for HTML content and attribute values.
 *
 * @param value - untrusted text.
 * @returns the escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

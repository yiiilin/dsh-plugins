/**
 * The `/admin` surface: profile lifecycle plus SSH deployment.
 *
 * Every route requires an authenticated session — the entry router guarantees
 * that before calling here — so this module never re-checks identity and never
 * exposes a credential. It is the only place a profile is created, started,
 * stopped or removed, which keeps the registry mutation in one file.
 *
 * @module @yiln-dsh/dsh-daemon/admin
 */

import { escapeHtml } from './portal.js'

/**
 * Build the admin router.
 *
 * @param options - collaborators owned by the plugin.
 * @param options.registry - the live registry accessor.
 * @param options.supervisor - the process supervisor.
 * @param options.provision - create/start/stop/remove operations.
 * @param options.ssh - connection probe and helper deployment.
 * @param options.config - resolved daemon configuration.
 * @returns a handler for `/admin…` requests.
 */
export function createAdmin({ registry, supervisor, provision, ssh, config }) {
  return async function handleAdmin(req, res, url) {
    try {
      return await route(req, res, url)
    } catch (error) {
      // A failed deploy or a bad body must not kill the daemon: every other
      // profile is still being served by this process.
      if (!res.headersSent) json(res, 500, { ok: false, error: error.message })
      else res.destroy()
      return true
    }
  }

  async function route(req, res, url) {
    const { pathname, searchParams } = splitUrl(url)
    const method = req.method ?? 'GET'

    if (pathname === '/admin' || pathname === '/admin/') {
      html(res, 200, renderAdminPage(registry.list(), supervisor))
      return true
    }

    if (pathname === '/admin/state' && method === 'GET') {
      json(res, 200, {
        ok: true,
        host: config.host,
        port: config.port,
        portBase: config.portBase,
        cacheDir: config.cacheDir,
        helperVersion: config.helperVersion,
        profiles: registry.list().map((profile) => describe(profile, supervisor)),
      })
      return true
    }

    if (pathname === '/admin/profiles' && method === 'POST') {
      const body = await readJson(req)
      const created = await provision.create(body)
      json(res, 201, { ok: true, profile: describe(created, supervisor) })
      return true
    }

    const match = /^\/admin\/profiles\/([a-z][a-z0-9-]{0,30})(?:\/(start|stop|restart|log|deploy))?$/u.exec(pathname)
    if (match !== null) {
      const [, id, action] = match
      const profile = registry.find(id)
      if (profile === undefined) {
        json(res, 404, { ok: false, error: `unknown profile ${JSON.stringify(id)}` })
        return true
      }
      if (action === undefined && method === 'DELETE') {
        await provision.remove(id)
        json(res, 200, { ok: true })
        return true
      }
      if (action === undefined && method === 'GET') {
        json(res, 200, { ok: true, profile: describe(profile, supervisor) })
        return true
      }
      if (action === 'start' && method === 'POST') {
        const result = await provision.start(id)
        json(res, 200, { ok: true, url: result.url, port: result.port })
        return true
      }
      if (action === 'stop' && method === 'POST') {
        await supervisor.stop(id)
        json(res, 200, { ok: true })
        return true
      }
      if (action === 'restart' && method === 'POST') {
        await supervisor.stop(id)
        const result = await provision.start(id)
        json(res, 200, { ok: true, url: result.url, port: result.port })
        return true
      }
      if (action === 'log' && method === 'GET') {
        json(res, 200, { ok: true, log: supervisor.log(id) })
        return true
      }
      if (action === 'deploy' && method === 'POST') {
        const result = await ssh.deploy(profile)
        json(res, 200, { ok: true, ...result })
        return true
      }
      json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` })
      return true
    }

    if (pathname === '/admin/ssh/probe' && method === 'POST') {
      const body = await readJson(req)
      json(res, 200, { ok: true, ...(await ssh.probe(body)) })
      return true
    }

    if (pathname === '/admin/ssh/deploy-preview' && method === 'POST') {
      const body = await readJson(req)
      json(res, 200, { ok: true, ...(await ssh.preview(body)) })
      return true
    }

    if (pathname === '/admin/reload' && method === 'POST') {
      await registry.reload()
      json(res, 200, { ok: true, profiles: registry.list().length })
      return true
    }

    json(res, 404, { ok: false, error: `unknown admin route ${pathname}${searchParams.size > 0 ? '?' : ''}` })
    return true
  }
}

/**
 * Describe one profile for the admin surface.
 *
 * @param profile - the registry record.
 * @param supervisor - the process supervisor.
 * @returns the JSON-safe view.
 */
function describe(profile, supervisor) {
  return {
    ...profile,
    running: supervisor.isRunning(profile.id),
    url: supervisor.url(profile.id),
  }
}

function splitUrl(url) {
  const at = url.indexOf('?')
  const pathname = at === -1 ? url : url.slice(0, at)
  return { pathname, searchParams: new URLSearchParams(at === -1 ? '' : url.slice(at + 1)) }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('daemon: admin body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * Render the admin page.
 *
 * A server-rendered page with inline JSON calls keeps the operator surface one
 * file and one origin: no build step, and it works before any client bundle.
 *
 * @param profiles - every registered profile.
 * @param supervisor - the process supervisor.
 * @returns the HTML document.
 */
function renderAdminPage(profiles, supervisor) {
  const rows = profiles
    .map((profile) => {
      const up = supervisor.isRunning(profile.id)
      return `<tr>
      <td class="name">${escapeHtml(profile.label)}<span class="id">/${escapeHtml(profile.id)}/</span></td>
      <td>${escapeHtml(profile.kind)}</td>
      <td class="path">${escapeHtml(profile.workspace)}</td>
      <td>${up ? 'running' : 'stopped'}</td>
      <td class="ops">
        <button data-op="start" data-id="${escapeHtml(profile.id)}"${up ? ' disabled' : ''}>start</button>
        <button data-op="stop" data-id="${escapeHtml(profile.id)}"${up ? '' : ' disabled'}>stop</button>
        <button data-op="restart" data-id="${escapeHtml(profile.id)}">restart</button>
        <button data-op="log" data-id="${escapeHtml(profile.id)}">log</button>
        <button data-op="delete" data-id="${escapeHtml(profile.id)}" class="danger">delete</button>
      </td>
    </tr>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>daemon · admin</title>
<style>
:root{color-scheme:light dark;--line:#8883;--dim:#8888}
body{margin:0;padding:2rem;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:72rem;margin-inline:auto}
h1{font-size:1.2rem;margin:0 0 1rem}
h2{font-size:.95rem;margin:2rem 0 .6rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid var(--line)}
th{font-size:.8rem;color:var(--dim)}
td.path{font-family:ui-monospace,monospace;font-size:.85rem;color:var(--dim);word-break:break-all}
td.name .id{display:block;font-size:.8rem;color:var(--dim);font-family:ui-monospace,monospace}
button{font:inherit;font-size:.85rem;padding:.2rem .6rem;border-radius:.35rem;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
button.danger{color:#c0392b}
form{display:grid;gap:.5rem;max-width:34rem;grid-template-columns:auto 1fr}
form label{font-size:.85rem;color:var(--dim);align-self:center}
input,select{font:inherit;padding:.35rem .5rem;border-radius:.35rem;border:1px solid var(--line);background:transparent;color:inherit}
pre{background:#8881;padding:1rem;border-radius:.5rem;overflow:auto;max-height:22rem;font-size:.8rem;white-space:pre-wrap}
nav{margin-top:2rem;font-size:.9rem}
nav a{color:inherit}
</style>
</head>
<body>
<h1>daemon · admin</h1>
<table>
<thead><tr><th>Profile</th><th>Kind</th><th>Workspace</th><th>State</th><th>Ops</th></tr></thead>
<tbody>${rows === '' ? '<tr><td colspan="5">No profiles yet.</td></tr>' : rows}</tbody>
</table>

<h2>Add profile</h2>
<form id="add">
  <label>Kind</label>
  <select id="kind"><option value="local">local</option><option value="ssh">ssh</option></select>
  <label>ID</label><input id="id" placeholder="empty = from host name">
  <label>Workspace</label><input id="workspace" placeholder="/root/ws">
  <span></span><span id="sshFields" style="display:none;display:grid;gap:.5rem">
    <input id="sshHost" placeholder="SSH host (alias or host:port)">
    <input id="sshUser" placeholder="SSH user">
    <input id="sshHelper" placeholder="remote helper path" value="/opt/dsh-helper/dsh-ssh-helper">
  </span>
  <span></span><button type="submit">create</button>
</form>
<div id="out"></div>

<nav><a href="/">← back to portal</a></nav>

<script>
const out = document.getElementById('out')
const say = (value) => { out.innerHTML = '<pre>' + JSON.stringify(value, null, 2).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>' }
const call = async (path, options) => (await fetch(path, { credentials: 'same-origin', ...options })).json()

document.getElementById('kind').addEventListener('change', (e) => {
  document.getElementById('sshFields').style.display = e.target.value === 'ssh' ? 'grid' : 'none'
})

document.querySelectorAll('button[data-op]').forEach((button) => {
  button.addEventListener('click', async () => {
    const { op, id } = button.dataset
    if (op === 'delete' && !confirm('Remove profile ' + id + '?')) return
    if (op === 'delete') return say(await call('/admin/profiles/' + id, { method: 'DELETE' }))
    if (op === 'log') return say({ log: (await call('/admin/profiles/' + id + '/log')).log })
    say(await call('/admin/profiles/' + id + '/' + op, { method: 'POST' }))
  })
})

document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault()
  const body = {
    kind: document.getElementById('kind').value,
    workspace: document.getElementById('workspace').value,
    sshHost: document.getElementById('sshHost').value || undefined,
    sshUser: document.getElementById('sshUser').value || undefined,
    sshHelper: document.getElementById('sshHelper').value || undefined,
  }
  const id = document.getElementById('id').value
  if (id) body.id = id
  say(await call('/admin/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
})
</script>
</body>
</html>
`
}

/**
 * dsh-plugin-model-config-remote
 *
 * Host-only DSH plugin that serves a self-contained model configuration page
 * backed directly by the Host `settings` service. The page works from any
 * address that can reach the DSH web server; it does not depend on the
 * loopback-pinned browser settings RPCs.
 *
 * Routes:
 *   GET  /_dsh/model-config          the editor page
 *   GET  /_dsh/model-config.js       the page script
 *   GET  /_dsh/model-config-api      current model settings snapshot
 *   POST /_dsh/model-config-api      save/reset one namespace
 */

export const name = 'model-config-remote'

/** The `webServer` service is required; `settings` is read through `ctx.get`. */
export const inject = ['webServer']

const RELEVANT_NAMESPACES = (ns) => ns === 'agent-default-model' || (typeof ns === 'string' && ns.startsWith('llm-'))

function cloneValue(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

/**
 * Dynamic plugin payloads arrive as objects from another realm; the DSH
 * `settings` service only accepts plain objects of its own realm. Rebuild any
 * structure as null-prototype objects so `isPlainObject` accepts them.
 */
function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone)
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null)
    for (const key of Object.keys(value)) out[key] = plainClone(value[key])
    return out
  }
  return value
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  if (body.length === 0) return {}
  return JSON.parse(body)
}

function apply(ctx) {
  const settings = ctx.get('settings')
  const webServer = ctx.get('webServer')
  if (settings === undefined || webServer === undefined) return

  const snapshot = () => {
    const descriptors = settings.describe({ redactSecrets: true })
    return {
      writable: settings.writable,
      sections: descriptors
        .filter((entry) => RELEVANT_NAMESPACES(entry.ns))
        .map((entry) => ({
          ns: entry.ns,
          value: cloneValue(entry.value),
          revision: entry.revision,
          applies: entry.applies,
        })),
    }
  }

  const pageHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Remote model config</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#111827;display:flex;justify-content:center;padding:32px 16px}
main{width:min(920px,100%);display:flex;flex-direction:column;gap:16px;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:20px}
h1{margin:0;font-size:20px;line-height:28px}
.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
label{font-size:13px;color:#6b7280}
select{height:34px;min-width:220px;padding:0 8px;border:1px solid #d1d5db;border-radius:6px;font:inherit}
textarea{box-sizing:border-box;width:100%;min-height:320px;resize:vertical;padding:10px;border:1px solid #d1d5db;border-radius:6px;font:13px/20px ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:flex;align-items:center;gap:8px}
button{height:34px;padding:0 14px;border-radius:6px;font:inherit;cursor:pointer}
button.primary{border:none;color:#fff;background:#2563eb}
button.secondary{border:1px solid #d1d5db;background:transparent}
button:disabled{opacity:.5;cursor:default}
.status{min-height:20px;font-size:13px;color:#16a34a}
.status.error{color:#dc2626}
</style>
</head>
<body>
<main>
<h1>Remote model config</h1>
<div class="toolbar">
<label for="ns">Namespace</label>
<select id="ns"></select>
<button id="refresh" class="secondary">Refresh</button>
</div>
<textarea id="body" spellcheck="false"></textarea>
<div class="actions">
<button id="save" class="primary">Save</button>
<button id="reset" class="secondary">Reset</button>
</div>
<div id="status" class="status"></div>
</main>
<script src="/_dsh/model-config.js"><\/script>
</body>
</html>`)
  }

  const scriptHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(`
const state = { sections: [], ns: '', revision: null }
const nsSelect = document.getElementById('ns')
const bodyInput = document.getElementById('body')
const statusEl = document.getElementById('status')
const saveButton = document.getElementById('save')
const resetButton = document.getElementById('reset')
const refreshButton = document.getElementById('refresh')

const labels = {
  'agent-default-model': 'Default model',
  'llm-pi-ai': 'PI AI providers',
}

function setStatus(message, error) {
  statusEl.textContent = message
  statusEl.classList.toggle('error', Boolean(error))
}

async function load() {
  setStatus('Loading')
  try {
    const data = await fetch('/_dsh/model-config-api').then((r) => r.json())
    state.sections = data.sections
    const preferred = state.sections.find((entry) => entry.ns === 'agent-default-model') ?? state.sections[0]
    if (!preferred) {
      setStatus('No model-related settings found')
      return
    }
    state.ns = preferred.ns
    state.revision = preferred.revision
    renderSelect()
    bodyInput.value = JSON.stringify(preferred.value, null, 2)
    setStatus('Ready')
  } catch (error) {
    setStatus(String(error), true)
  }
}

function renderSelect() {
  nsSelect.innerHTML = ''
  for (const entry of state.sections) {
    const option = document.createElement('option')
    option.value = entry.ns
    option.textContent = labels[entry.ns] ?? entry.ns
    option.selected = entry.ns === state.ns
    nsSelect.appendChild(option)
  }
}

function choose() {
  const entry = state.sections.find((item) => item.ns === nsSelect.value)
  if (!entry) return
  state.ns = entry.ns
  state.revision = entry.revision
  bodyInput.value = JSON.stringify(entry.value, null, 2)
  setStatus('Ready')
}

async function write(mode) {
  saveButton.disabled = true
  resetButton.disabled = true
  setStatus('Saving')
  try {
    const payload = { ns: state.ns, revision: state.revision }
    if (mode === 'reset') {
      payload.section = {}
      payload.mode = 'reset'
    } else {
      payload.section = JSON.parse(bodyInput.value)
      payload.mode = mode
    }
    const data = await fetch('/_dsh/model-config-api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json())
    if (!data.ok) throw new Error(data.error || 'save failed')
    state.revision = data.section.revision
    bodyInput.value = JSON.stringify(data.section.value, null, 2)
    setStatus('Saved')
  } catch (error) {
    setStatus(String(error), true)
  } finally {
    saveButton.disabled = false
    resetButton.disabled = false
  }
}

nsSelect.addEventListener('change', choose)
refreshButton.addEventListener('click', load)
saveButton.addEventListener('click', () => write('merge'))
resetButton.addEventListener('click', () => write('reset'))
load()
`)
  }

  const apiHandler = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, snapshot())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let args
    try {
      args = await readJson(req)
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    try {
      if (args === null || typeof args !== 'object' || typeof args.ns !== 'string' || !RELEVANT_NAMESPACES(args.ns)) {
        throw new Error('unsupported settings namespace')
      }
      if (args.section === null || typeof args.section !== 'object' || Array.isArray(args.section)) {
        throw new Error('expected a JSON object section')
      }
      const section = plainClone(args.section)
      if (args.mode === 'reset') await settings.replace(args.ns, Object.create(null), args.revision)
      else if (args.mode === 'replace') await settings.replace(args.ns, section, args.revision)
      else await settings.update(args.ns, section, args.revision)
      const updated = snapshot().sections.find((entry) => entry.ns === args.ns)
      sendJson(res, 200, { ok: true, section: updated ?? null })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/_dsh/model-config', handler: pageHandler }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/_dsh/model-config.js', handler: scriptHandler }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/_dsh/model-config-api', handler: apiHandler }))
}

export default apply
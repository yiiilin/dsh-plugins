/**
 * dsh-plugin-original-models-page-patch
 *
 * Host-only DSH plugin that makes the ORIGINAL built-in Models settings page
 * writable when the browser is NOT on 127.0.0.1, without restarting DSH.
 *
 * It does three things:
 *   1. Patches the official `dsh-client-ui-settings` bundle so the settings
 *      mirror always uses Host persistence instead of degrading to `memory`
 *      for non-loopback browsers, then bumps the bundle revision so the page
 *      loads the patched version on refresh.
 *   2. Registers exact `/api/settings.*` and `/api/credentials.*` routes that
 *      serve through the Host `settings`/`credentials` services, bypassing the
 *      loopback-pinned browser RPC guard.
 *   3. Keeps running as long as the row is mounted, so refresh makes the
 *      original Models page fully editable.
 *
 * The client bundle patch modifies DSH's installed package file in place. It is
 * idempotent: an already-patched bundle is left untouched.
 */

import { readFileSync, writeFileSync } from 'node:fs'

export const name = 'original-models-page-patch'

/** Hard dependencies: settings, webServer, and the client module graph. */
export const inject = ['settings', 'webServer', 'clientModules']

const SETTINGS_CLIENT_ID = '@deepseek-ai/dsh-client-ui-settings'
const OLD_MIRROR_EXPR = 'connection.isLoopback ? "host" : "memory"'
const NEW_MIRROR_EXPR = '"host"'

function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone)
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null)
    for (const key of Object.keys(value)) out[key] = plainClone(value[key])
    return out
  }
  return value
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function namespaceView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: clone(descriptor.schema),
    value: clone(descriptor.value),
    ...(descriptor.base === undefined ? {} : { base: clone(descriptor.base) }),
    ...(descriptor.user === undefined ? {} : { user: clone(descriptor.user) }),
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body.length === 0 ? {} : JSON.parse(body)
}

function sendJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function apply(ctx) {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  const clientModules = ctx.get('clientModules')
  if (settings === undefined || webServer === undefined || clientModules === undefined) return

  // --- 1. Patch the official client bundle so non-loopback mirrors stay live ---
  const bundlePath = clientModules.clientPath(SETTINGS_CLIENT_ID)
  if (bundlePath !== undefined) {
    const source = readFileSync(bundlePath, 'utf8')
    if (source.includes(OLD_MIRROR_EXPR)) {
      writeFileSync(bundlePath, source.replace(OLD_MIRROR_EXPR, NEW_MIRROR_EXPR))
    }
    clientModules.rebuilt(SETTINGS_CLIENT_ID)
  }

  // --- 2. Serve settings/credentials RPCs from the Host services ---
  const describeValue = () => ({
    writable: settings.writable,
    hasDocument: settings.documentPath !== undefined,
    namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
  })

  const writeView = async (ns, mode, section, expectedRevision) => {
    const payload = plainClone(section)
    if (mode === 'update') await settings.update(ns, payload, expectedRevision)
    else if (mode === 'replace') await settings.replace(ns, payload, expectedRevision)
    else await settings.mutate(ns, payload, expectedRevision)
    const descriptor = settings.describe({ redactSecrets: true }).find((entry) => String(entry.ns) === ns)
    if (descriptor === undefined) throw new Error(`settings namespace "${ns}" was disposed after ${mode}`)
    return namespaceView(descriptor)
  }

  const ok = (rpcId, value) => ({ type: 'server-response', rpcId, result: { ok: true, value } })
  const fail = (rpcId, code, message, details = {}) => ({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details } },
  })

  const route = (method, handler) => {
    const path = `/api/${method}`
    const dispatch = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return
      }
      let message
      try {
        message = await readJson(req)
      } catch {
        sendJson(res, { type: 'server-response', rpcId: null, result: { ok: false, error: { code: 'bad-request', message: 'invalid JSON body', details: {} } } })
        return
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : '00000000-0000-4000-8000-000000000000'
      try {
        const payload = message.payload ?? {}
        const value = await handler(payload)
        sendJson(res, ok(rpcId, value))
      } catch (error) {
        sendJson(res, fail(rpcId, 'settings-rejected', error instanceof Error ? error.message : String(error)))
      }
    }
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler: dispatch }))
  }

  route('settings.describe', () => describeValue())
  route('settings.update', (payload) => writeView(payload.ns, 'update', payload.patch, payload.expectedRevision))
  route('settings.replace', (payload) => writeView(payload.ns, 'replace', payload.section, payload.expectedRevision))
  route('settings.mutate', (payload) => writeView(payload.ns, 'mutate', payload.ops, payload.expectedRevision))

  if (credentials !== undefined) {
    route('credentials.describe', async (payload) => {
      const refs = Array.isArray(payload.refs) ? payload.refs : []
      const credentialsOut = Object.create(null)
      for (const ref of refs) {
        if (typeof ref !== 'string') continue
        const info = await credentials.describe(ref)
        credentialsOut[ref] = {
          configured: info.configured,
          ...(info.source === undefined ? {} : { source: info.source }),
          writable: info.writable,
        }
      }
      return { credentials: credentialsOut }
    })
    route('credentials.set', async (payload) => {
      await credentials.set(payload.ref, payload.value)
      return {}
    })
    route('credentials.unset', async (payload) => {
      await credentials.unset(payload.ref)
      return {}
    })
  }
}

export default apply
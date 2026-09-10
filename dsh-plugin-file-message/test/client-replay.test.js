import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { test } from 'node:test'

const CLIENT_SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function loadToolView(fetchImpl) {
  let loaded
  const sandbox = {
    URLSearchParams,
    fetch: fetchImpl,
    window: {
      __ModuleLoader__: {
        load(spec) {
          loaded = spec
        },
      },
    },
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox)

  const registered = new Map()
  const slots = {
    inject(_name, callback) {
      const result = callback()
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        while (!result.next().done) {}
      }
    },
    register(options, view) {
      registered.set(options.key, view)
      return () => {}
    },
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
  }
  let state
  const effects = []
  React.useState = (initial) => {
    if (state === undefined) state = initial
    const current = state
    return [current, (next) => {
      state = typeof next === 'function' ? next(state) : next
    }]
  }
  React.useEffect = (effect) => {
    effects.push(effect)
  }

  const moduleExports = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module ${name}`)
  })
  moduleExports.apply({
    slots,
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect(register) {
      return register()
    },
  })

  return {
    effects,
    render(props) {
      return registered.get(props.toolName)(props)
    },
  }
}

test('recovers a legacy image card through the metadata route', async () => {
  const requests = []
  const recovered = {
    plugin: 'dsh-plugin-file-message',
    kind: 'image',
    callId: 'call-legacy-client-test',
    sessionId: 'session-client-replay-test',
    path: '/workspace/result.png',
    mediaType: 'image/png',
    displayName: 'result.png',
    size: 12,
  }
  const view = loadToolView(async (url) => {
    requests.push(String(url))
    return {
      ok: true,
      async json() {
        return recovered
      },
    }
  })
  const props = {
    toolName: 'send_image',
    callId: recovered.callId,
    block: {
      kind: 'tool-result',
      isError: false,
      meta: { ...recovered, sessionId: undefined },
      content: [],
    },
  }

  const first = view.render(props)
  assert.equal(first.props.className, 'dfm-placeholder')
  for (const effect of view.effects.splice(0)) effect()
  await new Promise((resolve) => setImmediate(resolve))
  const second = view.render(props)
  assert.equal(second.type.name, 'ImageMessage')
  assert.equal(second.props.sessionId, recovered.sessionId)
  assert.match(requests[0], /mode=meta/u)
  assert.match(requests[0], /detail=id/u)
  assert.match(requests[0], /callId=call-legacy-client-test/u)
})

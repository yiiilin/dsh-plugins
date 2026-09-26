import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

function loadClient() {
  let entry
  const window = { __ModuleLoader__: { load(value) { entry = value } } }
  new Function('window', CLIENT_SOURCE)(window)
  assert.equal(entry?.id, '@yiln-dsh/dsh-plugin-mentor')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useCallback: (callback) => callback,
    useEffect() {},
  }
  return entry.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
}

test('registers Mentor UI translations and settings slots through the official locale context', () => {
  const client = loadClient()
  const localeRegistrations = []
  const slotRegistrations = []
  let language = 'zh'
  const locale = {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
    bind(namespace) {
      return (key, params) => {
        const template = localeRegistrations.find((entry) => entry.namespace === namespace)?.dictionaries[language]?.[key] ?? key
        return template.replace(/\{(\w+)\}/gu, (match, name) => name in (params ?? {}) ? String(params[name]) : match)
      }
    },
  }
  const slots = {
    inject(_name, register) { return register() },
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
  }
  const clientContext = {
    locale,
    slots,
    connection: { rpc: { call: async () => ({ ok: false }) } },
    get(name) { return name === 'configForms' ? {} : undefined },
    effect(factory) { return factory() },
  }

  client.apply(clientContext)

  assert.equal(localeRegistrations.length, 1)
  const { namespace, dictionaries } = localeRegistrations[0]
  assert.equal(namespace, 'mentor.history')
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  for (const slot of ['conversation.view', 'settings.section', 'settings.plugins.tab']) {
    const registration = slotRegistrations.find(({ options }) => options.name === slot)
    assert.ok(registration, `expected ${slot} registration`)
    assert.equal(registration.options.locale, namespace)
  }

  const settings = slotRegistrations.find(({ options }) => options.name === 'settings.section')
  assert.equal(settings.component({ view: 'summary' }), dictionaries.zh.settingsSummary)
  language = 'en'
  assert.equal(settings.component({ view: 'summary' }), dictionaries.en.settingsSummary)
})

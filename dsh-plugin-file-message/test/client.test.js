import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const CLIENT_SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function dictionaryKeys(name, endMarker) {
  const start = CLIENT_SOURCE.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `${name} dictionary must exist`)
  const end = CLIENT_SOURCE.indexOf(endMarker, start)
  assert.notEqual(end, -1, `${name} dictionary must have a boundary`)
  return new Set([...CLIENT_SOURCE.slice(start, end).matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w.$]*))\s*:/gmu)]
    .map((match) => match[1] ?? match[2]))
}

test('keeps the zh/en dictionary key sets identical', () => {
  assert.deepEqual(
    [...dictionaryKeys('ZH_DICT', 'const EN_DICT')].sort(),
    [...dictionaryKeys('EN_DICT', 'function applyParams')].sort(),
  )
})

test('replays file cards from persisted session metadata', () => {
  assert.match(CLIENT_SOURCE, /mode: "meta", detail/u)
  assert.match(CLIENT_SOURCE, /typeof record\.sessionId !== "string"/u)
  assert.match(CLIENT_SOURCE, /resolvedRecord\.sessionId/u)
  assert.doesNotMatch(CLIENT_SOURCE, /props\.sessionId/u)
})

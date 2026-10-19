/**
 * Read and write the model configuration inside a profile patch.
 *
 * The configuration is three layers, and they have very different natures:
 *
 * 1. which provider and model are selected (`agent-default-model`)
 * 2. how a provider is defined — endpoint, api shape (`llm-pi-ai`)
 * 3. the API key itself, which lives in `.credentials.yaml`, not in the patch
 *
 * Only the first two belong here. The key is a secret and is handled separately.
 *
 * **Everything is done line by line, never by parsing and re-serialising.** That is not
 * fussiness: a YAML round trip rewrites the key `off` to `false`, and `reasoningEfforts`
 * uses `off` as a key, so a round trip produces a config the schema rejects. This was
 * learned the hard way.
 *
 * @module @yiln-dsh/dsh-gateway/model-config
 */

/** Patch rows that carry model configuration. */
const MODEL_ROWS = ['agent-default-model', 'llm-pi-ai']

/**
 * Extract the model rows from a patch as text.
 *
 * @param patchText - the whole `cordis.patch.yml`.
 * @returns the rows, in their original text, or an empty string when absent.
 */
export function extractModelRows(patchText) {
  const lines = patchText.split('\n')
  const blocks = []
  for (const rowId of MODEL_ROWS) {
    const start = lines.findIndex((line) => line.trim() === `- id: ${rowId}`)
    if (start === -1) continue
    const block = [lines[start]]
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      // A new top-level row ends this one; blank lines are part of neither.
      if (line.startsWith('- ') || line.trim() === '') break
      block.push(line)
    }
    blocks.push(block.join('\n').replace(/\s+$/u, ''))
  }
  return blocks.join('\n')
}

/**
 * Replace the model rows in a patch, keeping everything else untouched.
 *
 * @param patchText - the whole patch.
 * @param rowsText - the new rows, as they should appear.
 * @returns the patch with the rows replaced (or appended when absent).
 */
export function replaceModelRows(patchText, rowsText) {
  const lines = patchText.split('\n')
  // Remove every existing model row, back to front so earlier indices stay valid.
  const ranges = []
  for (const rowId of MODEL_ROWS) {
    const start = lines.findIndex((line) => line.trim() === `- id: ${rowId}`)
    if (start === -1) continue
    let end = start + 1
    while (end < lines.length && !lines[end].startsWith('- ') && lines[end].trim() !== '') end += 1
    ranges.push({ start, end })
  }
  ranges.sort((a, b) => b.start - a.start)
  for (const range of ranges) lines.splice(range.start, range.end - range.start)

  const remaining = lines.join('\n').replace(/\n+$/u, '')
  const trimmed = rowsText.trim()
  if (trimmed === '') return `${remaining}\n`
  return `${remaining === '' ? '' : `${remaining}\n`}${trimmed}\n`
}

/**
 * Summarize a model configuration for display.
 *
 * Deliberately does not return the API key: a panel needs to know whether one exists,
 * not what it is.
 *
 * @param rowsText - the extracted rows.
 * @param hasKey - whether the referenced key exists in the credentials store.
 * @returns the summary, or undefined fields when a row is absent.
 */
export function summarizeModelRows(rowsText, hasKey) {
  const selected = readScalar(rowsText, 'provider')
  const model = readScalar(rowsText, 'model')
  const effort = readScalar(rowsText, 'reasoningEffort')
  const baseURL = readScalar(rowsText, 'baseURL')
  const api = readScalar(rowsText, 'api')
  const keyEnv = readScalar(rowsText, 'apiKeyEnv')
  return {
    provider: selected,
    model,
    reasoningEffort: effort,
    baseURL,
    api,
    // The name of the variable, never its value.
    apiKeyEnv: keyEnv,
    hasApiKey: hasKey === true,
    configured: selected !== undefined && model !== undefined,
  }
}

/** First value of `key:` in the text, unquoted. */
function readScalar(text, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mu').exec(text)
  if (match === null) return undefined
  return match[1].trim().replace(/^['"]|['"]$/gu, '')
}

/**
 * Build the two model rows from a summary.
 *
 * Used when pushing a main node's configuration to an edge: the rows are regenerated from
 * the source patch rather than retyped, so a new field is carried without this module
 * knowing about it.
 *
 * @param sourceRows - the rows to send, already as text.
 * @returns the rows unchanged, after checking they contain what is expected.
 */
export function prepareRowsForPush(sourceRows) {
  if (extractModelRows(sourceRows) === '') {
    throw new Error('daemon: the source has no model configuration to push')
  }
  return extractModelRows(sourceRows)
}

import { createHash, randomUUID } from 'node:crypto'
import {
  copyCanonicalResult,
  extractSettledReply,
  formatConsultation,
  inputFingerprint,
  makeBlocked,
  makeReply,
  MENTOR_SYSTEM_PROMPT,
  normalizeInput,
  normalizeUsage,
} from './protocol.js'
import {
  consultationIdFor,
  inputMessageIdFor,
  journalIdFor,
  makeJournalEvent,
  projectJournal,
} from './journal.js'

const PLUGIN_ID = 'dsh-plugin-mentor'
const TOOL_NAME = 'mentor'
const VIEW_REQUEST_VERSION = 'mentor_view_request_v1'
const VIEW_RESPONSE_VERSION = 'mentor_view_response_v1'
const VIEW_CHANNEL = '/mentor-view'
const VIEW_ENDPOINT = 'read'
const VIEW_SHARED_API_ENDPOINT = 'mentor.view'
const VIEW_SESSION_ID = /^[^\s\u0000-\u001f/\\'"]{1,128}$/u
const MAX_VIEW_RECORDS = 20
const DEFAULTS = Object.freeze({
  maxInputBytes: 96 * 1024,
  requestTimeoutMs: 300000,
  globalConcurrency: 2,
})
const TOOL_DESCRIPTION = `Consult a tool-less Mentor agent in an isolated Session.
Use Mentor when you have a concrete uncertainty, are choosing between meaningful alternatives, are stuck debugging, or need an independent challenge to an important assumption. Do not send routine steps.
The Mentor can see only the message, evidence, and Mentor-thread history explicitly provided to it. It cannot inspect files, search, run code, or observe your other activity.
The message is required; evidence is optional and must be supplied explicitly. Each primary Session runs consultations serially. Success, failure, cancellation and timeout end the current invocation; a new invocation can proceed without manual reset. An interrupted or undelivered thread is automatically retired before starting fresh context. Replay of the same host call only recovers an existing reply; it never silently regenerates an uncertain request. Mentor advice is not verified fact or authorization; you remain responsible for verification and action.`

function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const selected = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > max) {
    throw new TypeError(`${name} must be a positive integer no greater than ${max}`)
  }
  return selected
}

function normalizedConfig(input = {}) {
  const enabled = input.enabled === true
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if ((provider === '') !== (model === '')) throw new TypeError('Mentor provider and model must be configured together')
  const reasoningEffort = typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim() !== ''
    ? input.reasoningEffort.trim()
    : undefined
  return {
    enabled,
    ...(provider === '' ? {} : { provider, model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    maxInputBytes: positiveInteger(input.maxInputBytes, DEFAULTS.maxInputBytes, 'maxInputBytes'),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 'requestTimeoutMs', 2147000000),
    globalConcurrency: positiveInteger(input.globalConcurrency, DEFAULTS.globalConcurrency, 'globalConcurrency', 128),
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Mentor settings are global: they live in this plugin's own composition row
// and are edited through the DSH settings service. Nothing is per-Session, and
// the generation/input/context/output/reply caps no longer exist — the plugin
// records the measured values in its journal instead of enforcing them.
const SETTINGS_NAMESPACE_FALLBACK = 'dsh-mentor'
const VOLATILE_SETTINGS = Object.freeze([
  'enabled',
  'provider',
  'model',
  'reasoningEffort',
  'requestTimeoutMs',
  'globalConcurrency',
])

function getSessionController(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('sessionController') : ctx.sessionController
}

async function readModelCatalog(ctx) {
  const sessionController = getSessionController(ctx)
  if (typeof sessionController?.modelCatalog !== 'function') throw new Error('DSH model catalog is unavailable')
  return sessionController.modelCatalog()
}

function findCatalogModel(catalog, provider, model) {
  const group = catalog?.groups?.find((item) => item.id === provider)
  return group?.models?.find((item) => item.id === model)
}

function publicModelCatalog(catalog) {
  return {
    default: {
      provider: catalog.default.provider,
      model: catalog.default.model,
      ...(typeof catalog.default.reasoningEffort === 'string' ? { reasoningEffort: catalog.default.reasoningEffort } : {}),
    },
    groups: (Array.isArray(catalog.groups) ? catalog.groups : []).slice(0, 40).map((group) => ({
      id: group.id,
      name: group.name,
      models: (Array.isArray(group.models) ? group.models : []).slice(0, 200).map((item) => ({
        id: item.id,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
        ...(item.reasoning ? { reasoning: {
          ...(typeof item.reasoning.defaultEffort === 'string' ? { defaultEffort: item.reasoning.defaultEffort } : {}),
          efforts: (Array.isArray(item.reasoning.efforts) ? item.reasoning.efforts : []).slice(0, 32).map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...(effort.description ? { description: effort.description } : {}),
          })),
        } } : {}),
      })),
    })),
  }
}

// Resolve the one global route: the configured row value, or the DSH catalog
// default when the row leaves provider/model blank.
function mentorRoute(config, catalog) {
  const provider = config.provider ?? catalog?.default?.provider
  const model = config.model ?? catalog?.default?.model
  if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') {
    throw new Error('No Mentor provider/model is configured or available in the DSH model catalog')
  }
  const modelInfo = findCatalogModel(catalog, provider, model)
  const reasoningEffort = config.reasoningEffort ?? modelInfo?.reasoning?.defaultEffort ?? undefined
  const route = { ...config, provider, model }
  if (reasoningEffort === undefined || reasoningEffort === null || reasoningEffort === '') delete route.reasoningEffort
  else route.reasoningEffort = reasoningEffort
  return route
}

function settingsService(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
}

function configEditorService(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('configEditor') : ctx.configEditor
}

// The plugin's own profile entry id, discovered from the live Loader entries so
// a renamed row keeps its settings page.
function settingsNamespace(ctx) {
  try {
    const own = configEditorService(ctx)?.entries?.().find((entry) => entry?.fiber === ctx.fiber)
    if (typeof own?.options?.id === 'string' && own.options.id !== '') return own.options.id
  } catch {
    // Fall through to the id this package's bundle patch declares.
  }
  return SETTINGS_NAMESPACE_FALLBACK
}

function settingsDescriptor(ctx, namespace) {
  try {
    const descriptors = settingsService(ctx)?.describe?.({ redactSecrets: true })
    return Array.isArray(descriptors) ? descriptors.find((entry) => entry.ns === namespace) : undefined
  } catch {
    return undefined
  }
}

function currentMentorSettings(config) {
  return {
    enabled: config.enabled === true,
    provider: config.provider ?? '',
    model: config.model ?? '',
    reasoningEffort: config.reasoningEffort ?? '',
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    globalConcurrency: config.globalConcurrency ?? DEFAULTS.globalConcurrency,
  }
}

// A blank saved route means "use the catalog default", so clearing a field must
// remove it from the resolved route instead of overriding it with ''.
function routeWithSettings(config, values) {
  const next = { ...config }
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (typeof values[key] === 'string' && values[key] !== '') next[key] = values[key]
    else delete next[key]
  }
  return next
}

function boundedSetting(value, name, max) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive integer no greater than ${max}`)
  }
  return value
}

function normalizeMentorSettingsPatch(value, config, catalog) {
  if (!isPlainRecord(value)) throw new TypeError('Mentor settings must be an object')
  const allowed = new Set(VOLATILE_SETTINGS)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown Mentor setting: ${key}`)
  const patch = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    patch.enabled = value.enabled
  }
  const provider = value.provider
  const model = value.model
  if ((provider === undefined) !== (model === undefined)) throw new TypeError('provider and model must be saved together')
  if (provider !== undefined) {
    if (typeof provider !== 'string' || typeof model !== 'string') throw new TypeError('provider and model must be strings')
    const trimmedProvider = provider.trim()
    const trimmedModel = model.trim()
    if ((trimmedProvider === '') !== (trimmedModel === '')) throw new TypeError('choose both a provider and a model, or neither')
    if (trimmedProvider !== '' && findCatalogModel(catalog, trimmedProvider, trimmedModel) === undefined) {
      throw new TypeError('selected provider/model is not in the DSH model catalog')
    }
    patch.provider = trimmedProvider
    patch.model = trimmedModel
  }
  if (value.reasoningEffort !== undefined) {
    if (value.reasoningEffort !== null && typeof value.reasoningEffort !== 'string') {
      throw new TypeError('reasoningEffort must be a string or null')
    }
    patch.reasoningEffort = value.reasoningEffort ?? ''
  }
  if (value.requestTimeoutMs !== undefined) patch.requestTimeoutMs = boundedSetting(value.requestTimeoutMs, 'requestTimeoutMs', 2147000000)
  if (value.globalConcurrency !== undefined) patch.globalConcurrency = boundedSetting(value.globalConcurrency, 'globalConcurrency', 128)
  if (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort !== '') {
    const effectiveProvider = patch.provider || config.provider || catalog?.default?.provider
    const effectiveModel = patch.model || config.model || catalog?.default?.model
    const modelInfo = findCatalogModel(catalog, effectiveProvider, effectiveModel)
    if (!modelInfo?.reasoning?.efforts?.some((effort) => effort.id === patch.reasoningEffort)) {
      throw new TypeError('reasoningEffort is not supported by the selected model')
    }
  }
  return patch
}

async function readMentorSettings(ctx, config) {
  const catalog = await readModelCatalog(ctx)
  const namespace = settingsNamespace(ctx)
  const settings = settingsService(ctx)
  const descriptor = settingsDescriptor(ctx, namespace)
  const values = isPlainRecord(descriptor?.value) ? { ...currentMentorSettings(config), ...descriptor.value } : currentMentorSettings(config)
  let effective = null
  try {
    const resolved = mentorRoute(routeWithSettings(config, values), catalog)
    effective = { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort ?? null }
  } catch {
    effective = null
  }
  return {
    kind: 'settings',
    namespace,
    writable: descriptor !== undefined && settings?.writable !== false && typeof settings?.update === 'function',
    revision: Number.isSafeInteger(descriptor?.revision) ? descriptor.revision : null,
    values,
    effective,
    catalog: publicModelCatalog(catalog),
    priorityPolicy: 'profile-row',
  }
}

async function saveMentorSettings(ctx, config, request) {
  const settings = settingsService(ctx)
  const namespace = settingsNamespace(ctx)
  if (typeof settings?.update !== 'function') return mentorViewEnvelope({ kind: 'fault', code: 'read_only' }, 'settings-save')
  const catalog = await readModelCatalog(ctx)
  let patch
  try {
    patch = normalizeMentorSettingsPatch(request.settings, config, catalog)
  } catch (error) {
    const code = error instanceof TypeError || error instanceof RangeError ? 'invalid_settings' : 'save_failed'
    return mentorViewEnvelope({ kind: 'fault', code }, 'settings-save')
  }
  try {
    await settings.update(namespace, patch, request.revision)
  } catch (error) {
    return mentorViewEnvelope({
      kind: 'fault',
      code: error?.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'save_failed',
    }, 'settings-save')
  }
  try {
    return mentorViewEnvelope(await readMentorSettings(ctx, config), 'settings-save')
  } catch {
    // A live settings write reloads this plugin row; answering with the written
    // values keeps the page usable even while the new instance starts.
    return mentorViewEnvelope({
      kind: 'settings',
      namespace,
      writable: true,
      revision: null,
      values: { ...currentMentorSettings(config), ...patch },
      effective: null,
      catalog: { default: { provider: '', model: '' }, groups: [] },
      priorityPolicy: 'profile-row',
    }, 'settings-save')
  }
}

function isNotFound(error) {
  return error?.name === 'SessionPersistenceNotFoundError'
    || error?.code === 'SESSION_NOT_FOUND'
    || error?.code === 'session/not-found'
    || /session .* not found/iu.test(error?.message ?? '')
}

function isMissingRecord(error) {
  return isNotFound(error) || /not found|does not exist/iu.test(error?.message ?? '')
}

function eventsFromRead(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.events)) return value.events
  return []
}

function makeJournalHeader(id, version) {
  return {
    version,
    id,
    createdAt: Date.now(),
    isSeeded: false,
  }
}

async function openLegacyHandle(persistence, id, mode, header, signal) {
  const options = signal === undefined ? undefined : { signal }
  try {
    return await persistence.open(id, mode, options)
  } catch (error) {
    if (mode !== 'write' || !isMissingRecord(error)) throw error
    const created = await persistence.create(header)
    if (created !== null && typeof created === 'object' && typeof created.append === 'function') return created
    return persistence.open(id, 'write', options)
  }
}

async function readJournalEvents(ctx, parentSessionId, adapters) {
  const persistence = ctx.sessionPersistence
  const id = journalIdFor(parentSessionId)
  const header = makeJournalHeader(id, adapters.sessionFormatVersion ?? 0)

  if (typeof persistence.open === 'function') {
    let handle
    try {
      handle = await openLegacyHandle(persistence, id, 'read', header)
    } catch (error) {
      if (isMissingRecord(error)) return { id, header, events: [], exists: false }
      throw error
    }
    try {
      const read = await handle.read()
      return { id, header, events: eventsFromRead(read), exists: true }
    } finally {
      await handle.close?.()
    }
  }

  try {
    const inspection = typeof persistence.inspect === 'function'
      ? await persistence.inspect(id)
      : await persistence.load(id)
    return { id, header, events: eventsFromRead(inspection), exists: true }
  } catch (error) {
    if (isMissingRecord(error)) return { id, header, events: [], exists: false }
    throw error
  }
}

async function appendJournalBatch(ctx, journal, events, signal) {
  const persistence = ctx.sessionPersistence
  if (typeof persistence.open === 'function') {
    const handle = await openLegacyHandle(persistence, journal.id, 'write', journal.header, signal)
    try {
      await handle.append(events, signal === undefined ? undefined : { signal })
      await handle.flush(signal === undefined ? undefined : { signal })
    } finally {
      await handle.close?.()
    }
    return
  }

  if (!journal.exists) await persistence.create(journal.header)
  await persistence.append(journal.id, events)
}

const journalLocks = new Map()

async function withJournalLock(id, callback) {
  const previous = journalLocks.get(id) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const current = previous.catch(() => {}).then(() => gate)
  journalLocks.set(id, current)
  await previous.catch(() => {})
  try {
    return await callback()
  } finally {
    release()
    if (journalLocks.get(id) === current) journalLocks.delete(id)
  }
}

async function readJournal(ctx, parentSessionId, adapters, { create = false } = {}) {
  let journal = await readJournalEvents(ctx, parentSessionId, adapters)
  if (!journal.exists && create) {
    if (typeof ctx.sessionPersistence.open === 'function') {
      let handle
      try {
        handle = await openLegacyHandle(ctx.sessionPersistence, journal.id, 'write', journal.header)
        journal.events = eventsFromRead(await handle.read())
        journal.exists = true
      } finally {
        await handle?.close?.()
      }
    } else {
      try {
        await ctx.sessionPersistence.create(journal.header)
        journal.exists = true
      } catch (error) {
        if (!/already exists|duplicate/iu.test(error?.message ?? '')) throw error
        journal = await readJournalEvents(ctx, parentSessionId, adapters)
      }
    }
  }
  return journal
}

async function appendJournal(ctx, parentSessionId, adapters, kind, data, signal) {
  const id = journalIdFor(parentSessionId)
  return withJournalLock(id, async () => {
    const entryId = randomUUID()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let journal = await readJournal(ctx, parentSessionId, adapters, { create: true })
      const alreadyWritten = journal.events.find((event) => event.type === 'mentor/journal'
        && event.data?.entryId === entryId)
      if (alreadyWritten !== undefined) return alreadyWritten
      const event = makeJournalEvent(journal.events.length, kind, { ...data, entryId })
      try {
        await appendJournalBatch(ctx, journal, [event], signal)
        return event
      } catch (error) {
        journal = await readJournalEvents(ctx, parentSessionId, adapters)
        if (journal.events.some((stored) => stored.type === 'mentor/journal' && stored.data?.entryId === entryId)) {
          return journal.events.find((stored) => stored.type === 'mentor/journal' && stored.data?.entryId === entryId)
        }
        if (attempt === 2) throw error
      }
    }
    throw new Error('Mentor journal append did not converge')
  })
}

async function flushSession(ctx, session) {
  const durable = await ctx.sessions.flush(session)
  if (durable !== true) throw new Error('Mentor requires a durable session persistence backend')
}

async function markAbortedBeforeProvider(ctx, config, adapters, operation, reason) {
  if (!operation.accepted || operation.abortJournaled) return
  await appendJournal(ctx, operation.parentSessionId, adapters, 'consultation-aborted', {
    hostCallId: operation.callId,
    inputMessageId: operation.messageId,
    reason: typeof reason === 'string' ? reason.slice(0, 300) : 'request rejected before provider dispatch',
  })
  operation.abortJournaled = true
  operation.dispatched = false
}

function findInvocation(events, callId) {
  for (const event of events) {
    if (event.type === 'tool/call'
      && event.data?.name === TOOL_NAME
      && String(event.data.callId) === callId) {
      return { callId, arguments: event.data.arguments, nested: false }
    }
    if ((event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/code-dispatch-start')
      && event.data?.name === TOOL_NAME
      && String(event.data.subCallId) === callId) {
      return { callId, arguments: event.data.arguments, nested: true }
    }
  }
  return undefined
}

function parsePersistedArguments(value) {
  if (typeof value === 'string') return JSON.parse(value)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  throw new TypeError('persisted Mentor arguments are not an object')
}

function renderedText(content) {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (block?.type === 'tool-result') {
      const nested = renderedText(block.content)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function parseCanonicalResult(text) {
  if (typeof text !== 'string') return undefined
  try {
    return copyCanonicalResult(JSON.parse(text))
  } catch {
    return undefined
  }
}

function resultForInvocation(events, callId) {
  for (const event of events) {
    if (event.type === 'tool/result'
      && (String(event.data?.message?.source?.callId ?? '') === callId
        || String(event.data?.message?.content?.[0]?.toolCallId ?? '') === callId)) {
      const meta = copyCanonicalResult(event.data?.meta)
      if (meta !== undefined) return meta
      const text = renderedText(event.data.message.content)
      const result = parseCanonicalResult(text)
      if (result !== undefined) return result
    }
    if ((event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch')
      && String(event.data?.subCallId ?? '') === callId
      && event.data?.name === TOOL_NAME
      && event.data?.isError !== true) {
      const result = copyCanonicalResult(event.data?.meta) ?? parseCanonicalResult(renderedText(event.data.content))
      if (result !== undefined) return result
    }
  }
  return undefined
}

function exactTextContent(content) {
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0]
  if (block?.type === 'text' && typeof block.text === 'string') return block.text
  if (block?.type === 'tool-result' && block.isError !== true) return exactTextContent(block.content)
  return undefined
}

function deliveryOutcomeForInvocation(events, call) {
  const expected = copyCanonicalResult(call.result)
  if (expected === undefined) return 'undelivered'
  const expectedText = renderCanonicalResult(expected)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'tool/result'
      && (String(event.data?.message?.source?.callId ?? '') === call.hostCallId
        || String(event.data?.message?.content?.[0]?.toolCallId ?? '') === call.hostCallId)) {
      const blocks = event.data?.message?.content
      const resultBlock = Array.isArray(blocks) ? blocks.find((block) => block?.type === 'tool-result') : undefined
      const failed = event.data?.error !== undefined || resultBlock?.isError === true
      const rendered = exactTextContent(blocks)
      return !failed && rendered === expectedText ? 'delivered' : 'undelivered'
    }
    if ((event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch')
      && String(event.data?.subCallId ?? '') === call.hostCallId
      && event.data?.name === TOOL_NAME) {
      const rendered = exactTextContent(event.data.content)
      return event.data.isError !== true && rendered === expectedText
        ? 'delivered'
        : 'undelivered'
    }
  }
  return undefined
}

async function reconcileDeliveries(ctx, config, adapters, runtime, parentSession, state, exceptCallId) {
  const parentSessionId = String(parentSession.id)
  const events = parentSession.ownEvents()
  for (const call of state.calls.values()) {
    if (call.status !== 'settled' || call.hostCallId === exceptCallId) continue
    if ([...runtime.activeOperations].some((operation) => operation.threadId === call.threadId)) continue
    if (!['pending', 'undelivered'].includes(call.deliveryStatus)) continue
    const outcome = deliveryOutcomeForInvocation(events, call)
    if (outcome === undefined || outcome === call.deliveryStatus) continue

    await appendJournal(ctx, parentSessionId, adapters,
      outcome === 'delivered' ? 'consultation-delivered' : 'consultation-undelivered', {
        hostCallId: call.hostCallId,
        ...(outcome === 'undelivered' ? { reason: 'parent-result-error-or-content-changed' } : {}),
      })
    state = projectJournal((await readJournal(ctx, parentSessionId, adapters)).events)
  }
  return { state }
}

function extractAssistantText(message) {
  if (!Array.isArray(message?.content)) return ''
  let text = ''
  for (const block of message.content) {
    if (block?.type === 'tool-call') return ''
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text.trim()
}

function extractTextContent(message) {
  if (!Array.isArray(message?.content)) return undefined
  let text = ''
  for (const block of message.content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

function isExactTextMessage(message, text) {
  return Array.isArray(message?.content)
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text === text
}

// DSH 0.2.1 injects its own runtime-context snapshot into every Agent surface and
// now retains `working-directory:current` even under `suppressRuntimeContext()`.
// That message is DSH-owned, recorded in the child session, and carries no
// plugin-external payload, so it is excluded from the Mentor history comparison
// instead of failing the consultation. Every other user source stays rejected.
function isRuntimeContextMessage(message) {
  return message?.role === 'user'
    && message?.source?.kind === 'runtime-context'
    && message?.source?.form === 'snapshot'
}

function readMessageEvent(session, seq) {
  if (typeof session.eventAt === 'function') return session.eventAt(seq)
  return session.snapshotEvents?.().find((event) => event.seq === seq)
}

// Recover the child turn's own recorded failure. A guard rejection never reaches
// the assistant-stream listener or the provider generator, so without this the
// only surviving description of a deterministic local violation is a generic
// MENTOR_INCOMPLETE. The recorded error is preferred only when it belongs to this
// consultation's input.
function turnFailureFor(events, operation) {
  const inputIndex = events.findIndex((event) => event.type === 'user/message' && event.data?.id === operation.messageId)
  if (inputIndex < 0) return undefined
  for (let index = events.length - 1; index > inputIndex; index -= 1) {
    const event = events[index]
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason?.kind !== 'error') return undefined
    const message = reason.error?.message
    if (typeof message !== 'string' || message === '') return undefined
    const error = new Error(message)
    if (typeof reason.error?.code === 'string' && reason.error.code !== 'UNKNOWN') error.code = reason.error.code
    return error
  }
  return undefined
}

// ponytail: UTF-8 serialized-byte upper bound substitutes for a provider tokenizer; tighten with a route tokenizer when one is available.
function promptUpperBound(system, messages) {
  let bytes = Buffer.byteLength(JSON.stringify(system ?? ''), 'utf8') + 256
  for (const message of messages) {
    bytes += 256
    if (!Array.isArray(message?.content)) return Number.POSITIVE_INFINITY
    for (const block of message.content) {
      if (block?.type === 'text' || block?.type === 'reasoning') {
        if (typeof block.text !== 'string') return Number.POSITIVE_INFINITY
        bytes += Buffer.byteLength(JSON.stringify(block.text), 'utf8') + 16
      } else {
        return Number.POSITIVE_INFINITY
      }
    }
  }
  return bytes
}

function configFingerprint(config) {
  return createHash('sha256').update(JSON.stringify({
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort ?? null,
    prompt: MENTOR_SYSTEM_PROMPT,
    protocol: 1,
  })).digest('hex')
}

function renderCanonicalResult(value) {
  return value.kind === 'reply'
    ? `Mentor 建议（尚未验证）\n${value.message}\n\nthread_id: ${value.thread_id}\nconsultation_id: ${value.consultation_id}\nrevision: ${value.context_revision}`
    : `Mentor 暂不可用：${value.code}${value.thread_id === null ? '' : `\nthread_id: ${value.thread_id}`}\n${value.message}`
}

function toolOutputSchema() {
  const requiredString = (description) => ({ type: 'string', required: true, description })
  const nullableString = () => ({ oneOf: [{ type: 'string' }, { type: 'null' }], required: true })
  const nullableInteger = () => ({ oneOf: [{ type: 'integer' }, { type: 'null' }], required: true })
  const usage = {
    type: 'object',
    additionalProperties: false,
    properties: {
      input_tokens: nullableInteger(),
      cached_input_tokens: nullableInteger(),
      output_tokens: nullableInteger(),
      reasoning_tokens: nullableInteger(),
      cost_estimate_usd: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
      status: { type: 'string', enum: ['reported', 'partial', 'unknown'], required: true },
    },
  }
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer', const: 1, required: true },
          kind: { type: 'string', const: 'reply', required: true },
          thread_id: requiredString('Opaque Mentor thread identifier.'),
          consultation_id: requiredString('Opaque identity for this completed consultation.'),
          context_revision: { type: 'integer', required: true },
          message: requiredString('Unmodified final Mentor text.'),
          usage: { type: 'object', additionalProperties: false, properties: usage.properties, required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer', const: 1, required: true },
          kind: { type: 'string', const: 'blocked', required: true },
          thread_id: nullableString(),
          consultation_id: nullableString(),
          code: { type: 'string', enum: ['THREAD_BUSY', 'THREAD_RETIRED', 'THREAD_NOT_AVAILABLE', 'STALE_REPLY', 'MENTOR_DISABLED', 'MODEL_UNAVAILABLE'], required: true },
          message: requiredString('Why no Mentor generation was started.'),
          retryable: { type: 'boolean', required: true },
        },
      },
    ],
  }
}

function currentCallsForThread(journalState, threadId) {
  return [...journalState.calls.values()].filter((call) => call.threadId === threadId)
}

function completedGenerationsForThread(journalState, threadId) {
  return currentCallsForThread(journalState, threadId)
    .filter((call) => call.status === 'settled' && call.generationSent !== false).length
}

function spentGenerations(journalState) {
  let count = 0
  for (const call of journalState.calls.values()) {
    if (call.generationSent === false) continue
    if (call.status === 'dispatched' || call.status === 'settled' || call.status === 'indeterminate') count += 1
  }
  return count
}

function findPendingReplay(journalState, inputHash, currentFingerprint) {
  const thread = journalState.activeThread
  if (thread === null || thread.configFingerprint !== currentFingerprint || thread.epoch !== journalState.epoch) return undefined
  const calls = [...journalState.calls.values()]
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    const result = copyCanonicalResult(call.result)
    if (call.status === 'settled'
      && (call.deliveryStatus === 'pending' || call.deliveryStatus === 'undelivered')
      && call.inputHash === inputHash
      && call.threadId === thread.threadId
      && call.configFingerprint === currentFingerprint
      && call.epoch === journalState.epoch
      && result !== undefined) {
      return { call, result }
    }
  }
  return undefined
}


// Only live work holds a lease. Historical journal outcomes never hold the queue.
function acquireConsultation(runtime, parentId, signal, modelLimit) {
  const waitingSignal = signal === undefined ? runtime.shutdown.signal : AbortSignal.any([signal, runtime.shutdown.signal])
  return new Promise((resolve, reject) => {
    const entry = { parentId, modelLimit, grant: undefined }
    const onAbort = () => {
      const index = runtime.waiting.indexOf(entry)
      if (index >= 0) runtime.waiting.splice(index, 1)
      waitingSignal.removeEventListener('abort', onAbort)
      reject(waitingSignal.reason ?? new Error('Mentor wait cancelled'))
      drainConsultations(runtime)
    }
    if (waitingSignal.aborted) { onAbort(); return }
    entry.grant = () => {
      waitingSignal.removeEventListener('abort', onAbort)
      runtime.parentBusy.add(parentId)
      if (modelLimit !== undefined) runtime.activeCount += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        runtime.parentBusy.delete(parentId)
        if (modelLimit !== undefined) runtime.activeCount -= 1
        drainConsultations(runtime)
      })
    }
    waitingSignal.addEventListener('abort', onAbort, { once: true })
    runtime.waiting.push(entry)
    drainConsultations(runtime)
  })
}

function drainConsultations(runtime) {
  if (runtime.disposed) return
  const blockedParents = new Set()
  for (const entry of [...runtime.waiting]) {
    if (blockedParents.has(entry.parentId) || runtime.parentBusy.has(entry.parentId)
      || (entry.modelLimit !== undefined && runtime.activeCount >= entry.modelLimit)) {
      blockedParents.add(entry.parentId)
      continue
    }
    runtime.waiting.splice(runtime.waiting.indexOf(entry), 1)
    entry.grant()
  }
}

function makeCanonicalTool(ctx, config, runtime, adapters) {
  const inputProperties = {
    message: { type: 'string', required: true, description: 'The concrete question to ask the Mentor.' },
    evidence: {
      type: 'array',
      description: 'Optional supporting evidence explicitly provided by the primary Agent.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: 'A unique identifier for this evidence item.' },
          kind: { type: 'string', enum: ['code', 'diff', 'log', 'test', 'spec', 'note'], required: true, description: 'The evidence category.' },
          source: { type: 'string', required: true, description: 'A provenance label. The Mentor does not fetch this source.' },
          content: { type: 'string', required: true, description: 'The evidence content, treated as untrusted input.' },
        },
      },
    },
  }

  return adapters.defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: inputProperties,
    output: {
      schema: toolOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderCanonicalResult(value) }],
      presentationMeta: (_args, value) => value,
    },
    presentCall: () => ({ card: 'generic', title: '向 Mentor 咨询' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: 'Mentor 咨询失败' }
      : { card: 'generic', title: 'Mentor 建议' },
    async execute(args, exec) {
      if (!config.enabled) return makeBlocked('MENTOR_DISABLED', 'Mentor 未启用；未发起模型请求。')
      const input = normalizeInput(args, { maxInputBytes: config.maxInputBytes })
      const parentAgent = exec?.agent
      const parentSession = parentAgent?.session
      if (parentAgent === undefined || parentSession === undefined) throw new Error('mentor requires a live parent agent session')
      const parentRegistry = parentAgent.ctx?.agents ?? ctx.agents
      if (!isPrimaryAgent(parentRegistry, parentAgent)) {
        return makeBlocked('MENTOR_DISABLED', 'Mentor 工具仅供主 Agent 使用；未发起模型请求。')
      }
      if (typeof exec.callId !== 'string' || exec.callId === '') throw new Error('mentor requires a host tool call id')
      if (exec.signal === undefined) throw new Error('mentor requires the caller cancellation signal')

      if (exec.signal.aborted) throw exec.signal.reason ?? new Error('Mentor call was cancelled before dispatch')
      if (runtime.disposed) throw new Error('Mentor plugin is stopping')
      const callId = String(exec.callId)
      const ownerSessionId = String(parentSession.id)
      const hash = inputFingerprint(input)
      const inFlightKey = `${ownerSessionId}\0${callId}`
      const existingFlight = runtime.inFlight.get(inFlightKey)
      if (existingFlight !== undefined) {
        if (existingFlight.inputHash !== hash) throw new Error('Mentor host call id was replayed with different input')
        return existingFlight.promise
      }

      // Register before the first await, so retries of a queued call share its promise.
      const operationPromise = Promise.resolve().then(async () => {
        const release = await acquireConsultation(runtime, ownerSessionId, exec.signal, config.globalConcurrency)
        try {
          if (runtime.disposed) throw new Error('Mentor plugin stopped')
          if (exec.signal.aborted) throw exec.signal.reason
          let routeConfig
          try {
            routeConfig = mentorRoute(config, await readModelCatalog(ctx))
          } catch {
            return makeBlocked('MODEL_UNAVAILABLE', 'Mentor 全局模型配置不可用；未发起新的模型请求。')
          }
          return await runConsultation(ctx, routeConfig, runtime, adapters, input, exec, parentAgent, parentSession, callId, hash)
        } finally {
          release()
        }
      })
      runtime.inFlight.set(inFlightKey, { inputHash: hash, promise: operationPromise })
      try {
        return await operationPromise
      } finally {
        runtime.inFlight.delete(inFlightKey)
      }
    },
  })
}

async function runConsultation(ctx, config, runtime, adapters, input, exec, parentAgent, parentSession, callId, hash) {
  if (runtime.disposed) throw new Error('Mentor plugin is stopping')
  const parentSessionId = String(parentSession.id)
  const parentEvents = parentSession.ownEvents()
  const priorInvocation = findInvocation(parentEvents, callId)
  if (priorInvocation?.arguments !== undefined) {
    let priorInput
    try {
      priorInput = normalizeInput(parsePersistedArguments(priorInvocation.arguments), { maxInputBytes: config.maxInputBytes })
    } catch {
      throw new Error('Mentor host call id has invalid persisted arguments')
    }
    if (inputFingerprint(priorInput) !== hash) throw new Error('Mentor host call id was replayed with different input')
    const storedResult = resultForInvocation(parentEvents, callId)
    if (storedResult !== undefined) return storedResult
  }
  await flushSession(ctx, parentSession)

  const journalEvents = await readJournal(ctx, parentSessionId, adapters)
  let journalState = projectJournal(journalEvents.events)
  const priorCall = journalState.calls.get(callId)
  if (priorCall !== undefined && priorCall.inputHash !== hash) {
    throw new Error('Mentor host call id was replayed with different input')
  }
  if (priorCall?.status === 'settled') {
    const recovered = await recoverCanonicalResult(ctx, config, adapters, priorCall, parentSession)
    if (recovered !== undefined) return recovered
    throw new Error('Mentor settled result is missing from both the parent tool log and Mentor session')
  }

  if (priorCall !== undefined && ['accepted', 'dispatched', 'indeterminate'].includes(priorCall.status)) {
    const preceding = currentCallsForThread(journalState, priorCall.threadId)
    const index = preceding.findIndex(call => call.hostCallId === callId)
    const revision = preceding.slice(0, index).filter(call => call.status === 'settled' && call.generationSent !== false).length + 1
    const recovered = await recoverCanonicalResult(ctx, config, adapters, { ...priorCall, revision }, parentSession)
    if (recovered !== undefined) {
      await appendJournal(ctx, parentSessionId, adapters, 'consultation-settled', {
        hostCallId: callId,
        revision: recovered.context_revision,
        usage: recovered.usage,
        replyUtf8Bytes: Buffer.byteLength(recovered.message, 'utf8'),
        result: recovered,
      })
      return recovered
    }
    throw new Error('MENTOR_OUTCOME_INDETERMINATE: this invocation ended without a durable complete reply; start a new tool invocation')
  }
  const currentFingerprint = configFingerprint(config)
  const deliveries = await reconcileDeliveries(ctx, config, adapters, runtime, parentSession, journalState, callId)
  journalState = deliveries.state

  const pendingReplay = findPendingReplay(journalState, hash, currentFingerprint)
  if (pendingReplay !== undefined) {
    const source = pendingReplay.call
    const result = pendingReplay.result
    await appendJournal(ctx, parentSessionId, adapters, 'consultation-replayed', {
      hostCallId: callId,
      replayedFrom: source.replayedFrom ?? source.hostCallId,
      inputHash: hash,
      threadId: source.threadId,
      configFingerprint: source.configFingerprint,
      epoch: source.epoch,
      consultationId: result.consultation_id,
      inputMessageId: source.inputMessageId,
    }, exec.signal)
    return result
  }

  let thread = journalState.activeThread
  const unfinished = thread === null ? [] : currentCallsForThread(journalState, thread.threadId)
    .filter(call => call.hostCallId !== callId && (['accepted', 'dispatched', 'indeterminate'].includes(call.status)
      || (call.status === 'settled' && call.deliveryStatus !== 'delivered')))
  if (unfinished.length > 0) {
    for (const call of unfinished) {
      if (call.status === 'settled' && call.deliveryStatus === 'pending') {
        await appendJournal(ctx, parentSessionId, adapters, 'consultation-undelivered', {
          hostCallId: call.hostCallId,
          reason: 'parent-result-not-observed-at-next-invocation',
        }, exec.signal)
      }
    }
    // Historical outcomes are facts, not a runtime lock. Start clean without replaying unseen advice.
    await appendJournal(ctx, parentSessionId, adapters, 'thread-retired', {
      threadId: thread.threadId,
      reason: 'previous-consultation-ended-without-delivered-reply',
    }, exec.signal)
    journalState = projectJournal((await readJournal(ctx, parentSessionId, adapters)).events)
    thread = null
  }
  if (thread !== null && thread.configFingerprint !== currentFingerprint) {
    await appendJournal(ctx, parentSessionId, adapters, 'thread-retired', { threadId: thread.threadId, reason: 'configuration-changed' }, exec.signal)
    const previousHandle = runtime.handles.get(thread.threadId)
    runtime.handles.delete(thread.threadId)
    runtime.threads.delete(thread.threadId)
    runtime.mentorAgents.delete(thread.threadId)
    if (previousHandle !== undefined) await previousHandle.dispose()
    journalState = projectJournal((await readJournal(ctx, parentSessionId, adapters)).events)
    thread = null
  }

  if (thread === null) {
    const epoch = journalState.epoch
    thread = {
      threadId: adapters.createId('mt_'),
      configFingerprint: currentFingerprint,
      epoch,
    }
    if (!/^mt_[A-Za-z0-9_-]{16,80}$/u.test(thread.threadId)) throw new Error('Mentor id adapter returned an invalid thread id')
    await appendJournal(ctx, parentSessionId, adapters, 'thread-bound', thread, exec.signal)
    journalState = projectJournal((await readJournal(ctx, parentSessionId, adapters)).events)
    thread = journalState.activeThread
  }

  const consultationId = priorCall?.consultationId ?? consultationIdFor(thread.threadId, callId)
  const inputMessageId = priorCall?.inputMessageId ?? inputMessageIdFor(thread.threadId, callId)

  const formatted = formatConsultation(input)
  const newInputBytes = Buffer.byteLength(formatted, 'utf8')
  const message = adapters.freezeMessage({
    id: inputMessageId,
    role: 'user',
    content: [{ type: 'text', text: formatted }],
    source: { kind: PLUGIN_ID },
  })


  const ownerAgents = parentAgent.ctx?.agents ?? ctx.agents
  if (typeof ownerAgents?.create !== 'function' || typeof ownerAgents?.resume !== 'function') {
    return makeBlocked('MODEL_UNAVAILABLE', 'DSH Agent 创建/恢复服务不可用；未发起模型请求。', thread.threadId, null, true)
  }
  let threadState = runtime.threads.get(thread.threadId)
  if (threadState === undefined) {
    threadState = {
      threadId: thread.threadId,
      parentSessionId,
      parentAgent,
      agent: null,
      handle: null,
      pendingByMessageId: new Map(),
      callsByTurn: new Map(),
      attempts: new Map(),
      activeCall: null,
      config,
    }
    runtime.threads.set(thread.threadId, threadState)
  }
  if (runtime.disposed) throw new Error('Mentor plugin is stopping')
  const handle = await getMentorHandle(ctx, config, runtime, adapters, ownerAgents, parentAgent, threadState, exec.signal)
  if (runtime.disposed) {
    await releaseMentorHandle(ctx, runtime, thread.threadId, handle)
    throw new Error('Mentor plugin is stopping')
  }
  const agent = handle.agent
  threadState.parentAgent = parentAgent
  threadState.config = config
  if (exec.signal.aborted) {
    await releaseMentorHandle(ctx, runtime, thread.threadId, handle)
    throw exec.signal.reason ?? new Error('Mentor call was cancelled before dispatch')
  }
  const controller = new AbortController()
  const operation = {
    controller,
    agent,
    callId,
    threadId: thread.threadId,
    parentSessionId,
    requestCount: 0,
    accepted: priorCall !== undefined,
    abortJournaled: false,
    dispatched: false,
    settled: false,
    messageId: inputMessageId,
    expectedInputText: formatted,
    consultationId,
    journalState,
    timeout: undefined,
    onParentAbort: undefined,
  }
  if (runtime.disposed || exec.signal.aborted) {
    await releaseMentorHandle(ctx, runtime, thread.threadId, handle)
    throw exec.signal.reason ?? new Error('Mentor plugin is stopping')
  }
  operation.onParentAbort = () => {
    controller.abort(exec.signal.reason ?? new Error('parent tool call cancelled'))
    agent.cancel({ kind: 'parent' })
  }
  exec.signal.addEventListener('abort', operation.onParentAbort, { once: true })
  operation.timeout = setTimeout(() => {
    controller.abort(new Error('Mentor request timed out'))
    agent.cancel({ kind: 'hook', reason: 'mentor request timeout' })
  }, config.requestTimeoutMs)
  runtime.activeOperations.add(operation)
  runtime.activeByAgentId.set(String(agent.id), operation)
  threadState.activeCall = operation
  threadState.pendingByMessageId.set(inputMessageId, operation)

  try {
    if (priorCall === undefined || priorCall.status === 'aborted') {
      await appendJournal(ctx, parentSessionId, adapters, 'consultation-accepted', {
        hostCallId: callId,
        inputHash: hash,
        threadId: thread.threadId,
        configFingerprint: thread.configFingerprint,
        epoch: thread.epoch,
        consultationId,
        inputMessageId,
        inputMeasureMode: 'serialized-json-utf8-bytes',
        newInputBytes,
      }, controller.signal)
      operation.accepted = true
    }
    if (controller.signal.aborted) throw controller.signal.reason
    agent.followup(message)
    await agent.whenIdle()
    if (controller.signal.aborted) throw controller.signal.reason
    let committed = operation.reply
    if (committed === undefined) {
      committed = extractSettledReply(
        agent.session.ownEvents(),
        operation.messageId,
        adapters.lastAssistantStreamChunk,
      ) ?? undefined
      if (committed !== undefined) operation.reply = committed
    }
    if (committed === undefined) {
      // A guard can reject the request before any assistant-stream frame exists,
      // so `operation.failure` stays empty. The child session still records the
      // real reason on its `turn/end`, and reporting that beats a generic
      // MENTOR_INCOMPLETE that hides a deterministic local violation.
      throw operation.failure ?? turnFailureFor(agent.session.ownEvents(), operation) ?? new Error('MENTOR_INCOMPLETE: no committed final reply was produced')
    }
    const turnEnd = agent.session.ownEvents().findLast((event) => event.type === 'turn/end' && event.data?.turn === committed.turn)
    if (turnEnd?.data?.reason?.kind !== 'completed') throw new Error('MENTOR_INCOMPLETE: the correlated Mentor turn did not complete')
    await flushSession(ctx, agent.session)
    const revision = completedGenerationsForThread(journalState, thread.threadId) + 1
    const result = makeReply({
      threadId: thread.threadId,
      consultationId,
      revision,
      message: committed.message,
      usage: committed.usage,
    })
    await appendJournal(ctx, parentSessionId, adapters, 'consultation-settled', {
      hostCallId: callId,
      revision,
      usage: committed.usage,
      replyUtf8Bytes: Buffer.byteLength(committed.message, 'utf8'),
      result,
      deliveryStatus: 'pending',
    }, controller.signal)
    operation.settled = true
    return result
  } catch (error) {
    try {
      await agent.whenIdle()
    } catch {
      // Preserve the primary failure after the Agent has made its best effort to quiesce.
    }
    if (operation.dispatched && !operation.settled) {
      try {
        await flushSession(ctx, agent.session)
        await appendJournal(ctx, parentSessionId, adapters, 'consultation-indeterminate', {
          hostCallId: callId,
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown failure after dispatch',
          usage: operation.usage ?? normalizeUsage(undefined),
        })
      } catch (journalError) {
        ctx.logger?.warn?.('mentor: could not persist indeterminate consultation %s: %s', callId, journalError)
      }
    } else if (operation.accepted && !operation.settled) {
      try {
        const inputLogged = agent.session.ownEvents().some((event) => event.type === 'user/message' && event.data?.id === inputMessageId)
        if (inputLogged) await flushSession(ctx, agent.session)
        await markAbortedBeforeProvider(ctx, config, adapters, operation, error)
        if (inputLogged) {
          await appendJournal(ctx, parentSessionId, adapters, 'thread-retired', {
            threadId: thread.threadId,
            reason: 'consultation-failed-before-provider',
          })
        }
      } catch (journalError) {
        ctx.logger?.warn?.('mentor: could not persist pre-dispatch failure %s: %s', callId, journalError)
      }
    }
    throw error
  } finally {
    clearTimeout(operation.timeout)
    exec.signal.removeEventListener('abort', operation.onParentAbort)
    threadState.pendingByMessageId.delete(inputMessageId)
    if (operation.turn !== undefined) threadState.callsByTurn.delete(operation.turn)
    for (const [attemptId, attempt] of threadState.attempts) {
      if (attempt.operation === operation) threadState.attempts.delete(attemptId)
    }
    threadState.activeCall = null
    runtime.activeByAgentId.delete(String(agent.id))
    runtime.activeOperations.delete(operation)
    await releaseMentorHandle(ctx, runtime, thread.threadId, handle)
  }
}

async function getMentorHandle(ctx, config, runtime, adapters, agents, parentAgent, threadState, signal) {
  const known = runtime.handles.get(threadState.threadId)
  if (known !== undefined && agents.get(threadState.threadId) === known.agent) return known
  const live = agents.get(threadState.threadId)
  if (live !== undefined) {
    if (typeof agents.isOwnedBy === 'function' && !agents.isOwnedBy(threadState.threadId, parentAgent)) {
      throw new Error('Mentor thread identity is already owned by another live agent')
    }
    const borrowed = { agent: live, borrowed: true, dispose: async () => {} }
    runtime.handles.set(threadState.threadId, borrowed)
    runtime.mentorAgents.set(String(live.id), threadState)
    threadState.agent = live
    threadState.handle = borrowed
    return borrowed
  }

  const stored = await readStoredSession(ctx.sessionPersistence, threadState.threadId)
  const setup = async (agentCtx) => configureMentorAgent(agentCtx, threadState, adapters)
  const agentOptions = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
  runtime.mentorAgents.set(threadState.threadId, threadState)
  let handle
  try {
    handle = stored === undefined
      ? await agents.create({
        sessionId: threadState.threadId,
        parentAgent,
        meta: { origin: 'subagent', parentSession: parentAgent.session.id },
        agentOptions,
        signal,
        setup,
      })
      : await agents.resume({
        resumeSessionId: threadState.threadId,
        parentAgent,
        agentOptions,
        signal,
        setup,
      })
  } catch (error) {
    if (agents.get(threadState.threadId) === undefined) runtime.mentorAgents.delete(threadState.threadId)
    throw error
  }
  runtime.handles.set(threadState.threadId, handle)
  runtime.mentorAgents.set(String(handle.agent.id), threadState)
  threadState.agent = handle.agent
  threadState.handle = handle
  return handle
}

async function readStoredSession(persistence, id) {
  if (typeof persistence.open === 'function') {
    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch (error) {
      if (isMissingRecord(error)) return undefined
      throw error
    }
    try {
      return { events: eventsFromRead(await handle.read()) }
    } finally {
      await handle.close?.()
    }
  }
  try {
    const inspection = typeof persistence.inspect === 'function'
      ? await persistence.inspect(id)
      : await persistence.load(id)
    return { events: eventsFromRead(inspection) }
  } catch (error) {
    if (isMissingRecord(error)) return undefined
    throw error
  }
}

async function releaseMentorHandle(ctx, runtime, threadId, handle) {
  if (runtime.handles.get(threadId) === handle) runtime.handles.delete(threadId)
  runtime.threads.delete(threadId)
  if (handle.borrowed) return
  try {
    await handle.dispose()
  } catch (error) {
    ctx.logger?.warn?.('mentor: failed to release idle child Agent %s: %s', threadId, error)
  } finally {
    runtime.mentorAgents.delete(String(handle.agent.id))
  }
}

function configureMentorAgent(agentCtx, threadState, adapters) {
  agentCtx.tools.presentAs('native')
  agentCtx.tools.restrict({ allow: [] })
  agentCtx.tools.guard(() => 'MENTOR_TOOL_VIOLATION: tools are disabled for Mentor')
  agentCtx.systemPrompt.section({
    name: 'mentor:system',
    order: 0,
    complete: true,
    text: MENTOR_SYSTEM_PROMPT,
  })
  agentCtx.systemPrompt.suppressRuntimeContext()

  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      sections: [{ name: 'mentor:system', text: MENTOR_SYSTEM_PROMPT }],
      contexts: [],
      tools: [],
      variables: {},
    }
  })
  agentCtx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages.filter((message) => threadState.pendingByMessageId.has(message.id))
    if (messages.length === 0) return { kind: 'reject' }
    return { ...decision, messages }
  })
  agentCtx.on('agent/inbox/claimed', ({ message, turn }) => {
    const operation = threadState.pendingByMessageId.get(message?.id)
    if (operation === undefined) return
    operation.turn = turn
    threadState.callsByTurn.set(turn, operation)
  })
  agentCtx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (String(agent?.id) !== threadState.threadId || frame === null || typeof frame !== 'object') return
    const kind = frame.type
    if (kind === 'start') {
      const operation = threadState.callsByTurn.get(frame.turn)
      if (operation === undefined) return
      const attempt = { operation, turn: frame.turn, step: frame.step }
      threadState.attempts.set(frame.attemptId, attempt)
      return
    }
    if (kind !== 'end') return
    const attempt = threadState.attempts.get(frame.attemptId)
    if (attempt === undefined) return
    threadState.attempts.delete(frame.attemptId)
    const operation = attempt.operation
    const outcome = frame.outcome
    if (outcome?.kind !== 'committed' || outcome.eventType !== 'assistant/message') {
      operation.failure ??= new Error('MENTOR_INCOMPLETE: no committed assistant message was produced')
      return
    }
    const event = readMessageEvent(agent.session, outcome.seq)
    if (event?.type !== 'assistant/message'
      || event.seq !== outcome.seq
      || event.data?.turn !== attempt.turn
      || event.data?.step !== attempt.step) {
      operation.failure = new Error('MENTOR_INCOMPLETE: committed assistant event did not match the active input')
      return
    }
    operation.usage = normalizeUsage(event.data.usage)
    const finish = adapters.lastAssistantStreamChunk?.(event.data.stream, 'finish')
      ?? lastFinishChunk(event.data.stream)
    if (finish?.reason?.kind !== 'stop') {
      operation.failure = new Error('MENTOR_INCOMPLETE: Mentor did not stop with a complete text reply')
      return
    }
    const message = extractAssistantText(event.data.message)
    if (message === '') {
      operation.failure = new Error('MENTOR_INCOMPLETE: the committed Mentor reply is empty')
      return
    }
    operation.reply = { message, usage: normalizeUsage(event.data.usage), turn: event.data.turn, step: event.data.step }
  })
  agentCtx.on('agent/request-error', () => undefined)
}

function lastFinishChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk ?? stream[index]
    if (chunk?.type === 'finish') return chunk
  }
  return undefined
}

async function recoverCanonicalResult(ctx, config, adapters, priorCall, parentSession) {
  const journalResult = copyCanonicalResult(priorCall.result)
  if (journalResult !== undefined) return journalResult
  const parentResult = resultForInvocation(parentSession.ownEvents(), priorCall.hostCallId)
  if (parentResult !== undefined) return parentResult
  const child = await readStoredSession(ctx.sessionPersistence, priorCall.threadId)
  if (child === undefined) return undefined
  return recoverReplyFromEvents(child.events, adapters, priorCall)
}

async function recoverReplyFromEvents(events, adapters, priorCall) {
  const recovered = extractSettledReply(events, priorCall.inputMessageId, adapters.lastAssistantStreamChunk)
  if (recovered === null) return undefined
  const revision = Number.isSafeInteger(priorCall.revision) ? priorCall.revision : 1
  return makeReply({
    threadId: priorCall.threadId,
    consultationId: priorCall.consultationId,
    revision,
    message: recovered.message,
    usage: recovered.usage,
  })
}


function createToolMetadata() {
  return {
    disposed: false,
    activeCount: 0,
    activeOperations: new Set(),
    activeByAgentId: new Map(),
    parentBusy: new Set(),
    waiting: [],
    shutdown: new AbortController(),
    inFlight: new Map(),
    threads: new Map(),
    handles: new Map(),
    mentorAgents: new Map(),
    rootDisposers: new Map(),
    nestedDisposers: new Map(),
  }
}

function isPrimaryAgent(agents, agent) {
  if (agent?.session?.header?.origin === 'subagent' || typeof agents?.roots !== 'function') return false
  return agents.roots().some((root) => root === agent)
}

function installForPrimaryAgent(ctx, config, runtime, adapters, agent) {
  if (!config.enabled || !isPrimaryAgent(ctx.agents, agent) || runtime.rootDisposers.has(String(agent.id))) return
  const agentCtx = agent.ctx
  if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
  const dispose = agentCtx.effect(() => {
    const disposers = []
    try {
      disposers.push(agentCtx.systemPrompt.section({
        name: 'tool:mentor',
        order: 3000,
        text: TOOL_DESCRIPTION,
      }))
      disposers.push(agentCtx.tools.register(makeCanonicalTool(ctx, config, runtime, adapters)))
      return () => {
        for (const disposeContribution of disposers.reverse()) disposeContribution()
      }
    } catch (error) {
      for (const disposeContribution of disposers.reverse()) disposeContribution()
      throw error
    }
  }, 'mentor: primary Agent tool')
  runtime.rootDisposers.set(String(agent.id), dispose)
}

function hideFromNestedAgent(ctx, runtime, agent) {
  const id = String(agent.id)
  if (runtime.nestedDisposers.has(id) || typeof agent.ctx?.effect !== 'function') return
  const dispose = agent.ctx.effect(() => {
    const disposers = []
    try {
      if (typeof agent.ctx.tools?.get === 'function') {
        try {
          if (agent.ctx.tools.get(TOOL_NAME, agent) !== undefined) {
            disposers.push(agent.ctx.tools.restrict({ deny: [TOOL_NAME] }))
          }
        } catch (error) {
          ctx.logger?.warn?.('mentor: could not hide the tool from nested Agent %s: %s', id, error)
        }
      }
      disposers.push(agent.ctx.systemPrompt.section({ name: 'tool:mentor', order: 3000, text: '' }))
      return () => {
        for (const disposeContribution of disposers.reverse()) disposeContribution()
      }
    } catch (error) {
      for (const disposeContribution of disposers.reverse()) disposeContribution()
      throw error
    }
  }, 'mentor: hide from nested Agent')
  runtime.nestedDisposers.set(id, dispose)
}

function mentorViewEnvelope(result, op = 'read', fields = {}) {
  return { v: VIEW_RESPONSE_VERSION, op, ...fields, result }
}

function connectionResult(value) {
  return { ok: true, value }
}

function connectionFailure(code = 'internal') {
  return { ok: false, error: { code, message: 'Mentor history request failed', details: {} } }
}

function decodeMentorViewRequest(value) {
  if (!isPlainRecord(value) || value.v !== VIEW_REQUEST_VERSION) return undefined
  // Session-scoped history read.
  if (value.op === 'read' && Object.keys(value).length === 3
    && typeof value.sessionId === 'string' && VIEW_SESSION_ID.test(value.sessionId)) {
    return { v: VIEW_REQUEST_VERSION, op: 'read', sessionId: value.sessionId }
  }
  // Global settings: no Session is involved.
  if (value.op === 'settings-read' && Object.keys(value).length === 2) {
    return { v: VIEW_REQUEST_VERSION, op: 'settings-read' }
  }
  if (value.op === 'settings-save'
    && (Object.keys(value).length === 3 || Object.keys(value).length === 4)
    && isPlainRecord(value.settings)
    && (value.revision === undefined || value.revision === null || Number.isSafeInteger(value.revision))) {
    return {
      v: VIEW_REQUEST_VERSION,
      op: 'settings-save',
      settings: value.settings,
      revision: Number.isSafeInteger(value.revision) ? value.revision : undefined,
    }
  }
  return undefined
}

async function readMentorHistory(ctx, config, adapters, runtime, request) {
  const parentAgent = ctx.agents.get(request.sessionId)
  if (!isPrimaryAgent(ctx.agents, parentAgent)) {
    return mentorViewEnvelope({ kind: 'unavailable' }, 'read', { sessionId: request.sessionId })
  }
  const parentSession = parentAgent.session
  await flushSession(ctx, parentSession)
  const journal = await readJournal(ctx, request.sessionId, adapters)
  const observed = await reconcileDeliveries(
    ctx,
    config,
    adapters,
    runtime,
    parentSession,
    projectJournal(journal.events),
    undefined,
    false,
    undefined,
  )
  const calls = [...observed.state.calls.values()].filter((call) =>
    call.status === 'settled' && call.generationSent !== false && copyCanonicalResult(call.result)?.kind === 'reply')
  const truncated = calls.length > MAX_VIEW_RECORDS
  const records = []
  const parentEvents = parentSession.ownEvents()
  for (const call of calls.slice(-MAX_VIEW_RECORDS).reverse()) {
    const invocation = findInvocation(parentEvents, call.hostCallId)
    if (invocation?.arguments === undefined) continue
    let input
    try {
      input = normalizeInput(parsePersistedArguments(invocation.arguments), { maxInputBytes: config.maxInputBytes })
    } catch {
      continue
    }
    const result = copyCanonicalResult(call.result)
    if (result?.kind !== 'reply') continue
    records.push({
      consultationId: result.consultation_id,
      threadId: result.thread_id,
      revision: result.context_revision,
      message: input.message,
      evidence: input.evidence.map(({ id, kind, source, content }) => ({ id, kind, source, content })),
      answer: result.message,
      deliveryStatus: call.deliveryStatus ?? 'pending',
    })
  }
  return mentorViewEnvelope({ kind: 'present', records, truncated }, 'read', { sessionId: request.sessionId })
}

function createMentorViewHandler(ctx, config, runtime, adapters) {
  return async (endpoint, payload, signal) => {
    const request = decodeMentorViewRequest(payload)
    if (endpoint !== VIEW_ENDPOINT || request === undefined) return connectionFailure('bad-request')
    if (signal?.aborted) return connectionFailure('aborted')
    try {
      if (request.op === 'read') return connectionResult(await readMentorHistory(ctx, config, adapters, runtime, request))
      if (request.op === 'settings-read') return connectionResult(mentorViewEnvelope(await readMentorSettings(ctx, config), 'settings-read'))
      if (request.op === 'settings-save') return connectionResult(await saveMentorSettings(ctx, config, request))
      return connectionFailure('bad-request')
    } catch {
      return connectionResult(mentorViewEnvelope({ kind: 'fault', code: 'read_failed' }, request.op))
    }
  }
}

async function handleMentorSharedApiRequest(request, handler) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body
  try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  const rpcId = typeof input?.rpcId === 'string' ? input.rpcId : 'invalid-request'
  if (input?.type !== 'client-request' || typeof input.rpcId !== 'string' || input.method !== VIEW_SHARED_API_ENDPOINT || !Object.hasOwn(input, 'payload')) {
    return Response.json({ type: 'server-response', rpcId, result: connectionFailure('bad-request') })
  }
  const result = await handler(VIEW_ENDPOINT, input.payload, request.signal)
  return Response.json({ type: 'server-response', rpcId, result })
}

function installMentorView(ctx, config, runtime, adapters) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  if (connection === undefined) return
  const handler = createMentorViewHandler(ctx, config, runtime, adapters)
  ctx.effect(() => {
    if (Reflect.has(connection, 'fetch')) {
      return connection.fetch.register({
        path: `/api/${VIEW_SHARED_API_ENDPOINT}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleMentorSharedApiRequest(request, handler),
      })
    }
    return connection.rpc.handle(VIEW_CHANNEL, handler, { authority: 'loopback' })
  }, 'mentor history view route')
}

function installCommands(ctx, config, runtime, adapters) {
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
  if (commands === undefined || typeof commands.register !== 'function') return
  ctx.effect(() => commands.register({
    name: 'mentor',
    description: 'View or reset the Mentor thread for the current primary Session.',
    input: { hint: 'status|reset' },
    recordInput: true,
    handler: async ({ agent, rawInput, signal }) => {
      const session = agent?.session
      if (session === undefined) return { kind: 'error', text: '当前没有可管理的主 Session。' }
      if (!isPrimaryAgent(ctx.agents, agent)) return { kind: 'error', text: 'Mentor 命令仅支持主 Agent Session。' }
      const action = String(rawInput ?? '').trim().toLowerCase()
      if (action === 'status') {
        const parentId = String(session.id)
        const busy = runtime.parentBusy.has(parentId)
        if (!busy) await flushSession(ctx, session)
        const journal = await readJournal(ctx, parentId, adapters)
        const initial = projectJournal(journal.events)
        const observed = busy
          ? { state: initial }
          : await reconcileDeliveries(ctx, config, adapters, runtime, session, initial, undefined)
        const state = observed.state
        let statusConfig = config
        if (config.enabled) {
          try { statusConfig = mentorRoute(config, await readModelCatalog(ctx)) } catch {}
        }
        const calls = [...state.calls.values()]
        const active = state.activeThread?.threadId ?? '无'
        const used = spentGenerations(state)
        const attempted = calls.filter((call) => call.generationSent !== false && (call.status === 'dispatched' || call.status === 'settled' || call.status === 'indeterminate'))
        const reported = attempted.filter((call) => Number.isSafeInteger(call.usage?.input_tokens) && Number.isSafeInteger(call.usage?.output_tokens))
        const uncertain = attempted.length - reported.length
        const deliveryPending = new Set(calls.filter((call) => call.status === 'settled' && call.deliveryStatus === 'pending').map((call) => call.consultationId)).size
        const deliveryFailed = new Set(calls.filter((call) => call.deliveryStatus === 'undelivered').map((call) => call.consultationId)).size
        const inputTokens = reported.reduce((sum, call) => sum + call.usage.input_tokens, 0)
        const outputTokens = reported.reduce((sum, call) => sum + call.usage.output_tokens, 0)
        const route = config.enabled ? `${statusConfig.provider}/${statusConfig.model}` : 'disabled'
        const usage = reported.length > 0
          ? `reported tokens: ${inputTokens} in / ${outputTokens} out (${reported.length} generation(s)); usage unknown/partial: ${uncertain}`
          : `usage unknown/partial: ${uncertain}`
        return {
          kind: 'success',
          text: `Mentor ${config.enabled ? '已启用' : '未启用'}；路由：${route}；线程：${active}；已派发生成：${used} 次（无上限，仅在 journal 记录）；${usage}；结果待确认：${deliveryPending}；未送达：${deliveryFailed}；费用估算未配置。`,
        }
      }
      if (action === 'reset') {
        const parentId = String(session.id)
        // Match tool scheduling so reset is a FIFO barrier between submitted consultations.
        await Promise.resolve()
        const release = await acquireConsultation(runtime, parentId, signal)
        try {
          if (runtime.disposed) throw new Error('Mentor plugin stopped')
          if (signal?.aborted) throw signal.reason
          const journal = await readJournal(ctx, parentId, adapters, { create: true })
          const state = projectJournal(journal.events)
          if (runtime.disposed) throw new Error('Mentor plugin stopped')
          if (signal?.aborted) throw signal.reason
          await appendJournal(ctx, parentId, adapters, 'thread-reset', {
            threadId: state.activeThread?.threadId ?? null,
            epoch: state.epoch + 1,
          }, signal)
          if (state.activeThread !== null) {
            const handle = runtime.handles.get(state.activeThread.threadId)
            runtime.handles.delete(state.activeThread.threadId)
            runtime.threads.delete(state.activeThread.threadId)
            if (handle !== undefined) await handle.dispose()
          }
          return { kind: 'success', text: 'Mentor 线程已封存并重置。历史记录与已记录指标保留；下一次咨询会创建空线程。' }
        } finally {
          release()
        }
      }
      return { kind: 'error', text: '用法：/mentor status 或 /mentor reset。' }
    },
  }), 'mentor: command')
}

// Live-editable schema fields arrive as lazy volatile wrappers; the runtime
// wants plain values.
export function plainConfig(value) {
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    if (typeof value.get === 'function') return plainConfig(value.get())
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

// This plugin owns its Settings > Plugins card, so it opts out of the generic
// schema-generated form for its own row.
function installSettingsPresentation(ctx) {
  const settings = settingsService(ctx)
  if (typeof settings?.configure !== 'function') return
  try {
    ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'mentor: profile config form')
  } catch (error) {
    ctx.logger?.warn?.('mentor: could not claim the profile configuration form: %s', error)
  }
}

export function installMentor(ctx, rawConfig, adapters) {
  const config = normalizedConfig(plainConfig(rawConfig))
  const runtime = createToolMetadata()
  installSettingsPresentation(ctx)
  if (config.enabled) {
    const attachAgent = (agent) => {
      try {
        if (isPrimaryAgent(ctx.agents, agent)) installForPrimaryAgent(ctx, config, runtime, adapters, agent)
        else hideFromNestedAgent(ctx, runtime, agent)
      } catch (error) {
        ctx.logger?.warn?.('mentor: could not compose tools for Agent %s: %s', agent?.id, error)
      }
    }
    const agents = typeof ctx.agents.list === 'function' ? ctx.agents.list() : ctx.agents.roots()
    for (const agent of agents) attachAgent(agent)
    ctx.on('agent/created', ({ agent }) => attachAgent(agent))
  }
  installCommands(ctx, config, runtime, adapters)
  installMentorView(ctx, config, runtime, adapters)

  ctx.on('llm/stream', (options, next) => {
    const threadState = runtime.mentorAgents.get(String(options.sessionId ?? ''))
    if (threadState === undefined) return next()
    const operation = runtime.activeByAgentId.get(String(options.sessionId))
    if (operation === undefined) throw new Error('MENTOR_EXTRA_GENERATION: no explicit Mentor consultation owns this request')
    if (operation.requestCount >= 1) throw new Error('MENTOR_EXTRA_GENERATION: one model request is allowed per consultation')
    if (options.purpose !== undefined) throw new Error('MENTOR_EXTRA_GENERATION: auxiliary model requests are disabled')
    const mentorConfig = threadState.config
    if (options.provider !== mentorConfig.provider || options.model !== mentorConfig.model) throw new Error('MENTOR_ROUTE_VIOLATION: Mentor route is fixed by trusted plugin configuration')
    if (mentorConfig.reasoningEffort !== undefined && options.reasoningEffort !== mentorConfig.reasoningEffort) throw new Error('MENTOR_ROUTE_VIOLATION: reasoning effort is fixed by trusted plugin configuration')
    if (options.tools !== undefined && options.tools.length > 0) throw new Error('MENTOR_TOOL_VIOLATION: final DSH request contains tools')
    if (options.system !== undefined) throw new Error('MENTOR_PROMPT_VIOLATION: unexpected one-shot system field')

    const requestMessages = options.messages
    const systemMessage = requestMessages?.[0]
    if (systemMessage?.role !== 'system' || !isExactTextMessage(systemMessage, MENTOR_SYSTEM_PROMPT)) {
      throw new Error('MENTOR_PROMPT_VIOLATION: leading DSH system message is not the Mentor prompt')
    }
    const recorded = threadState.agent.session.deriveMessages()
    // DSH 0.2.1 keeps its own `working-directory:current` snapshot in the Agent
    // surface even under `suppressRuntimeContext()`, so that recorded DSH message
    // reaches the outgoing request too. Drop exactly the runtime-context messages
    // the child session already recorded, then compare the rest positionally.
    // Anything unrecorded, or recorded under any other source, still fails closed.
    const recordedContextIds = new Set(recorded.filter((message) => isRuntimeContextMessage(message)).map((message) => message.id))
    const isRecordedRuntimeContext = (message) => isRuntimeContextMessage(message) && recordedContextIds.has(message?.id)
    const recordedHistory = recorded.filter((message) => !isRecordedRuntimeContext(message))
    const requestedHistory = Array.isArray(requestMessages)
      ? requestMessages.filter((message) => !isRecordedRuntimeContext(message))
      : undefined
    const historyMessages = requestedHistory?.length === recordedHistory.length
      ? requestedHistory
      : requestedHistory?.length === recordedHistory.length + 1 ? requestedHistory.slice(1) : undefined
    if (historyMessages === undefined) throw new Error('MENTOR_CONTEXT_VIOLATION: request messages differ from the Mentor session history')
    for (let index = 0; index < recordedHistory.length; index += 1) {
      const message = historyMessages[index]
      if (message?.id !== recordedHistory[index]?.id || message.role !== recordedHistory[index]?.role) {
        throw new Error('MENTOR_CONTEXT_VIOLATION: request includes unrecorded message content')
      }
      if (message.role === 'user' && message.source?.kind !== PLUGIN_ID) {
        throw new Error('MENTOR_CONTEXT_VIOLATION: only explicit Mentor inputs may reach the model')
      }
      if (message.role === 'user' && message.id === operation.messageId && extractTextContent(message) !== operation.expectedInputText) {
        throw new Error('MENTOR_CONTEXT_VIOLATION: the submitted input was altered before provider dispatch')
      }
      if (message.role === 'assistant' && (message.source?.kind !== 'model'
        || message.source.provider !== mentorConfig.provider
        || message.source.model !== mentorConfig.model)) {
        throw new Error('MENTOR_CONTEXT_VIOLATION: child history contains an unexpected assistant route')
      }
    }
    if (!historyMessages.some((message) => message?.id === operation.messageId)) {
      throw new Error('MENTOR_CONTEXT_VIOLATION: explicit consultation input is absent from the request')
    }
    // ponytail: record the conservative serialized-byte size of the dispatched
    // request; the plugin no longer caps context, output, or reply size.
    const contextUpperBoundBytes = promptUpperBound(options.system, requestMessages)

    operation.requestCount += 1
    return (async function* mentorStream() {
      if (operation.controller.signal.aborted) throw operation.controller.signal.reason
      await flushSession(ctx, threadState.agent.session)
      await appendJournal(ctx, operation.parentSessionId, adapters, 'consultation-dispatched', {
        hostCallId: operation.callId,
        contextMeasureMode: 'serialized-json-utf8-upper-bound',
        ...(Number.isFinite(contextUpperBoundBytes) ? { contextUpperBoundBytes } : {}),
        ...(Number.isSafeInteger(options.maxTokens) ? { requestMaxTokens: options.maxTokens } : {}),
      }, operation.controller.signal)
      operation.dispatched = true
      const stream = next()
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'tool-call-delta' || (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call')) {
            operation.failure = new Error('MENTOR_TOOL_VIOLATION: provider emitted an unexpected tool call')
            threadState.agent.cancel({ kind: 'hook', reason: 'Mentor tool-call violation' })
            throw operation.failure
          }
          if (chunk?.type === 'finish'
            && chunk.reason?.kind === 'error'
            && chunk.reason.failure?.code === 'NO_ADAPTER') {
            await markAbortedBeforeProvider(ctx, mentorConfig, adapters, operation, 'configured provider route is unavailable')
          }
          yield chunk
        }
      } catch (error) {
        // Keep the first provider failure even if AgentLoop contains it or attempts another request.
        operation.failure ??= error
        if (operation.dispatched && error?.code === 'NO_ADAPTER') {
          await markAbortedBeforeProvider(ctx, mentorConfig, adapters, operation, error.message)
        }
        throw error
      }
    })()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    const rootDispose = runtime.rootDisposers.get(String(agent.id))
    if (rootDispose !== undefined) {
      runtime.rootDisposers.delete(String(agent.id))
      try { rootDispose() } catch (error) {
        ctx.logger?.warn?.('mentor: failed to remove root Agent tool for %s: %s', agent.id, error)
      }
    }
    const nestedDispose = runtime.nestedDisposers.get(String(agent.id))
    if (nestedDispose !== undefined) {
      runtime.nestedDisposers.delete(String(agent.id))
      try { nestedDispose() } catch (error) {
        ctx.logger?.warn?.('mentor: failed to remove nested Agent restriction for %s: %s', agent.id, error)
      }
    }
    const handle = runtime.handles.get(String(agent.id))
    if (handle?.agent === agent) runtime.handles.delete(String(agent.id))
    runtime.mentorAgents.delete(String(agent.id))
  })

  ctx.effect(() => () => {
    runtime.disposed = true
    runtime.shutdown.abort(new Error('Mentor plugin stopped'))
    const mentorAgents = new Set([...runtime.mentorAgents.values()].map((thread) => thread.agent).filter(Boolean))
    for (const operation of runtime.activeOperations) {
      operation.controller.abort(new Error('Mentor plugin stopped'))
      mentorAgents.add(operation.agent)
    }
    for (const agent of mentorAgents) agent.cancel({ kind: 'disposed' })
    return Promise.all([...mentorAgents].map(async (agent) => {
      try { await agent.whenIdle() } catch {}
    })).then(async () => {
      for (const handle of runtime.handles.values()) {
        try { await handle.dispose() } catch (error) {
          ctx.logger?.warn?.('mentor: failed to dispose a child Agent: %s', error)
        }
      }
      for (const dispose of runtime.nestedDisposers.values()) {
        try { dispose() } catch (error) {
          ctx.logger?.warn?.('mentor: failed to remove a nested Agent restriction: %s', error)
        }
      }
      runtime.nestedDisposers.clear()
      for (const dispose of runtime.rootDisposers.values()) {
        try { dispose() } catch (error) {
          ctx.logger?.warn?.('mentor: failed to remove a root Agent tool: %s', error)
        }
      }
      runtime.rootDisposers.clear()
      runtime.handles.clear()
      runtime.mentorAgents.clear()
    })
  }, 'mentor: lifecycle')

  return runtime
}

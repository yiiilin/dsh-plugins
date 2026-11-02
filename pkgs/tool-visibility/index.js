/**
 * Per-tool Agent Preset visibility.
 *
 * A host-plane row contributes its tools to an ANCESTOR layer of every Agent, so
 * one deployment-wide plugin (ds-bot registers `list_bots`, `message_bot`,
 * `ask_user`, …) reaches every Session in the profile — including Sessions that
 * can never use them: those tools are gated internally to Bot chats and answer an
 * ordinary Session with a refusal. They still cost their schema on every request.
 *
 * This module lets a tool DECLARE the presets that may see it. A tool with no
 * declaration keeps the behaviour it had before this plugin existed — visible
 * everywhere — so installing it never silently removes a tool the deployment did
 * not name.
 *
 * Two layers, matching how the platform itself models the difference:
 *
 * - `systemPrompt.tools()` trims the model-facing catalog, so a hidden tool does
 *   not cost schema tokens. The provider receives only an opaque `ScopeKey`, so
 *   this module records each Agent's preset when the Agent is created and reads
 *   it back on every assembly. Nothing here may throw in the way of a request: a
 *   failing provider breaks every turn, not one tool, so resolution is total and
 *   falls back to "unfiltered".
 * - `tools.restrict({ deny })` makes a hidden tool genuinely uncallable rather
 *   than merely absent from the catalog. `restrict()` throws on an unknown name
 *   and on an unscoped context, so the deny list is intersected with what the
 *   Agent actually inherits before it is applied.
 *
 * @module @yiln-dsh/dsh-tool-visibility
 */
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'

/** Stable Cordis plugin name. */
export const name = 'tool-visibility'

/** Host services this module reads. */
export const inject = ['tools', 'agents', 'agentPresets', 'systemPrompt']

export const Config = z.object({
  /**
   * Tool name -> the Agent Preset ids that may see it. A tool named here is
   * hidden from every other preset; a tool not named here is left alone.
   * `allowAll` on one entry opts that tool back out without deleting the entry.
   */
  tools: z
    .dict(
      z.object({
        presets: z.array(z.string()).default([]),
        /** Show this tool to every preset, overriding `presets`. */
        allowAll: z.boolean().default(false),
      }),
    )
    .default({}),
  /** Write one informational line per Agent whose catalog was trimmed. */
  verbose: z.boolean().default(false).volatile(),
})

/**
 * Build the tool -> allowed-presets map once, so the hot path is a plain lookup.
 *
 * A tool whose preset list is empty would be visible nowhere, which always reads
 * as a configuration mistake, so it is treated as unlisted rather than as a
 * silent global hide.
 *
 * @param raw - the validated config's `tools`.
 * @returns tool name -> the preset ids allowed to see it.
 */
export function compileRules(raw) {
  /** @type {Map<string, Set<string>>} */
  const restricted = new Map()
  for (const [tool, policy] of Object.entries(raw ?? {})) {
    if (typeof tool !== 'string' || tool.length === 0) continue
    if (policy?.allowAll === true) continue
    const presets = new Set(
      (Array.isArray(policy?.presets) ? policy.presets : []).filter(
        (entry) => typeof entry === 'string' && entry.length > 0,
      ),
    )
    if (presets.size > 0) restricted.set(tool, presets)
  }
  return restricted
}

/**
 * Decide the tool names one Agent must not see.
 *
 * @param restricted - tool name -> allowed preset ids.
 * @param presetId - the Agent's composed preset, when bound.
 * @returns names to hide, in configuration order.
 */
export function hiddenFor(restricted, presetId) {
  if (presetId === undefined) return []
  const hidden = []
  for (const [tool, allowed] of restricted) {
    if (!allowed.has(presetId)) hidden.push(tool)
  }
  return hidden
}

/** Read a context's session id, tolerating a partially built Agent. */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return id === undefined || id === null ? undefined : String(id)
}

export function apply(ctx, config) {
  const restricted = compileRules(config?.tools)
  if (restricted.size === 0) return

  const log = config?.verbose === true ? (message) => ctx.logger?.info?.(message) : () => {}

  // Session id and scope key both address the same live Agent, and the provider
  // is handed only the scope. Keeping both avoids a linear Agent scan per
  // assembly and keeps the mapping when a blank Session changes preset.
  /** @type {Map<string, string>} */
  const presetBySession = new Map()
  /** @type {Map<object, string>} */
  const sessionByScope = new Map()
  /** Session id -> the exact disposer that lifts this module's restriction. */
  const restrictedSessions = new Map()

  /** Record an Agent's preset under both handles it will be looked up by. */
  const remember = (agent) => {
    const id = sessionIdOf(agent)
    if (id === undefined) return undefined
    let presetId
    try {
      presetId = ctx.agentPresets.composedPreset(agent.ctx)
    } catch {
      // An unbound or already disposed Agent has no preset to decide on.
      presetId = undefined
    }
    if (presetId === undefined) {
      presetBySession.delete(id)
      return undefined
    }
    presetBySession.set(id, presetId)
    const key = scopeOf(agent.ctx)
    if (key !== undefined) sessionByScope.set(key, id)
    return presetId
  }

  /**
   * Hide the tools this Agent's preset may not see.
   *
   * `restrict()` refuses an unknown name, so the decision is intersected with
   * what the Agent actually inherits; a name this deployment never mounted is
   * not an error.
   */
  const restrictAgent = (agent, presetId) => {
    const id = sessionIdOf(agent)
    if (id === undefined || presetId === undefined) return
    const hidden = hiddenFor(restricted, presetId)
    // Departing a matching preset must give the tools back.
    if (hidden.length === 0) {
      restrictedSessions.get(id)?.()
      restrictedSessions.delete(id)
      return
    }
    if (restrictedSessions.has(id)) return
    const tools = agent.ctx?.tools
    if (typeof tools?.restrict !== 'function') return
    try {
      const served = new Set(
        (typeof tools.schemas === 'function' ? tools.schemas(agent) : []).map((schema) => schema?.name),
      )
      const deny = hidden.filter((tool) => served.has(tool))
      if (deny.length === 0) return
      restrictedSessions.set(id, tools.restrict({ deny }))
      log(`tool-visibility: preset "${presetId}" agent ${id} hides ${deny.join(', ')}`)
    } catch (error) {
      // A policy failure must never take down Agent creation.
      ctx.logger?.warn?.(
        `tool-visibility: agent ${id} runs preset "${presetId}" but cannot be restricted (${error}); its catalog is still trimmed`,
      )
    }
  }

  const syncAgent = (agent) => {
    const presetId = remember(agent)
    restrictAgent(agent, presetId)
  }

  // The catalog provider. Every failure mode returns "unfiltered": a throwing
  // provider fails the whole prompt assembly, which turns a wrong visibility
  // rule into a broken Session.
  ctx.systemPrompt.tools((context) => {
    let schemas
    try {
      schemas = ctx.tools.schemas(context.scope)
    } catch (error) {
      // The registry failing is this module's fallback obligation too: return
      // nothing rather than letting one bad pass fail the turn.
      ctx.logger?.warn?.(`tool-visibility: catalog read failed (${error}); contributing no schemas`)
      return { schemas: [] }
    }
    try {
      if (context.scope === undefined) return { schemas }
      const id = sessionByScope.get(context.scope)
      const presetId = id === undefined ? undefined : presetBySession.get(id)
      if (presetId === undefined) return { schemas }
      const hidden = new Set(hiddenFor(restricted, presetId))
      if (hidden.size === 0) return { schemas }
      return { schemas: schemas.filter((schema) => !hidden.has(schema?.name)) }
    } catch (error) {
      ctx.logger?.warn?.(`tool-visibility: catalog pass failed (${error}); tools stay visible`)
      return { schemas }
    }
  })

  const guard = (agent) => {
    try {
      syncAgent(agent)
    } catch (error) {
      ctx.logger?.warn?.(`tool-visibility: could not evaluate ${sessionIdOf(agent)}: ${error}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => guard(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const id = sessionIdOf(agent)
    if (id === undefined) return
    presetBySession.delete(id)
    const key = scopeOf(agent.ctx)
    if (key !== undefined) sessionByScope.delete(key)
    restrictedSessions.get(id)?.()
    restrictedSessions.delete(id)
  })
  // A blank Session may change preset, and the registry announces that with
  // `tools/change`; re-resolve so a newly matching Agent is restricted and a
  // departing one is freed. `guard` is idempotent through `restrictedSessions`.
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.list()) guard(agent)
  })
  // Agents that already existed when this row activated still need the policy.
  for (const agent of ctx.agents.list()) guard(agent)

  ctx.effect(() => () => {
    for (const dispose of restrictedSessions.values()) dispose()
    restrictedSessions.clear()
    presetBySession.clear()
    sessionByScope.clear()
  }, 'tool-visibility: lift every restriction')
}

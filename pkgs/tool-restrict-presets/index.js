/**
 * Deny every model-facing tool to Agents that run a named Agent Preset.
 *
 * A preset decides only its own layer. The host composition contributes its
 * tools to an ancestor layer, and `agent-preset-registry` binds each Agent's
 * scope as a CHILD of its preset's scope, so a row declared inside a preset
 * cannot shed the tools it inherits from above. The `mentor` preset proved it:
 * its persona says "You do not have tools", while the spawned child received 40
 * host-plane tools (including `create_bot`, `stop_bot`, `remember` and
 * `work_journal`).
 *
 * This module is the missing half. It runs on the Host plane and applies
 * `agent.ctx.tools.restrict({ allow: [] })` to each Agent whose preset id is
 * listed, which is the same mechanism `session-mode` already uses to prune the
 * restricted Lead's catalog. Two of that mechanism's properties are load-bearing
 * here:
 *
 * - A restriction masks what a scope INHERITS — the global layer and every
 *   ancestor layer — and never what the scope's own layer registers. A
 *   delegation runtime registers capabilities such as `structured_output`
 *   through `childCtx.tools.register`, so an empty allow-list hides everything
 *   inherited without stripping the machinery a child answers through.
 * - An unscoped Agent cannot be restricted; `restrict()` throws. That throw is
 *   the check, so an unusual Agent is reported and left alone instead of failing
 *   the composition.
 *
 * @module @yiln-dsh/dsh-tool-restrict-presets
 */

import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'tool-restrict-presets'

/** Host services this module reads. */
export const inject = ['tools', 'agents', 'agentPresets']

export const Config = z.object({
  /** Agent Preset ids whose Agents inherit no model-facing tool at all. */
  presets: z.array(z.string()).default([]),
  /** Write one informational line per Agent whose preset matched. */
  verbose: z.boolean().default(false).volatile(),
})

/**
 * Apply the empty allow-list to one Agent when its preset is listed, and lift a
 * previous restriction when it no longer is.
 *
 * The preset is re-resolved on every pass rather than cached, so a blank
 * Session's preset change is honoured: the restriction always reflects the
 * composition the Agent is running now.
 *
 * @param ctx - the plugin context.
 * @param agent - the live Agent to inspect.
 * @param presets - matched preset ids.
 * @param track - session id -> restriction disposer.
 * @param log - one-line informational logger.
 */
export function syncAgent(ctx, agent, presets, track, log) {
  const id = String(agent.session.id)
  let presetId
  try {
    presetId = ctx.agentPresets.composedPreset(agent.ctx)
  } catch {
    // Unbound or already disposed; nothing to decide.
    return
  }
  if (presetId === undefined || !presets.includes(presetId)) {
    // Departing the preset must release the tools again.
    track.get(id)?.()
    track.delete(id)
    return
  }
  if (track.has(id)) return
  const tools = agent.ctx?.tools
  if (typeof tools?.restrict !== 'function') return
  try {
    track.set(id, tools.restrict({ allow: [] }))
    log(`tool-restrict-presets: preset "${presetId}" agent ${id} now inherits no tools`)
  } catch (error) {
    // An unscoped Agent cannot be restricted: report, never fail the Agent.
    ctx.logger?.warn?.(
      `tool-restrict-presets: agent ${id} runs preset "${presetId}" but cannot be restricted (${error}); its tools stay available`,
    )
  }
}

export async function apply(ctx, config) {
  // The Loader validates `config` through `Config`, but a direct caller may pass
  // nothing, so the default is applied here too.
  const presets = [...new Set((config?.presets ?? []).filter((entry) => typeof entry === 'string' && entry.length > 0))]
  if (presets.length === 0) return
  const track = new Map()
  const log = config?.verbose === true ? (message) => ctx.logger?.info?.(message) : () => {}

  const guard = (agent) => {
    try {
      syncAgent(ctx, agent, presets, track, log)
    } catch (error) {
      // A policy failure must never take down Agent creation.
      ctx.logger?.warn?.(`tool-restrict-presets: could not evaluate ${String(agent?.session?.id)}: ${error}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => guard(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.session.id)
    track.get(id)?.()
    track.delete(id)
  })
  // A blank Session may change preset, and the registry announces that with
  // `tools/change`; re-resolve so a newly matching Agent is restricted and a
  // departing one is freed. `guard` is idempotent through `track`.
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.list()) guard(agent)
  })
  // Agents that already existed when this row activated still need the policy.
  for (const agent of ctx.agents.list()) guard(agent)

  ctx.effect(() => () => {
    for (const dispose of track.values()) dispose()
    track.clear()
  }, 'tool-restrict-presets: lift every restriction')
}

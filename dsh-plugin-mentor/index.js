import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { installMentor } from './lib/mentor.js'

export const name = 'mentor'
export const inject = [
  'tools',
  'agents',
  'agentLoop',
  'commands',
  'connection',
  'sessions',
  'sessionPersistence',
  'sessionController',
  'settings',
  'systemPrompt',
]

// The whole deployment shares one Mentor configuration: this row is the global
// settings page's storage, and every volatile field is editable from
// Settings > Plugins while `maxInputBytes` stays an ordinary config value.
// Generation/input/context/output/reply caps do not exist; the plugin records
// the measured values in its journal.
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  requestTimeoutMs: z.natural().default(300000).volatile(),
  globalConcurrency: z.natural().default(2).volatile(),
  maxInputBytes: z.natural().default(98304),
})

// NO default export: the Cordis Loader normalizes a module with
// `exports.default ?? exports` and then reads `Config`/`inject`/`name` off that
// value, so a default export would hide the schema that makes this row's
// settings editable.
export function apply(ctx, config = {}) {
  return installMentor(ctx, config, {
    defineTool,
    freezeMessage,
    sessionFormatVersion: SESSION_FORMAT_VERSION,
    createId: (prefix) => `${prefix}${randomUUID()}`,
  })
}

apply.inject = inject

import z from '@deepseek-ai/schemastery'
import { DEFAULT_ALLOWED_TOOLS, NORMAL_PROMPT, DELEGATE_WRITES_PROMPT } from './policy.js'
import { installSessionMode } from './runtime.js'

export const name = 'session-mode'
export const inject = ['tools', 'agents', 'commands', 'connection', 'systemPrompt', 'sessionController', 'jobs', 'sessions']
export const Config = z.object({
  defaultMode: z.union([z.const('normal'), z.const('delegate-writes')]).default('normal'),
  normalPrompt: z.string().default(NORMAL_PROMPT).volatile(),
  delegateWritesPrompt: z.string().default(DELEGATE_WRITES_PROMPT).volatile(),
  mainAllowedTools: z.array(z.string()).default([...DEFAULT_ALLOWED_TOOLS]),
  stateDir: z.string().default(''),
})

export async function apply(ctx, config) {
  await installSessionMode(ctx, config)
}

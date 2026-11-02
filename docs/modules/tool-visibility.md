# tool-visibility

Standalone package [`@yiln-dsh/dsh-tool-visibility`](../../pkgs/tool-visibility). Loader row: `tool-visibility`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/tool-visibility"
```

Lets a tool declare the Agent Presets that may see it, so a host-plane plugin's
tools stop reaching Sessions that can never use them.

## The problem it solves

A host-plane row contributes its tools to an **ancestor** layer of every Agent,
and a preset cannot mask them. `ds-bot` registers 25 model-facing tools
(`list_bots`, `message_bot`, `ask_user`, `remember`, …) into that shared layer,
but each one is gated internally to Bot and group Sessions: an ordinary GUI
Session calling `recall` gets

```
Only Bots on the team keep a memory.
```

The tools are unusable there, yet their schemas ride on every request. A
measured `yiln` Session carried 108 tools / 106 823 bytes of schema, and this
family alone was ≈5 593 tokens.

Deleting them is not an option: the Bot Sessions need them. Denying them per
preset works but inverts the maintenance — every new ds-bot tool leaks again.
This package lets the deployment name the tool once, in one place.

## How it works

Two layers, matching how the platform itself splits the concern.

### Catalog trimming (`systemPrompt.tools`)

`dsh-tools` publishes the model-facing catalog through
`ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`. This
module appends its own provider to that same list and drops the tools the
current Agent's preset may not see, so a hidden tool costs no schema tokens.

The provider receives only an opaque `ScopeKey` (`ScopeKey = object`), while
`agentPresets.composedPreset()` takes a `Context`. The mapping is therefore
recorded at `agent/created` through the platform's own `scopeOf()` and read back
by scope key per assembly. This is the same `agent.ctx` → scope read that
`delegate-mode` performs.

**Every failure in this layer returns the unfiltered catalog.** A provider that
throws fails every prompt assembly, which would turn one wrong visibility rule
into a broken Session — a far worse outcome than showing a tool that should have
been hidden. Both the registry read and the rule resolution are total.

### Execution denial (`tools.restrict`)

Trimming the catalog only hides a tool; it does not stop an execution. The same
decision is applied as `granted: deny`, via `agent.ctx.tools.restrict({ deny })`.

Two properties of `restrict()` shape that call:

- **Names are validated.** An unknown global name throws. A rule may name a tool
  this deployment never mounted, so the deny list is intersected with what the
  Agent actually inherits.
- **The context must be scoped.** A context-global call throws. The restriction
  therefore hangs off `agent/created`, and an Agent that cannot be restricted is
  reported at warn level and left with its catalog still trimmed.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `tools` | `{}` | Tool name → `{ presets: string[], allowAll?: boolean }`. A tool named here is hidden from every preset not listed. |
| `verbose` | `false` | One informational line per Agent whose policy applied. |

**A tool with no entry keeps the visibility it had before this plugin existed.**
That default is deliberate: an allow-list model would silently remove every tool
the deployment forgot to name, including tools a later plugin installs. A tool
whose `presets` list is empty is treated as unlisted rather than as a global
hide, because "visible nowhere" always reads as a configuration mistake.

```yaml
- id: tool-visibility
  config:
    tools:
      list_bots: { presets: [standard] }
      message_bot: { presets: [standard] }
```

## Scope

This changes only model-facing tool visibility. It does not change a persona,
prompt, model route, sandbox or approval policy, and it never touches an Agent
whose preset does not appear in any rule.

It also cannot identify a Bot Session. Rules are matched by preset id, so a
preset shared by Bot and GUI Sessions — `standard` is both — cannot separate
them. Distinguishing "is this Session a Bot" needs `ds-bot`'s internal
`isBotSession`, which is not a Host service.

## Verification

`npm test` covers the catalog layer, the execution layer and the interactions
that are easy to regress: an undeclared tool staying visible, a rule naming a
tool the deployment never mounted, a preset change lifting and re-applying the
restriction, disposal releasing exactly once, and a throwing catalog pass
falling back instead of failing the turn. Fake Agents carry a **real** scope
minted by `createScope`, so the lookup is exercised through the same `scopeOf()`
the runtime uses.

# tool-restrict-presets

Standalone package [`@yiln-dsh/dsh-tool-restrict-presets`](../../pkgs/tool-restrict-presets). Loader row: `tool-restrict-presets`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/tool-restrict-presets"
```

See the [root README](../../README.md) for the workspace layout, migration and testing.

Denies every model-facing tool to Agents that run a named Agent Preset, so a
preset whose persona promises a tool-less child actually gets one.

## The problem it solves

An Agent Preset contributes **its own layer** to an Agent's composition. It does
not own the layers above it, and `agent-preset-registry` binds each Agent's scope
as a **child** of its preset's scope. Host-plane rows — the shipped bundles, a
deployment's own patch layer, optional bundles such as free search or Agent
Teams — contribute their tools to those ancestor layers, and a preset cannot mask
them.

The `mentor` preset is the recorded case. Its persona opens with:

> You are a mentor: … You do not have tools, and you cannot inspect files,
> search, run code, or observe anything outside this conversation.

The spawned child received **40** host-plane tools anyway, including
`create_bot`, `stop_bot`, `remember`, `work_journal` and `session_search`. The
prompt was false about the Agent's actual capabilities.

## How it works

`tools.restrict({ allow: [] })` masks the tools a scope **inherits** — the global
layer plus every ancestor layer on its chain — and deliberately never what the
scope's own layer registers. Applying it to `agent.ctx` is therefore exactly the
lever this needs, and it is the same mechanism `session-mode` uses to prune the
restricted Lead's catalog.

Two properties of that mechanism are load-bearing:

- **The Agent's own layer stays exempt.** A delegation runtime registers
  capabilities such as `structured_output` through `childCtx.tools.register`, so
  an empty allow-list hides everything inherited without stripping the machinery
  a child answers through.
- **An unscoped Agent cannot be restricted.** `restrict()` throws on a
  context-global call. Such an Agent is reported at warn level and left with its
  tools rather than failing the composition.

The preset is re-resolved on every pass instead of cached at attach time, so a
blank Session that changes preset is handled: `tools/change` re-runs the policy,
which restricts a newly matching Agent and releases one that left.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `presets` | `[]` | Agent Preset ids whose Agents inherit no model-facing tool. Empty mounts the module inert. |
| `verbose` | `false` | Write one informational line per Agent whose preset matched. |

The shipped row defaults `presets` to empty on purpose: a preset id is a
deployment fact, so the profile patch enables the ids that deployment cares
about.

```yaml
- id: tool-restrict-presets
  config:
    presets:
      - mentor
```

## Scope

This removes **model-facing tools** only. It does not change the persona, the
prompt, the model route, the sandbox policy or the approval policy, and it does
not touch Agents on any other preset. A preset still cannot shed a non-tool
contribution from an ancestor layer; that remains a separate problem.

## Verification

`pkgs/tool-restrict-presets/test/apply.test.js` covers the mount contract, the
restriction itself, the unlisted-preset and empty-list paths, preset departure,
single-release on disposal, mount-time backfill, unload, the unscoped-Agent
warning and config normalization.

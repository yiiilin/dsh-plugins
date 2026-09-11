# @yiln-dsh/dsh-plugin-llm-adapter

A local fork of DSH's `@deepseek-ai/dsh-llm-pi-ai` adapter. It keeps the original provider routes, including `sub2api-gpt`, and adds per-model defaults for OpenAI Responses `serviceTier` and Harness `reasoningEffort`, plus an optional per-model argument cleanup for models that answer with every advertised tool property filled in.

This package is the replacement for the temporary `sub2api-gpt-fast` route. The user-facing model selector and Settings → Models page continue to use one provider:

```text
sub2api-gpt / gpt-5.6-luna
sub2api-gpt / gpt-5.6-terra
sub2api-gpt / gpt-5.6-sol
```

## Model configuration

Each model may carry these optional fields in `$DSH_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    sub2api-gpt:
      models:
        - id: gpt-5.6-luna
          reasoningEffort: max
          serviceTier: priority
          dropArgumentFillers: true
        - id: gpt-5.6-terra
          reasoningEffort: high
          serviceTier: default
        - id: gpt-5.6-sol
          reasoningEffort: low
          serviceTier: flex
```

The request precedence is:

```text
explicit session/request selection > model default > provider default
```

For an OpenAI Responses model, `serviceTier: priority` is sent as `service_tier: priority`. `reasoningEffort` is exposed as the model's default reasoning selection and is still overridable from the conversation model picker.

The Models page renders both fields inline for every provider's model editor, directly below the context-window and max-output-token fields. The adapter also preserves image request metadata when serializing admitted image
history for pi-ai models. The Settings Models extension tolerates the current
upstream editor signature and uses the Settings Remote operations; changes reach
the next request without replacing the provider route.

## `dropArgumentFillers`

Some models answer with **every** property their tool schema advertises instead of only the ones they mean. `gpt-5.6-luna` is one: it sends `justification: ""` next to a `sandbox_permissions` it never intended to use, and `provider: ""` / `model: ""` on delegation tools.

DSH validates those fields as *present*, so a blank value is a malformed ask rather than an omitted property:

```text
Error: invalid justification: expected a non-empty sentence
Error: invalid escalation: sandbox_permissions requires a justification
Error: child LLM `provider` must be non-empty
```

The rejection names a shape the model cannot see, so it repeats the identical call until the turn is aborted. With `dropArgumentFillers: true` the adapter removes the filler before the call is recorded and dispatched:

- a non-required property whose value is exactly `""`;
- a sandbox-escalation request that is incomplete — `sandbox_permissions` with a blank or missing `justification`, or a `justification` with no `sandbox_permissions`;
- a sandbox-escalation request that is **complete but unanswered** — the pair survives only when the latest result of *that same tool* carries a sandbox denial marker (`[sandbox: file access denied under …` or `[sandbox: escalation available …`).

`required` properties are never touched, so an empty `write.content` still writes an empty file, and a denied command still escalates on the retry that answers its denial.

The third rule covers the loop a syntax-only fix leaves behind: a session already at the widest sandbox mode refuses **every** escalation as `not strictly wider`, so a speculative ask there cannot succeed however it is worded — and a model that has been told to send a non-empty `justification` will keep supplying one. Dropping the ungrantable pair lets the call run at the mode already in effect, which is exactly what omitting the fields would do: it grants nothing and relaxes no policy. A genuine denial still returns its own `[sandbox: escalation available …]` hint, and the next reasoned retry is kept and reaches the approval flow.

The flag is off by default and belongs on the model that has the habit, not on the route.

## Install locally

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-llm-adapter
```

The Host bundle patch replaces the stock `llm-pi-ai` row by id and injects the model fields into the official Settings Models editor. Do not keep the temporary `dsh-plugin-llm-fast` bundle installed at the same time. Restart
`dsh web` after changing the profile bundle.

`priority` only has an effect when the upstream gateway implements the OpenAI Responses `service_tier` field. The adapter cannot create priority capacity that the gateway does not provide.

The published package is `@yiln-dsh/dsh-plugin-llm-adapter@0.4.0`.

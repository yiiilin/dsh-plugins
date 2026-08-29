# @yiln-dsh/dsh-plugin-llm-adapter

A local fork of DSH's `@deepseek-ai/dsh-llm-pi-ai` adapter. It keeps the original provider routes, including `sub2api-gpt`, and adds per-model defaults for OpenAI Responses `serviceTier` and Harness `reasoningEffort`.

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

The model settings page renders both fields inside the expanded row for each `sub2api-gpt` model. Changes are written through the normal DSH settings API and reach the next request without replacing the provider route.

## Install locally

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-llm-adapter
```

The bundle patch replaces the stock `llm-pi-ai` row by id, so do not keep the temporary `dsh-plugin-llm-fast` bundle installed at the same time. Restart `dsh web` after changing the profile bundle.

`priority` only has an effect when the upstream gateway implements the OpenAI Responses `service_tier` field. The adapter cannot create priority capacity that the gateway does not provide.

The published package is `@yiln-dsh/dsh-plugin-llm-adapter@0.1.0`.

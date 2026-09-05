# @yiln-dsh/dsh-plugin-sandbox-guidance

A Host-only DSH plugin that explains one confusing sandbox failure to the model:
when a bash call asks for a mode that is not strictly wider than the current
sandbox mode.

It does not change sandbox policy, bypass approval, rewrite tool arguments, or
replace the built-in bash executor. The native failure remains an error and the
command remains unexecuted.

## Behavior

The plugin adds a `systemPrompt` section that tells the model to omit
`sandbox_permissions` during ordinary calls and to explain this failure instead
of repeating it blindly. It also listens to `tools/post-execute` and replaces
only the matching bash failure text with a diagnostic containing:

- the fact that bash did not run;
- the requested sandbox mode;
- the current effective mode;
- whether the retry should omit `sandbox_permissions` or request a genuinely wider mode.

Other bash failures pass through unchanged.

## Install

The published package is `@yiln-dsh/dsh-plugin-sandbox-guidance@0.1.0`.

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-sandbox-guidance@latest
```

Restart `dsh web` after installing the package so the Host composition loads the
new row.

## Limitations

`tools/pre-execute` and `tools/post-execute` receive immutable tool arguments.
This plugin can explain a failure and guide the next model step, but it cannot
silently convert an invalid escalation into a valid one. Removing the strict
sandbox check still requires a DSH core patch or fork.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host system prompt section and bash failure diagnostic. |
| `cordis.patch.yml` | Composition patch that mounts the Host row. |

/**
 * Explains non-widening sandbox errors to the model without changing execution.
 * The native bash tool remains fail-closed; this package only improves recovery
 * guidance when a caller repeats the current sandbox mode.
 */

export const name = "sandbox-guidance";
export const inject = ["tools", "systemPrompt"];

const NON_WIDENING_ERROR = /sandbox escalation to "([^"]+)"\s+is not strictly wider than (?:this call's )?current "([^"]+)"\s+mode/iu;

/**
 * Turn the native sandbox error into a model-facing diagnostic that says what
 * ran, what did not run, and which retry shape is valid.
 */
export function explainSandboxFailure(message) {
  if (typeof message !== "string") return undefined;
  const match = NON_WIDENING_ERROR.exec(message);
  if (match === null) return undefined;
  const requested = match[1];
  const effective = match[2];
  const sameMode = requested === effective;
  return [
    "Bash was not executed; this failure happened before the command ran.",
    `Cause: sandbox_permissions requested \"${requested}\", but the current effective sandbox mode is \"${effective}\".`,
    sameMode
      ? "The requested mode is already active, so omit both sandbox_permissions and justification for the retry."
      : "The requested mode is not wider than the current mode, so omit both sandbox_permissions and justification when the current mode is sufficient.",
    "Explain this cause to the user instead of silently repeating the same bash call.",
  ].join(" ");
}

const SYSTEM_PROMPT = [
  "Sandbox escalation recovery:",
  "- Do not include sandbox_permissions in an ordinary bash call.",
  "- Never send justification by itself. When the current effective mode is sufficient, omit both sandbox_permissions and justification.",
  "- Only include sandbox_permissions and a non-empty justification when retrying a call that was actually denied by the sandbox and the requested mode is strictly wider than the effective mode.",
  "- If a bash result says the requested mode is not strictly wider than the current mode, state that the command did not run, explain the requested and effective modes, and retry without sandbox_permissions when the current mode is sufficient.",
  "- If a denied command genuinely needs a wider mode, retry the exact same command once with the narrowest wider sandbox_permissions value and a non-empty justification. This retry triggers the approval flow; do not ask for approval in chat first.",
].join("\n");

export function apply(ctx) {
  const order = ctx.systemPrompt.getSectionOrder("TOOL_BASH") + 1;
  ctx.systemPrompt.section({
    name: "tool:sandbox-guidance",
    order,
    text: SYSTEM_PROMPT,
  });

  ctx.on("tools/post-execute", (exec, result, next) => {
    if (exec.name !== "bash" || result.isError !== true) return next();
    const explained = explainSandboxFailure(result.error?.message);
    if (explained === undefined) return next();
    return {
      kind: "accept",
      content: [{ type: "text", text: explained }],
    };
  });
}

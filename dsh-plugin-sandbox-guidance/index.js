/**
 * Explains non-widening sandbox errors to the model without changing execution.
 * The native bash tool remains fail-closed; this package only improves recovery
 * guidance when a caller repeats the current sandbox mode.
 */

export const name = "sandbox-guidance";
export const inject = ["tools", "systemPrompt"];

const NON_WIDENING_ERROR = /^sandbox escalation to "([^"]+)" is not strictly wider than this call's current "([^"]+)" mode$/u;

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
      ? "The requested mode is already active, so sandbox_permissions must be omitted for the retry."
      : "sandbox_permissions is only valid for a retry that requests a strictly wider mode; do not retry with this mode.",
    "Explain this cause to the user instead of silently repeating the same bash call.",
  ].join(" ");
}

const SYSTEM_PROMPT = [
  "Sandbox escalation recovery:",
  "- Do not include sandbox_permissions in an ordinary bash call.",
  "- Only include it when retrying a call that was actually denied by the sandbox and the requested mode is strictly wider than the effective mode.",
  "- If a bash result says the requested mode is not strictly wider than the current mode, state that the command did not run, explain the requested and effective modes, and retry without sandbox_permissions when the current mode is sufficient.",
  "- If a wider mode is genuinely required, explain why to the user and request approval rather than repeating the failed call.",
].join("\n");

export function apply(ctx) {
  const order = typeof ctx.systemPrompt.getSectionOrder === "function"
    ? ctx.systemPrompt.getSectionOrder("TOOL_BASH") + 1
    : 105;
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

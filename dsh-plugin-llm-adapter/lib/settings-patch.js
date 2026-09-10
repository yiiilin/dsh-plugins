import { readFileSync, writeFileSync } from "node:fs";

const SETTINGS_MODELS_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-ui-settings-models/client.js";
const PATCH_MARKER = "dsh-plugin-llm-adapter settings patch";

/** Patch the shipped Models editor without replacing its page or provider rows. */
export function patchModelsSettingsClient(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const englishAnchor = 'maxTokensPlaceholder: "Uses the provider default",';
  const chineseAnchor = 'maxTokensPlaceholder: "使用提供方默认值",';
  const modelEditorAnchor = "function ModelListEditor(props) {";
  const modelDestructureAnchor = /const \{ models, onChange, probe, (api|operations), t, disabled \} = props;/;
  const advancedAnchor = /className: ModelsSection_module_css_default\["modelAdvanced"\],\s*children: \[/;
  const catalogPropsAnchor = /const catalogProps = \{\s*models,\s*overridden: modelsOverridden,/;
  const modelDestructureMatch = modelDestructureAnchor.exec(source);
  if (!source.includes(englishAnchor)
    || !source.includes(chineseAnchor)
    || !source.includes(modelEditorAnchor)
    || modelDestructureMatch === null
    || !advancedAnchor.test(source)
    || !catalogPropsAnchor.test(source)) return null;

  let patched = source.replace(englishAnchor, `${englishAnchor}
\t\t\tfastServiceTier: "Service tier",
\t\t\tfastReasoningEffort: "Default reasoning effort",
\t\t\t\t\t\tfastTierDefault: "Default",
\t\t\t\t\t\t\t\t\tfastTierPriority: "Priority",
\t\t\tfastReasoningOff: "Off",
			fastInherited: "Uses the provider default",
\t\t\tfastReasoningMinimal: "Minimal",
\t\t\tfastReasoningLow: "Low",
\t\t\tfastReasoningMedium: "Medium",
\t\t\tfastReasoningHigh: "High",
\t\t\tfastReasoningXhigh: "Xhigh",
\t\t\tfastReasoningMax: "Max",
			`);
  patched = patched.replace(chineseAnchor, `${chineseAnchor}
\t\t\tfastServiceTier: "服务等级",
\t\t\tfastReasoningEffort: "默认推理等级",
\t\t\t\t\t\tfastTierDefault: "默认",
\t\t\t\t\t\t\t\t\tfastTierPriority: "优先",
\t\t\tfastReasoningOff: "关闭",
			fastInherited: "跟随提供方默认值",
\t\t\tfastReasoningMinimal: "Minimal",
\t\t\tfastReasoningLow: "Low",
\t\t\tfastReasoningMedium: "Medium",
\t\t\tfastReasoningHigh: "High",
\t\t\tfastReasoningXhigh: "Xhigh",
\t\t\tfastReasoningMax: "Max",
			`);

  const component = String.raw`function LlmAdapterModelFields({ model, index, update, disabled, defaultReasoning, defaultServiceTier, t }) {
  const tierLabels = {
    default: "fastTierDefault",
    priority: "fastTierPriority",
  };
  const reasoningLabels = {
    off: "fastReasoningOff",
    minimal: "fastReasoningMinimal",
    low: "fastReasoningLow",
    medium: "fastReasoningMedium",
    high: "fastReasoningHigh",
    xhigh: "fastReasoningXhigh",
    max: "fastReasoningMax",
  };
  const tiers = Object.keys(tierLabels);
  const efforts = Object.keys(reasoningLabels);
  const modelTier = typeof model.serviceTier === "string" ? model.serviceTier : void 0;
  const serviceTier = tiers.includes(modelTier) ? modelTier : tiers.includes(defaultServiceTier) ? defaultServiceTier : "";
  const modelReasoning = typeof model.reasoningEffort === "string" ? model.reasoningEffort : void 0;
  const reasoning = efforts.includes(modelReasoning) ? modelReasoning : efforts.includes(defaultReasoning) ? defaultReasoning : "";
  return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
    (0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["modelField"], children: [
      (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelFieldLabel"], children: t("fastServiceTier") }),
      (0, react_jsx_runtime.jsx)("select", {
        className: ModelsSection_module_css_default["input"],
        value: serviceTier,
        "aria-label": t("fastServiceTier"),
        disabled,
        onChange: (event) => update(index, "serviceTier", event.target.value),
        children: [(0, react_jsx_runtime.jsx)("option", { value: "", children: t("fastInherited") }), ...tiers.map((value) => (0, react_jsx_runtime.jsx)("option", { value, children: t(tierLabels[value]) }, value))],
      }),
    ] }),
    (0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["modelField"], children: [
      (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelFieldLabel"], children: t("fastReasoningEffort") }),
      (0, react_jsx_runtime.jsx)("select", {
        className: ModelsSection_module_css_default["input"],
        value: reasoning,
        "aria-label": t("fastReasoningEffort"),
        disabled,
        onChange: (event) => update(index, "reasoningEffort", event.target.value),
        children: [(0, react_jsx_runtime.jsx)("option", { value: "", children: t("fastInherited") }), ...efforts.map((value) => (0, react_jsx_runtime.jsx)("option", { value, children: t(reasoningLabels[value]) }, value))],
      }),
    ] }),
  ] });
}
/* ${PATCH_MARKER} */
`;
  patched = patched.replace(modelEditorAnchor, `${component}${modelEditorAnchor}`);
  patched = patched.replace(
    modelDestructureAnchor,
    `const { models, onChange, probe, ${modelDestructureMatch[1]}, t, disabled, defaultReasoning, defaultServiceTier } = props;`,
  );
  patched = patched.replace(
    catalogPropsAnchor,
    `const catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\toverridden: modelsOverridden,
\t\t\t\t\tdefaultReasoning: stringAt(fallback, "reasoning") ?? "",
\t\t\t\t\tdefaultServiceTier: stringAt(fallback, "serviceTier") ?? "",`,
  );

  const modelEditorStart = patched.indexOf(modelEditorAnchor);
  if (modelEditorStart < 0) return null;
  const modelEditorBody = patched.slice(modelEditorStart);
  const advancedMatch = advancedAnchor.exec(modelEditorBody);
  if (advancedMatch === null) return null;
  const advancedBodyOffset = advancedMatch.index + advancedMatch[0].length;
  const advancedEndMatch = /\}\) : null\]/.exec(modelEditorBody.slice(advancedBodyOffset));
  if (advancedEndMatch === null) return null;
  const advancedChildrenOffset = modelEditorBody.slice(advancedBodyOffset, advancedBodyOffset + advancedEndMatch.index).lastIndexOf("]");
  if (advancedChildrenOffset < 0) return null;
  const advancedChildrenCloseAt = modelEditorStart + advancedBodyOffset + advancedChildrenOffset;
  const advancedInsertion = `,
              (0, react_jsx_runtime.jsx)(LlmAdapterModelFields, {
                model,
                index,
                update: (at, key, value) => patch(at, { [key]: value }),
                disabled,
                defaultReasoning,
                defaultServiceTier,
                t
              }),`;
  return patched.slice(0, advancedChildrenCloseAt) + advancedInsertion + patched.slice(advancedChildrenCloseAt);
}

const SETTINGS_MODELS_CLIENT_PACKAGE = "@deepseek-ai/dsh-client-ui-settings-models";

/** Serve the patched built-in Models page from the Host and rebuild combo scripts. */
export function registerModelsSettingsPatch(ctx) {
  const clientModules = ctx.clientModules ?? ctx.get?.("clientModules");
  if (clientModules === undefined || typeof clientModules.clientPath !== "function") {
    ctx.logger?.warn?.("llm-pi-ai-adapter: client modules service is unavailable");
    return;
  }
  const clientPath = clientModules.clientPath(SETTINGS_MODELS_CLIENT_PACKAGE);
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("llm-pi-ai-adapter: settings models client bundle was not found");
    return;
  }
  let original;
  let body;
  try {
    original = readFileSync(clientPath, "utf8");
    body = patchModelsSettingsClient(original);
  } catch (error) {
    ctx.logger?.warn?.("llm-pi-ai-adapter: could not read settings models client bundle: %s", error);
    return;
  }
  if (body === null) {
    ctx.logger?.warn?.("llm-pi-ai-adapter: settings models client bundle shape changed");
    return;
  }
  const ownsPatch = body !== original;
  try {
    ctx.effect(() => {
      if (ownsPatch) writeFileSync(clientPath, body, "utf8");
      if (typeof clientModules.rebuilt === "function") {
        const revision = clientModules.rebuilt(SETTINGS_MODELS_CLIENT_PACKAGE);
        if (revision === undefined) throw new Error("settings models client bundle is not registered");
      }
      const routeDisposer = ctx.webServer?.register?.({
        kind: "exact",
        path: SETTINGS_MODELS_CLIENT_PATH,
        handler: (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
          });
          if (req.method === "HEAD") res.end();
          else res.end(body);
        },
      });
      return () => {
        routeDisposer?.();
        if (!ownsPatch) return;
        writeFileSync(clientPath, original, "utf8");
        clientModules.rebuilt?.(SETTINGS_MODELS_CLIENT_PACKAGE);
      };
    }, "llm-pi-ai-adapter: Models client patch");
  } catch (error) {
    if (ownsPatch) {
      try {
        writeFileSync(clientPath, original, "utf8");
        clientModules.rebuilt?.(SETTINGS_MODELS_CLIENT_PACKAGE);
      } catch (restoreError) {
        ctx.logger?.warn?.("llm-pi-ai-adapter: could not restore settings models client bundle: %s", restoreError);
      }
    }
    ctx.logger?.warn?.("llm-pi-ai-adapter: could not install settings models client patch: %s", error);
  }
}

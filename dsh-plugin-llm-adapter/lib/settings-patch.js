import { readFileSync } from "node:fs";

const SETTINGS_MODELS_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-ui-settings-models/client.js";
const PATCH_MARKER = "dsh-plugin-llm-adapter settings patch";

/** Patch the shipped Models editor without replacing its page or provider rows. */
export function patchModelsSettingsClient(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const englishAnchor = 'maxTokensPlaceholder: "Uses the provider default",';
  const chineseAnchor = 'maxTokensPlaceholder: "使用提供方默认值",';
  const modelEditorAnchor = "function ModelListEditor(props) {";
  const modelDestructureAnchor = "const { models, onChange, probe, api, t, disabled } = props;";
  const advancedAnchor = /className: ModelsSection_module_css_default\["modelAdvanced"\],\s*children: \[/;
  const catalogPropsAnchor = /const catalogProps = \{\s*models,\s*overridden: modelsOverridden,/;
  if (!source.includes(englishAnchor)
    || !source.includes(chineseAnchor)
    || !source.includes(modelEditorAnchor)
    || !source.includes(modelDestructureAnchor)
    || !advancedAnchor.test(source)
    || !catalogPropsAnchor.test(source)) return null;

  let patched = source.replace(englishAnchor, `${englishAnchor}
\t\t\tfastServiceTier: "Service tier",
\t\t\tfastReasoningEffort: "Default reasoning effort",
\t\t\tfastTierAuto: "Auto",
\t\t\tfastTierDefault: "Default",
\t\t\tfastTierFlex: "Flex",
\t\t\tfastTierScale: "Scale",
\t\t\tfastTierPriority: "Priority",
\t\t\tfastReasoningOff: "Off",
\t\t\tfastReasoningMinimal: "Minimal",
\t\t\tfastReasoningLow: "Low",
\t\t\tfastReasoningMedium: "Medium",
\t\t\tfastReasoningHigh: "High",
\t\t\tfastReasoningXhigh: "Xhigh",
\t\t\tfastReasoningMax: "Max",`);
  patched = patched.replace(chineseAnchor, `${chineseAnchor}
\t\t\tfastServiceTier: "服务等级",
\t\t\tfastReasoningEffort: "默认推理等级",
\t\t\tfastTierAuto: "自动",
\t\t\tfastTierDefault: "默认",
\t\t\tfastTierFlex: "弹性",
\t\t\tfastTierScale: "扩展",
\t\t\tfastTierPriority: "优先",
\t\t\tfastReasoningOff: "关闭",
\t\t\tfastReasoningMinimal: "Minimal",
\t\t\tfastReasoningLow: "Low",
\t\t\tfastReasoningMedium: "Medium",
\t\t\tfastReasoningHigh: "High",
\t\t\tfastReasoningXhigh: "Xhigh",
\t\t\tfastReasoningMax: "Max",`);

  const component = String.raw`function LlmAdapterModelFields({ provider, model, index, update, disabled, defaultReasoning, defaultServiceTier, t }) {
  if (provider !== "sub2api-gpt") return null;
  const tierLabels = {
    auto: "fastTierAuto",
    default: "fastTierDefault",
    flex: "fastTierFlex",
    scale: "fastTierScale",
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
  const serviceTier = tiers.includes(modelTier) ? modelTier : tiers.includes(defaultServiceTier) ? defaultServiceTier : "priority";
  const modelReasoning = typeof model.reasoningEffort === "string" ? model.reasoningEffort : void 0;
  const reasoning = efforts.includes(modelReasoning) ? modelReasoning : efforts.includes(defaultReasoning) ? defaultReasoning : "max";
  return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
    (0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["modelField"], children: [
      (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelFieldLabel"], children: t("fastServiceTier") }),
      (0, react_jsx_runtime.jsx)("select", {
        className: ModelsSection_module_css_default["input"],
        value: serviceTier,
        "aria-label": t("fastServiceTier"),
        disabled,
        onChange: (event) => update(index, "serviceTier", event.target.value),
        children: tiers.map((value) => (0, react_jsx_runtime.jsx)("option", { value, children: t(tierLabels[value]) }, value)),
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
        children: efforts.map((value) => (0, react_jsx_runtime.jsx)("option", { value, children: t(reasoningLabels[value]) }, value)),
      }),
    ] }),
  ] });
}
/* ${PATCH_MARKER} */
`;
  patched = patched.replace(modelEditorAnchor, `${component}${modelEditorAnchor}`);
  patched = patched.replace(
    modelDestructureAnchor,
    "const { models, onChange, probe, api, t, disabled, defaultReasoning, defaultServiceTier } = props;",
  );
  patched = patched.replace(
    catalogPropsAnchor,
    `const catalogProps = {
\t\t\t\t\tmodels,
\t\t\t\t\toverridden: modelsOverridden,
\t\t\t\t\tdefaultReasoning: stringAt(fallback, "reasoning") ?? "max",
\t\t\t\t\tdefaultServiceTier: stringAt(fallback, "serviceTier") ?? "priority",`,
  );

  const modelEditorStart = patched.indexOf(modelEditorAnchor);
  if (modelEditorStart < 0) return null;
  const modelEditorBody = patched.slice(modelEditorStart);
  const advancedMatch = advancedAnchor.exec(modelEditorBody);
  if (advancedMatch === null) return null;
  const advancedAt = modelEditorStart + advancedMatch.index;
  const advancedInsertion = `${advancedMatch[0]}
              (0, react_jsx_runtime.jsx)(LlmAdapterModelFields, {
                provider: probe.provider,
                model,
                index,
                update: (at, key, value) => patch(at, { [key]: value }),
                disabled,
                defaultReasoning,
                defaultServiceTier,
                t
              }),`;
  return patched.slice(0, advancedAt) + advancedInsertion + patched.slice(advancedAt + advancedMatch[0].length);
}

/** Serve the patched built-in Models page from the Host. */
export function registerModelsSettingsPatch(ctx) {
  const clientPath = ctx.clientModules.clientPath("@deepseek-ai/dsh-client-ui-settings-models");
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("llm-pi-ai-adapter: settings models client bundle was not found");
    return;
  }
  let body;
  try {
    body = patchModelsSettingsClient(readFileSync(clientPath, "utf8"));
  } catch (error) {
    ctx.logger?.warn?.("llm-pi-ai-adapter: could not read settings models client bundle: %s", error);
    return;
  }
  if (body === null) {
    ctx.logger?.warn?.("llm-pi-ai-adapter: settings models client bundle shape changed");
    return;
  }
  ctx.effect(() => ctx.webServer.register({
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
  }), "llm-pi-ai-adapter: Models client patch");
}

/*
 * The RC1 Models page exposes provider-card extension Slots. This client face
 * keeps the adapter's provider-specific controls out of the official bundle so
 * the feature survives the combo-script loader and future UI rebuilds.
 */
window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-llm-adapter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const inject = ["slots", "locale", "remote", "remote.settings"];
    const LOCALE_NS = "llm-adapter";
    const SETTINGS_NS = "llm-pi-ai";
    const STYLE_ID = "dsh-plugin-llm-adapter-model-settings";

    const ZH_DICT = {
      title: "适配器模型设置",
      open: "编辑高级模型设置",
      close: "收起高级模型设置",
      model: "模型 {id}",
      serviceTier: "服务等级",
      reasoningEffort: "默认推理等级",
      inherited: "跟随提供方默认值",
      auto: "自动",
      default: "默认",
      flex: "弹性",
      scale: "扩展",
      priority: "优先",
      off: "关闭",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Xhigh",
      max: "Max",
      load: "加载中…",
      loadFailed: "无法加载模型设置",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      saveFailed: "无法保存模型设置",
      empty: "当前没有可编辑的模型。",
      configureFirst: "请先配置模型提供方。",
    };
    const EN_DICT = {
      title: "Adapter model settings",
      open: "Edit advanced model settings",
      close: "Collapse advanced model settings",
      model: "Model {id}",
      serviceTier: "Service tier",
      reasoningEffort: "Default reasoning effort",
      inherited: "Use provider default",
      auto: "Auto",
      default: "Default",
      flex: "Flex",
      scale: "Scale",
      priority: "Priority",
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Xhigh",
      max: "Max",
      load: "Loading…",
      loadFailed: "Could not load model settings",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      saveFailed: "Could not save model settings",
      empty: "There are no editable models.",
      configureFirst: "Configure the model provider first.",
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    function isRecord(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function cloneModels(value) {
      return Array.isArray(value)
        ? value.filter(isRecord).map((model) => ({ ...model }))
        : [];
    }

    function modelsFromView(view, provider) {
      const providers = isRecord(view?.value?.providers) ? view.value.providers : {};
      const profile = providers[provider];
      return isRecord(profile) ? cloneModels(profile.models) : [];
    }

    function createProviderCardExtras(settings, t) {
      return function ProviderCardExtras({ provider, configured }) {
        if (provider?.provider !== "sub2api-gpt") return null;
        const [open, setOpen] = React.useState(false);
        const [models, setModels] = React.useState(null);
        const [revision, setRevision] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const [error, setError] = React.useState(null);

        const load = React.useCallback(async () => {
          setBusy(true);
          setSaved(false);
          setError(null);
          try {
            const response = await settings.describe();
            if (!response.ok) throw new Error(response.error.message);
            const view = response.value.namespaces.find((entry) => entry.ns === SETTINGS_NS);
            if (view === undefined) throw new Error(t("configureFirst"));
            setModels(modelsFromView(view, provider.provider));
            setRevision(view.revision);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("loadFailed"));
          } finally {
            setBusy(false);
          }
        }, [provider.provider, settings, t]);

        const toggle = () => {
          if (!open && models === null) void load();
          setOpen((value) => !value);
        };

        const updateModel = (index, key, value) => {
          setSaved(false);
          setModels((current) => current.map((model, modelIndex) => {
            if (modelIndex !== index) return model;
            const next = { ...model };
            if (value === "") delete next[key];
            else next[key] = value;
            return next;
          }));
        };

        const save = async () => {
          if (busy || models === null || revision === null) return;
          setBusy(true);
          setSaved(false);
          setError(null);
          try {
            const response = await settings.update(SETTINGS_NS, {
              providers: { [provider.provider]: { models } },
            }, revision);
            if (!response.ok) throw new Error(response.error.message);
            setRevision(response.value.revision);
            setSaved(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("saveFailed"));
          } finally {
            setBusy(false);
          }
        };

        return React.createElement(
          "section",
          { className: "dla-cardExtras", "data-provider": provider.provider },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dla-cardExtrasToggle",
              "aria-expanded": open,
              onClick: toggle,
            },
            open ? t("close") : t("open"),
          ),
          open
            ? React.createElement(
                "div",
                { className: "dla-cardExtrasBody" },
                configured !== true
                  ? React.createElement("p", { className: "dla-cardExtrasMessage" }, t("configureFirst"))
                  : busy && models === null
                    ? React.createElement("p", { className: "dla-cardExtrasMessage" }, t("load"))
                    : error !== null && models === null
                      ? React.createElement("p", { className: "dla-cardExtrasError", role: "alert" }, error)
                      : models !== null && models.length === 0
                        ? React.createElement("p", { className: "dla-cardExtrasMessage" }, t("empty"))
                        : React.createElement(
                            React.Fragment,
                            null,
                            models?.map((model, index) => {
                              const id = typeof model.id === "string" && model.id !== "" ? model.id : String(index + 1);
                              const tiers = ["auto", "default", "flex", "scale", "priority"];
                              const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
                              return React.createElement(
                                "div",
                                { className: "dla-modelRow", key: `${id}:${index}` },
                                React.createElement("strong", { className: "dla-modelName" }, t("model", { id })),
                                React.createElement(
                                  "label",
                                  { className: "dla-modelField" },
                                  React.createElement("span", null, t("serviceTier")),
                                  React.createElement(
                                    "select",
                                    {
                                      className: "dla-modelSelect",
                                      value: tiers.includes(model.serviceTier) ? model.serviceTier : "",
                                      disabled: busy,
                                      onChange: (event) => updateModel(index, "serviceTier", event.target.value),
                                    },
                                    React.createElement("option", { value: "" }, t("inherited")),
                                    ...tiers.map((item) => React.createElement("option", { key: item, value: item }, t(item))),
                                  ),
                                ),
                                React.createElement(
                                  "label",
                                  { className: "dla-modelField" },
                                  React.createElement("span", null, t("reasoningEffort")),
                                  React.createElement(
                                    "select",
                                    {
                                      className: "dla-modelSelect",
                                      value: efforts.includes(model.reasoningEffort) ? model.reasoningEffort : "",
                                      disabled: busy,
                                      onChange: (event) => updateModel(index, "reasoningEffort", event.target.value),
                                    },
                                    React.createElement("option", { value: "" }, t("inherited")),
                                    ...efforts.map((item) => React.createElement("option", { key: item, value: item }, t(item))),
                                  ),
                                ),
                              );
                            }),
                            React.createElement(
                              "div",
                              { className: "dla-cardExtrasFooter" },
                              error === null ? null : React.createElement("span", { className: "dla-cardExtrasError", role: "alert" }, error),
                              saved ? React.createElement("span", { className: "dla-cardExtrasSaved", role: "status" }, t("saved")) : null,
                              React.createElement("button", { type: "button", className: "dla-cardExtrasSave", disabled: busy || models === null || revision === null, onClick: save }, busy ? t("saving") : t("save")),
                            ),
                          ),
              )
            : null,
        );
      };
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      const settings = ctx.remote.settings;
      if (slots === undefined || settings === undefined) return;
      if (typeof document !== "undefined" && document.getElementById(STYLE_ID) === null) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.setAttribute("data-plugin", "dsh-plugin-llm-adapter");
        style.textContent = `
.dla-cardExtras{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.dla-cardExtrasToggle{align-self:flex-start;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57534e);font:inherit;font-size:12px;cursor:pointer}
.dla-cardExtrasToggle:hover{background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
.dla-cardExtrasBody{display:flex;flex-direction:column;gap:8px;min-width:0}
.dla-modelRow{display:grid;grid-template-columns:minmax(100px,1fr) repeat(2,minmax(130px,1fr));gap:8px;align-items:end;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff)}
.dla-modelName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#111827);font-size:12px}
.dla-modelField{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--dsw-alias-label-tertiary,#78716c);font-size:11px}
.dla-modelSelect{min-width:0;height:30px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.2));border-radius:5px;background:var(--dsw-alias-bg-input,#fff);color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:12px}
.dla-cardExtrasFooter{display:flex;align-items:center;gap:8px;min-height:30px}
.dla-cardExtrasMessage{margin:0;color:var(--dsw-alias-label-tertiary,#78716c);font-size:12px}
.dla-cardExtrasError{color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;overflow-wrap:anywhere}
.dla-cardExtrasSaved{color:var(--dsw-alias-state-success-primary,#15803d);font-size:12px}
.dla-cardExtrasSave{margin-left:auto;padding:5px 10px;border:0;border-radius:6px;background:var(--dsw-alias-brand-primary,#2563eb);color:#fff;font:inherit;font-size:12px;cursor:pointer}
.dla-cardExtrasSave:disabled{opacity:.55;cursor:default}
@media (max-width:680px){.dla-modelRow{grid-template-columns:minmax(0,1fr)}}
`;
        document.head.append(style);
        ctx.effect(() => () => style.remove(), "llm-adapter model settings stylesheet");
      }
      const locale = ctx.get("locale");
      if (locale !== undefined) ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "llm-adapter: locale");
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
      const ProviderCardExtras = createProviderCardExtras(settings, t);
      ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
        name: "settings.models.provider-card",
        key: "llm-pi-ai",
        locale: LOCALE_NS,
      }, ProviderCardExtras));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

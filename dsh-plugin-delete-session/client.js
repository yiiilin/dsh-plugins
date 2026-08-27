/*
 * dsh-plugin-delete-session — browser half.
 *
 * Adds one additive action to the current conversation header. The Host owns
 * all deletion work; this module only confirms the intent and refreshes the
 * session list after the Host reports success.
 */
window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-delete-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const inject = ["slots", "sessions"];
    const API_PATH = "/_dsh/delete-session/delete";
    const STYLE_ID = "dsh-plugin-delete-session-style";

    const LOCALE_NS = "delete-session";
    const ZH_DICT = {
      cancel: "取消",
      "confirm.title": "删除会话",
      "confirm.body": "确定要删除“{name}”吗？",
      "confirm.warning": "会话日志及其会话专属临时文件将被永久删除，无法恢复。",
      "delete.busy": "删除中…",
      "delete.confirm": "永久删除",
    };
    const EN_DICT = {
      cancel: "Cancel",
      "confirm.title": "Delete session",
      "confirm.body": "Delete “{name}”?",
      "confirm.warning": "The session transcript and its temporary workspace files will be permanently deleted and cannot be recovered.",
      "delete.busy": "Deleting…",
      "delete.confirm": "Delete permanently",
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    const STYLE_TEXT = `
.dss-action{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
.dss-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dss-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dss-action:disabled{opacity:.55;cursor:default}
.dss-overlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:rgba(15,23,42,.42)}
.dss-dialog{box-sizing:border-box;width:min(420px,100%);padding:20px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 18px 50px rgba(0,0,0,.22)}
.dss-title{margin:0 0 8px;font-size:16px;line-height:22px;font-weight:600}
.dss-copy{margin:0;color:var(--dsw-alias-label-secondary,#57534e);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dss-name{color:var(--dsw-alias-label-primary,#111827);font-weight:600}
.dss-warning{margin:12px 0 0;color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px}
.dss-error{margin:12px 0 0;padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dss-buttons{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dss-button{min-height:32px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#57534e);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dss-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
.dss-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dss-button:disabled{opacity:.55;cursor:default}
.dss-button-danger{border-color:rgba(185,28,28,.45);background:var(--dsw-alias-state-error-primary,#b91c1c);color:#fff}
.dss-button-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#b91c1c);color:#fff}
`;

    function installStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return () => {};
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-plugin", "dsh-plugin-delete-session");
      style.textContent = STYLE_TEXT;
      document.head.append(style);
      return () => style.remove();
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    async function requestDelete(sessionId) {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, confirm: true }),
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error(`delete-session API returned HTTP ${response.status}`);
      }
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || `delete-session API returned HTTP ${response.status}`);
      }
      return result;
    }

    function createDeleteSessionAction(t) {
      return function DeleteSessionAction(props) {
      const [confirming, setConfirming] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      if (typeof props.useSession !== "function" || typeof props.useSessions !== "function") return null;

      const blank = props.useSession((state) => state.blank);
      const removed = props.useSession((state) => state.removed);
      const subagent = props.useSession((state) => state.subagent !== null);
      const title = props.useSessions((state) => state.byId[props.sessionId]?.displayTitle || props.sessionId);
      const nextSessionId = props.useSessions((state) => state.ids.find((id) => id !== props.sessionId && state.byId[id]?.origin !== "subagent" && state.byId[id]?.blank !== true));

      if (blank || removed || subagent) return null;

      const openConfirmation = () => {
        setError(null);
        setConfirming(true);
      };

      const cancel = () => {
        if (busy) return;
        setError(null);
        setConfirming(false);
      };

      const confirmDelete = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          await requestDelete(props.sessionId);
          if (nextSessionId !== undefined) props.sessions.open(nextSessionId);
          if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();
        } catch (reason) {
          setError(messageOf(reason));
          setBusy(false);
        }
      };

      const trashIcon = primitives.IconTrashOutline16
        ? React.createElement(primitives.IconTrashOutline16, { size: 16 })
        : React.createElement("span", { "aria-hidden": "true" }, "×");

      const dialog = confirming
        ? React.createElement(
            "div",
            {
              className: "dss-overlay",
              role: "presentation",
              onClick: cancel,
            },
            React.createElement(
              "div",
              {
                className: "dss-dialog",
                role: "dialog",
                "aria-modal": "true",
                "aria-labelledby": "dss-delete-title",
                onClick: (event) => event.stopPropagation(),
              },
              React.createElement("h2", { id: "dss-delete-title", className: "dss-title" }, t("confirm.title")),
              React.createElement(
                "p",
                { className: "dss-copy" },
                t("confirm.body", { name: title }),
              ),
              React.createElement("p", { className: "dss-warning" }, t("confirm.warning")),
              error === null ? null : React.createElement("div", { className: "dss-error", role: "alert" }, error),
              React.createElement(
                "div",
                { className: "dss-buttons" },
                React.createElement("button", { type: "button", className: "dss-button", disabled: busy, onClick: cancel }, t("cancel")),
                React.createElement("button", { type: "button", className: "dss-button dss-button-danger", disabled: busy, onClick: () => void confirmDelete() }, busy ? t("delete.busy") : t("delete.confirm")),
              ),
            ),
          )
        : null;

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            className: "dss-action",
            "aria-label": t("confirm.title"),
            title: t("confirm.title"),
            disabled: busy,
            onClick: openConfirmation,
          },
          trashIcon,
        ),
        dialog,
      );
    };
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined || ctx.sessions === undefined) return;
      const locale = ctx.get("locale");
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "delete-session: locale");
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
      const DeleteSessionAction = createDeleteSessionAction(t);
      ctx.effect(() => installStyle(), "delete-session: stylesheet");
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "delete-session",
        order: 100,
        inject: () => ({}),
      }, DeleteSessionAction));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

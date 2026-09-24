/*
 * dsh-plugin-delete-session — browser half.
 *
 * Adds the current-session action plus a batch-management action beside the
 * workspace controls. The Host owns all deletion work; this module only tracks
 * transient selection state and refreshes the session list after success.
 */
window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-delete-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { createPortal } = require("react-dom");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const inject = ["slots", "sessions"];
    const API_PATH = "/_dsh/delete-session/delete";
    const MAX_BATCH_SIZE = 100;
    const STYLE_ID = "dsh-plugin-delete-session-style";
    /** Widest gap, in pixels, between a session row's action button and its own popup menu. */
    const MENU_ANCHOR_GAP_PX = 24;

    const LOCALE_NS = "delete-session";
    const ZH_DICT = {
      cancel: "取消",
      close: "关闭",
      "error.http": "删除服务返回 HTTP {status}。",
      "confirm.title": "删除会话",
      "menu.delete": "删除会话",
      "confirm.body": "确定要删除“{name}”吗？",
      "confirm.warning": "会话日志、该会话派生的子 agent 会话日志及其会话专属临时文件将被永久删除，无法恢复。",
      "delete.busy": "删除中…",
      "delete.confirm": "永久删除",
      "manage.start": "批量管理",
      "manage.confirm": "确认删除 ({n})",
      "manage.session.aria": "选择会话“{name}”",
      "manage.busy": "删除中…",
    };
    const EN_DICT = {
      cancel: "Cancel",
      close: "Close",
      "error.http": "The delete service answered HTTP {status}.",
      "confirm.title": "Delete session",
      "menu.delete": "Delete session",
      "confirm.body": "Delete “{name}”?",
      "confirm.warning": "The session transcript, the subagent session transcripts delegated from it, and their temporary workspace files will be permanently deleted and cannot be recovered.",
      "delete.busy": "Deleting…",
      "delete.confirm": "Delete permanently",
      "manage.start": "Manage sessions",
      "manage.confirm": "Delete selected ({n})",
      "manage.session.aria": "Select session {name}",
      "manage.busy": "Deleting…",
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    /*
     * Every control below copies a shipped counterpart instead of inventing
     * geometry, so the plugin's buttons are indistinguishable from the shell's:
     * the header icon action is the session header's own `.moreButton`
     * (28px, radius 28px, secondary label, hover fill with no color change),
     * the sidebar icon action is the sidebar's `.iconButton` (`corner-shape:
     * round` over the theme's global superellipse, 28px, same label and hover); the confirmation card
     * is ui-primitives' `Modal` (blurred `--dsw-alias-bg-mask-1` mask, 24px
     * layer-2 card with the prominent elevation, title row with the close
     * button, secondary warning line behind an error-colored glyph, and 18px
     * capsule footer buttons whose destructive action carries the error label
     * color rather than a filled red); the menu row is the Menu cell the
     * shipped `MenuItemButton` rows use (34px, 8px radius, 13px/20px, danger
     * hover fill); and the managing pair is the compact Button capsule (28px,
     * 14px radius). The fallback values stay for a shell whose theme predates
     * a token.
     */
    const STYLE_TEXT = `
.dss-action{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:6px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
.dss-action svg{width:16px;height:16px}
.dss-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
.dss-action:disabled{cursor:not-allowed;opacity:.4}
.dss-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-top-clearance,24px)) 24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,blur(2px))}
.dss-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);max-height:100%;padding:0 0 24px;border:0;border-radius:24px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:var(--dsw-elevation-prominent,0 18px 50px rgba(0,0,0,.22));overflow:hidden}
.dss-dialogContent{display:flex;flex-direction:column;width:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dss-dialogHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dss-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dss-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#57534e);cursor:pointer}
.dss-close svg{width:14px;height:14px}
.dss-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
.dss-close:disabled{cursor:not-allowed;opacity:.4}
.dss-copy{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#111827);overflow-wrap:anywhere}
.dss-warning{display:flex;align-items:flex-start;gap:10px;margin:20px 0 0;padding:0 24px;color:var(--dsw-alias-label-secondary,#57534e);font-size:14px;line-height:22px;overflow-wrap:anywhere}
.dss-warning p{margin:0}
.dss-warningIcon{flex:none;display:inline-flex;margin-top:2px;color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dss-warningIcon svg{width:18px;height:18px}
.dss-error{margin:20px 0 0;padding:0 24px;color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dss-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dss-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dss-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
.dss-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,#e7e5e4)}
.dss-button:disabled{cursor:not-allowed;opacity:.4}
.dss-button-outline{border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18))}
.dss-button-danger{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dss-batch-control{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dss-batch-control:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
.dss-batch-control:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,#e7e5e4)}
.dss-batch-control:disabled{cursor:not-allowed;opacity:.4}
.dss-batch-control-danger{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dss-batch-control-icon{corner-shape:round;width:28px;height:28px;padding:0;border:0;border-radius:50%;color:var(--dsw-alias-label-secondary,#6b7280)}
.dss-batch-control-icon svg{width:16px;height:16px}
div:has(> .dss-batch-control){max-width:160px!important;overflow:visible!important}
div:has(> .dss-batch-mode-marker) button:not(.dss-batch-control){display:none!important}
.dss-batch-mode-marker{display:none!important}
.dss-session-checkbox-host{position:absolute;z-index:2;left:4px;top:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;transform:translateY(-50%);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#fff)}
.dss-session-checkbox-host input{box-sizing:border-box;flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#2563eb);cursor:pointer}
.dss-session-checkbox-host input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dss-session-checkbox-host:has(input:disabled){cursor:default;opacity:.5}
div[role="treeitem"]:has(> .dss-session-checkbox-host){position:relative}
.dss-batch-status{position:absolute;z-index:3;left:8px;right:8px;bottom:8px;box-sizing:border-box;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px;overflow-wrap:anywhere;box-shadow:var(--dsw-elevation-prominent,0 18px 50px rgba(0,0,0,.22))}
.dss-menu-delete-wrap{box-sizing:border-box;position:relative;width:100%;padding:0}
.dss-menu-delete-item{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary,#b91c1c);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dss-menu-delete-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.08))}
.dss-menu-delete-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.08));outline:none}
.dss-menu-delete-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dss-menu-delete-icon svg{width:14px;height:14px}

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

    /*
     * The shipped icon set names its artwork by stroke weight, never by pixel
     * size, so resolve each glyph from the exports this shell actually carries
     * and keep a plain replacement for a shell that predates it.
     */
    const ICONS = {
      trash: primitives.IconTrashOutlineRegular ?? primitives.IconTrashOutlineMedium ?? null,
      checklist: primitives.IconChecklistOutlineRegular ?? primitives.IconChecklistOutlineMedium ?? null,
      close: primitives.IconCloseOutlineRegular ?? primitives.IconCloseFillRegular ?? null,
      warning: primitives.IconWarningOutlineRegular ?? primitives.IconWarningTriangleOutlineRegular ?? null,
    };

    /**
     * Render one shipped icon at the size its host control uses.
     * @param {string} name - key into {@link ICONS}.
     * @param {number} size - square pixel size of the artwork.
     * @param {string} fallback - text shown when the shell has no such icon.
     * @returns {object} the icon element.
     */
    function icon(name, size, fallback) {
      const Component = ICONS[name];
      return Component === null
        ? React.createElement("span", { "aria-hidden": "true" }, fallback)
        : React.createElement(Component, { size });
    }

    /**
     * The destructive-confirmation card, one dialog for every entry point.
     *
     * The markup and geometry are the shipped Modal's: a blurred mask, a 24px
     * layer-2 card, a title row with a close button, and capsule footer buttons
     * whose destructive action is outline-filled with the error label color —
     * the shipped dialogs never fill a button red. Escape and a mask click
     * cancel, exactly as the Modal does; a busy dialog ignores both.
     * @param {object} props - locale lookup and the dialog's own state.
     * @param {Function} props.t - bound locale lookup.
     * @param {string} props.titleId - id the dialog is labelled by.
     * @param {string} props.name - session title the request names.
     * @param {string|null} props.error - failure text, or null while none.
     * @param {boolean} props.busy - whether the deletion is in flight.
     * @param {() => void} props.onCancel - dismiss without deleting.
     * @param {() => void} props.onConfirm - run the confirmed deletion.
     * @returns {object} the overlay tree.
     */
    function ConfirmDialog({ t, titleId, name, error, busy, onCancel, onConfirm }) {
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onCancel();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [onCancel]);
      return React.createElement(
        "div",
        { className: "dss-overlay", role: "presentation", onClick: onCancel },
        React.createElement(
          "div",
          {
            className: "dss-dialog",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": titleId,
            onClick: (event) => event.stopPropagation(),
          },
          React.createElement(
            "div",
            { className: "dss-dialogContent" },
            React.createElement(
              "div",
              { className: "dss-dialogHead" },
              React.createElement("h2", { id: titleId, className: "dss-title" }, t("confirm.title")),
              React.createElement(
                "button",
                { type: "button", className: "dss-close", "aria-label": t("close"), disabled: busy, onClick: onCancel },
                icon("close", 14, "×"),
              ),
            ),
            React.createElement("p", { className: "dss-copy" }, t("confirm.body", { name })),
            React.createElement(
              "div",
              { className: "dss-warning" },
              React.createElement("span", { className: "dss-warningIcon" }, icon("warning", 18, "!")),
              React.createElement("p", null, t("confirm.warning")),
            ),
            error === null ? null : React.createElement("div", { className: "dss-error", role: "alert" }, error),
          ),
          React.createElement(
            "div",
            { className: "dss-buttons" },
            React.createElement("button", { type: "button", className: "dss-button dss-button-outline", disabled: busy, onClick: onCancel }, t("cancel")),
            React.createElement(
              "button",
              { type: "button", className: "dss-button dss-button-outline dss-button-danger", disabled: busy, onClick: onConfirm },
              busy ? t("delete.busy") : t("delete.confirm"),
            ),
          ),
        ),
      );
    }

    /**
     * A failed HTTP call, carrying the status rather than a rendered sentence.
     * This helper has no locale in scope and the alert box is the only place
     * that knows which language the user is reading; the server's own message
     * goes to the console, where it stays useful for diagnosis.
     */
    function httpFailure(status, serverError) {
      const error = new Error(`delete-session API returned HTTP ${status}`);
      error.dshStatus = status;
      error.dshServerError = typeof serverError === "string" ? serverError : undefined;
      if (error.dshServerError !== undefined) console.warn("delete-session:", error.message, error.dshServerError);
      return error;
    }

    function messageOf(error, t) {
      if (error && typeof error.dshStatus === "number" && typeof t === "function") {
        return t("error.http", { status: error.dshStatus });
      }
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
        result = undefined;
      }
      if (!response.ok || result?.ok !== true) {
        throw httpFailure(response.status, result?.error);
      }
      return result;
    }

    async function requestDeleteMany(sessionIds) {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionIds, confirm: true }),
      });
      let result;
      try {
        result = await response.json();
      } catch {
        result = undefined;
      }
      if (!response.ok || result?.ok !== true) {
        throw httpFailure(response.status, result?.error);
      }
      return result;
    }

    /**
     * Re-read the session list after a deletion.
     *
     * The Host deletes through this plugin's own route, which the Session
     * Controller never sees, so the sidebar keeps the deleted rows until its
     * baseline is pulled again. `sessions.refresh()` is that pull; a shell too
     * old to expose it still gets the page reload this plugin used to rely on.
     * @param {object|undefined} sessions - client Session service.
     * @returns {Promise<void>} completion of the refresh or the reload.
     */
    async function refreshSessionList(sessions) {
      if (typeof sessions?.refresh === "function") {
        try {
          await sessions.refresh();
          return;
        } catch {
          // Fall through to the reload below.
        }
      }
      if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();
    }

    /**
     * Run one confirmed deletion and release the dialog's busy flag as soon as
     * the deletion itself is settled.
     *
     * The busy flag gates the dialog's own buttons, so a path that sets it and
     * never clears it strands the dialog on "Deleting…" — unusable and
     * uncancellable. The sidebar refresh therefore runs *after* the release:
     * it is a list-consistency step, not part of the deletion, and a slow or
     * hung refresh must never keep the dialog disabled.
     * @param {object} options - the setters, the error mapper, and the work.
     * @param {(value: boolean) => void} options.setBusy - busy-flag setter.
     * @param {(value: string|null) => void} options.setError - error-text setter.
     * @param {(reason: unknown, t: Function) => string} options.messageOf - error mapper.
     * @param {Function} options.t - bound locale lookup.
     * @param {() => Promise<void>} options.attempt - the confirmed delete plus navigation.
     * @param {() => Promise<void>} [options.settle] - post-delete list refresh.
     * @returns {Promise<boolean>} whether the deletion committed.
     */
    async function runConfirmedDelete({ setBusy, setError, messageOf, t, attempt, settle }) {
      setBusy(true);
      setError(null);
      try {
        await attempt();
      } catch (reason) {
        setBusy(false);
        setError(messageOf(reason, t));
        return false;
      }
      setBusy(false);
      if (typeof settle === "function") {
        try {
          await settle();
        } catch {
          // `refreshSessionList` owns its own reload fallback; a refresh failure
          // is never a deletion failure and must not surface as one.
        }
      }
      return true;
    }

    const EMPTY_SESSION_LIST = { current: undefined, ids: [], byId: {} };
    const EMPTY_WORKSPACE_LIST = { items: [], archivedSessionIds: [] };

    function sessionIsVisible(summary, current, archived) {
      return summary !== undefined
        && summary.origin !== "subagent"
        && !archived.has(summary.id)
        && (!summary.blank || summary.id === current);
    }

    function compareSessionRecency(left, right, byId) {
      const leftUpdatedAt = byId[left]?.updatedAt ?? Number.NEGATIVE_INFINITY;
      const rightUpdatedAt = byId[right]?.updatedAt ?? Number.NEGATIVE_INFINITY;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return left < right ? -1 : left > right ? 1 : 0;
    }

    function buildSessionSelectionModel(list, workspaceList) {
      const byId = list?.byId ?? {};
      const sourceIds = Array.isArray(list?.ids) ? list.ids : [];
      const current = list?.current;
      const archived = new Set(Array.isArray(workspaceList?.archivedSessionIds) ? workspaceList.archivedSessionIds : []);
      const visible = (id) => sessionIsVisible(byId[id], current, archived);
      const workspaces = Array.isArray(workspaceList?.items) ? workspaceList.items : [];
      const accounted = new Set();
      const allIds = [];
      for (const workspace of workspaces) {
        for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          if (byId[id] === undefined) continue;
          accounted.add(id);
          if (visible(id)) allIds.push(id);
        }
      }
      for (const id of sourceIds) {
        if (!accounted.has(id) && visible(id)) allIds.push(id);
      }
      return {
        allIds,
        flatIds: sourceIds.filter(visible).sort((left, right) => compareSessionRecency(left, right, byId)),
        selectableIds: allIds.filter((id) => byId[id]?.blank !== true),
      };
    }

    function targetsEqual(previous, next) {
      return previous.length === next.length
        && previous.every((target, index) => target.id === next[index].id && target.element === next[index].element);
    }

    function workspaceBrowserRoot() {
      if (typeof document === "undefined") return null;
      const tree = [...document.querySelectorAll('[role="tree"]')].find((candidate) => candidate.querySelector('[role="treeitem"]') !== null);
      return tree?.parentElement?.parentElement?.parentElement ?? null;
    }

    function directSessionRowTitle(row) {
      for (const child of row.children) {
        if (child.tagName !== "SPAN" || child.children.length !== 0) continue;
        const text = child.textContent?.trim();
        if (text !== undefined && text !== "") return text;
      }
      return "";
    }

    function collectWorkspaceTargets(browserRoot, model, list) {
      const sectionHeader = browserRoot?.firstElementChild;
      const headerTarget = [...sectionHeader?.children ?? []].find((child) => (
        child.tagName === "DIV"
        && child.querySelector("input") === null
        && child.querySelector("button") !== null
      )) ?? null;
      const tree = browserRoot?.querySelector('[role="tree"]');
      const grouped = tree?.querySelector('div[role="treeitem"][aria-expanded]') !== null;
      const rows = tree === null || tree === undefined
        ? []
        : [...tree.querySelectorAll('[role="treeitem"]')].filter((item) => (
          item.tagName === "DIV"
          && !item.hasAttribute("aria-expanded")
          && item.getAttribute("aria-selected") !== null
        ));
      const byId = list?.byId ?? {};
      const candidatesByTitle = new Map();
      for (const id of (grouped ? model.allIds : model.flatIds)) {
        const summary = byId[id];
        if (summary === undefined) continue;
        const title = summary.displayTitle || id;
        const candidates = candidatesByTitle.get(title) ?? [];
        candidates.push(id);
        candidatesByTitle.set(title, candidates);
      }
      const targets = [];
      for (const row of rows) {
        let id;
        if (list?.current !== undefined && row.getAttribute("aria-selected") === "true" && byId[list.current]?.blank === true) {
          id = list.current;
        } else {
          const candidates = candidatesByTitle.get(directSessionRowTitle(row));
          id = candidates?.shift();
        }
        const summary = byId[id];
        if (summary === undefined || summary.blank === true || summary.origin === "subagent") continue;
        targets.push({ id, element: row, title: summary.displayTitle || id });
      }
      return { sectionTarget: sectionHeader, headerTarget, targets };
    }

    /**
     * Distance between two boxes, zero when they overlap.
     * @param {DOMRect} left - first box.
     * @param {DOMRect} right - second box.
     * @returns {number} shortest gap between the boxes, in pixels.
     */
    function boxDistance(left, right) {
      const dx = Math.max(left.left - right.right, right.left - left.right, 0);
      const dy = Math.max(left.top - right.bottom, right.top - left.bottom, 0);
      return Math.hypot(dx, dy);
    }

    /**
     * The open popup menu that belongs to one session row.
     *
     * Every menu in the product is one primitives component, so a document-wide
     * `[role="menu"]` lookup also matches popups that have nothing to do with a
     * session row — the composer's permission dropdown, for instance. A row's
     * own menu is the visible menu anchored against that row's action button, so
     * the association is geometric: a menu further away than {@link MENU_ANCHOR_GAP_PX}
     * is not this row's, and null means the row has no open menu at all.
     * @param {Element|null} row - session row element.
     * @returns {Element|null} the row's open menu, or null when none is adjacent.
     */
    function openMenuForRow(row) {
      if (typeof document === "undefined" || row === null) return null;
      const anchor = [...row.querySelectorAll("button")].find((button) => button.getClientRects().length > 0);
      if (anchor === undefined) return null;
      const anchorRect = anchor.getBoundingClientRect();
      let closest = null;
      let closestDistance = Infinity;
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        const rect = menu.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (getComputedStyle(menu).visibility === "hidden") continue;
        const distance = boxDistance(rect, anchorRect);
        if (distance > MENU_ANCHOR_GAP_PX || distance >= closestDistance) continue;
        closest = menu;
        closestDistance = distance;
      }
      return closest;
    }

    function menuContentTarget(menu) {
      return menu?.querySelector('[role="presentation"]') ?? menu;
    }

    function keepSessionMenuOpen(row) {
      if (row === null || typeof PointerEvent !== "function") return;
      const trigger = [...row.querySelectorAll("button")].find((button) => button.getClientRects().length > 0);
      const menuRoot = trigger?.parentElement;
      menuRoot?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    }

    function createBatchManagementAction(t, sessions) {
      return function BatchManagementAction(props) {
        const list = typeof props.useSessions === "function" ? props.useSessions((state) => state) : EMPTY_SESSION_LIST;
        const workspaceList = typeof props.useWorkspaces === "function" ? props.useWorkspaces((state) => state) : EMPTY_WORKSPACE_LIST;
        const model = React.useMemo(() => buildSessionSelectionModel(list, workspaceList), [list, workspaceList]);
        const selectableSet = React.useMemo(() => new Set(model.selectableIds), [model.selectableIds]);
        const [managing, setManaging] = React.useState(false);
        const [selectedIds, setSelectedIds] = React.useState(() => new Set());
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [headerTarget, setHeaderTarget] = React.useState(null);
        const [sectionTarget, setSectionTarget] = React.useState(null);
        const [rowTargets, setRowTargets] = React.useState([]);
        const [menuTarget, setMenuTarget] = React.useState(null);
        const [menuDeleteTarget, setMenuDeleteTarget] = React.useState(null);
        const [menuDeleteBusy, setMenuDeleteBusy] = React.useState(false);
        const [menuDeleteError, setMenuDeleteError] = React.useState(null);
        const activeMenuRowRef = React.useRef(null);
        const activeMenuSessionRef = React.useRef(null);

        React.useEffect(() => {
          setSelectedIds((previous) => {
            const next = new Set([...previous].filter((id) => selectableSet.has(id)));
            if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
            return next;
          });
        }, [selectableSet]);

        React.useEffect(() => {
          if (props.wide || !managing) return;
          setManaging(false);
          setSelectedIds(new Set());
          setError(null);
        }, [managing, props.wide]);

        React.useEffect(() => {
          if (typeof document === "undefined") return undefined;
          const rememberMenuRow = (event) => {
            const source = event.target;
            if (source === null || typeof source.closest !== "function") return;
            const button = source.closest("button");
            const row = button?.closest('div[role="treeitem"][aria-selected]');
            if (row === null || row === undefined || row.hasAttribute("aria-expanded")) return;
            const target = rowTargets.find((candidate) => candidate.element === row);
            if (target === undefined) return;
            activeMenuRowRef.current = row;
            activeMenuSessionRef.current = { id: target.id, title: target.title };
          };
          document.addEventListener("click", rememberMenuRow, true);
          return () => document.removeEventListener("click", rememberMenuRow, true);
        }, [rowTargets]);

        React.useLayoutEffect(() => {
          let disposed = false;
          const refreshTargets = () => {
            if (disposed) return;
            const found = collectWorkspaceTargets(workspaceBrowserRoot(), model, list);
            setSectionTarget((previous) => previous === found.sectionTarget ? previous : found.sectionTarget);
            setHeaderTarget((previous) => previous === found.headerTarget ? previous : found.headerTarget);
            setRowTargets((previous) => targetsEqual(previous, found.targets) ? previous : found.targets);
            const activeSession = activeMenuSessionRef.current;
            const openMenu = activeMenuRowRef.current === null ? null : openMenuForRow(activeMenuRowRef.current);
            const contentTarget = menuContentTarget(openMenu);
            /* A remembered row whose menu is gone must not be reused: the next menu
               to open anywhere in the page would otherwise be mistaken for it. */
            if (contentTarget === null) {
              activeMenuRowRef.current = null;
              activeMenuSessionRef.current = null;
            }
            const nextMenuTarget = activeSession === null || contentTarget === null
              ? null
              : { host: contentTarget, id: activeSession.id, title: activeSession.title };
            setMenuTarget((previous) => previous !== null
              && nextMenuTarget !== null
              && previous.host === nextMenuTarget.host
              && previous.id === nextMenuTarget.id
              ? previous
              : nextMenuTarget);
          };
          refreshTargets();
          let observer;
          if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.body !== null) {
            observer = new MutationObserver(refreshTargets);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["aria-expanded", "aria-selected"],
            });
          }
          if (typeof window !== "undefined") window.addEventListener("resize", refreshTargets);
          return () => {
            disposed = true;
            observer?.disconnect();
            if (typeof window !== "undefined") window.removeEventListener("resize", refreshTargets);
          };
        }, [list, model]);

        const toggleSelected = (id, checked) => {
          setSelectedIds((previous) => {
            if (checked && !previous.has(id) && previous.size >= MAX_BATCH_SIZE) return previous;
            const next = new Set(previous);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
          });
          setError(null);
        };
        const startManaging = () => {
          setSelectedIds(new Set());
          setError(null);
          setManaging(true);
        };
        const cancelManaging = () => {
          if (busy) return;
          setSelectedIds(new Set());
          setError(null);
          setManaging(false);
        };
        const confirmManaging = async () => {
          if (busy) return;
          const selected = model.allIds.filter((id) => selectedIds.has(id) && selectableSet.has(id));
          if (selected.length === 0) return;
          await runConfirmedDelete({
            setBusy,
            setError,
            messageOf,
            t,
            attempt: async () => {
              await requestDeleteMany(selected);
              const selectedSet = new Set(selected);
              if (selectedSet.has(list.current)) {
                const archived = new Set(Array.isArray(workspaceList?.archivedSessionIds) ? workspaceList.archivedSessionIds : []);
                const nextSessionId = (Array.isArray(list.ids) ? list.ids : []).find((id) => {
                  const summary = list.byId[id];
                  return !selectedSet.has(id) && sessionIsVisible(summary, list.current, archived) && summary.blank !== true;
                });
                if (nextSessionId !== undefined && typeof sessions?.open === "function") sessions.open(nextSessionId);
                else if (typeof sessions?.clear === "function") sessions.clear(); else if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();

              }
            },
            settle: () => refreshSessionList(sessions),
          });
        };

        const openMenuDelete = (target) => {
          activeMenuRowRef.current = null;
          activeMenuSessionRef.current = null;
          setMenuTarget(null);
          setMenuDeleteError(null);
          setMenuDeleteBusy(false);
          setMenuDeleteTarget({ id: target.id, title: target.title });
        };
        const cancelMenuDelete = () => {
          if (menuDeleteBusy) return;
          setMenuDeleteTarget(null);
          setMenuDeleteError(null);
        };
        const confirmMenuDelete = async () => {
          if (menuDeleteBusy || menuDeleteTarget === null) return;
          const target = menuDeleteTarget;
          await runConfirmedDelete({
            setBusy: setMenuDeleteBusy,
            setError: setMenuDeleteError,
            messageOf,
            t,
            attempt: async () => {
              await requestDelete(target.id);
              if (list.current === target.id) {
                const archived = new Set(Array.isArray(workspaceList?.archivedSessionIds) ? workspaceList.archivedSessionIds : []);
                const nextSessionId = (Array.isArray(list.ids) ? list.ids : []).find((id) => {
                  const summary = list.byId[id];
                  return id !== target.id && sessionIsVisible(summary, list.current, archived) && summary.blank !== true;
                });
                if (nextSessionId !== undefined && typeof sessions?.open === "function") sessions.open(nextSessionId);
                else if (typeof sessions?.clear === "function") sessions.clear(); else if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();

              }
            },
            settle: () => refreshSessionList(sessions),
          });
        };

        const modeMarker = !managing || sectionTarget === null
          ? null
          : createPortal(React.createElement("span", { className: "dss-batch-mode-marker", "aria-hidden": "true" }), sectionTarget, "dss-batch-mode-marker");
        const controls = !props.wide || headerTarget === null ? null : createPortal(
          managing
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dss-batch-control",
                    "aria-label": t("cancel"),
                    disabled: busy,
                    onClick: cancelManaging,
                  },
                  t("cancel"),
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dss-batch-control dss-batch-control-danger",
                    "aria-label": t("manage.confirm", { n: selectedIds.size }),
                    disabled: busy || selectedIds.size === 0,
                    onClick: () => void confirmManaging(),
                  },
                  busy ? t("manage.busy") : t("manage.confirm", { n: selectedIds.size }),
                ),
              )
            : React.createElement(
                "button",
                {
                  type: "button",
                  className: "dss-batch-control dss-batch-control-icon",
                  "aria-label": t("manage.start"),
                  title: t("manage.start"),
                  onClick: startManaging,
                },
                icon("checklist", 16, "☷"),
              ),
          headerTarget,
          "dss-batch-controls",
        );
        const menuDeleteItem = !managing && menuTarget !== null
          ? createPortal(
              React.createElement(
                "div",
                { className: "dss-menu-delete-wrap" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    role: "menuitem",
                    className: "dss-menu-delete-item",
                    onPointerEnter: () => keepSessionMenuOpen(activeMenuRowRef.current),
                    onClick: (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openMenuDelete(menuTarget);
                    },
                  },
                  React.createElement(
                    "span",
                    { className: "dss-menu-delete-icon" },
                    icon("trash", 14, "×"),
                  ),
                  t("menu.delete"),
                ),
              ),
              menuTarget.host,
              "dss-menu-delete-item",
            )
          : null;
        const checkboxPortals = managing
          ? rowTargets.map((target) => createPortal(
              React.createElement(
                "span",
                {
                  className: "dss-session-checkbox-host",
                  onClick: (event) => event.stopPropagation(),
                  onMouseDown: (event) => event.stopPropagation(),
                  onPointerDown: (event) => event.stopPropagation(),
                },
                React.createElement("input", {
                  type: "checkbox",
                  checked: selectedIds.has(target.id),
                  disabled: busy || (!selectedIds.has(target.id) && selectedIds.size >= MAX_BATCH_SIZE),
                  "aria-label": t("manage.session.aria", { name: target.title }),
                  onChange: (event) => toggleSelected(target.id, event.target.checked),
                }),
              ),
              target.element,
              `dss-session-checkbox-${target.id}`,
            ))
          : null;
        const status = error === null
          ? null
          : React.createElement("div", { className: "dss-batch-status", role: "alert" }, error);
        const menuDialog = menuDeleteTarget === null
          ? null
          : React.createElement(ConfirmDialog, {
              t,
              titleId: "dss-menu-delete-title",
              name: menuDeleteTarget.title,
              error: menuDeleteError,
              busy: menuDeleteBusy,
              onCancel: cancelMenuDelete,
              onConfirm: () => void confirmMenuDelete(),
            });

        const footerControls = !props.wide
          ? managing
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement("button", { type: "button", className: "dss-batch-control", "aria-label": t("cancel"), disabled: busy, onClick: cancelManaging }, t("cancel")),
                React.createElement("button", { type: "button", className: "dss-batch-control dss-batch-control-danger", "aria-label": t("manage.confirm", { n: selectedIds.size }), disabled: busy || selectedIds.size === 0, onClick: () => void confirmManaging() }, busy ? t("manage.busy") : t("manage.confirm", { n: selectedIds.size })),
              )
            : React.createElement(
                "button",
                { type: "button", className: "dss-action", "aria-label": t("manage.start"), title: t("manage.start"), onClick: startManaging },
                icon("checklist", 16, "☷"),
              )
          : null;
        return React.createElement(
          React.Fragment,
          null,
          footerControls,
          modeMarker,
          controls,
          menuDeleteItem,
          checkboxPortals,
          status,
          menuDialog,
        );
      };
    }

    function createDeleteSessionAction(t, sessions) {
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
        await runConfirmedDelete({
          setBusy,
          setError,
          messageOf,
          t,
          attempt: async () => {
            await requestDelete(props.sessionId);
            // The slot's own props carry no `sessions` seat, so the service is the
            // one closed over at registration — the same one the batch action uses.
            if (nextSessionId !== undefined && typeof sessions?.open === "function") sessions.open(nextSessionId);
            else if (typeof sessions?.clear === "function") sessions.clear(); else if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();
          },
          settle: () => refreshSessionList(sessions),
        });
      };

      const trashIcon = icon("trash", 16, "×");

      const dialog = confirming
        ? React.createElement(ConfirmDialog, {
            t,
            titleId: "dss-delete-title",
            name: title,
            error,
            busy,
            onCancel: cancel,
            onConfirm: () => void confirmDelete(),
          })
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
      const DeleteSessionAction = createDeleteSessionAction(t, ctx.sessions);
      ctx.effect(() => installStyle(), "delete-session: stylesheet");
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "delete-session-batch",
        order: 100,
        inject: () => ({}),
      }, createBatchManagementAction(t, ctx.sessions)));
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "delete-session",
        order: 100,
        inject: () => ({}),
      }, DeleteSessionAction));
    }

    exports.apply = apply;
    exports.inject = inject;
    /* Pure helpers the Node test suite exercises directly; the browser half
       reads only `apply` and `inject` from these exports. */
    exports.__test = {
      MENU_ANCHOR_GAP_PX,
      boxDistance,
      menuContentTarget,
      openMenuForRow,
      refreshSessionList,
      runConfirmedDelete,
    };
    return module.exports;
  },
});

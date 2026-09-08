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

    const LOCALE_NS = "delete-session";
    const ZH_DICT = {
      cancel: "取消",
      "confirm.title": "删除会话",
      "menu.delete": "删除会话",
      "confirm.body": "确定要删除“{name}”吗？",
      "confirm.warning": "会话日志及其会话专属临时文件将被永久删除，无法恢复。",
      "delete.busy": "删除中…",
      "delete.confirm": "永久删除",
      "manage.start": "批量管理",
      "manage.confirm": "确认删除 ({n})",
      "manage.session.aria": "选择会话“{name}”",
      "manage.busy": "删除中…",
    };
    const EN_DICT = {
      cancel: "Cancel",
      "confirm.title": "Delete session",
      "menu.delete": "Delete session",
      "confirm.body": "Delete “{name}”?",
      "confirm.warning": "The session transcript and its temporary workspace files will be permanently deleted and cannot be recovered.",
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
 .dss-batch-control{box-sizing:border-box;min-width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:inherit;font-size:12px;line-height:18px;white-space:nowrap}
 .dss-batch-control:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
 .dss-batch-control:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
 .dss-batch-control:disabled{opacity:.55;cursor:default}
 .dss-batch-control-danger{color:var(--dsw-alias-state-error-primary,#b91c1c)}
 .dss-batch-control-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#b91c1c)}
 div:has(> .dss-batch-control){max-width:160px!important;overflow:visible!important}
  .dss-batch-control-icon{width:28px;height:28px;min-width:28px;padding:0;border-radius:50%}
  div:has(> .dss-batch-mode-marker) button:not(.dss-batch-control){display:none!important}
  .dss-batch-mode-marker{display:none!important}
 .dss-session-checkbox-host{position:absolute;z-index:2;left:4px;top:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;transform:translateY(-50%);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#fff)}
 .dss-session-checkbox-host input{box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#2563eb);cursor:pointer}
 .dss-session-checkbox-host:focus-within{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}
 div[role="treeitem"]:has(> .dss-session-checkbox-host){position:relative}
  .dss-batch-status{position:absolute;z-index:3;left:8px;right:8px;bottom:8px;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px;overflow-wrap:anywhere;box-shadow:0 4px 14px rgba(0,0,0,.12)}
 .dss-menu-delete-wrap{box-sizing:border-box;width:100%;padding:0}
 .dss-menu-delete-item{box-sizing:border-box;width:100%;min-height:40px;display:flex;align-items:center;gap:8px;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary,#b91c1c);cursor:pointer;font:inherit;font-size:14px;line-height:22px;text-align:left}
 .dss-menu-delete-item:hover{background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
 .dss-menu-delete-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-2px}
 .dss-menu-delete-icon{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex:none}

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
        throw new Error(`delete-session API returned HTTP ${response.status}`);
      }
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || `delete-session API returned HTTP ${response.status}`);
      }
      return result;
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

    function openMenuForRow(row) {
      if (typeof document === "undefined" || row === null) return null;
      const anchor = [...row.querySelectorAll("button")].find((button) => button.getClientRects().length > 0);
      const anchorRect = anchor?.getBoundingClientRect();
      const menus = [...document.querySelectorAll('[role="menu"]')].filter((menu) => {
        const rect = menu.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(menu).visibility !== "hidden";
      });
      if (menus.length === 0) return null;
      if (anchorRect === undefined) return menus.at(-1) ?? null;
      return menus.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftDistance = Math.abs(leftRect.left - anchorRect.left) + Math.abs(leftRect.top - anchorRect.top);
        const rightDistance = Math.abs(rightRect.left - anchorRect.left) + Math.abs(rightRect.top - anchorRect.top);
        return leftDistance - rightDistance;
      })[0] ?? null;
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
          setBusy(true);
          setError(null);
          try {
            await requestDeleteMany(selected);
            const selectedSet = new Set(selected);
            if (selectedSet.has(list.current)) {
              const archived = new Set(Array.isArray(workspaceList?.archivedSessionIds) ? workspaceList.archivedSessionIds : []);
              const nextSessionId = (Array.isArray(list.ids) ? list.ids : []).find((id) => {
                const summary = list.byId[id];
                return !selectedSet.has(id) && sessionIsVisible(summary, list.current, archived) && summary.blank !== true;
              });
              if (nextSessionId !== undefined && typeof sessions?.open === "function") sessions.open(nextSessionId);
              else if (typeof sessions?.clear === "function") sessions.clear();
            }
            if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();
          } catch (reason) {
            setBusy(false);
            setError(messageOf(reason));
          }
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
          setMenuDeleteBusy(true);
          setMenuDeleteError(null);
          try {
            await requestDelete(target.id);
            if (list.current === target.id) {
              const archived = new Set(Array.isArray(workspaceList?.archivedSessionIds) ? workspaceList.archivedSessionIds : []);
              const nextSessionId = (Array.isArray(list.ids) ? list.ids : []).find((id) => {
                const summary = list.byId[id];
                return id !== target.id && sessionIsVisible(summary, list.current, archived) && summary.blank !== true;
              });
              if (nextSessionId !== undefined && typeof sessions?.open === "function") sessions.open(nextSessionId);
              else if (typeof sessions?.clear === "function") sessions.clear();
            }
            if (typeof window !== "undefined" && typeof window.location?.reload === "function") window.location.reload();
          } catch (reason) {
            setMenuDeleteBusy(false);
            setMenuDeleteError(messageOf(reason));
          }
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
                primitives.IconChecklistOutline14
                  ? React.createElement(primitives.IconChecklistOutline14, { size: 16 })
                  : React.createElement("span", { "aria-hidden": "true" }, "☷"),
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
                    primitives.IconTrashOutline16
                      ? React.createElement(primitives.IconTrashOutline16, { size: 16 })
                      : React.createElement("span", { "aria-hidden": "true" }, "×"),
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
          : React.createElement(
              "div",
              {
                className: "dss-overlay",
                role: "presentation",
                onClick: cancelMenuDelete,
              },
              React.createElement(
                "div",
                {
                  className: "dss-dialog",
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-labelledby": "dss-menu-delete-title",
                  onClick: (event) => event.stopPropagation(),
                },
                React.createElement("h2", { id: "dss-menu-delete-title", className: "dss-title" }, t("confirm.title")),
                React.createElement("p", { className: "dss-copy" }, t("confirm.body", { name: menuDeleteTarget.title })),
                React.createElement("p", { className: "dss-warning" }, t("confirm.warning")),
                menuDeleteError === null ? null : React.createElement("div", { className: "dss-error", role: "alert" }, menuDeleteError),
                React.createElement(
                  "div",
                  { className: "dss-buttons" },
                  React.createElement("button", { type: "button", className: "dss-button", disabled: menuDeleteBusy, onClick: cancelMenuDelete }, t("cancel")),
                  React.createElement("button", { type: "button", className: "dss-button dss-button-danger", disabled: menuDeleteBusy, onClick: () => void confirmMenuDelete() }, menuDeleteBusy ? t("delete.busy") : t("delete.confirm")),
                ),
              ),
            );

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
                primitives.IconChecklistOutline14
                  ? React.createElement(primitives.IconChecklistOutline14, { size: 16 })
                  : React.createElement("span", { "aria-hidden": "true" }, "☷"),
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
    return module.exports;
  },
});

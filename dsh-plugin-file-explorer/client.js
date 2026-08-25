/**
 * dsh-plugin-file-explorer — browser bundle (static DSH client module).
 *
 * Renders the file explorer into the `details` slot (right layout column),
 * replacing the native tool-details panel while running. The column squeezes
 * the conversation and keeps the native resizer handle.
 *
 * Two views behind the header tabs:
 *  - Files: directory browser (list / read / download / delete via the
 *    /_dsh/file-explorer API).
 *  - Git Graph: a vscode/git-graph style commit DAG with colored lanes, ref
 *    pills, a working-tree row, expandable commit details, and per-file diffs
 *    (via the /_dsh/file-explorer/git-* API).
 */
window.__ModuleLoader__.load({
	id: "@yiln-dsh/dsh-plugin-file-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const inject = ["slots", "layout"];

		function apply(ctx) {
			const slots = ctx.get('slots')
			const layout = ctx.get('layout')
			if (slots === undefined) return

			const style = document.createElement("style");
			style.id = "dsh-plugin-file-explorer-style";
			style.setAttribute("data-plugin", "dsh-plugin-file-explorer");
			style.textContent = `
.dsh-fe-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
  overflow: hidden;
}
.dsh-fe-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 10px 12px 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  box-sizing: border-box;
}
.dsh-fe-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-fe-icon {
  flex: 0 0 auto;
  cursor: pointer;
  width: 28px;
  height: 28px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-icon:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
}
.dsh-fe-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
}
.dsh-fe-tab {
  flex: 1 1 0;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.dsh-fe-tab:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-fe-tab-active,
.dsh-fe-tab-active:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-primary, #111827);
  font-weight: 600;
}
.dsh-fe-path {
  min-width: 0;
  margin: 8px 12px 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #57534e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  box-sizing: border-box;
  background: transparent;
  text-align: left;
}
.dsh-fe-path:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-fe-path-input {
  width: 100%;
  box-sizing: border-box;
  margin: 8px 12px 0;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  outline: none;
  width: calc(100% - 24px);
}
.dsh-fe-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 4px;
}
.dsh-fe-toolbutton {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-toolbutton:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-fe-toolbutton:disabled {
  opacity: 0.35;
  cursor: default;
}
.dsh-fe-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 10px;
}
.dsh-fe-row {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  text-align: left;
  box-sizing: border-box;
  font: inherit;
}
.dsh-fe-row:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-fe-marker {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-marker-dir {
  color: var(--dsw-alias-brand-primary, #4f46e5);
}
.dsh-fe-marker-file {
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-fe-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.dsh-fe-meta {
  flex: 0 0 auto;
  min-width: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.dsh-fe-size {
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-fe-actions {
  display: none;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.dsh-fe-row:hover .dsh-fe-actions {
  display: inline-flex;
}
.dsh-fe-row:hover .dsh-fe-size {
  display: none;
}
.dsh-fe-action {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #57534e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-action:hover {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-fe-action-danger:hover {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dsh-fe-action-confirm {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dsh-fe-status {
  margin: 8px 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 12px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dsh-fe-status-error {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dsh-fe-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 45%, transparent);
  pointer-events: auto;
}
.dsh-fe-modal {
  width: min(680px, calc(100vw - 40px));
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 8px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.dsh-fe-modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-fe-modal-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.dsh-fe-modal-meta {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12px;
}
.dsh-fe-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dsh-git-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 2px;
}
.dsh-git-scope {
  margin-left: auto;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  font-size: 11px;
}
.dsh-git-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 14px 6px;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 11px;
}
.dsh-git-info-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #111827);
  font-weight: 600;
}
.dsh-git-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 10px;
}
.dsh-git-row {
  width: 100%;
  height: 38px;
  display: flex;
  align-items: stretch;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  padding: 0;
  font: inherit;
  overflow: hidden;
}
.dsh-git-row:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-git-cell {
  flex: 0 0 auto;
  display: block;
}
.dsh-git-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 8px 0 2px;
}
.dsh-git-line1 {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.dsh-git-subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-git-line2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-pill {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 15px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.dsh-git-pill-head {
  background: var(--dsw-alias-brand-primary, #4f46e5);
  color: #fff;
}
.dsh-git-pill-branch {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-git-pill-remote {
  background: transparent;
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-pill-tag {
  background: rgba(217, 119, 6, 0.16);
  color: #b45309;
}
.dsh-git-pill-detached {
  background: transparent;
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  color: var(--dsw-alias-label-secondary, #78716c);
  font-style: italic;
}
.dsh-git-detail {
  padding: 2px 8px 10px 36px;
}
.dsh-git-msg {
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-git-files-title {
  margin: 0 2px 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-file {
  width: 100%;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.dsh-git-file:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-git-badge {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.dsh-git-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  unicode-bidi: plaintext;
}
.dsh-fe-rail {
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
}
/* While collapsed, keep a real RAIL_WIDTH column in the layout (like the left
   sidebar's 56px rail) instead of a floating overlay. This !important rule
   overrides React's inline grid-template-columns on the app frame; the data
   attribute is added by applyRail() and removed on expand/unload. */
[data-dsh-fe-rail] {
  grid-template-columns: var(--dsh-fe-rail-sidebar, 280px) minmax(0, 1fr) 56px !important;
}
.dsh-fe-rail-button {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-rail-button:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-brand-primary, #4f46e5);
}
`;
			document.head.append(style);

			// --- details-column width persistence ---------------------------------
			// The shell's layout store is transient: openDetails() resets the column
			// to its 360px contract default on every mount and session switch. The
			// bound store actions reach the LayoutController after every client
			// module has applied (the root entry's inject hook fires on first
			// render and again on re-register), so wrapping attachPanels on the
			// prototype captures them reliably. setDetails then restores the last
			// user-chosen width, and a document-level pointerup listener persists
			// the column width after each resizer drag.
			const WIDTH_KEY = "dsh-plugin-file-explorer.detailsWidth";
			const WIDTH_MIN = 300; // the layout contract's clamp floor
			let panelActions = null;
			let savedWidth = 0;
			try { savedWidth = Number(window.localStorage.getItem(WIDTH_KEY)) || 0 } catch (_e) { }

			const findDetailsColumn = () => {
				// The details column's own class is the reliable anchor: the drag
				// handle's previousElementSibling is the sidebar handle or the
				// overlay layer, never the column itself.
				const byClass = document.querySelector('[class*="detailsCol"]')
				if (byClass !== null) return byClass
				const handle = document.querySelector('[data-side="details"]')
				if (handle !== null && handle.previousElementSibling !== null) return handle.previousElementSibling
				return null
			}
			const persistWidth = () => {
				const column = findDetailsColumn()
				if (column === null) return
				const width = Math.round(column.getBoundingClientRect().width)
				if (width < WIDTH_MIN) return
				savedWidth = width
				try { window.localStorage.setItem(WIDTH_KEY, String(width)) } catch (_e) { }
			}
			const onDocumentPointerUp = () => { persistWidth() }
			document.addEventListener("pointerup", onDocumentPointerUp, true)
			ctx.effect(() => () => document.removeEventListener("pointerup", onDocumentPointerUp, true))

			if (layout !== undefined) {
				const proto = Object.getPrototypeOf(layout)
				if (proto !== null && typeof proto.attachPanels === "function") {
					const originalAttach = proto.attachPanels
					proto.attachPanels = function (actions) {
						panelActions = actions
						return originalAttach.call(this, actions)
					}
					ctx.effect(() => () => { proto.attachPanels = originalAttach })
				}
			}
			const restoreWidth = () => {
				if (savedWidth < WIDTH_MIN) return
				if (panelActions === null || typeof panelActions.setDetails !== "function") return
				try { panelActions.setDetails(savedWidth) } catch (_e) { }
			}

			// --- collapsed rail as a real layout column --------------------------
			// The layout contract gives the sidebar a 56px rail when closed but
			// closes the details column to 0px (no rail). To collapse like the left
			// sidebar, keep the store closed (no drag handle / border) and force the
			// frame's third grid track to RAIL_WIDTH via an !important stylesheet
			// rule keyed on a data attribute we own. CSS !important beats React's
			// inline grid style, so there is no fight with React re-renders: set the
			// attribute to collapse, remove it to expand. A MutationObserver only
			// refreshes the sidebar-width variable (the first track) when the app
			// re-renders the frame.
			const RAIL_WIDTH = 56;
			let railActive = false;
			const frameOfDetails = () => {
				const column = findDetailsColumn();
				if (column === null || column.parentElement === null) return null;
				return column.parentElement;
			};
			const syncRailVar = () => {
				const frame = frameOfDetails();
				if (frame === null) return;
				const sideCol = frame.children.length > 0 ? frame.children[0] : null;
				const sidebarPx = sideCol !== null ? Math.round(sideCol.getBoundingClientRect().width) : 280;
				try { frame.style.setProperty("--dsh-fe-rail-sidebar", `${sidebarPx}px`) } catch (_e) { }
			};
			const applyRail = () => {
				const frame = frameOfDetails();
				if (frame === null) return;
				if (railActive) {
					frame.setAttribute("data-dsh-fe-rail", "");
					syncRailVar();
				} else {
					frame.removeAttribute("data-dsh-fe-rail");
				}
			};
			const releaseRail = () => {
				railActive = false;
				applyRail();
			};
			let railObserver = null;
			if (typeof MutationObserver === "function") {
				railObserver = new MutationObserver(() => {
					if (railActive) syncRailVar();
				});
				ctx.effect(() => {
					const frame = frameOfDetails();
					if (frame !== null) railObserver.observe(frame, { attributes: true, attributeFilter: ["style"] });
					return () => {
						railObserver?.disconnect();
						const frame = frameOfDetails();
						if (frame !== null) frame.removeAttribute("data-dsh-fe-rail");
						railActive = false;
					};
				});
			}
			// -----------------------------------------------------------------------

			async function api(method, payload) {
				const options = { headers: { "content-type": "application/json" } };
				options.method = "POST";
				options.body = JSON.stringify(payload === undefined ? {} : payload);
				const response = await fetch(`/_dsh/file-explorer/${method}`, options);
				let data;
				try {
					data = await response.json();
				} catch {
					throw new Error(`file explorer API returned HTTP ${response.status}`);
				}
				if (!response.ok || data.ok === false) {
					throw new Error(data.error || `file explorer API returned HTTP ${response.status}`);
				}
				return data;
			}

			function svgIcon(icon, size) {
				return React.createElement('svg', {
					viewBox: '0 0 24 24',
					width: size || 16,
					height: size || 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				}, icon)
			}
			const folderIcon = React.createElement('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })
			const fileIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
				React.createElement('polyline', { points: '14 2 14 8 20 8' }),
			)
			const upIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M12 19V5' }),
				React.createElement('polyline', { points: '5 12 12 5 19 12' }),
			)
			const refreshIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M3 12a9 9 0 1 0 2.64-6.36' }),
				React.createElement('polyline', { points: '21 3 21 9 15 9' }),
			)
			const eyeIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' }),
				React.createElement('circle', { cx: '12', cy: '12', r: '3' }),
			)
			const downloadIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
				React.createElement('polyline', { points: '7 10 12 15 17 10' }),
				React.createElement('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
			)
			const trashIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M3 6h18' }),
				React.createElement('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
				React.createElement('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
				React.createElement('line', { x1: '10', y1: '11', x2: '10', y2: '17' }),
				React.createElement('line', { x1: '14', y1: '11', x2: '14', y2: '17' }),
			)
			const closeIcon = React.createElement(React.Fragment, null,
				React.createElement('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
				React.createElement('line', { x1: '6', y1: '6', x2: '18', y2: '18' }),
			)
			// Mirror of DeepSeek's sidebar IconPanelLeftOutline16 (spine on the
			// right): this panel lives on the right edge, so the glyph mirrors the
			// left sidebar's, signaling collapse into the right-edge icon rail.
			const collapseIcon = React.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 16,
				height: 16,
				fill: 'none',
				'aria-hidden': true,
			},
				React.createElement('g', { transform: 'translate(16,0) scale(-1,1)' },
					React.createElement('path', {
						fillRule: 'evenodd',
						clipRule: 'evenodd',
						fill: 'currentColor',
						d: 'M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z',
					}),
				),
			)
			const branchIcon = React.createElement(React.Fragment, null,
				React.createElement('line', { x1: '6', y1: '3', x2: '6', y2: '15' }),
				React.createElement('circle', { cx: '18', cy: '6', r: '3' }),
				React.createElement('circle', { cx: '6', cy: '18', r: '3' }),
				React.createElement('path', { d: 'M18 9a9 9 0 0 1-9 9' }),
			)

			function formatSize(size) {
				if (typeof size !== 'number' || !Number.isFinite(size)) return ''
				if (size < 1024) return `${size} B`
				if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
				if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
				return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
			}

			// --- git graph helpers -------------------------------------------------

			const LANE_COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777']
			const STATUS_COLORS = {
				A: '#16a34a', M: '#d97706', D: '#dc2626', R: '#2563eb', C: '#2563eb',
				T: '#d97706', U: '#7c3aed', B: '#6b7280', X: '#6b7280', '?': '#6b7280',
			}
			const GIT_ROW_H = 38

			function statusColor(letter) {
				return STATUS_COLORS[letter] || '#6b7280'
			}

			function relTime(epochSeconds) {
				if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
				const s = Math.max(0, Date.now() / 1000 - epochSeconds)
				if (s < 60) return 'just now'
				if (s < 3600) return `${Math.floor(s / 60)}m ago`
				if (s < 86400) return `${Math.floor(s / 3600)}h ago`
				if (s < 604800) return `${Math.floor(s / 86400)}d ago`
				if (s < 2592000) return `${Math.floor(s / 604800)}w ago`
				if (s < 31536000) return `${Math.floor(s / 2592000)}mo ago`
				return `${Math.floor(s / 31536000)}y ago`
			}

			function shortHash(hash) {
				return typeof hash === 'string' && hash.length > 7 ? hash.slice(0, 7) : (hash || '')
			}

			// Turn the linear commit list (newest first) into graph rows with lane
			// assignments and parent edges, mirroring git-graph/vscode style layout:
			// each lane tracks the hash expected to appear there next; a commit
			// consumes its lane and re-fills it with its first parent, while extra
			// parents take new lanes (drawn as merge curves).
			function buildGraphData(commits) {
				const lanes = [] // expected hash per lane; null = free slot
				const colorOf = new Map()
				let nextColor = 0
				const pickColor = (hash, preferred) => {
					let c = colorOf.get(hash)
					if (c === undefined) {
						if (preferred === undefined) {
							c = nextColor % LANE_COLORS.length
							nextColor += 1
						} else {
							c = preferred % LANE_COLORS.length
						}
						colorOf.set(hash, c)
					}
					return c
				}
				const rows = commits.map((commit) => {
					const parents = Array.isArray(commit.parents)
						? commit.parents.filter((p) => typeof p === 'string' && p !== '')
						: []
					const inLanes = lanes.slice()
					let lane = lanes.indexOf(commit.hash)
					const isNew = lane === -1
					if (isNew) {
						let free = lanes.indexOf(null)
						if (free === -1) {
							lanes.push(null)
							free = lanes.length - 1
						}
						lane = free
					}
					const color = pickColor(commit.hash)
					lanes[lane] = null
					const edges = []
					parents.forEach((p, pi) => {
						let pl = lanes.indexOf(p)
						if (pl === -1) {
							let slot = pi === 0 ? lane : lanes.indexOf(null)
							if (slot === -1) {
								lanes.push(p)
								slot = lanes.length - 1
							} else {
								lanes[slot] = p
							}
							pl = slot
						}
						const pColor = pickColor(p, pi === 0 ? color : undefined)
						edges.push({ from: lane, to: pl, color: pColor })
					})
					return { commit, lane, color, isNew, inLanes, edges }
				})
				let width = 1
				rows.forEach((r) => {
					if (r.lane + 1 > width) width = r.lane + 1
					r.edges.forEach((e) => { if (e.to + 1 > width) width = e.to + 1 })
				})
				return { rows, width, colorOf }
			}

			// One commit row's graph cell: pass-through lanes, its incoming stub,
			// parent edges (straight for first parents, curves for merges), dot.
			function GraphSvg(props) {
				const { row, width, colorOf } = props
				const laneW = 12
				const padL = 9
				const xOf = (l) => padL + l * laneW
				// Cell width follows THIS row's actual lanes (lane indices are
				// absolute, so columns stay aligned row-to-row; this just trims the
				// empty right side that a global max-lane width would leave on
				// mostly-linear rows). 1 lane = 24px, so linear history renders
				// compact and the commit text sits right next to the graph.
				let rowLanes = row.lane + 1
				row.edges.forEach((e) => {
					if (e.from + 1 > rowLanes) rowLanes = e.from + 1
					if (e.to + 1 > rowLanes) rowLanes = e.to + 1
				})
				row.inLanes.forEach((hash, k) => {
					if (hash !== null && hash !== undefined && k + 1 > rowLanes) rowLanes = k + 1
				})
				const w = rowLanes * laneW + padL + 3
				const h = GIT_ROW_H
				const cy = h / 2
				const els = []
				const colorOfHash = (hash) => {
					const c = colorOf.get(hash)
					return LANE_COLORS[(typeof c === 'number' ? c : 0) % LANE_COLORS.length]
				}
				row.inLanes.forEach((hash, k) => {
					if (hash === null || hash === undefined || hash === row.commit.hash) return
					els.push(React.createElement('line', {
						key: 'p' + k,
						x1: xOf(k), y1: 0, x2: xOf(k), y2: h,
						stroke: colorOfHash(hash), strokeWidth: 1.5,
					}))
				})
				if (!row.isNew) {
					els.push(React.createElement('line', {
						key: 'in',
						x1: xOf(row.lane), y1: 0, x2: xOf(row.lane), y2: cy,
						stroke: LANE_COLORS[row.color % LANE_COLORS.length], strokeWidth: 1.5,
					}))
				}
				row.edges.forEach((edge, i) => {
					const stroke = LANE_COLORS[edge.color % LANE_COLORS.length]
					if (edge.from === edge.to) {
						els.push(React.createElement('line', {
							key: 'e' + i,
							x1: xOf(edge.from), y1: cy, x2: xOf(edge.to), y2: h,
							stroke, strokeWidth: 1.5,
						}))
					} else {
						const bend = (h - cy) * 0.55
						const d = 'M ' + xOf(edge.from) + ' ' + cy +
							' C ' + xOf(edge.from) + ' ' + (cy + bend) +
							', ' + xOf(edge.to) + ' ' + (h - bend) +
							', ' + xOf(edge.to) + ' ' + h
						els.push(React.createElement('path', {
							key: 'e' + i, d, fill: 'none', stroke, strokeWidth: 1.5,
						}))
					}
				})
				els.push(React.createElement('circle', {
					key: 'dot',
					cx: xOf(row.lane), cy, r: 3.5,
					fill: LANE_COLORS[row.color % LANE_COLORS.length],
					stroke: 'var(--dsw-alias-bg-base, #ffffff)', strokeWidth: 1,
				}))
				return React.createElement('svg', {
					className: 'dsh-git-cell',
					width: w, height: h,
					viewBox: '0 0 ' + w + ' ' + h,
				}, els)
			}

			// Uncommitted-changes pseudo row at the top of the graph.
			function WorkTreeCell(props) {
				const { lane, connectorColor } = props
				const laneW = 12
				const padL = 9
				const xOf = (l) => padL + l * laneW
				const laneIdx = typeof lane === 'number' && lane >= 0 ? lane : 0
				const w = (laneIdx + 1) * laneW + padL + 3
				const h = GIT_ROW_H
				const cy = h / 2
				const x = xOf(laneIdx)
				const els = []
				if (connectorColor !== null) {
					els.push(React.createElement('line', {
						key: 'c', x1: x, y1: cy, x2: x, y2: h,
						stroke: connectorColor, strokeWidth: 1.5,
					}))
				}
				els.push(React.createElement('circle', {
					key: 'dot', cx: x, cy, r: 3.5,
					fill: 'none',
					stroke: 'var(--dsw-alias-label-secondary, #78716c)', strokeWidth: 1.2,
					strokeDasharray: '2 2',
				}))
				return React.createElement('svg', {
					className: 'dsh-git-cell',
					width: w, height: h,
					viewBox: '0 0 ' + w + ' ' + h,
				}, els)
			}

			function RefPills(props) {
				const refs = props.refs
				if (!Array.isArray(refs) || refs.length === 0) return null
				return React.createElement(React.Fragment, null, refs.map((ref, i) =>
					React.createElement('span', {
						key: i,
						className: 'dsh-git-pill dsh-git-pill-' + ref.kind,
						title: ref.name,
					}, ref.name),
				))
			}

			function StatusBadge(props) {
				return React.createElement('span', {
					className: 'dsh-git-badge',
					style: { background: statusColor(props.letter) },
				}, props.letter)
			}

			function GitFileRow(props) {
				const file = props.file
				const label = file.oldPath ? file.oldPath + ' → ' + file.path : file.path
				return React.createElement('button', {
					type: 'button',
					className: 'dsh-git-file',
					onClick: () => props.onOpen(file),
					title: label,
				},
					React.createElement(StatusBadge, { letter: file.status }),
					React.createElement('span', { className: 'dsh-git-file-path' }, label),
				)
			}

			// The whole Git Graph view: toolbar (refresh + branch scope), repo info
			// line, the commit lane rows with an expandable per-commit detail, and a
			// diff modal. Data comes entirely from the /_dsh/file-explorer/git-*
			// JSON API.
			function GitGraphView(props) {
				const api = props.api
				const cwd = props.cwd
				const [scope, setScope] = React.useState('all')
				const [log, setLog] = React.useState(null)
				const [status, setStatus] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [loading, setLoading] = React.useState(false)
				const [tick, setTick] = React.useState(0)
				const [selected, setSelected] = React.useState(null) // commit hash or 'WORKING'
				const [details, setDetails] = React.useState({}) // hash -> {message, files} | {error}
				const [diff, setDiff] = React.useState(null)

				React.useEffect(() => {
					if (cwd === undefined) return
					let cancelled = false
					setLoading(true)
					setError(null)
					setLog(null)
					setSelected(null)
					setDetails({})
					setStatus(null)
					api('git-log', { path: cwd, all: scope === 'all', limit: 300 })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setLog(raw)
							} else {
								setError(raw && typeof raw.error === 'string' ? raw.error : 'Failed to load git log')
							}
						})
						.catch((err) => {
							if (!cancelled) setError(err && typeof err.message === 'string' ? err.message : String(err))
						})
						.finally(() => {
							if (!cancelled) setLoading(false)
						})
					api('git-status', { path: cwd })
						.then((raw) => { if (!cancelled && raw && raw.ok === true) setStatus(raw) })
						.catch(() => { })
					return () => { cancelled = true }
				}, [cwd, scope, tick])

				// Lazy-load the selected commit's changed-file list.
				React.useEffect(() => {
					if (selected === null || selected === 'WORKING') return
					if (details[selected]) return
					let cancelled = false
					api('git-commit', { path: cwd, hash: selected })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setDetails((prev) => ({ ...prev, [selected]: raw }))
							} else {
								setDetails((prev) => ({ ...prev, [selected]: { error: raw && typeof raw.error === 'string' ? raw.error : 'Failed to load commit' } }))
							}
						})
						.catch((err) => {
							if (!cancelled) setDetails((prev) => ({ ...prev, [selected]: { error: err && typeof err.message === 'string' ? err.message : String(err) } }))
						})
					return () => { cancelled = true }
				}, [selected, cwd])

				if (cwd === undefined) return null

				const reload = () => { setTick((t) => t + 1) }
				const toggle = (key) => setSelected((cur) => (cur === key ? null : key))

				const openDiff = (hash, file) => {
					setDiff({ title: file.path, hash, loading: true, text: null, error: null })
					api('git-diff', { path: cwd, hash, file: file.path })
						.then((raw) => {
							if (raw && raw.ok === true) {
								const note = raw.truncated ? '\n\n… (diff truncated)' : ''
								setDiff({ title: file.path, hash, loading: false, text: (raw.patch || '') + note, error: null })
							} else {
								setDiff({ title: file.path, hash, loading: false, text: null, error: raw && typeof raw.error === 'string' ? raw.error : 'Failed to load diff' })
							}
						})
						.catch((err) => {
							setDiff({ title: file.path, hash, loading: false, text: null, error: err && typeof err.message === 'string' ? err.message : String(err) })
						})
				}

				const graph = log && Array.isArray(log.commits) ? buildGraphData(log.commits) : null
				const changes = status && Array.isArray(status.entries) ? status.entries : []

				const renderCommitDetail = (hash, d) => {
					if (d === undefined) {
						return React.createElement('div', { className: 'dsh-git-detail' },
							React.createElement('div', { className: 'dsh-git-files-title' }, 'Loading changes…'))
					}
					if (d.error) {
						return React.createElement('div', { className: 'dsh-git-detail' },
							React.createElement('div', { className: 'dsh-git-files-title dsh-fe-status-error' }, d.error))
					}
					const files = Array.isArray(d.files) ? d.files : []
					return React.createElement('div', { className: 'dsh-git-detail' },
						React.createElement('div', { className: 'dsh-git-msg' }, d.message || '(no message)'),
						React.createElement('div', { className: 'dsh-git-files-title' },
							`${files.length} changed file${files.length === 1 ? '' : 's'}`),
						files.length === 0 ? null : files.map((f, i) =>
							React.createElement(GitFileRow, { key: i, file: f, onOpen: (file) => openDiff(hash, file) })),
					)
				}

				const rows = []
				if (loading) {
					rows.push(React.createElement('div', { key: 'loading', className: 'dsh-fe-status' }, 'Loading…'))
				} else if (error) {
					rows.push(React.createElement('div', { key: 'error', className: 'dsh-fe-status dsh-fe-status-error' }, error))
				} else if (graph !== null) {
					if (changes.length > 0) {
						const first = graph.rows.length > 0 ? graph.rows[0] : null
						const connectorColor = first !== null && first.lane === 0
							? LANE_COLORS[first.color % LANE_COLORS.length]
							: null
						rows.push(React.createElement('div', { key: 'worktree' },
							React.createElement('div', {
								className: 'dsh-git-row',
								onClick: () => toggle('WORKING'),
								role: 'button',
								title: 'Uncommitted changes',
							},
								React.createElement(WorkTreeCell, { lane: first !== null ? first.lane : 0, connectorColor }),
								React.createElement('div', { className: 'dsh-git-main' },
									React.createElement('div', { className: 'dsh-git-line1' },
										React.createElement('span', { className: 'dsh-git-subject' }, 'Uncommitted changes'),
										React.createElement('span', { className: 'dsh-git-pill dsh-git-pill-branch' }, String(changes.length)),
									),
									React.createElement('div', { className: 'dsh-git-line2' }, 'Working tree'),
								),
							),
							selected === 'WORKING'
								? React.createElement('div', { className: 'dsh-git-detail' },
									React.createElement('div', { className: 'dsh-git-files-title' },
										`${changes.length} changed file${changes.length === 1 ? '' : 's'} (vs HEAD)`),
									changes.map((f, i) =>
										React.createElement(GitFileRow, { key: i, file: f, onOpen: (file) => openDiff('WORKING', file) })),
								)
								: null,
						))
					}
					graph.rows.forEach((row, idx) => {
						const c = row.commit
						rows.push(React.createElement('div', { key: c.hash + '-' + idx },
							React.createElement('div', {
								className: 'dsh-git-row',
								onClick: () => toggle(c.hash),
								role: 'button',
								title: c.subject,
							},
								React.createElement(GraphSvg, { row, width: graph.width, colorOf: graph.colorOf }),
								React.createElement('div', { className: 'dsh-git-main' },
									React.createElement('div', { className: 'dsh-git-line1' },
										React.createElement(RefPills, { refs: c.refs }),
										React.createElement('span', { className: 'dsh-git-subject' }, c.subject),
									),
									React.createElement('div', { className: 'dsh-git-line2' },
										`${c.author || 'unknown'} · ${relTime(c.date)} · ${shortHash(c.hash)}`),
								),
							),
							selected === c.hash ? renderCommitDetail(c.hash, details[c.hash]) : null,
						))
					})
					if (rows.length === 0) {
						rows.push(React.createElement('div', { key: 'empty', className: 'dsh-fe-status' }, 'No commits yet'))
					}
				} else {
					rows.push(React.createElement('div', { key: 'none', className: 'dsh-fe-status' }, 'No data'))
				}

				const branchLabel = status
					? (status.branch === null
						? 'detached HEAD'
						: status.branch + (status.unborn ? ' (no commits yet)' : ''))
					: null
				const upstreamBits = []
				if (status && status.ahead > 0) upstreamBits.push('↑' + status.ahead)
				if (status && status.behind > 0) upstreamBits.push('↓' + status.behind)

				return React.createElement(React.Fragment, null,
					React.createElement('div', { className: 'dsh-git-bar' },
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							onClick: reload,
							'aria-label': 'Refresh graph',
							title: 'Refresh',
						}, svgIcon(refreshIcon, 15)),
						React.createElement('select', {
							className: 'dsh-git-scope',
							value: scope,
							'aria-label': 'Branch filter',
							onChange: (event) => setScope(event.target.value),
						},
							React.createElement('option', { value: 'all' }, 'All branches'),
							React.createElement('option', { value: 'current' }, 'Current branch'),
						),
					),
					branchLabel !== null
						? React.createElement('div', { className: 'dsh-git-info' },
							svgIcon(branchIcon, 12),
							React.createElement('span', { className: 'dsh-git-info-name' }, branchLabel),
							upstreamBits.length > 0 ? React.createElement('span', null, upstreamBits.join(' ')) : null,
							React.createElement('span', null, `${changes.length} change${changes.length === 1 ? '' : 's'}`),
						)
						: null,
					React.createElement('div', { className: 'dsh-git-list' }, rows),
					diff !== null
						? React.createElement('div', {
							className: 'dsh-fe-overlay',
							onClick: () => setDiff(null),
						},
							React.createElement('div', {
								className: 'dsh-fe-modal',
								role: 'dialog',
								'aria-label': 'Diff',
								onClick: (event) => event.stopPropagation(),
							},
								React.createElement('div', { className: 'dsh-fe-modal-head' },
									React.createElement('div', { className: 'dsh-fe-modal-title' }, diff.title),
									React.createElement('div', { className: 'dsh-fe-modal-meta' },
										diff.hash === 'WORKING' ? 'working tree' : shortHash(diff.hash)),
									React.createElement('button', {
										type: 'button',
										className: 'dsh-fe-icon',
										onClick: () => setDiff(null),
										'aria-label': 'Close diff',
									}, svgIcon(closeIcon, 14)),
								),
								React.createElement('div', { className: 'dsh-fe-modal-body' },
									diff.loading ? 'Loading…' : (diff.error || diff.text || '(no diff)')),
							),
						)
						: null,
				)
			}

			function FileExplorerPanel(props) {
				if (typeof props.useSessions !== 'function') return null

				const sessionId = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					if (!row || row.blank === true) return undefined
					return current
				})
				const cwd = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					return row ? row.cwd : undefined
				})
				const [requestPath, setRequestPath] = React.useState('')
				const [currentPath, setCurrentPath] = React.useState('')
				const [parentPath, setParentPath] = React.useState(null)
				const [entries, setEntries] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [loading, setLoading] = React.useState(false)
				const [reloadTick, setReloadTick] = React.useState(0)
				const [editingPath, setEditingPath] = React.useState(false)
				const [draftPath, setDraftPath] = React.useState('')
				const [preview, setPreview] = React.useState(null)
				const [previewLoading, setPreviewLoading] = React.useState(false)
				const [pendingDelete, setPendingDelete] = React.useState(null)
				const [view, setView] = React.useState('files')
				const [collapsed, setCollapsed] = React.useState(false)

				React.useEffect(() => {
					if (sessionId === undefined) return
					setCollapsed(false)
					if (layout !== undefined) {
						try { layout.openDetails() } catch (_e) { }
					}
					// Same-tick store updates batch in React, so restoring right after
					// openDetails() replaces the 360px default without a visible jump.
					restoreWidth()
				}, [sessionId])

				React.useEffect(() => {
					if (sessionId === undefined) {
						releaseRail()
						return
					}
					setParentPath(null)
					setRequestPath(cwd === undefined ? '' : cwd)
				}, [sessionId, cwd])

				React.useEffect(() => {
					if (sessionId === undefined) {
						setEntries(null)
						setError(null)
						return
					}
					let cancelled = false
					setLoading(true)
					setEntries(null)
					setError(null)
					api('list', { path: requestPath === '' ? null : requestPath })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setCurrentPath(raw.path)
								setParentPath(raw.parent || null)
								setEntries(raw.entries || [])
							} else {
								setCurrentPath(requestPath)
								setParentPath(null)
								setEntries([])
								setError(raw && typeof raw.error === 'string' ? raw.error : 'Failed to list files')
							}
						})
						.catch((err) => {
							if (cancelled) return
							setCurrentPath(requestPath)
							setParentPath(null)
							setEntries([])
							setError(err && typeof err.message === 'string' ? err.message : String(err))
						})
						.finally(() => {
							if (!cancelled) setLoading(false)
						})
					return () => { cancelled = true }
				}, [sessionId, requestPath, reloadTick])

				if (sessionId === undefined) return null

				const sorted = (entries || []).slice().sort((a, b) => {
					const aDir = a.type === 'directory' ? 0 : 1
					const bDir = b.type === 'directory' ? 0 : 1
					return aDir - bDir || a.name.localeCompare(b.name)
				})
				const isRoot = parentPath === null || parentPath === currentPath
				// Collapse into a slim icon rail that keeps a real 56px column in
				// the layout (like the left sidebar's rail): the details store stays
				// closed (no drag handle / border), and applyRail() toggles the
				// [data-dsh-fe-rail] attribute so the !important stylesheet rule
				// overrides the frame's third grid track. A MutationObserver keeps
				// the sidebar-width variable fresh across app re-renders.
				const collapse = () => {
					setCollapsed(true)
					railActive = true
					setPreview(null)
					setPendingDelete(null)
					setEditingPath(false)
					if (layout !== undefined) {
						try { layout.closeDetails() } catch (_e) { }
					}
					applyRail()
				}
				const expand = (nextView) => {
					releaseRail()
					setCollapsed(false)
					setView(nextView)
					if (layout !== undefined) {
						try { layout.openDetails() } catch (_e) { }
					}
					// Same-tick store updates batch in React, so restoring right after
					// openDetails() replaces the 360px default without a visible jump.
					restoreWidth()
				}
				const reload = () => { setPendingDelete(null); setReloadTick((tick) => tick + 1) }
				const startEditPath = () => {
					setDraftPath(currentPath)
					setEditingPath(true)
				}
				const commitPath = () => {
					setPendingDelete(null)
					setEditingPath(false)
					const next = draftPath.trim()
					if (next.length === 0) return
					setRequestPath(next)
				}

				const openPreview = (entry) => {
					setPendingDelete(null)
					setPreviewLoading(true)
					setPreview(null)
					api('read', { path: entry.path })
						.then((raw) => {
							setPreview(raw && raw.ok === true ? raw : { ok: false, error: raw && typeof raw.error === 'string' ? raw.error : 'Failed to read file' })
						})
						.catch((err) => {
							setPreview({ ok: false, error: err && typeof err.message === 'string' ? err.message : String(err) })
						})
						.finally(() => setPreviewLoading(false))
				}

				const downloadFile = (entry) => {
					setPendingDelete(null)
					api('download', { path: entry.path })
						.then((raw) => {
							if (!raw || raw.ok !== true) {
								const message = raw && typeof raw.error === 'string' ? raw.error : 'Download failed'
								setError(message)
								return
							}
							try {
								const link = document.createElement('a')
								link.href = raw.dataUrl
								link.download = entry.name
								document.body.appendChild(link)
								link.click()
								link.remove()
							} catch (err) {
								setError(err && typeof err.message === 'string' ? err.message : String(err))
							}
						})
						.catch((err) => setError(err && typeof err.message === 'string' ? err.message : String(err)))
				}

				const requestDelete = (entry) => {
					if (pendingDelete !== entry.path) {
						setPendingDelete(entry.path)
						return
					}
					setPendingDelete(null)
					api('delete', { path: entry.path })
						.then((raw) => {
							if (!raw || raw.ok !== true) {
								setError(raw && typeof raw.error === 'string' ? raw.error : 'Delete failed')
								return
							}
							reload()
						})
						.catch((err) => setError(err && typeof err.message === 'string' ? err.message : String(err)))
				}

				const pathControl = editingPath
					? React.createElement('input', {
						key: 'path-input',
						className: 'dsh-fe-path-input',
						value: draftPath,
						autoFocus: true,
						onChange: (event) => setDraftPath(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') commitPath()
							if (event.key === 'Escape') setEditingPath(false)
						},
						onBlur: () => setEditingPath(false),
					})
					: React.createElement('button', {
						type: 'button',
						className: 'dsh-fe-path',
						title: currentPath || 'workspace root',
						onClick: startEditPath,
					}, currentPath || 'workspace root')

				const filesView = React.createElement(React.Fragment, null,
					pathControl,
					React.createElement('div', { className: 'dsh-fe-toolbar' },
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							disabled: isRoot,
							onClick: () => {
								if (parentPath !== null && parentPath !== currentPath) setRequestPath(parentPath)
							},
							'aria-label': 'Go to parent directory',
							title: 'Up',
						}, svgIcon(upIcon, 15)),
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							onClick: reload,
							'aria-label': 'Refresh file list',
							title: 'Refresh',
						}, svgIcon(refreshIcon, 15)),
					),
					React.createElement('div', { className: 'dsh-fe-list' },
						loading
							? React.createElement('div', { className: 'dsh-fe-status' }, 'Loading...')
							: error
								? React.createElement('div', { className: 'dsh-fe-status dsh-fe-status-error' }, error)
								: sorted.length === 0
									? React.createElement('div', { className: 'dsh-fe-status' }, 'Empty folder')
									: sorted.map((entry) => {
										const isDir = entry.type === 'directory'
										return React.createElement('div', {
											key: entry.path,
											className: 'dsh-fe-row',
											onClick: isDir ? () => setRequestPath(entry.path) : undefined,
											title: entry.path || entry.name,
											role: isDir ? 'button' : undefined,
										},
											React.createElement('span', {
												className: isDir ? 'dsh-fe-marker dsh-fe-marker-dir' : 'dsh-fe-marker dsh-fe-marker-file',
											}, svgIcon(isDir ? folderIcon : fileIcon, 16)),
											React.createElement('span', { className: 'dsh-fe-name' }, entry.name),
											React.createElement('span', { className: 'dsh-fe-meta' },
												React.createElement('span', { className: 'dsh-fe-size' }, isDir ? '' : formatSize(entry.size)),
												React.createElement('span', { className: 'dsh-fe-actions' },
													!isDir && React.createElement('button', {
														type: 'button',
														className: 'dsh-fe-action',
														onClick: (event) => { event.stopPropagation(); openPreview(entry) },
														'aria-label': `View ${entry.name}`,
														title: 'View',
													}, svgIcon(eyeIcon, 14)),
													!isDir && React.createElement('button', {
														type: 'button',
														className: 'dsh-fe-action',
														onClick: (event) => { event.stopPropagation(); downloadFile(entry) },
														'aria-label': `Download ${entry.name}`,
														title: 'Download',
													}, svgIcon(downloadIcon, 14)),
													React.createElement('button', {
														type: 'button',
														className: pendingDelete === entry.path ? 'dsh-fe-action dsh-fe-action-confirm' : 'dsh-fe-action dsh-fe-action-danger',
														onClick: (event) => { event.stopPropagation(); requestDelete(entry) },
														'aria-label': pendingDelete === entry.path ? `Confirm deleting ${entry.name}` : `Delete ${entry.name}`,
														title: pendingDelete === entry.path ? 'Click again to delete' : 'Delete',
													}, svgIcon(trashIcon, 14)),
												),
											),
										)
									}),
					),
				)

				// Collapsed: a slim icon rail (file / git) that keeps a real 56px
				// column in the layout (the [data-dsh-fe-rail] !important grid rule;
				// see applyRail above), mirroring the left sidebar's collapsed rail.
				// Placed after every handler declaration: a collapsed render must not
				// return early and leave `expand` uninitialized (TDZ error on click).
				if (collapsed) {
					return React.createElement('div', {
						className: 'dsh-fe-rail',
						role: 'region',
						'aria-label': 'File explorer (collapsed)',
					},
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-rail-button',
							onClick: () => expand('files'),
							title: 'Files',
							'aria-label': 'Open file explorer',
						}, svgIcon(folderIcon, 16)),
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-rail-button',
							onClick: () => expand('git'),
							title: 'Git Graph',
							'aria-label': 'Open git graph',
						}, svgIcon(branchIcon, 16)),
					)
				}

				return React.createElement(React.Fragment, null,
					React.createElement('div', {
						className: 'dsh-fe-panel',
						role: 'region',
						'aria-label': 'File explorer',
					},
						React.createElement('div', { className: 'dsh-fe-header' },
							React.createElement('button', {
								type: 'button',
								className: 'dsh-fe-icon',
								onClick: collapse,
								'aria-label': 'Collapse file explorer into icon bar',
								title: 'Collapse',
							}, collapseIcon),
							React.createElement('div', { className: 'dsh-fe-title' }, view === 'git' ? 'Git Graph' : 'Files'),
						),
						React.createElement('div', { className: 'dsh-fe-tabs' },
							React.createElement('button', {
								type: 'button',
								className: 'dsh-fe-tab' + (view === 'files' ? ' dsh-fe-tab-active' : ''),
								onClick: () => setView('files'),
							}, svgIcon(folderIcon, 13), 'Files'),
							React.createElement('button', {
								type: 'button',
								className: 'dsh-fe-tab' + (view === 'git' ? ' dsh-fe-tab-active' : ''),
								onClick: () => setView('git'),
							}, svgIcon(branchIcon, 13), 'Git Graph'),
						),
						view === 'git'
							? React.createElement(GitGraphView, { api, cwd })
							: filesView,
					),
					preview &&
						React.createElement('div', {
							className: 'dsh-fe-overlay',
							onClick: () => setPreview(null),
						},
							React.createElement('div', {
								className: 'dsh-fe-modal',
								role: 'dialog',
								'aria-label': 'File preview',
								onClick: (event) => event.stopPropagation(),
							},
								React.createElement('div', { className: 'dsh-fe-modal-head' },
									React.createElement('div', { className: 'dsh-fe-modal-title' }, preview.name || 'Preview'),
									React.createElement('div', { className: 'dsh-fe-modal-meta' }, preview.binary ? 'Binary' : formatSize(preview.size)),
									React.createElement('button', {
										type: 'button',
										className: 'dsh-fe-icon',
										onClick: () => setPreview(null),
										'aria-label': 'Close preview',
									}, svgIcon(closeIcon, 14)),
								),
								React.createElement('div', { className: 'dsh-fe-modal-body' },
									previewLoading
										? 'Loading...'
										: preview.error
											? preview.error
											: preview.text !== undefined ? preview.text : preview.tooLarge ? 'File is too large to preview here' : '(No preview)',
								),
							),
						),
				)
			}

			ctx.effect(() => slots.inject('details', () => slots.register(
				{ name: 'details', priority: -6 },
				FileExplorerPanel,
			)))
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
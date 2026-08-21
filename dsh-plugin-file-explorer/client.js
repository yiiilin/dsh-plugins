/**
 * dsh-plugin-file-explorer — browser bundle (static DSH client module).
 *
 * Renders the file explorer into the `details` slot (right layout column),
 * replacing the native tool-details panel while running. The column squeezes
 * the conversation and keeps the native resizer handle.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-file-explorer",
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
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-fe-icon {
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
.dsh-fe-icon:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-primary, #111827);
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
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
				const handle = document.querySelector('[data-side="details"]')
				if (handle !== null && handle.previousElementSibling !== null) return handle.previousElementSibling
				return document.querySelector('[class*="detailsCol"]')
			}
			const persistWidth = () => {
				const column = findDetailsColumn()
				if (column === null) return
				const width = Math.round(column.getBoundingClientRect().width)
				if (width < WIDTH_MIN) return
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

    function formatSize(size) {
      if (typeof size !== 'number' || !Number.isFinite(size)) return ''
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
      if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
      return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
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

      React.useEffect(() => {
        if (sessionId === undefined) return
        if (layout !== undefined) {
          try { layout.openDetails() } catch (_e) { }
        }
        // Same-tick store updates batch in React, so restoring right after
        // openDetails() replaces the 360px default without a visible jump.
        restoreWidth()
      }, [sessionId])

      React.useEffect(() => {
        if (sessionId === undefined) return
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
      const close = () => {
        if (layout !== undefined) {
          try { layout.closeDetails() } catch (_e) { }
        }
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

      return React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'dsh-fe-panel',
          role: 'region',
          'aria-label': 'File explorer',
        },
          React.createElement('div', { className: 'dsh-fe-header' },
            React.createElement('div', { className: 'dsh-fe-title' }, 'Files'),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-fe-icon',
              onClick: close,
              'aria-label': 'Close file explorer',
            }, svgIcon(closeIcon, 14)),
          ),
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
                        isDir
                          ? React.createElement('span', { className: 'dsh-fe-size' }, '')
                          : React.createElement(React.Fragment, null,
                            React.createElement('span', { className: 'dsh-fe-size' }, formatSize(entry.size)),
                            React.createElement('span', { className: 'dsh-fe-actions' },
                              React.createElement('button', {
                                type: 'button',
                                className: 'dsh-fe-action',
                                onClick: (event) => { event.stopPropagation(); openPreview(entry) },
                                'aria-label': `View ${entry.name}`,
                                title: 'View',
                              }, svgIcon(eyeIcon, 14)),
                              React.createElement('button', {
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
                      ),
                    )
                  }),
          ),
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
                preview.error
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
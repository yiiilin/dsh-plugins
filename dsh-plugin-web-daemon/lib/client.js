/**
 * dsh-plugin-web-daemon — browser settings section.
 *
 * Static DSH client bundle. The node half exposes the daemon API routes under
 * /_dsh/web-daemon; this section is the Settings-side editor for them.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-web-daemon",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const inject = ["slots"];

		const STYLE_ID = "dsh-plugin-web-daemon-settings";
		if (typeof document !== "undefined" && document.getElementById(STYLE_ID) === null) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.setAttribute("data-plugin", "dsh-plugin-web-daemon");
			style.textContent = `
.dwd-section{display:flex;flex-direction:column;gap:18px}
.dwd-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:38px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1, #fff)}
.dwd-pill{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600}
.dwd-pill[data-state="running"]{background:rgba(34,197,94,.14);color:#15803d}
.dwd-pill[data-state="failed"]{background:rgba(239,68,68,.14);color:#b91c1c}
.dwd-pill[data-state="restarting"]{background:rgba(245,158,11,.16);color:#b45309}
.dwd-pill[data-state="starting"]{background:rgba(59,130,246,.14);color:#1d4ed8}
.dwd-meta{min-width:0;display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--dsw-alias-label-secondary, #57534e);font-size:12px;line-height:18px}
.dwd-meta b{font-weight:600;color:var(--dsw-alias-label-primary, #111827)}
.dwd-actions{display:flex;flex-wrap:wrap;gap:8px}
.dwd-btn{min-height:30px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.18));border-radius:6px;background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #111827);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dwd-btn:hover{background:var(--dsw-alias-bg-layer-2, #e7e5e4)}
.dwd-btn:disabled{opacity:.55;cursor:default}
.dwd-btn.primary{background:var(--dsw-alias-brand-primary, #2563eb);border-color:transparent;color:#fff}
.dwd-btn.danger{border-color:rgba(239,68,68,.35);color:#b91c1c}
.dwd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.dwd-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dwd-field.full{grid-column:1 / -1}
.dwd-field label,.dwd-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary, #111827)}
.dwd-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, #78716c)}
.dwd-input{box-sizing:border-box;width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.22));border-radius:6px;background:var(--dsw-alias-bg-input, #fff);color:var(--dsw-alias-label-primary, #111827);font:13px/18px inherit}
.dwd-input:focus{outline:2px solid rgba(59,130,246,.35);outline-offset:1px}
.dwd-check{display:flex;gap:8px;align-items:center;min-height:32px}
.dwd-check input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary, #2563eb)}
.dwd-command{max-width:100%;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.16));border-radius:6px;background:var(--dsw-alias-bg-code, rgba(0,0,0,.04));color:var(--dsw-alias-label-primary, #111827);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dwd-error{padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:#b91c1c;font-size:13px;line-height:18px}
.dwd-notice{padding:6px 10px;border:1px solid rgba(34,197,94,.28);border-radius:6px;background:rgba(34,197,94,.08);color:#15803d;font-size:13px;line-height:18px}
.dwd-empty{color:var(--dsw-alias-label-secondary, #57534e);font-size:13px}
`;

			document.head.append(style);
		}

		async function api(path, payload) {
			const options = { headers: { "content-type": "application/json" } };
			if (payload !== undefined) {
				options.method = "POST";
				options.body = JSON.stringify(payload);
			}
			const response = await fetch(path, options);
			let data;
			try {
				data = await response.json();
			} catch {
				throw new Error(`daemon API returned HTTP ${response.status}`);
			}
			if (!response.ok || data.ok === false) {
				throw new Error(data.error || `daemon API returned HTTP ${response.status}`);
			}
			return data;
		}

		function WebDaemonSection() {
			const [snapshot, setSnapshot] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const failuresRef = React.useRef(0);

			const refresh = React.useCallback(async () => {
				try {
					const next = await api("/_dsh/web-daemon/state");
					failuresRef.current = 0;
					setSnapshot(next);
					setError(null);
				} catch (err) {
					// Transient loss is normal right after a self-restart: stay
					// quiet until the daemon misses several polls in a row.
					failuresRef.current += 1;
					if (failuresRef.current >= 3) {
						setError("Lost contact with the daemon API — retrying...");
					}
				}
			}, []);

			React.useEffect(() => {
				void refresh();
				const timer = window.setInterval(() => void refresh(), 4000);
				return () => window.clearInterval(timer);
			}, [refresh]);

			const config = draft === null ? snapshot?.config : draft;

			const update = (key, value) => {
				setDraft((current) => ({ ...(current ?? snapshot?.config ?? {}), [key]: value }));
			};

			const run = async (action) => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					if (action === "save") {
						if (draft === null) return;
						const result = await api("/_dsh/web-daemon/save", {
							config: draft,
							revision: snapshot?.revision ?? 0,
						});
						setSnapshot(result);
						setDraft(null);
						setNotice("Daemon settings saved.");
					} else if (action === "restart" && snapshot?.nested) {
						// The worker kills itself as part of `systemctl restart`,
						// so this request never gets a response — fire it and let
						// polling reconnect to the fresh process.
						api("/_dsh/web-daemon/restart", {}).catch(() => {});
						setNotice("Restart requested — waiting for the service to come back...");
						window.setTimeout(() => void refresh(), 3000);
					} else {
						const result = await api(`/_dsh/web-daemon/${action}`, {});
						setSnapshot(result);
						setDraft(null);
						if (action === "start") setNotice("Daemon start requested.");
						if (action === "stop") setNotice("Daemon stopped.");
						if (action === "restart") setNotice("Daemon restart requested.");
						if (action === "reset") setNotice("Daemon start limit reset.");
					}
				} catch (err) {
					setError(err && err.message ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			if (snapshot === null && error === null) {
				return React.createElement("div", { className: "dwd-section" }, "Loading daemon status...");
			}

			if (config === undefined) {
				return React.createElement(
					"div",
					{ className: "dwd-section" },
					React.createElement("p", { className: "dwd-empty" }, "Daemon status is not available."),
				);
			}

			const status = snapshot.status || "unknown";
			const disabled = busy || !snapshot.writable || snapshot.nested;
			const changed = draft !== null;
			const unit = snapshot.unit || {};

			return React.createElement(
				"div",
				{ className: "dwd-section" },
				React.createElement(
					"div",
					{ className: "dwd-status" },
					React.createElement(
						"span",
						{ className: "dwd-pill", "data-state": status, "aria-live": "polite" },
						status === "running" ? "Running" : status === "failed" ? "Failed" : status === "restarting" ? "Restarting" : status === "starting" ? "Starting" : "Stopped",
					),
					React.createElement(
						"span",
						{ className: "dwd-meta" },
						React.createElement("span", null, "PID: ", React.createElement("b", null, snapshot.pid || "-")),
						React.createElement("span", null, "restarts: ", React.createElement("b", null, snapshot.restarts || 0)),
						React.createElement("span", null, "started: ", React.createElement("b", null, snapshot.startedAt || "-")),
						React.createElement("span", null, "unit: ", React.createElement("b", null, unit.name || "-"), " (", unit.activeState || "unknown", ")"),
					),
					React.createElement(
						"div",
						{ className: "dwd-actions" },
						React.createElement("button", { type: "button", className: "dwd-btn primary", disabled: busy || snapshot.nested, onClick: () => void run("start") }, "Start"),
						React.createElement("button", { type: "button", className: "dwd-btn danger", disabled: busy || snapshot.nested, onClick: () => void run("stop") }, "Stop"),
						React.createElement("button", { type: "button", className: "dwd-btn", disabled: busy, onClick: () => void run("restart") }, "Restart"),
						React.createElement("button", { type: "button", className: "dwd-btn", disabled: busy || snapshot.nested, onClick: () => void run("reset") }, "Reset failed state"),
					),
				),
				snapshot.nested
					? React.createElement("div", { className: "dwd-notice", role: "status" }, "This process is the managed worker. Restart is available here (e.g. after plugin updates); Start/Stop and configuration live on the unit owner.")
					: null,
				error === null ? null : React.createElement("div", { className: "dwd-error", role: "alert" }, error),
				notice === null ? null : React.createElement("div", { className: "dwd-notice", role: "status" }, notice),
				React.createElement(
					"div",
					{ className: "dwd-grid" },
					React.createElement(
						"label",
						{ className: "dwd-field" },
						React.createElement("span", { className: "dwd-label" }, "Enabled"),
						React.createElement(
							"label",
							{ className: "dwd-check" },
							React.createElement("input", { type: "checkbox", checked: Boolean(config.enabled), disabled: disabled, onChange: (event) => update("enabled", event.target.checked) }),
							"start on boot and keep running",
						),
						React.createElement("span", { className: "dwd-hint" }, "Maps to systemctl enable/disable; Start/Stop still work while disabled."),
					),
					React.createElement(
						"label",
						{ className: "dwd-field" },
						React.createElement("span", { className: "dwd-label" }, "Systemd scope"),
						React.createElement(
							"select",
							{ className: "dwd-input", value: config.systemdScope || "system", disabled: disabled, onChange: (event) => update("systemdScope", event.target.value) },
							React.createElement("option", { value: "system" }, "system"),
							React.createElement("option", { value: "user" }, "user"),
						),
						React.createElement("span", { className: "dwd-hint" }, "system needs root; user units use --user."),
					),
					React.createElement(
						"label",
						{ className: "dwd-field" },
						React.createElement("span", { className: "dwd-label" }, "Systemd unit"),
						React.createElement("input", { className: "dwd-input", value: config.systemdUnit || "dsh-web.service", disabled: disabled, onChange: (event) => update("systemdUnit", event.target.value) }),
					),
					React.createElement(
						"label",
						{ className: "dwd-field" },
						React.createElement("span", { className: "dwd-label" }, "Profile"),
						React.createElement("input", { className: "dwd-input", value: config.profile || "", disabled: disabled, onChange: (event) => update("profile", event.target.value) }),
						React.createElement("span", { className: "dwd-hint" }, "DSH profile started by the worker."),
					),
					React.createElement(
						"label",
						{ className: "dwd-field" },
						React.createElement("span", { className: "dwd-label" }, "Port"),
						React.createElement("input", { type: "number", min: "0", max: "65535", className: "dwd-input", value: config.port ?? 3081, disabled: disabled, onChange: (event) => update("port", Number(event.target.value)) }),
						React.createElement("span", { className: "dwd-hint" }, "Worker always binds loopback; LAN access is handled by dsh-plugin-auth-webserver."),
					),
				),
				snapshot.command
					? React.createElement("pre", { className: "dwd-command" }, snapshot.command)
					: null,
				unit.name
					? React.createElement("p", { className: "dwd-hint" }, "Logs go to the systemd journal: journalctl -u ", unit.name, " -f")
					: null,
				React.createElement(
					"div",
					{ className: "dwd-actions" },
					React.createElement("button", { type: "button", className: "dwd-btn primary", disabled: busy || !changed || !snapshot.writable || snapshot.nested, onClick: () => void run("save") }, "Save settings"),
					changed
						? React.createElement("button", { type: "button", className: "dwd-btn", disabled: busy, onClick: () => setDraft(null) }, "Discard")
						: null,
				),
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "web-daemon",
				order: 16,
				label: () => "Web daemon",
				inject: () => ({})
			}, WebDaemonSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

/**
 * dsh-plugin-auth-webserver — browser plugin configuration card.
 *
 * Static DSH client bundle. The node half exposes the auth gateway API under
 * /_dsh/auth-webserver; this card appears under Settings > Plugins > Plugin
 * configuration (settings.plugin.item, keyed by the "auth-webserver" settings
 * namespace). The card chrome (header, disclosure, footer) is implemented
 * here because the client bundle purity gate forbids importing the official
 * card chrome as values; only the slot registration protocol is shared.
 */
window.__ModuleLoader__.load({
	id: "@yiln-dsh/dsh-plugin-auth-webserver",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const inject = ["slots"];

		const STYLE_ID = "dsh-plugin-auth-webserver-settings";
		if (typeof document !== "undefined" && document.getElementById(STYLE_ID) === null) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.setAttribute("data-plugin", "dsh-plugin-auth-webserver");
			style.textContent = `
.daw-card{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1, #fff);overflow:hidden}
.daw-cardHeader{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:8px 12px;border:0;background:none;color:var(--dsw-alias-label-primary, #111827);font:inherit;text-align:left;cursor:pointer}
.daw-cardHeader:hover{background:var(--dsw-alias-bg-layer-2, #e7e5e4)}
.daw-cardHead{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.daw-cardTitle{font-size:13px;font-weight:600;line-height:18px}
.daw-cardDesc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary, #78716c)}
.daw-unsaved{flex:none;font-size:11px;font-weight:600;color:#b45309;background:rgba(245,158,11,.12);border-radius:999px;padding:2px 8px}
.daw-chevron{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary, #78716c);transition:transform .15s ease}
.daw-chevron[data-open="true"]{transform:rotate(180deg)}
.daw-cardBody{display:flex;flex-direction:column;gap:14px;padding:14px 16px 16px;border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-0, #fafafa)}
.daw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.daw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.daw-field.full{grid-column:1 / -1}
.daw-field label,.daw-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary, #111827)}
.daw-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, #78716c)}
.daw-input{box-sizing:border-box;width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.22));border-radius:6px;background:var(--dsw-alias-bg-input, #fff);color:var(--dsw-alias-label-primary, #111827);font:13px/18px inherit}
.daw-input:focus{outline:2px solid rgba(59,130,246,.35);outline-offset:1px}
.daw-actions{display:flex;flex-wrap:wrap;gap:8px}
.daw-btn{min-height:30px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.18));border-radius:6px;background:var(--dsw-alias-bg-layer-1, #fff);color:var(--dsw-alias-label-primary, #111827);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.daw-btn:hover{background:var(--dsw-alias-bg-layer-2, #e7e5e4)}
.daw-btn:disabled{opacity:.55;cursor:default}
.daw-btn.primary{background:var(--dsw-alias-brand-primary, #2563eb);border-color:transparent;color:#fff}
.daw-btn.ghost{border-color:transparent;background:none}
.daw-error{padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:#b91c1c;font-size:13px;line-height:18px}
.daw-notice{padding:6px 10px;border:1px solid rgba(34,197,94,.28);border-radius:6px;background:rgba(34,197,94,.08);color:#15803d;font-size:13px;line-height:18px}
.daw-warn{padding:6px 10px;border:1px solid rgba(245,158,11,.35);border-radius:6px;background:rgba(245,158,11,.10);color:#b45309;font-size:13px;line-height:18px}
.daw-cardFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));padding-top:12px}
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
				throw new Error(`auth webserver API returned HTTP ${response.status}`);
			}
			if (!response.ok || data.ok === false) {
				throw new Error(data.error || `auth webserver API returned HTTP ${response.status}`);
			}
			return data;
		}

		function AuthWebserverCard() {
			const [open, setOpen] = React.useState(false);
			const [meta, setMeta] = React.useState(null);
			const [username, setUsername] = React.useState("");
			const [password, setPassword] = React.useState("");
			const [realm, setRealm] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [notice, setNotice] = React.useState(null);

			const refresh = React.useCallback(async () => {
				try {
					const data = await api("/_dsh/auth-webserver/state");
					const state = data.state || {};
					setMeta(state);
					setUsername((current) => (current === "" && state.username ? state.username : current));
					setRealm((current) => (current === "" && state.realm ? state.realm : current));
					setError(null);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}, []);

			React.useEffect(() => {
				void refresh();
			}, [refresh]);

			const changed = meta !== null && (username !== meta.username || realm !== meta.realm || password !== "");

			const save = async () => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const payload = { username: username.trim(), realm: realm.trim() };
					if (password !== "") payload.password = password;
					const data = await api("/_dsh/auth-webserver/save", payload);
					setMeta(data.state);
					setUsername(data.state.username);
					setRealm(data.state.realm);
					setPassword("");
					setNotice("Saved. New credentials take effect on the next login.");
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const disabled = busy || meta === null;

			return React.createElement(
				"div",
				{ className: "daw-card" },
				React.createElement(
					"button",
					{
						type: "button",
						className: "daw-cardHeader",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
					},
					React.createElement(
						"span",
						{ className: "daw-cardHead" },
						React.createElement("span", { className: "daw-cardTitle" }, "Auth webserver"),
						React.createElement("span", { className: "daw-cardDesc" }, "Credentials for the auth-gated LAN gateway."),
					),
					changed ? React.createElement("span", { className: "daw-unsaved" }, "Unsaved changes") : null,
					React.createElement(
						"svg",
						{ className: "daw-chevron", "data-open": String(open), viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" },
						React.createElement("path", { d: "M3 5l4 4 4-4", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
					),
				),
				open
					? React.createElement(
							"div",
							{ className: "daw-cardBody" },
							React.createElement(
								"p",
								{ className: "daw-hint" },
								"Credentials for the auth-gated LAN gateway. Stored in the settings document (settings.yaml); the password never leaves it unredacted.",
							),
							meta !== null && meta.overriddenByEnv
								? React.createElement(
										"div",
										{ className: "daw-warn" },
										"DSH_AUTH_USER/DSH_AUTH_PASS (or AUTH_USER/AUTH_PASS) are set in the environment — they take precedence over these settings.",
									)
								: null,
							meta !== null && meta.overriddenByConfig
								? React.createElement(
										"div",
										{ className: "daw-warn" },
										"The webserver-auth row in cordis.patch.yml carries username/password — those act as the base layer and are effective until you save an override here.",
									)
								: null,
							React.createElement(
								"div",
								{ className: "daw-grid" },
								React.createElement(
									"label",
									{ className: "daw-field" },
									React.createElement("span", { className: "daw-label" }, "Username"),
									React.createElement("input", {
										className: "daw-input",
										value: username,
										disabled: disabled,
										onChange: (event) => setUsername(event.target.value),
									}),
								),
								React.createElement(
									"label",
									{ className: "daw-field" },
									React.createElement("span", { className: "daw-label" }, "Password"),
									React.createElement("input", {
										type: "password",
										className: "daw-input",
										value: password,
										disabled: disabled,
										placeholder: meta?.hasPassword ? "••••••••  leave empty to keep" : "set a password",
										onChange: (event) => setPassword(event.target.value),
									}),
									React.createElement("span", { className: "daw-hint" }, meta?.hasPassword ? "A password is configured." : "No password configured — the gateway refuses everyone."),
								),
								React.createElement(
									"label",
									{ className: "daw-field full" },
									React.createElement("span", { className: "daw-label" }, "Realm"),
									React.createElement("input", {
										className: "daw-input",
										value: realm,
										disabled: disabled,
										onChange: (event) => setRealm(event.target.value),
									}),
									React.createElement("span", { className: "daw-hint" }, "Shown on the login page and the Basic Auth challenge."),
								),
							),
							error ? React.createElement("div", { className: "daw-error" }, error) : null,
							notice ? React.createElement("div", { className: "daw-notice" }, notice) : null,
							React.createElement(
								"div",
								{ className: "daw-cardFooter" },
								changed
									? React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: busy, onClick: () => { setUsername(meta.username); setRealm(meta.realm); setPassword(""); setError(null); setNotice(null); } }, "Discard")
									: null,
								React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || !changed, onClick: () => void save() }, "Save"),
							),
						)
					: null,
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "auth-webserver",
				inject: () => ({})
			}, AuthWebserverCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
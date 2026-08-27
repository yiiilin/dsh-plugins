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
.daw-card{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.daw-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.daw-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.daw-cardHeader{appearance:none;display:flex;align-items:center;width:100%;gap:12px;padding:14px 16px;border:0;border-radius:12px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.daw-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.daw-cardHead{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}
.daw-cardTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.daw-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.daw-unsaved{flex:none;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px}
.daw-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}
.daw-chevron[data-open="true"]{transform:rotate(180deg)}
.daw-cardBody{display:flex;flex-direction:column;gap:14px;margin:0 16px;padding:12px 0 8px;border-top:1px solid var(--dsw-alias-border-l2);background:transparent}
.daw-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.daw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.daw-field.full{grid-column:1 / -1}
.daw-field label,.daw-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary, #111827)}
.daw-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, #78716c)}
.daw-input{box-sizing:border-box;width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.22));border-radius:6px;background:var(--dsw-alias-bg-input, #fff);color:var(--dsw-alias-label-primary, #111827);font:13px/18px inherit}
.daw-input:focus{outline:2px solid rgba(59,130,246,.35);outline-offset:1px}
.daw-actions{display:flex;flex-wrap:wrap;gap:8px}
.daw-btn{appearance:none;min-height:unset;padding:5px 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;white-space:nowrap}
.daw-btn:hover{background:var(--dsw-alias-bg-layer-2, #e7e5e4)}
.daw-btn:disabled{opacity:.55;cursor:default}
.daw-btn.primary{background:var(--dsw-alias-brand-primary, #2563eb);border-color:transparent;color:#fff}
.daw-btn.primary:hover{background:var(--dsw-alias-brand-primary, #2563eb)}
.daw-btn.ghost{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}
.daw-error{padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:#b91c1c;font-size:13px;line-height:18px}
.daw-notice{padding:6px 10px;border:1px solid rgba(34,197,94,.28);border-radius:6px;background:rgba(34,197,94,.08);color:#15803d;font-size:13px;line-height:18px}
.daw-warn{padding:6px 10px;border:1px solid rgba(245,158,11,.35);border-radius:6px;background:rgba(245,158,11,.10);color:#b45309;font-size:13px;line-height:18px}
.daw-twoFactor{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.daw-twoFactorTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.daw-secret{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-input,#fff);color:var(--dsw-alias-label-primary);font-size:12px}
.daw-uri{width:100%;min-height:58px;resize:vertical}
.daw-otp{max-width:180px}
.daw-cardFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
`;

			document.head.append(style);
		}

		const LOCALE_NS = "auth-webserver";
		const ZH_DICT = {
			"card.title": "认证网关",
			"card.desc": "认证保护局域网网关的登录凭据。",
			"card.unsaved": "未保存的更改",
			"hint.credentials": "认证保护局域网网关的登录凭据。保存在设置文档（settings.yaml）中，密码绝不会以明文形式离开该文档。",
			"warn.env": "环境中已设置 DSH_AUTH_USER/DSH_AUTH_PASS（或 AUTH_USER/AUTH_PASS）——它们优先于此处设置生效。",
			"warn.config": "cordis.patch.yml 中的 webserver-auth 行带有用户名/密码——它们作为基础层生效，直到您在此处保存覆盖配置为止。",
			username: "用户名",
			password: "密码",
			"password.placeholder.set": "••••••••  留空则保留原密码",
			"password.placeholder.empty": "设置密码",
			"password.hint.set": "已配置密码。",
			"password.hint.empty": "未配置密码——网关将拒绝所有访问。",
			currentPassword: "当前网关密码",
			"currentPassword.placeholder": "更改密码或 2FA 时必填",
			realm: "域名",
			"realm.hint": "显示在登录页面和 Basic Auth 认证提示框中。",
			"twoFactor.status": "两步验证：{state}",
			"twoFactor.state.enabled": "已启用",
			"twoFactor.state.disabled": "已禁用",
			"twoFactor.warn.env": "2FA 由 AUTH_2FA_ENABLED/AUTH_2FA_SECRET 控制，无法在此处更改。",
			"twoFactor.hint.enabled": "登录需要密码和六位验证器动态码；启用 2FA 期间 Basic Auth 被禁用。",
			"twoFactor.hint.setup": "在验证器应用中添加密钥，然后输入验证器生成的动态码以完成设置。",
			"twoFactor.hint.enterPassword": "请先在上方输入当前网关密码，再确认验证器应用生成的动态码。",
			"twoFactor.setupKey": "设置密钥",
			"twoFactor.uri": "验证器 URI",
			"twoFactor.newCode": "新的验证器动态码",
			"twoFactor.currentCode": "当前验证器动态码",
			"twoFactor.enableButton": "启用 2FA",
			"twoFactor.replaceButton": "更换验证器",
			"twoFactor.disableButton": "禁用 2FA",
			"twoFactor.setupButton": "设置 2FA",
			cancel: "取消",
			save: "保存",
			discard: "放弃更改",
			"notice.saved": "已保存，新凭据将在下次登录时生效。",
			"notice.2faStart": "请将密钥添加到验证器应用，然后输入当前动态码进行确认。",
			"notice.2faEnabled": "2FA 已启用。请使用验证器动态码重新登录。",
			"notice.2faDisabled": "2FA 已禁用。请重新登录以继续。",
		};
		const EN_DICT = {
			"card.title": "Auth webserver",
			"card.desc": "Credentials for the auth-gated LAN gateway.",
			"card.unsaved": "Unsaved changes",
			"hint.credentials": "Credentials for the auth-gated LAN gateway. Stored in the settings document (settings.yaml); the password never leaves it unredacted.",
			"warn.env": "DSH_AUTH_USER/DSH_AUTH_PASS (or AUTH_USER/AUTH_PASS) are set in the environment — they take precedence over these settings.",
			"warn.config": "The webserver-auth row in cordis.patch.yml carries username/password — those act as the base layer and are effective until you save an override here.",
			username: "Username",
			password: "Password",
			"password.placeholder.set": "••••••••  leave empty to keep",
			"password.placeholder.empty": "set a password",
			"password.hint.set": "A password is configured.",
			"password.hint.empty": "No password configured — the gateway refuses everyone.",
			currentPassword: "Current gateway password",
			"currentPassword.placeholder": "required when changing password or 2FA",
			realm: "Realm",
			"realm.hint": "Shown on the login page and the Basic Auth challenge.",
			"twoFactor.status": "Two-factor authentication: {state}",
			"twoFactor.state.enabled": "enabled",
			"twoFactor.state.disabled": "disabled",
			"twoFactor.warn.env": "2FA is controlled by AUTH_2FA_ENABLED/AUTH_2FA_SECRET and cannot be changed here.",
			"twoFactor.hint.enabled": "Login requires the password and a six-digit authenticator code. Basic Auth is disabled while 2FA is enabled.",
			"twoFactor.hint.setup": "Finish setup by entering a code from your authenticator app.",
			"twoFactor.hint.enterPassword": "Enter the current gateway password above before confirming a code from your authenticator app.",
			"twoFactor.setupKey": "Setup key",
			"twoFactor.uri": "Authenticator URI",
			"twoFactor.newCode": "New authenticator code",
			"twoFactor.currentCode": "Current authenticator code",
			"twoFactor.enableButton": "Enable 2FA",
			"twoFactor.replaceButton": "Replace authenticator",
			"twoFactor.disableButton": "Disable 2FA",
			"twoFactor.setupButton": "Set up 2FA",
			cancel: "Cancel",
			save: "Save",
			discard: "Discard",
			"notice.saved": "Saved. New credentials take effect on the next login.",
			"notice.2faStart": "Add the key to an authenticator app, then enter the current code to confirm.",
			"notice.2faEnabled": "2FA is enabled. Sign in again with your authenticator code.",
			"notice.2faDisabled": "2FA is disabled. Sign in again to continue.",
		};

		function applyParams(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}

		async function api(path, payload) {
			const headers = { "content-type": "application/json" };
			const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("dsh_auth_csrf="));
			if (csrf !== undefined) {
				try {
					headers["X-DSH-CSRF"] = decodeURIComponent(csrf.slice("dsh_auth_csrf=".length));
				} catch {
					// Let the server reject a malformed CSRF cookie.
				}
			}
			const options = { headers };
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

		function createAuthWebserverCard(t) {
			return function AuthWebserverCard(props) {
			const [open, setOpen] = React.useState(false);
			const [meta, setMeta] = React.useState(null);
			const [username, setUsername] = React.useState("");
			const [password, setPassword] = React.useState("");
			const [currentPassword, setCurrentPassword] = React.useState("");
			const [currentOtp, setCurrentOtp] = React.useState("");
			const [totpSecret, setTotpSecret] = React.useState("");
			const [totpUri, setTotpUri] = React.useState("");
			const [totpCode, setTotpCode] = React.useState("");
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
					if (password !== "") {
						payload.password = password;
						payload.currentPassword = currentPassword;
						if (twoFactorEnabled) payload.currentOtp = currentOtp;
					}
					const data = await api("/_dsh/auth-webserver/save", payload);
					setMeta(data.state);
					setUsername(data.state.username);
					setRealm(data.state.realm);
					setPassword("");
					setCurrentPassword("");
					setCurrentOtp("");
					setNotice(t("notice.saved"));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const startTwoFactor = async () => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const data = await api("/_dsh/auth-webserver/2fa", { action: "start" });
					setTotpSecret(data.setup.secret);
					setTotpUri(data.setup.otpauthUrl);
					setTotpCode("");
					setNotice(t("notice.2faStart"));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const confirmTwoFactor = async () => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const data = await api("/_dsh/auth-webserver/2fa", {
						action: "verify",
						secret: totpSecret,
						code: totpCode.trim(),
						currentPassword,
						currentOtp,
					});
					setMeta(data.state);
					setTotpSecret("");
					setTotpUri("");
					setTotpCode("");
					setCurrentPassword("");
					setCurrentOtp("");
					setNotice(t("notice.2faEnabled"));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const disableTwoFactor = async () => {
				setBusy(true);
				setError(null);
				setNotice(null);
				try {
					const data = await api("/_dsh/auth-webserver/2fa", {
						action: "disable",
						currentPassword,
						currentOtp,
						});
					setMeta(data.state);
					setCurrentPassword("");
					setCurrentOtp("");
					setNotice(t("notice.2faDisabled"));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const disabled = busy || meta === null;
			const twoFactorEnabled = Boolean(meta?.twoFactorEnabled);
			const twoFactorOverriddenByEnv = Boolean(meta?.twoFactorOverriddenByEnv);

			return React.createElement(
				"div",
				{ className: open ? "daw-card daw-cardOpen" : "daw-card" },
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
						React.createElement("span", { className: "daw-cardTitle" }, t("card.title")),
						React.createElement("span", { className: "daw-cardDesc" }, t("card.desc")),
					),
					changed ? React.createElement("span", { className: "daw-unsaved" }, t("card.unsaved")) : null,
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
								t("hint.credentials"),
							),
							meta !== null && meta.overriddenByEnv
								? React.createElement(
										"div",
										{ className: "daw-warn" },
										t("warn.env"),
									)
								: null,
							meta !== null && meta.overriddenByConfig
								? React.createElement(
										"div",
										{ className: "daw-warn" },
										t("warn.config"),
									)
								: null,
							React.createElement(
								"div",
								{ className: "daw-grid" },
								React.createElement(
									"label",
									{ className: "daw-field" },
									React.createElement("span", { className: "daw-label" }, t("username")),
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
									React.createElement("span", { className: "daw-label" }, t("password")),
									React.createElement("input", {
										type: "password",
										className: "daw-input",
										value: password,
										disabled: disabled,
										placeholder: meta?.hasPassword ? t("password.placeholder.set") : t("password.placeholder.empty"),
										onChange: (event) => setPassword(event.target.value),
									}),
									React.createElement("span", { className: "daw-hint" }, meta?.hasPassword ? t("password.hint.set") : t("password.hint.empty")),
								),
								React.createElement(
									"label",
									{ className: "daw-field" },
									React.createElement("span", { className: "daw-label" }, t("currentPassword")),
									React.createElement("input", {
										type: "password",
										className: "daw-input",
										value: currentPassword,
										disabled: disabled,
										placeholder: t("currentPassword.placeholder"),
										onChange: (event) => setCurrentPassword(event.target.value),
									}),
								),
								React.createElement(
									"label",
									{ className: "daw-field full" },
									React.createElement("span", { className: "daw-label" }, t("realm")),
									React.createElement("input", {
										className: "daw-input",
										value: realm,
										disabled: disabled,
										onChange: (event) => setRealm(event.target.value),
									}),
									React.createElement("span", { className: "daw-hint" }, t("realm.hint")),
								),
							),
							React.createElement(
								"div",
								{ className: "daw-twoFactor" },
								React.createElement("div", { className: "daw-twoFactorTitle" }, t("twoFactor.status", { state: twoFactorEnabled ? t("twoFactor.state.enabled") : t("twoFactor.state.disabled") })),
								twoFactorOverriddenByEnv
									? React.createElement("div", { className: "daw-warn" }, t("twoFactor.warn.env"))
									: null,
								twoFactorEnabled || totpSecret
									? React.createElement("div", { className: "daw-hint" }, twoFactorEnabled ? t("twoFactor.hint.enabled") : t("twoFactor.hint.setup"))
									: React.createElement("div", { className: "daw-hint" }, t("twoFactor.hint.enterPassword"))
								, totpSecret
									? React.createElement(
										React.Fragment,
										React.createElement("span", { className: "daw-label" }, t("twoFactor.setupKey")),
										React.createElement("code", { className: "daw-secret" }, totpSecret),
										React.createElement("span", { className: "daw-label" }, t("twoFactor.uri")),
										React.createElement("textarea", { className: "daw-input daw-uri", value: totpUri, readOnly: true, spellCheck: false }),
										React.createElement("label", { className: "daw-field" },
											React.createElement("span", { className: "daw-label" }, t("twoFactor.newCode")),
											React.createElement("input", { className: "daw-input daw-otp", inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6, value: totpCode, disabled: disabled, onChange: (event) => setTotpCode(event.target.value) }),
										),
										React.createElement("div", { className: "daw-actions" },
											React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || twoFactorOverriddenByEnv || currentPassword === "" || totpCode.trim() === "" || (twoFactorEnabled && currentOtp === ""), onClick: () => void confirmTwoFactor() }, twoFactorEnabled ? t("twoFactor.replaceButton") : t("twoFactor.enableButton")),
											React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: busy, onClick: () => { setTotpSecret(""); setTotpUri(""); setTotpCode(""); setError(null); setNotice(null); } }, t("cancel")),
										),
									)
									: twoFactorEnabled
										? React.createElement("div", { className: "daw-actions" },
											React.createElement("label", { className: "daw-field" },
												React.createElement("span", { className: "daw-label" }, t("twoFactor.currentCode")),
												React.createElement("input", { className: "daw-input daw-otp", inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6, value: currentOtp, disabled: disabled, onChange: (event) => setCurrentOtp(event.target.value) }),
											),
											React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: disabled || twoFactorOverriddenByEnv || currentPassword === "" || currentOtp === "", onClick: () => void disableTwoFactor() }, t("twoFactor.disableButton")),
										)
										: React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || twoFactorOverriddenByEnv || !meta?.hasPassword, onClick: () => void startTwoFactor() }, t("twoFactor.setupButton")),
							),
							error ? React.createElement("div", { className: "daw-error" }, error) : null,
							notice ? React.createElement("div", { className: "daw-notice" }, notice) : null,
							React.createElement(
								"div",
								{ className: "daw-cardFooter" },
								changed
									? React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: busy, onClick: () => { setUsername(meta.username); setRealm(meta.realm); setPassword(""); setError(null); setNotice(null); } }, t("discard"))
									: null,
								React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || !changed, onClick: () => void save() }, t("save")),
							),
						)
					: null,
			);
		};
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const locale = ctx.get("locale");
			if (locale !== undefined) {
				ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "auth-webserver: locale");
			}
			const t = locale !== undefined
				? locale.bind(LOCALE_NS)
				: (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
			const AuthWebserverCard = createAuthWebserverCard(t);
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
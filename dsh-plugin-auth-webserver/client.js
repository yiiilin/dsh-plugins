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
.daw-clients{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.daw-clientsHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.daw-clientsTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:18px}
.daw-clientList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.daw-client{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;min-width:0;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.daw-client+.daw-client{border-top:1px solid var(--dsw-alias-border-l2)}
.daw-clientIdentity{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}
.daw-clientName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:18px}
.daw-clientCurrent{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.daw-clientMeta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;margin:7px 0 0;font-size:11px;line-height:15px}
.daw-clientMeta dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.daw-clientMeta dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.daw-clientUserAgent{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px}
.daw-clientAction{align-self:center;min-width:52px;padding-inline:9px}
.daw-clientState{padding:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.daw-passkeys{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.daw-passkeysHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.daw-passkeysTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:18px}
.daw-passkeyAdd{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
.daw-passkeyList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.daw-passkey{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;min-width:0;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.daw-passkey+.daw-passkey{border-top:1px solid var(--dsw-alias-border-l2)}
.daw-passkeyName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:18px}
.daw-passkeyMeta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;margin:7px 0 0;font-size:11px;line-height:15px}
.daw-passkeyMeta dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.daw-passkeyMeta dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.daw-passkeyAction{align-self:center;min-width:52px;padding-inline:9px}
.daw-settingsEditorOverlay{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:rgba(15,23,42,.42);pointer-events:auto}
.daw-settingsEditorDialog{box-sizing:border-box;width:min(920px,100%);height:min(80vh,720px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 18px 50px rgba(0,0,0,.22)}
.daw-settingsEditorHead{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}
.daw-settingsEditorTitle{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.daw-settingsEditorMeta{flex:none;color:var(--dsw-alias-label-tertiary,#78716c);font-size:12px}
.daw-settingsEditorIcon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57534e);cursor:pointer}
.daw-settingsEditorIcon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
.daw-settingsEditorIcon:disabled{opacity:.55;cursor:default}
.daw-settingsEditorWarning{margin:0;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 12%,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-state-warning-primary,#b45309);font-size:12px;line-height:18px}
.daw-settingsEditorBody{display:flex;flex:1 1 auto;min-height:0;padding:0;overflow:hidden}
.daw-settingsEditorInput{width:100%;height:100%;resize:none;box-sizing:border-box;padding:14px;border:0;outline:0;background:transparent;color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}
.daw-settingsEditorFallback{padding:14px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary,#b91c1c);font:13px/1.5 sans-serif}
.daw-settingsEditorFooter{display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#78716c);font-size:12px}
.daw-settingsEditorStatus{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daw-settingsEditorStatus[data-kind="dirty"]{color:var(--dsw-alias-state-warning-primary,#d97706)}
.daw-settingsEditorStatus[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.daw-settingsEditorSave{margin-left:auto}
@media (max-width:560px){.daw-client{grid-template-columns:minmax(0,1fr);gap:8px}.daw-clientAction{justify-self:end}.daw-clientsHeader{align-items:flex-start}.daw-clientList{border-radius:6px}.daw-passkey{grid-template-columns:minmax(0,1fr);gap:8px}.daw-passkeyAction{justify-self:end}.daw-passkeyAdd{grid-template-columns:minmax(0,1fr)}.daw-settingsEditorOverlay{padding:0}.daw-settingsEditorDialog{width:100vw;height:100vh;max-height:none;border:0;border-radius:0}}
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
			"twoFactor.warn.env": "2FA 由 AUTH_2FA_ENABLED/AUTH_2FA_REQUIRED/AUTH_2FA_SECRET 控制，无法在此处更改。",
			"twoFactor.warn.required": "部署策略强制启用 2FA，无法在此处禁用。",
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
			"clients.title": "在线客户端",
			"clients.refresh": "刷新",
			"clients.loading": "正在加载在线客户端…",
			"clients.empty": "当前没有在线客户端。",
			"clients.error": "无法加载在线客户端。",
			"clients.created": "创建时间",
			"clients.lastSeen": "最后活动",
			"clients.address": "地址",
			"clients.userAgent": "客户端",
			"clients.unknown": "未知",
			"clients.current": "当前设备",
			"clients.revoke": "踢出",
			"clients.revoking": "踢出中…",
			"clients.revokeAria": "踢出 {name}",
			"notice.clientRevoked": "客户端已撤销。",
			"clients.retry": "重试",
			"passkeys.title": "通行密钥",
			"passkeys.description": "使用设备生物识别或屏幕锁保护此网关。",
			"passkeys.loading": "正在加载通行密钥…",
			"passkeys.empty": "尚未注册通行密钥。",
			"passkeys.unknown": "未命名通行密钥",
			"passkeys.error": "通行密钥操作失败，请重试。",
			"passkeys.cancelled": "通行密钥操作已取消。",
			"passkeys.unsupported": "当前浏览器或连接不支持通行密钥。",
			"passkeys.name": "名称",
			"passkeys.namePlaceholder": "例如：我的 iPhone",
			"passkeys.add": "添加通行密钥",
			"passkeys.registering": "正在注册…",
			"passkeys.created": "创建时间",
			"passkeys.lastUsed": "最后使用",
			"passkeys.never": "从未使用",
			"passkeys.device": "设备类型",
			"passkeys.singleDevice": "单设备",
			"passkeys.multiDevice": "多设备",
			"passkeys.backedUp": "已备份",
			"passkeys.notBackedUp": "未备份",
			"passkeys.revoke": "撤销",
			"passkeys.revoking": "撤销中…",
			"passkeys.revokeAria": "撤销 {name}",
			"notice.passkeyRegistered": "通行密钥已注册。",
			"notice.passkeyRevoked": "通行密钥已撤销。",
			"settingsEditor.title": "模型配置文件",
			"settingsEditor.open": "编辑配置文件",
			"settingsEditor.filename": "settings.yaml",
			"settingsEditor.loading": "正在加载配置文件…",
			"settingsEditor.reload": "重新加载配置文件",
			"settingsEditor.close": "关闭配置编辑器",
			"settingsEditor.save": "保存配置",
			"settingsEditor.saving": "保存中…",
			"settingsEditor.saved": "已保存",
			"settingsEditor.dirty": "有未保存的更改",
			"settingsEditor.discardConfirm": "有未保存的配置更改，确定放弃并关闭吗？",
			"settingsEditor.loadFailed": "无法加载配置文件",
			"settingsEditor.saveFailed": "无法保存配置文件",
			"settingsEditor.insecure": "当前连接未加密，配置内容会以明文传输。",
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
			"twoFactor.warn.env": "2FA is controlled by AUTH_2FA_ENABLED/AUTH_2FA_REQUIRED/AUTH_2FA_SECRET and cannot be changed here.",
			"twoFactor.warn.required": "Deployment policy requires 2FA and it cannot be disabled here.",
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
			"clients.title": "Online clients",
			"clients.refresh": "Refresh",
			"clients.loading": "Loading online clients…",
			"clients.empty": "No online clients.",
			"clients.error": "Could not load online clients.",
			"clients.created": "Created",
			"clients.lastSeen": "Last seen",
			"clients.address": "Address",
			"clients.userAgent": "Client",
			"clients.unknown": "Unknown",
			"clients.current": "This device",
			"clients.revoke": "Kick",
			"clients.revoking": "Kicking…",
			"clients.revokeAria": "Kick {name}",
			"notice.clientRevoked": "Client revoked.",
			"clients.retry": "Retry",
			"passkeys.title": "Passkeys",
			"passkeys.description": "Protect this gateway with your device biometrics or screen lock.",
			"passkeys.loading": "Loading passkeys…",
			"passkeys.empty": "No passkeys registered.",
			"passkeys.unknown": "Unnamed passkey",
			"passkeys.error": "Passkey operation failed. Please try again.",
			"passkeys.cancelled": "Passkey operation was cancelled.",
			"passkeys.unsupported": "This browser or connection does not support passkeys.",
			"passkeys.name": "Name",
			"passkeys.namePlaceholder": "For example: My iPhone",
			"passkeys.add": "Add passkey",
			"passkeys.registering": "Registering…",
			"passkeys.created": "Created",
			"passkeys.lastUsed": "Last used",
			"passkeys.never": "Never",
			"passkeys.device": "Device type",
			"passkeys.singleDevice": "Single-device",
			"passkeys.multiDevice": "Multi-device",
			"passkeys.backedUp": "Backed up",
			"passkeys.notBackedUp": "Not backed up",
			"passkeys.revoke": "Revoke",
			"passkeys.revoking": "Revoking…",
			"passkeys.revokeAria": "Revoke {name}",
			"notice.passkeyRegistered": "Passkey registered.",
			"notice.passkeyRevoked": "Passkey revoked.",
			"settingsEditor.title": "Model configuration file",
			"settingsEditor.open": "Edit configuration file",
			"settingsEditor.filename": "settings.yaml",
			"settingsEditor.loading": "Loading configuration file…",
			"settingsEditor.reload": "Reload configuration file",
			"settingsEditor.close": "Close configuration editor",
			"settingsEditor.save": "Save configuration",
			"settingsEditor.saving": "Saving…",
			"settingsEditor.saved": "Saved",
			"settingsEditor.dirty": "Unsaved changes",
			"settingsEditor.discardConfirm": "You have unsaved configuration changes. Discard them and close?",
			"settingsEditor.loadFailed": "Could not load configuration file",
			"settingsEditor.saveFailed": "Could not save configuration file",
			"settingsEditor.insecure": "This connection is unencrypted; configuration content travels as plain text.",
		};

		function applyParams(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}

		async function api(path, payload) {
			const headers = { "content-type": "application/json" };
			const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) =>
				part.startsWith("__Host-dsh_auth_csrf=") || part.startsWith("dsh_auth_csrf="));
			if (csrf !== undefined) {
				try {
					const prefix = csrf.startsWith("__Host-dsh_auth_csrf=") ? "__Host-dsh_auth_csrf=" : "dsh_auth_csrf=";
					headers["X-DSH-CSRF"] = decodeURIComponent(csrf.slice(prefix.length));
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

		const ONLINE_CLIENTS_PATH = "/_dsh/auth-webserver/clients";
		const REVOKE_CLIENT_PATH = "/_dsh/auth-webserver/clients/revoke";

		function textValue(value) {
			return typeof value === "string" && value.trim() !== "" ? value : "";
		}

		function onlineClientsFromResponse(data) {
			const rows = Array.isArray(data)
				? data
				: Array.isArray(data?.clients)
					? data.clients
					: Array.isArray(data?.onlineClients)
						? data.onlineClients
						: [];
			const currentId = textValue(data?.currentClientId || data?.currentId);
			return rows.map((entry, index) => {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
				const id = textValue(entry.id || entry.clientId || entry.sessionId);
				if (id === "") return null;
				return {
					id,
					current: entry.current === true || entry.isCurrent === true || entry.currentSession === true || id === currentId,
					label: textValue(entry.label || entry.name),
					createdAt: entry.createdAt ?? entry.created ?? entry.created_at,
					lastSeenAt: entry.lastSeenAt ?? entry.lastSeen ?? entry.last_seen ?? entry.updatedAt,
					address: textValue(entry.address || entry.remoteAddress || entry.ip),
					userAgent: textValue(entry.userAgent || entry.ua),
					order: index,
				};
			}).filter((entry) => entry !== null);
		}

		function formatClientTimestamp(value) {
			if (value === undefined || value === null || value === "") return "";
			const numeric = typeof value === "number" ? value : Number(value);
			const date = new Date(Number.isFinite(numeric) && numeric > 0 && numeric < 1e12 ? numeric * 1000 : value);
			return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
		}

		const PASSKEYS_PATH = "/_dsh/auth-webserver/passkeys";
		const PASSKEY_REGISTER_OPTIONS_PATH = "/_dsh/auth-webserver/passkeys/register/options";
		const PASSKEY_REGISTER_VERIFY_PATH = "/_dsh/auth-webserver/passkeys/register/verify";
		const PASSKEY_REVOKE_PATH = "/_dsh/auth-webserver/passkeys/revoke";
		const SETTINGS_EDITOR_EVENT = "dsh-auth-open-settings-editor";
		const SETTINGS_EDITOR_DOCUMENT_PATH = "/_dsh/auth-webserver/settings-editor/document";

		function passkeysFromResponse(data) {
			const rows = Array.isArray(data)
				? data
				: Array.isArray(data?.passkeys)
					? data.passkeys
					: Array.isArray(data?.state?.passkeys)
						? data.state.passkeys
						: [];
			return rows.map((entry) => {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
				const id = textValue(entry.id || entry.credentialId);
				if (id === "") return null;
				return {
					id,
					name: textValue(entry.name),
					createdAt: entry.createdAt,
					lastUsedAt: entry.lastUsedAt,
					deviceType: entry.deviceType === "multiDevice" ? "multiDevice" : "singleDevice",
					backedUp: entry.backedUp === true,
				};
			}).filter((entry) => entry !== null);
		}

		function decodeBase64url(value) {
			if (typeof value !== "string" || value === "") throw new Error("invalid base64url value");
			const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
			const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			return bytes.buffer;
		}

		function bytesOf(value) {
			if (value instanceof ArrayBuffer) return new Uint8Array(value);
			if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			throw new TypeError("expected an ArrayBuffer");
		}

		function encodeBase64url(value) {
			const bytes = bytesOf(value);
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
		}

		function publicKeyCreationOptions(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid passkey options");
			return {
				...value,
				challenge: typeof value.challenge === "string" ? decodeBase64url(value.challenge) : value.challenge,
				user: value.user === null || typeof value.user !== "object" ? value.user : {
					...value.user,
					id: typeof value.user.id === "string" ? decodeBase64url(value.user.id) : value.user.id,
				},
				excludeCredentials: Array.isArray(value.excludeCredentials)
					? value.excludeCredentials.map((entry) => ({
						...entry,
						id: typeof entry.id === "string" ? decodeBase64url(entry.id) : entry.id,
					}))
					: value.excludeCredentials,
			};
		}

		function serializeRegistrationCredential(credential) {
			if (credential === null || typeof credential !== "object" || credential.response === null) throw new Error("invalid passkey credential");
			const response = credential.response;
			const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
			return {
				id: credential.id,
				rawId: encodeBase64url(credential.rawId),
				type: credential.type,
				response: {
					clientDataJSON: encodeBase64url(response.clientDataJSON),
					attestationObject: encodeBase64url(response.attestationObject),
					...(Array.isArray(transports) ? { transports } : {}),
				},
				clientExtensionResults: typeof credential.getClientExtensionResults === "function"
					? credential.getClientExtensionResults()
					: {},
				...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
			};
		}

		function createSettingsEditorOverlay(t) {
			return function SettingsEditorOverlay() {
				const [open, setOpen] = React.useState(false);
				const [generation, setGeneration] = React.useState(0);
				const [content, setContent] = React.useState(null);
				const [revision, setRevision] = React.useState(null);
				const [loading, setLoading] = React.useState(false);
				const [saving, setSaving] = React.useState(false);
				const [dirty, setDirty] = React.useState(false);
				const [saved, setSaved] = React.useState(false);
				const [error, setError] = React.useState(null);
				const dirtyRef = React.useRef(false);

				React.useEffect(() => {
					const openEditor = (event) => {
						event.preventDefault();
						dirtyRef.current = false;
						setDirty(false);
						setSaved(false);
						setError(null);
						setContent(null);
						setRevision(null);
						setOpen(true);
						setGeneration((value) => value + 1);
					};
					window.addEventListener(SETTINGS_EDITOR_EVENT, openEditor);
					return () => window.removeEventListener(SETTINGS_EDITOR_EVENT, openEditor);
				}, []);

				React.useEffect(() => {
					if (!open) return undefined;
					let cancelled = false;
					setLoading(true);
					setSaved(false);
					setError(null);
					api(SETTINGS_EDITOR_DOCUMENT_PATH)
						.then((data) => {
							if (cancelled) return;
							if (typeof data.content !== "string" || typeof data.revision !== "string") {
								throw new Error(t("settingsEditor.loadFailed"));
							}
							dirtyRef.current = false;
							setDirty(false);
							setContent(data.content);
							setRevision(data.revision);
						})
						.catch((cause) => {
							if (!cancelled) setError(cause instanceof Error ? cause.message : t("settingsEditor.loadFailed"));
						})
						.finally(() => {
							if (!cancelled) setLoading(false);
						});
					return () => { cancelled = true; };
				}, [open, generation]);

				const close = () => {
					if (saving) return;
					if (dirtyRef.current && !window.confirm(t("settingsEditor.discardConfirm"))) return;
					dirtyRef.current = false;
					setDirty(false);
					setOpen(false);
					setContent(null);
					setRevision(null);
					setError(null);
				};
				const reload = () => {
					if (loading || saving) return;
					if (dirtyRef.current && !window.confirm(t("settingsEditor.discardConfirm"))) return;
					dirtyRef.current = false;
					setDirty(false);
					setSaved(false);
					setGeneration((value) => value + 1);
				};
				const saveDocument = () => {
					if (saving || content === null || revision === null) return;
					setSaving(true);
					setSaved(false);
					setError(null);
					api(SETTINGS_EDITOR_DOCUMENT_PATH, { content, revision })
						.then((data) => {
							if (typeof data.revision !== "string") throw new Error(t("settingsEditor.saveFailed"));
							dirtyRef.current = false;
							setDirty(false);
							setRevision(data.revision);
							setSaved(true);
						})
						.catch((cause) => setError(cause instanceof Error ? cause.message : t("settingsEditor.saveFailed")))
						.finally(() => setSaving(false));
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.stopPropagation();
					close();
				};
				if (!open) return null;

				const insecure = typeof location !== "undefined" && location.protocol !== "https:";
				const status = loading
					? { text: t("settingsEditor.loading"), kind: "" }
					: saving
						? { text: t("settingsEditor.saving"), kind: "" }
						: error !== null
							? { text: error, kind: "error" }
							: dirty
								? { text: t("settingsEditor.dirty"), kind: "dirty" }
								: saved ? { text: t("settingsEditor.saved"), kind: "" } : null;

				return React.createElement(
					"div",
					{ className: "daw-settingsEditorOverlay", role: "presentation", onClick: close },
					React.createElement(
						"div",
						{
							className: "daw-settingsEditorDialog",
							role: "dialog",
							"aria-modal": "true",
							"aria-label": t("settingsEditor.title"),
							tabIndex: -1,
							onKeyDown,
							onClick: (event) => event.stopPropagation(),
						},
						React.createElement(
							"div",
							{ className: "daw-settingsEditorHead" },
							React.createElement("div", { className: "daw-settingsEditorTitle" }, t("settingsEditor.title")),
							React.createElement("div", { className: "daw-settingsEditorMeta" }, t("settingsEditor.filename")),
							React.createElement("button", {
								type: "button",
								className: "daw-settingsEditorIcon",
								disabled: loading || saving,
								onClick: reload,
								"aria-label": t("settingsEditor.reload"),
								title: t("settingsEditor.reload"),
							}, "↻"),
							React.createElement("button", {
								type: "button",
								className: "daw-settingsEditorIcon",
								disabled: saving,
								onClick: close,
								"aria-label": t("settingsEditor.close"),
								title: t("settingsEditor.close"),
							}, "×"),
						),
						insecure ? React.createElement("p", { className: "daw-settingsEditorWarning", role: "alert" }, t("settingsEditor.insecure")) : null,
						React.createElement(
							"div",
							{ className: "daw-settingsEditorBody" },
							content === null
								? React.createElement("div", { className: "daw-settingsEditorFallback" }, loading ? t("settingsEditor.loading") : error || t("settingsEditor.loadFailed"))
								: React.createElement("textarea", {
									className: "daw-settingsEditorInput",
									value: content,
									autoFocus: true,
									spellCheck: false,
									disabled: loading || saving,
									onChange: (event) => {
										dirtyRef.current = true;
										setDirty(true);
										setSaved(false);
										setContent(event.target.value);
									},
								}),
						),
						React.createElement(
							"div",
							{ className: "daw-settingsEditorFooter" },
							status === null ? null : React.createElement("span", { className: "daw-settingsEditorStatus", "data-kind": status.kind }, status.text),
							React.createElement("button", {
								type: "button",
								className: "daw-btn primary daw-settingsEditorSave",
								disabled: !dirty || loading || saving || content === null || revision === null,
								onClick: saveDocument,
							}, t("settingsEditor.save")),
						),
					),
				);
			};
		}

		function createSettingsEditorAction(t) {
			const SettingsEditorOverlay = createSettingsEditorOverlay(t);
			return function SettingsEditorAction() {
				const openEditor = () => {
					const event = new CustomEvent(SETTINGS_EDITOR_EVENT, { cancelable: true });
					window.dispatchEvent(event);
				};
				return React.createElement(React.Fragment, null,
					React.createElement("button", {
						type: "button",
						className: "daw-btn ghost",
						onClick: openEditor,
					}, t("settingsEditor.open")),
					React.createElement(SettingsEditorOverlay),
				);
			};
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
			const [clients, setClients] = React.useState([]);
			const [clientsLoading, setClientsLoading] = React.useState(false);
			const [clientsError, setClientsError] = React.useState(false);
			const [clientActionId, setClientActionId] = React.useState(null);
			const [passkeys, setPasskeys] = React.useState([]);
			const [passkeysLoading, setPasskeysLoading] = React.useState(false);
			const [passkeysError, setPasskeysError] = React.useState(false);
			const [passkeyName, setPasskeyName] = React.useState("");
			const [passkeyBusy, setPasskeyBusy] = React.useState(false);

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

			const refreshClients = React.useCallback(async () => {
				setClientsLoading(true);
				setClientsError(false);
				try {
					const data = await api(ONLINE_CLIENTS_PATH);
					setClients(onlineClientsFromResponse(data));
					return true;
				} catch {
					setClientsError(true);
					return false;
				} finally {
					setClientsLoading(false);
				}
			}, []);

			React.useEffect(() => {
				void refresh();
			}, [refresh]);

			React.useEffect(() => {
				if (open) void refreshClients();
			}, [open, refreshClients]);

			const revokeClient = async (client) => {
				if (clientActionId !== null || client.id === "") return;
				setClientActionId(client.id);
				setError(null);
				setNotice(null);
				try {
					const data = await api(REVOKE_CLIENT_PATH, { clientId: client.id });
					const current = client.current === true
						|| data?.current === true
						|| data?.revokedCurrent === true
						|| data?.currentSessionRevoked === true;
					if (current) {
						window.location.reload();
						return;
					}
					if (await refreshClients()) setNotice(t("notice.clientRevoked"));
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setClientActionId(null);
				}
			};

			const refreshPasskeys = React.useCallback(async () => {
				setPasskeysLoading(true);
				setPasskeysError(false);
				try {
					const data = await api(PASSKEYS_PATH);
					setPasskeys(passkeysFromResponse(data));
					return true;
				} catch {
					setPasskeysError(true);
					return false;
				} finally {
					setPasskeysLoading(false);
				}
			}, []);

			React.useEffect(() => {
				if (open) void refreshPasskeys();
			}, [open, refreshPasskeys]);

			const revokePasskey = async (passkey) => {
				if (passkeyBusy || passkey.id === "") return;
				setPasskeyBusy(true);
				setError(null);
				setNotice(null);
				try {
					const data = await api(PASSKEY_REVOKE_PATH, {
						credentialId: passkey.id,
						currentPassword,
						currentOtp,
					});
					setPasskeys(passkeysFromResponse(data));
					setCurrentPassword("");
					setCurrentOtp("");
					setNotice(t("notice.passkeyRevoked"));
				} catch {
					setError(t("passkeys.error"));
				} finally {
					setPasskeyBusy(false);
				}
			};

			const registerPasskey = async () => {
				if (passkeyBusy || disabled || passkeyName.trim() === "") return;
				if (typeof window.PublicKeyCredential !== "function" || !navigator.credentials?.create) {
					setError(t("passkeys.unsupported"));
					return;
				}
				setPasskeyBusy(true);
				setError(null);
				setNotice(null);
				try {
					const optionsData = await api(PASSKEY_REGISTER_OPTIONS_PATH, { currentPassword, currentOtp });
					const credential = await navigator.credentials.create({ publicKey: publicKeyCreationOptions(optionsData.options) });
					if (credential === null) throw new Error("cancelled");
					const data = await api(PASSKEY_REGISTER_VERIFY_PATH, {
						challenge: optionsData.challenge,
						response: serializeRegistrationCredential(credential),
						name: passkeyName.trim(),
					});
					setPasskeys(passkeysFromResponse(data));
					setPasskeyName("");
					setCurrentPassword("");
					setCurrentOtp("");
					setNotice(t("notice.passkeyRegistered"));
				} catch (cause) {
					setError(cause?.name === "NotAllowedError" || cause?.message === "cancelled"
						? t("passkeys.cancelled")
						: t("passkeys.error"));
				} finally {
					setPasskeyBusy(false);
				}
			};

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
			const twoFactorRequiredByConfig = Boolean(meta?.twoFactorRequiredByConfig);
			const twoFactorLocked = twoFactorOverriddenByEnv || twoFactorRequiredByConfig;

			const renderPasskey = (passkey) => {
				const name = passkey.name || t("passkeys.unknown");
				return React.createElement(
					"article",
					{ className: "daw-passkey", key: passkey.id, "data-auth-passkey-id": passkey.id },
					React.createElement(
						"div",
						{ className: "daw-passkeyMain" },
						React.createElement("div", { className: "daw-passkeyName" }, name),
						React.createElement(
							"dl",
							{ className: "daw-passkeyMeta" },
							React.createElement("dt", null, t("passkeys.created")),
							React.createElement("dd", null, formatClientTimestamp(passkey.createdAt) || t("passkeys.unknown")),
							React.createElement("dt", null, t("passkeys.lastUsed")),
							React.createElement("dd", null, formatClientTimestamp(passkey.lastUsedAt) || t("passkeys.never")),
							React.createElement("dt", null, t("passkeys.device")),
							React.createElement("dd", null, t(passkey.deviceType === "multiDevice" ? "passkeys.multiDevice" : "passkeys.singleDevice")),
							React.createElement("dt", null, t("passkeys.backedUp")),
							React.createElement("dd", null, t(passkey.backedUp ? "passkeys.backedUp" : "passkeys.notBackedUp")),
						),
					),
					React.createElement("button", {
						type: "button",
						className: "daw-btn ghost daw-passkeyAction",
						disabled: disabled || passkeyBusy,
						"aria-label": t("passkeys.revokeAria", { name }),
						onClick: () => void revokePasskey(passkey),
					}, passkeyBusy ? t("passkeys.revoking") : t("passkeys.revoke")),
				);
			};

			const renderClient = (client) => {
				const name = client.label || (client.current ? t("clients.current") : t("clients.unknown"));
				const unknown = t("clients.unknown");
				return React.createElement(
					"article",
					{ className: "daw-client", key: client.id, "data-auth-client-id": client.id },
					React.createElement(
						"div",
						{ className: "daw-clientMain" },
						React.createElement(
							"div",
							{ className: "daw-clientIdentity" },
							React.createElement("span", { className: "daw-clientName" }, name),
							client.current
								? React.createElement("span", { className: "daw-clientCurrent" }, t("clients.current"))
								: null,
						),
						React.createElement(
							"dl",
							{ className: "daw-clientMeta" },
							React.createElement("dt", null, t("clients.created")),
							React.createElement("dd", null, formatClientTimestamp(client.createdAt) || unknown),
							React.createElement("dt", null, t("clients.lastSeen")),
							React.createElement("dd", null, formatClientTimestamp(client.lastSeenAt) || unknown),
							React.createElement("dt", null, t("clients.address")),
							React.createElement("dd", null, client.address || unknown),
							React.createElement("dt", null, t("clients.userAgent")),
							React.createElement("dd", { className: "daw-clientUserAgent" }, client.userAgent || unknown),
						),
					),
					React.createElement(
						"button",
						{
							type: "button",
							className: "daw-btn ghost daw-clientAction",
							disabled: disabled || clientActionId !== null,
							"aria-label": t("clients.revokeAria", { name }),
							onClick: () => void revokeClient(client),
						},
						clientActionId === client.id ? t("clients.revoking") : t("clients.revoke"),
					),
				);
			};

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
								"section",
								{ className: "daw-clients", "aria-label": t("clients.title") },
								React.createElement(
									"div",
									{ className: "daw-clientsHeader" },
									React.createElement("div", { className: "daw-clientsTitle" }, t("clients.title")),
									React.createElement("button", {
										type: "button",
										className: "daw-btn ghost",
										disabled: disabled || clientsLoading || clientActionId !== null,
										onClick: () => void refreshClients(),
									}, t("clients.refresh")),
								),
								clientsLoading
									? React.createElement("div", { className: "daw-clientState" }, t("clients.loading"))
									: clientsError
										? React.createElement(
											"div",
											{ className: "daw-actions" },
											React.createElement("div", { className: "daw-clientState" }, t("clients.error")),
											React.createElement("button", {
												type: "button",
												className: "daw-btn ghost",
												disabled: disabled || clientActionId !== null,
												onClick: () => void refreshClients(),
											}, t("clients.retry")),
										)
										: clients.length === 0
											? React.createElement("div", { className: "daw-clientState" }, t("clients.empty"))
											: React.createElement("div", { className: "daw-clientList" }, clients.map(renderClient)),
							),
								React.createElement(
									"section",
									{ className: "daw-passkeys", "aria-label": t("passkeys.title") },
									React.createElement(
										"div",
										{ className: "daw-passkeysHeader" },
										React.createElement("div", { className: "daw-passkeysTitle" }, t("passkeys.title")),
										React.createElement("button", {
											type: "button",
											className: "daw-btn ghost",
											disabled: disabled || passkeysLoading || passkeyBusy,
											onClick: () => void refreshPasskeys(),
										}, t("clients.refresh")),
									),
									React.createElement("div", { className: "daw-hint" }, t("passkeys.description")),
									React.createElement(
										"div",
										{ className: "daw-passkeyAdd" },
										React.createElement(
											"label",
											{ className: "daw-field" },
											React.createElement("span", { className: "daw-label" }, t("passkeys.name")),
											React.createElement("input", {
												className: "daw-input",
												value: passkeyName,
												placeholder: t("passkeys.namePlaceholder"),
												disabled: disabled || passkeyBusy,
												onChange: (event) => setPasskeyName(event.target.value),
											}),
										),
										React.createElement("button", {
											type: "button",
											className: "daw-btn primary",
											disabled: disabled || passkeyBusy || passkeyName.trim() === "" || currentPassword === "" || (twoFactorEnabled && currentOtp === ""),
											onClick: () => void registerPasskey(),
										}, passkeyBusy ? t("passkeys.registering") : t("passkeys.add")),
									),
									passkeysLoading
										? React.createElement("div", { className: "daw-clientState" }, t("passkeys.loading"))
										: passkeysError
											? React.createElement(
												"div",
												{ className: "daw-actions" },
												React.createElement("div", { className: "daw-clientState" }, t("passkeys.error")),
												React.createElement("button", {
													type: "button",
													className: "daw-btn ghost",
													disabled: disabled || passkeyBusy,
													onClick: () => void refreshPasskeys(),
												}, t("clients.retry")),
											)
											: passkeys.length === 0
												? React.createElement("div", { className: "daw-clientState" }, t("passkeys.empty"))
												: React.createElement("div", { className: "daw-passkeyList" }, passkeys.map(renderPasskey)),
								),
							React.createElement(
								"div",
								{ className: "daw-twoFactor" },
								React.createElement("div", { className: "daw-twoFactorTitle" }, t("twoFactor.status", { state: twoFactorEnabled ? t("twoFactor.state.enabled") : t("twoFactor.state.disabled") })),
								twoFactorOverriddenByEnv
									? React.createElement("div", { className: "daw-warn" }, t("twoFactor.warn.env"))
									: null,
								twoFactorRequiredByConfig
									? React.createElement("div", { className: "daw-warn" }, t("twoFactor.warn.required"))
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
											React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || twoFactorLocked || currentPassword === "" || totpCode.trim() === "" || (twoFactorEnabled && currentOtp === ""), onClick: () => void confirmTwoFactor() }, twoFactorEnabled ? t("twoFactor.replaceButton") : t("twoFactor.enableButton")),
											React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: busy, onClick: () => { setTotpSecret(""); setTotpUri(""); setTotpCode(""); setError(null); setNotice(null); } }, t("cancel")),
										),
									)
									: twoFactorEnabled
										? React.createElement("div", { className: "daw-actions" },
											React.createElement("label", { className: "daw-field" },
												React.createElement("span", { className: "daw-label" }, t("twoFactor.currentCode")),
												React.createElement("input", { className: "daw-input daw-otp", inputMode: "numeric", autoComplete: "one-time-code", maxLength: 6, value: currentOtp, disabled: disabled, onChange: (event) => setCurrentOtp(event.target.value) }),
											),
											React.createElement("button", { type: "button", className: "daw-btn ghost", disabled: disabled || twoFactorLocked || currentPassword === "" || currentOtp === "", onClick: () => void disableTwoFactor() }, t("twoFactor.disableButton")),
										)
										: React.createElement("button", { type: "button", className: "daw-btn primary", disabled: disabled || twoFactorLocked || !meta?.hasPassword, onClick: () => void startTwoFactor() }, t("twoFactor.setupButton")),
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
			const SettingsEditorAction = createSettingsEditorAction(t);
			ctx.effect(() => slots.inject("settings.action", () => slots.register({
				name: "settings.action",
				id: "open-document",
				priority: -1,
				order: 0,
			}, SettingsEditorAction)), "auth-webserver: settings editor action");
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
/**
 * dsh-plugin-web-daemon — browser plugin configuration card.
 *
 * Static DSH client bundle. The node half exposes the daemon API routes under
 * /_dsh/web-daemon; this card appears under Settings > Plugins > Plugin
 * configuration (settings.plugin.item, keyed by the "web-daemon" settings
 * namespace). The card chrome (header, disclosure, footer) is implemented
 * here because the client bundle purity gate forbids importing the official
 * card chrome as values; only the slot registration protocol is shared.
 */
window.__ModuleLoader__.load({
	id: "@yiln-dsh/dsh-plugin-web-daemon",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const inject = ["slots", "timer"];

		const LOCALE_NS = "web-daemon";
		const ZH_DICT = {
			server: "服务器",
			"server.status": "服务器状态",
			"server.status.unavailable": "服务器状态不可用",
			"server.status.error": "服务器状态暂时不可用",
			cpu: "CPU：",
			memory: "内存",
			"net.up": "上行 ",
			"net.down": "下行 ",
			network: "网络：",
			disk: "硬盘",
			"disk.count": "{count} 个挂载点",
			"disk.none": "未发现已挂载的物理硬盘",
			"disk.unavailable": "硬盘占用不可用",
			"disk.partial": "部分挂载点暂时不可用",
			"disk.usage": "已用 {used} / {total}",
			"disk.item": "{device}，挂载点 {mountpoint}，已用 {percent}",
			"daemon.title": "Web 守护进程",
			"daemon.desc": "以 systemd 单元形式管理 dsh Web 工作进程。",
			"status.running": "运行中",
			"status.failed": "失败",
			"status.restarting": "重启中",
			"status.starting": "启动中",
			"status.stopped": "已停止",
			"action.start": "启动",
			"action.stop": "停止",
			"action.restart": "重启",
			"action.reset": "重置失败状态",
			save: "保存设置",
			discard: "放弃修改",
			saved: "守护进程设置已保存。",
			"lost.contact": "与守护进程 API 失去联系——正在重试…",
			"loading.status": "正在加载守护进程状态…",
			"status.na": "守护进程状态不可用。",
			enabled: "启用",
			"enabled.hint": "对应 systemctl enable/disable；停用后仍可执行启动/停止。",
			boot: "开机自启并保持运行",
			scope: "systemd 作用域",
			"scope.hint": "system 作用域需要 root；用户单元使用 --user。",
			unit: "systemd 单元",
			profile: "配置文件",
			"profile.hint": "由工作进程启动的 DSH 配置。",
			port: "端口",
			"port.hint": "工作进程始终绑定回环地址；局域网访问由 dsh-plugin-auth-webserver 处理。",
			"journal.hint": "日志写入 systemd 日志：journalctl -u {name} -f",
			"nested.notice": "当前进程即为受管工作进程：可在此重启（例如插件更新后）；启动/停止和配置由单元所有者管理。",
			unsaved: "有未保存的更改",
			"meta.pid": "PID：",
			"meta.restarts": "重启次数：",
			"meta.started": "启动于：",
			"meta.unit": "单元：",
			"meta.stateOpen": "（",
			"meta.stateClose": "）",
			"state.unknown": "未知",
			"notice.start": "已请求启动守护进程。",
			"notice.stop": "守护进程已停止。",
			"notice.restart": "已请求重启守护进程。",
			"notice.reset": "已重置守护进程启动次数限制。",
			"notice.restarting": "已请求重启——正在等待服务恢复…",
		};
		const EN_DICT = {
			server: "Server",
			"server.status": "Server status",
			"server.status.unavailable": "Server status unavailable",
			"server.status.error": "Server status temporarily unavailable",
			cpu: "CPU: ",
			memory: "Memory",
			"net.up": "Up ",
			"net.down": "Down ",
			network: "Network: ",
			disk: "Disk",
			"disk.count": "{count} mounted filesystem(s)",
			"disk.none": "No mounted physical disks found",
			"disk.unavailable": "Disk usage unavailable",
			"disk.partial": "Some mounted filesystems are temporarily unavailable",
			"disk.usage": "Used {used} / {total}",
			"disk.item": "{device}, mounted at {mountpoint}, {percent} used",
			"daemon.title": "Web daemon",
			"daemon.desc": "Manages the dsh web worker as a systemd unit.",
			"status.running": "Running",
			"status.failed": "Failed",
			"status.restarting": "Restarting",
			"status.starting": "Starting",
			"status.stopped": "Stopped",
			"action.start": "Start",
			"action.stop": "Stop",
			"action.restart": "Restart",
			"action.reset": "Reset failed state",
			save: "Save settings",
			discard: "Discard",
			saved: "Daemon settings saved.",
			"lost.contact": "Lost contact with the daemon API — retrying...",
			"loading.status": "Loading daemon status...",
			"status.na": "Daemon status is not available.",
			enabled: "Enabled",
			"enabled.hint": "Maps to systemctl enable/disable; Start/Stop still work while disabled.",
			boot: "start on boot and keep running",
			scope: "Systemd scope",
			"scope.hint": "system needs root; user units use --user.",
			unit: "Systemd unit",
			profile: "Profile",
			"profile.hint": "DSH profile started by the worker.",
			port: "Port",
			"port.hint": "Worker always binds loopback; LAN access is handled by dsh-plugin-auth-webserver.",
			"journal.hint": "Logs go to the systemd journal: journalctl -u {name} -f",
			"nested.notice": "This process is the managed worker. Restart is available here (e.g. after plugin updates); Start/Stop and configuration live on the unit owner.",
			unsaved: "Unsaved changes",
			"meta.pid": "PID: ",
			"meta.restarts": "restarts: ",
			"meta.started": "started: ",
			"meta.unit": "unit: ",
			"meta.stateOpen": " (",
			"meta.stateClose": ")",
			"state.unknown": "unknown",
			"notice.start": "Daemon start requested.",
			"notice.stop": "Daemon stopped.",
			"notice.restart": "Daemon restart requested.",
			"notice.reset": "Daemon start limit reset.",
			"notice.restarting": "Restart requested — waiting for the service to come back...",
		};

		function applyParams(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}

		const STYLE_ID = "dsh-plugin-web-daemon-settings";
		if (typeof document !== "undefined") {
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				style.setAttribute("data-plugin", "dsh-plugin-web-daemon");
			}
			style.textContent = `
.dwd-card{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dwd-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dwd-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dwd-cardHeader{appearance:none;display:flex;align-items:center;width:100%;gap:12px;padding:14px 16px;border:0;border-radius:12px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dwd-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dwd-cardHead{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}
.dwd-cardTitle{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dwd-cardDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dwd-unsaved{flex:none;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px}
.dwd-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}
.dwd-chevron[data-open="true"]{transform:rotate(180deg)}
.dwd-cardBody{display:flex;flex-direction:column;gap:14px;margin:0 16px;padding:12px 0 8px;border-top:1px solid var(--dsw-alias-border-l2);background:transparent}
.dwd-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:38px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-1, #fff)}
.dwd-pill{display:inline-flex;align-items:center;gap:6px;min-height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600}
.dwd-pill[data-state="running"]{background:rgba(34,197,94,.14);color:#15803d}
.dwd-pill[data-state="failed"]{background:rgba(239,68,68,.14);color:#b91c1c}
.dwd-pill[data-state="restarting"]{background:rgba(245,158,11,.16);color:#b45309}
.dwd-pill[data-state="starting"]{background:rgba(59,130,246,.14);color:#1d4ed8}
.dwd-meta{min-width:0;display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--dsw-alias-label-secondary, #57534e);font-size:12px;line-height:18px}
.dwd-meta b{font-weight:600;color:var(--dsw-alias-label-primary, #111827)}
.dwd-actions{display:flex;flex-wrap:wrap;gap:8px}
.dwd-btn{appearance:none;min-height:unset;padding:5px 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;white-space:nowrap}
.dwd-btn:hover{background:var(--dsw-alias-bg-layer-2, #e7e5e4)}
.dwd-btn:disabled{opacity:.55;cursor:default}
.dwd-btn.primary{background:var(--dsw-alias-brand-primary, #2563eb);border-color:transparent;color:#fff}
.dwd-btn.primary:hover{background:var(--dsw-alias-brand-primary, #2563eb)}
.dwd-btn.ghost{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}
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
.dwd-override{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#b45309}
.dwd-command{max-width:100%;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.16));border-radius:6px;background:var(--dsw-alias-bg-code, rgba(0,0,0,.04));color:var(--dsw-alias-label-primary, #111827);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dwd-error{padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:#b91c1c;font-size:13px;line-height:18px}
.dwd-notice{padding:6px 10px;border:1px solid rgba(34,197,94,.28);border-radius:6px;background:rgba(34,197,94,.08);color:#15803d;font-size:13px;line-height:18px}
.dwd-empty{color:var(--dsw-alias-label-secondary, #57534e);font-size:13px}
.dwd-cardFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dwd-serverStatus{box-sizing:border-box;width:100%;margin:0 0 8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#111827)}
.dwd-serverStatusHeader{display:flex;align-items:center;gap:6px;min-height:18px;color:var(--dsw-alias-label-secondary,#57534e);font-size:11px;font-weight:600;line-height:16px}
.dwd-serverDot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary,#a8a29e)}
.dwd-serverStatus[data-state="ok"] .dwd-serverDot{background:#16a34a}
.dwd-serverStatus[data-state="error"] .dwd-serverDot{background:#dc2626}
.dwd-serverStatus[data-state="loading"] .dwd-serverDot{background:#d97706}
.dwd-serverGrid{display:flex;flex-direction:column;gap:5px;margin-top:8px;min-width:0}
.dwd-serverMetricRow{display:flex;align-items:baseline;gap:7px;min-width:0;white-space:nowrap;overflow:hidden}
.dwd-serverMetricLabel{flex:none;color:var(--dsw-alias-label-tertiary,#78716c);font-size:10px;line-height:16px}
.dwd-serverMetricValue{display:inline-block;min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-primary,#111827);font-size:12px;font-weight:600;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwd-serverMetricValueNetwork{font-size:11px;font-weight:500}
.dwd-serverMetricValue[data-tone="warn"]{color:#b45309}
.dwd-serverMetricValue[data-tone="critical"]{color:#b91c1c}
.dwd-serverDiskSection{display:flex;flex-direction:column;gap:3px;margin-top:1px;min-width:0}
.dwd-serverDiskHeading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;line-height:14px}
.dwd-serverDiskCount{flex:none;color:var(--dsw-alias-label-tertiary,#78716c);font-size:9px;line-height:14px}
.dwd-serverDiskList{display:flex;flex-direction:column;gap:2px;min-width:0;margin:0;padding:0;list-style:none}
.dwd-serverDiskRow{display:flex;align-items:baseline;gap:6px;min-width:0;padding:2px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.dwd-serverDiskIdentity{display:flex;align-items:baseline;gap:4px;min-width:0;flex:1 1 auto;overflow:hidden}
.dwd-serverDiskDevice{flex:none;max-width:40%;color:var(--dsw-alias-label-primary,#111827);font-size:10px;font-weight:600;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwd-serverDiskMount{min-width:0;color:var(--dsw-alias-label-secondary,#57534e);font-size:9px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwd-serverDiskPercent{order:3;flex:none;color:var(--dsw-alias-label-primary,#111827);font-size:11px;font-weight:700;line-height:14px;white-space:nowrap}
.dwd-serverDiskPercent[data-tone="warn"]{color:#b45309}
.dwd-serverDiskPercent[data-tone="critical"]{color:#b91c1c}
.dwd-serverDiskDetail{order:2;min-width:0;flex:0 1 auto;max-width:44%;color:var(--dsw-alias-label-tertiary,#78716c);font-size:9px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwd-serverDiskEmpty{color:var(--dsw-alias-label-tertiary,#78716c);font-size:10px;line-height:14px;overflow-wrap:anywhere}
.dwd-serverError{margin-top:7px;color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:10px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwd-serverStatusRail{box-sizing:border-box;width:28px;height:28px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-secondary,#57534e)}
.dwd-serverStatusRail .dwd-serverDot{width:8px;height:8px}
.dwd-serverStatusRail[data-state="ok"] .dwd-serverDot{background:#16a34a}
.dwd-serverStatusRail[data-state="error"] .dwd-serverDot{background:#dc2626}
.dwd-serverStatusRail[data-state="loading"] .dwd-serverDot{background:#d97706}
`;
			if (style.parentNode === null) document.head.append(style);
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

		function formatPercent(value) {
			return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "--";
		}

		function formatRate(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "--";
			const units = ["B/s", "KB/s", "MB/s", "GB/s"];
			let scaled = Math.max(0, value);
			let unit = 0;
			while (scaled >= 1024 && unit < units.length - 1) {
				scaled /= 1024;
				unit += 1;
			}
			const amount = scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1);
			return `${amount} ${units[unit]}`;
		}

		function formatBytes(value) {
			let bytes;
			try {
				bytes = typeof value === "bigint" ? value : BigInt(String(value));
			} catch {
				return "--";
			}
			if (bytes < 0n) return "--";
			const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
			let divisor = 1n;
			let unit = 0;
			while (bytes >= divisor * 1024n && unit < units.length - 1) {
				divisor *= 1024n;
				unit += 1;
			}
			const whole = bytes / divisor;
			const tenths = divisor === 1n ? 0n : (bytes % divisor) * 10n / divisor;
			const amount = whole >= 10n || divisor === 1n ? whole.toString() : `${whole}.${tenths}`;
			return `${amount} ${units[unit]}`;
		}

		function metricTone(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
			if (value >= 90) return "critical";
			if (value >= 75) return "warn";
			return "ok";
		}

		function createServerStatus(timer, t) {
			return function ServerStatus(props) {
				const [snapshot, setSnapshot] = React.useState(null);
				const [error, setError] = React.useState(null);
				const failuresRef = React.useRef(0);
				const requestRef = React.useRef(false);

				const refresh = React.useCallback(async () => {
					if (requestRef.current) return;
					requestRef.current = true;
					try {
						const next = await api("/_dsh/web-daemon/metrics");
						failuresRef.current = 0;
						setSnapshot(next);
						setError(null);
					} catch {
						failuresRef.current += 1;
						if (failuresRef.current >= 3) setError(t("server.status.error"));
					} finally {
						requestRef.current = false;
					}
				}, []);

				React.useEffect(() => {
					void refresh();
					return timer.interval(() => void refresh(), 3000);
				}, [refresh]);

				const state = error !== null ? "error" : snapshot === null ? "loading" : "ok";
				const wide = props.wide !== false;
				if (!wide) {
					return React.createElement(
						"div",
						{ className: "dwd-serverStatusRail", "data-state": state, role: "status", "aria-label": error === null ? t("server.status") : t("server.status.unavailable"), title: t("server.status") },
						React.createElement("span", { className: "dwd-serverDot", "aria-hidden": "true" }),
					);
				}

				const cpu = snapshot?.cpu;
				const memory = snapshot?.memory;
				const network = snapshot?.network;
				const disks = snapshot?.disks;
				const filesystems = Array.isArray(disks?.filesystems) ? disks.filesystems : [];
				const diskNotice = disks?.available === false
					? t("disk.unavailable")
					: disks?.partial === true
						? t("disk.partial")
						: filesystems.length === 0
							? t("disk.none")
							: null;
				return React.createElement(
					"section",
					{ className: "dwd-serverStatus", "data-state": state, role: "region", "aria-label": t("server.status") },
					React.createElement(
						"div",
						{ className: "dwd-serverStatusHeader" },
						React.createElement("span", { className: "dwd-serverDot", "aria-hidden": "true" }),
						t("server"),
					),
					React.createElement(
						"div",
						{ className: "dwd-serverGrid" },
						React.createElement(
							"div",
							{ className: "dwd-serverMetricRow" },
							React.createElement("span", { className: "dwd-serverMetricLabel" }, t("cpu")),
							React.createElement("b", { className: "dwd-serverMetricValue", "data-tone": metricTone(cpu?.percent) }, formatPercent(cpu?.percent)),
							React.createElement("span", { className: "dwd-serverMetricLabel" }, t("memory")),
							React.createElement("b", { className: "dwd-serverMetricValue", "data-tone": metricTone(memory?.percent) }, formatPercent(memory?.percent)),
						),
						React.createElement(
							"div",
							{ className: "dwd-serverMetricRow" },
							React.createElement("span", { className: "dwd-serverMetricLabel" }, t("network")),
							React.createElement("span", { className: "dwd-serverMetricValue dwd-serverMetricValueNetwork" }, t("net.up"), formatRate(network?.txBytesPerSecond)),
							React.createElement("span", { className: "dwd-serverMetricValue dwd-serverMetricValueNetwork" }, t("net.down"), formatRate(network?.rxBytesPerSecond)),
						),
						snapshot === null
							? null
							: React.createElement(
									"div",
									{ className: "dwd-serverDiskSection" },
									React.createElement(
										"div",
										{ className: "dwd-serverDiskHeading" },
										React.createElement("span", { className: "dwd-serverMetricLabel" }, t("disk")),
										React.createElement("span", { className: "dwd-serverDiskCount" }, t("disk.count", { count: filesystems.length })),
									),
									diskNotice === null
										? null
										: React.createElement("div", { className: "dwd-serverDiskEmpty", role: disks?.partial === true ? "status" : undefined }, diskNotice),
								filesystems.length === 0
										? null
										: React.createElement(
												"ul",
												{ className: "dwd-serverDiskList", "aria-label": t("disk") },
												filesystems.map((filesystem, index) => {
													const device = typeof filesystem?.source === "string" && filesystem.source !== "" ? filesystem.source : "--";
													const mountpoint = typeof filesystem?.mountpoint === "string" && filesystem.mountpoint !== "" ? filesystem.mountpoint : "--";
													const percent = formatPercent(filesystem?.percent);
													return React.createElement(
														"li",
														{ className: "dwd-serverDiskRow", key: `${device}:${mountpoint}:${index}`, "aria-label": t("disk.item", { device, mountpoint, percent }) },
														React.createElement(
															"div",
															{ className: "dwd-serverDiskIdentity" },
															React.createElement("b", { className: "dwd-serverDiskDevice", title: device }, device),
															React.createElement("span", { className: "dwd-serverDiskMount", title: mountpoint }, mountpoint),
														),
														React.createElement("b", { className: "dwd-serverDiskPercent", "data-tone": metricTone(filesystem?.percent) }, percent),
														React.createElement("span", { className: "dwd-serverDiskDetail" }, t("disk.usage", { used: formatBytes(filesystem?.usedBytes), total: formatBytes(filesystem?.totalBytes) })),
													);
												}),
											),
								),
					),
					error === null ? null : React.createElement("div", { className: "dwd-serverError", role: "alert" }, error),
				);
			};
		}

		function createWebDaemonCard(t) {
			return function WebDaemonCard(props) {
			const timer = props.timer;
			const [open, setOpen] = React.useState(false);
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
						setError(t("lost.contact"));
					}
				}
			}, []);

			React.useEffect(() => {
				void refresh();
				const cancel = timer.interval(() => void refresh(), 4000);
				return cancel;
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
						setNotice(t("saved"));
					} else if (action === "restart" && snapshot?.nested) {
						// The worker kills itself as part of `systemctl restart`,
						// so this request never gets a response — fire it and let
						// polling reconnect to the fresh process.
						api("/_dsh/web-daemon/restart", {}).catch(() => {});
						setNotice(t("notice.restarting"));
						timer.timeout(() => void refresh(), 3000);
					} else {
						const result = await api(`/_dsh/web-daemon/${action}`, {});
						setSnapshot(result);
						setDraft(null);
						if (action === "start") setNotice(t("notice.start"));
						if (action === "stop") setNotice(t("notice.stop"));
						if (action === "restart") setNotice(t("notice.restart"));
						if (action === "reset") setNotice(t("notice.reset"));
					}
				} catch (err) {
					setError(err && err.message ? err.message : String(err));
				} finally {
					setBusy(false);
				}
			};

			const changed = draft !== null;
			const status = snapshot?.status || "unknown";
			const writable = snapshot?.writable !== false;
			const nested = Boolean(snapshot?.nested);
			const unit = snapshot?.unit || {};
			const disabled = busy || !writable || nested;

			return React.createElement(
				"div",
				{ className: open ? "dwd-card dwd-cardOpen" : "dwd-card" },
				React.createElement(
					"button",
					{
						type: "button",
						className: "dwd-cardHeader",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
					},
					React.createElement(
						"span",
						{ className: "dwd-cardHead" },
						React.createElement("span", { className: "dwd-cardTitle" }, t("daemon.title")),
						React.createElement("span", { className: "dwd-cardDesc" }, t("daemon.desc")),
					),
					changed ? React.createElement("span", { className: "dwd-unsaved" }, t("unsaved")) : null,
					React.createElement(
						"svg",
						{ className: "dwd-chevron", "data-open": String(open), viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" },
						React.createElement("path", { d: "M3 5l4 4 4-4", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
					),
				),
				open
					? React.createElement(
							"div",
							{ className: "dwd-cardBody" },
							snapshot === null && error === null
								? React.createElement("div", { className: "dwd-section" }, t("loading.status"))
								: null,
							config === undefined && snapshot !== null
								? React.createElement("p", { className: "dwd-empty" }, t("status.na"))
								: null,
							config !== undefined && snapshot !== null
								? React.createElement(
										"div",
										{ className: "dwd-section" },
										React.createElement(
											"div",
											{ className: "dwd-status" },
											React.createElement(
												"span",
												{ className: "dwd-pill", "data-state": status, "aria-live": "polite" },
												status === "running" ? t("status.running") : status === "failed" ? t("status.failed") : status === "restarting" ? t("status.restarting") : status === "starting" ? t("status.starting") : t("status.stopped"),
											),
											React.createElement(
												"span",
												{ className: "dwd-meta" },
												React.createElement("span", null, t("meta.pid"), React.createElement("b", null, snapshot.pid || "-")),
												React.createElement("span", null, t("meta.restarts"), React.createElement("b", null, snapshot.restarts || 0)),
												React.createElement("span", null, t("meta.started"), React.createElement("b", null, snapshot.startedAt || "-")),
												React.createElement("span", null, t("meta.unit"), React.createElement("b", null, unit.name || "-"), t("meta.stateOpen"), unit.activeState || t("state.unknown"), t("meta.stateClose")),
											),
											React.createElement(
												"div",
												{ className: "dwd-actions" },
												React.createElement("button", { type: "button", className: "dwd-btn primary", disabled: busy || nested, onClick: () => void run("start") }, t("action.start")),
												React.createElement("button", { type: "button", className: "dwd-btn danger", disabled: busy || nested, onClick: () => void run("stop") }, t("action.stop")),
												React.createElement("button", { type: "button", className: "dwd-btn", disabled: busy, onClick: () => void run("restart") }, t("action.restart")),
												React.createElement("button", { type: "button", className: "dwd-btn", disabled: busy || nested, onClick: () => void run("reset") }, t("action.reset")),
											),
										),
										nested
											? React.createElement("div", { className: "dwd-notice", role: "status" }, t("nested.notice"))
											: null,
										error === null ? null : React.createElement("div", { className: "dwd-error", role: "alert" }, error),
										notice === null ? null : React.createElement("div", { className: "dwd-notice", role: "status" }, notice),
										React.createElement(
											"div",
											{ className: "dwd-grid" },
											React.createElement(
												"label",
												{ className: "dwd-field" },
												React.createElement("span", { className: "dwd-label" }, t("enabled")),
												React.createElement(
													"label",
													{ className: "dwd-check" },
													React.createElement("input", { type: "checkbox", checked: Boolean(config.enabled), disabled: disabled, onChange: (event) => update("enabled", event.target.checked) }),
													t("boot"),
												),
												React.createElement("span", { className: "dwd-hint" }, t("enabled.hint")),
											),
											React.createElement(
												"label",
												{ className: "dwd-field" },
												React.createElement("span", { className: "dwd-label" }, t("scope")),
												React.createElement(
													"select",
													{ className: "dwd-input", value: config.systemdScope || "system", disabled: disabled, onChange: (event) => update("systemdScope", event.target.value) },
													React.createElement("option", { value: "system" }, "system"),
													React.createElement("option", { value: "user" }, "user"),
												),
												React.createElement("span", { className: "dwd-hint" }, t("scope.hint")),
											),
											React.createElement(
												"label",
												{ className: "dwd-field" },
												React.createElement("span", { className: "dwd-label" }, t("unit")),
												React.createElement("input", { className: "dwd-input", value: config.systemdUnit || "dsh-web.service", disabled: disabled, onChange: (event) => update("systemdUnit", event.target.value) }),
											),
											React.createElement(
												"label",
												{ className: "dwd-field" },
												React.createElement("span", { className: "dwd-label" }, t("profile")),
												React.createElement("input", { className: "dwd-input", value: config.profile || "", disabled: disabled, onChange: (event) => update("profile", event.target.value) }),
												React.createElement("span", { className: "dwd-hint" }, t("profile.hint")),
											),
											React.createElement(
												"label",
												{ className: "dwd-field" },
												React.createElement("span", { className: "dwd-label" }, t("port")),
												React.createElement("input", { type: "number", min: "0", max: "65535", className: "dwd-input", value: config.port ?? 3081, disabled: disabled, onChange: (event) => update("port", Number(event.target.value)) }),
												React.createElement("span", { className: "dwd-hint" }, t("port.hint")),
											),
										),
										snapshot.command
											? React.createElement("pre", { className: "dwd-command" }, snapshot.command)
											: null,
										unit.name
											? React.createElement("p", { className: "dwd-hint" }, t("journal.hint", { name: unit.name }))
											: null,
										React.createElement(
											"div",
											{ className: "dwd-cardFooter" },
											changed
												? React.createElement("button", { type: "button", className: "dwd-btn ghost", disabled: busy, onClick: () => setDraft(null) }, t("discard"))
												: null,
											React.createElement("button", { type: "button", className: "dwd-btn primary", disabled: disabled || !changed, onClick: () => void run("save") }, t("save")),
										),
									)
								: null,
						)
					: null,
			);
			};
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const timer = ctx.get("timer");
			if (slots === undefined || timer === undefined) return;
			const locale = ctx.get("locale");
			if (locale !== undefined) {
				ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "web-daemon: locale");
			}
			const t = locale !== undefined
				? locale.bind(LOCALE_NS)
				: (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
			const ServerStatus = createServerStatus(timer, t);
			ctx.slots.inject("sidebar.server.status", () => ctx.slots.register({
				name: "sidebar.server.status",
				id: "web-daemon-server-status",
				inject: () => ({})
			}, ServerStatus));
			const WebDaemonCard = createWebDaemonCard(t);
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "web-daemon",
				inject: () => ({ timer })
			}, WebDaemonCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
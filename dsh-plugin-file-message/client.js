/*
 * dsh-plugin-file-message — browser half.
 *
 * The card owns the presentation for the two tools registered by the Host.
 * It asks the Host for bytes only when an image needs a preview or the user
 * explicitly downloads a file. The persisted tool-result metadata remains the
 * source of truth for replay.
 */

window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-file-message",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const inject = ["slots"];
    const API_PATH = "/_dsh/file-message/content";
    const STYLE_ID = "dsh-plugin-file-message-style";

    const LOCALE_NS = "file-message";
    const ZH_DICT = {
      download: "下载",
      "download.original": "下载原图",
      close: "关闭",
      preparing: "准备中…",
      "loading.preview": "加载图片预览…",
      "send.failed": "发送失败",
      "meta.unavailable": "文件消息元数据不可用",
      "view.original": "查看原图",
      "download.withName": "下载 {name}",
      "preparing.withName": "准备下载 {name}",
      sending: "正在发送 {name}…",
    };
    const EN_DICT = {
      download: "Download",
      "download.original": "Download original",
      close: "Close",
      preparing: "Preparing…",
      "loading.preview": "Loading image preview…",
      "send.failed": "Failed to send",
      "meta.unavailable": "File message metadata unavailable",
      "view.original": "View original",
      "download.withName": "Download {name}",
      "preparing.withName": "Preparing {name}",
      sending: "Sending {name}…",
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    const STYLE_TEXT = `
.dfm-card{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;min-width:0;padding:10px 0;color:var(--dsw-alias-label-primary,#111827)}
.dfm-caption{font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary,#4b5563);overflow-wrap:anywhere}
.dfm-preview{position:relative;display:flex;align-items:center;justify-content:center;min-height:96px;max-height:240px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f5f4)}
.dfm-preview img{display:block;max-width:100%;max-height:240px;width:auto;height:auto;object-fit:contain;cursor:zoom-in}
.dfm-placeholder{display:flex;align-items:center;justify-content:center;min-height:72px;padding:12px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:18px;text-align:center;overflow-wrap:anywhere}
.dfm-file{display:flex;align-items:center;gap:10px;min-width:0;padding:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f5f5f4)}
.dfm-file-mark{display:flex;align-items:center;justify-content:center;flex:none;width:34px;height:40px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:5px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#4b5563);font-size:10px;font-weight:700;text-transform:uppercase}
.dfm-file-info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dfm-file-name{font-size:13px;line-height:19px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfm-file-detail{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dfm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dfm-button,.dfm-link{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:28px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:12px;line-height:18px;text-decoration:none;cursor:pointer}
.dfm-button:hover,.dfm-link:hover{background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
.dfm-button:focus-visible,.dfm-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dfm-button:disabled{opacity:.55;cursor:default}
.dfm-error{padding:8px 10px;border:1px solid rgba(239,68,68,.35);border-radius:6px;background:rgba(239,68,68,.08);color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dfm-lightbox{position:fixed;inset:0;z-index:1500;display:flex;align-items:center;justify-content:center;gap:12px;padding:24px;box-sizing:border-box;background:rgba(15,23,42,.78)}
.dfm-lightbox-inner{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:100%;max-height:100%}
.dfm-lightbox img{display:block;max-width:min(92vw,1400px);max-height:82vh;width:auto;height:auto;object-fit:contain;background:#111;box-shadow:0 16px 48px rgba(0,0,0,.38)}
.dfm-lightbox-actions{display:flex;gap:8px;align-items:center}
.dfm-lightbox .dfm-button,.dfm-lightbox .dfm-link{border-color:rgba(255,255,255,.38);background:rgba(15,23,42,.55);color:#fff}
.dfm-lightbox .dfm-button:hover,.dfm-lightbox .dfm-link:hover{background:rgba(15,23,42,.82);color:#fff}
`;

    function installStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return () => {};
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-plugin", "dsh-plugin-file-message");
      style.textContent = STYLE_TEXT;
      document.head.append(style);
      return () => style.remove();
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function settledBlock(block) {
      return block !== null && typeof block === "object" && block.kind === "tool-result";
    }

    function metadataOf(block) {
      if (!settledBlock(block) || block.meta === null || typeof block.meta !== "object") return null;
      const meta = block.meta;
      if (meta.plugin !== "dsh-plugin-file-message") return null;
      if (typeof meta.kind !== "string" || typeof meta.callId !== "string" || typeof meta.displayName !== "string") return null;
      if (typeof meta.path !== "string" || typeof meta.mediaType !== "string") return null;
      if (typeof meta.size !== "number") return null;
      return meta;
    }

    function argsName(block, fallback) {
      if (block && typeof block.argsRaw === "string") {
        try {
          const parsed = JSON.parse(block.argsRaw);
          if (parsed && typeof parsed.file_path === "string" && parsed.file_path.trim() !== "") return parsed.file_path;
        } catch (_error) {
          // The generic tool protocol keeps raw arguments; a malformed pending
          // value is still renderable with the tool name fallback.
        }
      }
      return fallback;
    }

    async function fetchResource(sessionId, callId, mode) {
      const query = new URLSearchParams({ sessionId: String(sessionId), callId: String(callId), mode });
      const response = await fetch(`${API_PATH}?${query.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        let detail = `file-message returned HTTP ${response.status}`;
        try {
          const result = await response.json();
          if (typeof result?.error === "string") detail = result.error;
        } catch (_error) {
          // Keep the HTTP fallback when the Host did not return JSON.
        }
        throw new Error(detail);
      }
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    }

    function downloadUrl(sessionId, callId) {
      const query = new URLSearchParams({ sessionId: String(sessionId), callId: String(callId), mode: "download" });
      return `${API_PATH}?${query.toString()}`;
    }

    function createDownloadLink(t) {
      return function DownloadLink({ sessionId, callId, name, className = "dfm-link", children = t("download") }) {
        // Native streaming download: the anchor navigates straight to the Host
        // route, which streams the file with `Content-Disposition: attachment`.
        // The browser handles the download natively — no fetch, no blob, no
        // object URL, no full-file buffering in page memory.
        const href = downloadUrl(sessionId, callId);
        return React.createElement("a", {
          className,
          href,
          download: name,
          title: t("download.withName", { name }),
        }, children);
      };
    }

    function createImageMessage(t, DownloadLink) {
      return function ImageMessage({ sessionId, callId, record }) {
        const [preview, setPreview] = React.useState({ status: "loading", url: null, error: null });
        const [lightbox, setLightbox] = React.useState(false);

        React.useEffect(() => {
          let active = true;
          let objectUrl = null;
          setPreview({ status: "loading", url: null, error: null });
          fetchResource(sessionId, callId, "preview").then((url) => {
            objectUrl = url;
            if (active) setPreview({ status: "ready", url, error: null });
            else URL.revokeObjectURL(url);
          }).catch((error) => {
            if (active) setPreview({ status: "error", url: null, error: messageOf(error) });
          });
          return () => {
            active = false;
            if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
          };
        }, [sessionId, callId, record.path, record.version]);

        React.useEffect(() => {
          if (!lightbox) return undefined;
          const onKeyDown = (event) => {
            if (event.key === "Escape") setLightbox(false);
          };
          document.addEventListener("keydown", onKeyDown);
          return () => document.removeEventListener("keydown", onKeyDown);
        }, [lightbox]);

        const image = preview.status === "ready"
          ? React.createElement("img", {
            src: preview.url,
            alt: record.displayName,
            loading: "lazy",
            decoding: "async",
            onClick: () => setLightbox(true),
          })
          : React.createElement("div", { className: preview.status === "error" ? "dfm-error" : "dfm-placeholder", role: preview.status === "error" ? "alert" : undefined }, preview.status === "error" ? preview.error : t("loading.preview"));

        const overlay = lightbox && preview.url !== null
          ? React.createElement("div", {
            className: "dfm-lightbox",
            role: "presentation",
            onClick: () => setLightbox(false),
          }, React.createElement("div", {
            className: "dfm-lightbox-inner",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": record.displayName,
            onClick: (event) => event.stopPropagation(),
          }, React.createElement("img", { src: preview.url, alt: record.displayName }), React.createElement("div", { className: "dfm-lightbox-actions" }, React.createElement(DownloadLink, { sessionId, callId, name: record.displayName, className: "dfm-link", children: t("download.original") }), React.createElement("button", { type: "button", className: "dfm-button", onClick: () => setLightbox(false) }, t("close")))))
          : null;

        return React.createElement(React.Fragment, null,
          React.createElement("div", { className: "dfm-card" },
            record.caption ? React.createElement("div", { className: "dfm-caption" }, record.caption) : null,
            React.createElement("div", { className: "dfm-preview" }, image),
            React.createElement("div", { className: "dfm-actions" },
              preview.status === "ready" ? React.createElement("button", { type: "button", className: "dfm-button", onClick: () => setLightbox(true) }, t("view.original")) : null,
              React.createElement(DownloadLink, { sessionId, callId, name: record.displayName, children: t("download.original") }),
            ),
          ),
          overlay,
        );
      };
    }

    function createFileMessage(t, DownloadLink) {
      return function FileMessage({ sessionId, callId, record }) {
        const extension = record.displayName.includes(".") ? record.displayName.split(".").pop().slice(0, 5) : "file";
        const size = `${Math.max(0, Math.round(record.size / 1024))} KB`;
        return React.createElement("div", { className: "dfm-card" },
          record.caption ? React.createElement("div", { className: "dfm-caption" }, record.caption) : null,
          React.createElement("div", { className: "dfm-file" },
            React.createElement("div", { className: "dfm-file-mark", "aria-hidden": "true" }, extension),
            React.createElement("div", { className: "dfm-file-info" },
              React.createElement("div", { className: "dfm-file-name", title: record.displayName }, record.displayName),
              React.createElement("div", { className: "dfm-file-detail" }, `${size} · ${record.mediaType}`),
            ),
            React.createElement(DownloadLink, { sessionId, callId, name: record.displayName }),
          ),
        );
      };
    }

    function createFileMessageToolView(t, ImageMessage, FileMessage) {
      return function FileMessageToolView(props) {
        const errorText = (block) => {
          if (!settledBlock(block) || !Array.isArray(block.content)) return t("send.failed");
          for (const item of block.content) {
            if (item && item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") return item.text;
          }
          return t("send.failed");
        };

        const record = metadataOf(props.block);
        if (!settledBlock(props.block)) {
          return React.createElement("div", { className: "dfm-placeholder" }, t("sending", { name: argsName(props.block, props.toolName) }));
        }
        if (props.block.isError) {
          return React.createElement("div", { className: "dfm-error", role: "alert" }, errorText(props.block));
        }
        if (record === null) {
          return React.createElement("div", { className: "dfm-error", role: "alert" }, t("meta.unavailable"));
        }
        return record.kind === "image"
          ? React.createElement(ImageMessage, { sessionId: props.sessionId, callId: props.callId, record })
          : React.createElement(FileMessage, { sessionId: props.sessionId, callId: props.callId, record });
      };
    }

    function apply(ctx) {
      if (ctx.get("slots") === undefined) return;
      const locale = ctx.get("locale");
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "file-message: locale");
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
      const DownloadLink = createDownloadLink(t);
      const ImageMessage = createImageMessage(t, DownloadLink);
      const FileMessage = createFileMessage(t, DownloadLink);
      const FileMessageToolView = createFileMessageToolView(t, ImageMessage, FileMessage);
      ctx.effect(() => installStyle(), "file-message: stylesheet");
      ctx.slots.inject("tool.call.toolview", function* () {
        yield ctx.slots.register({ name: "tool.call.toolview", key: "send_file" }, FileMessageToolView);
        yield ctx.slots.register({ name: "tool.call.toolview", key: "send_image" }, FileMessageToolView);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
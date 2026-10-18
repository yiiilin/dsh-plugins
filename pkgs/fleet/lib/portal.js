/**
 * Portal page for the fleet gateway root.
 *
 * The page lists every enabled box and links into its prefix, so one browser
 * tab reaches the whole fleet. It is server-rendered and dependency-free: the
 * portal must stay readable even when no box process is healthy.
 *
 * Copy uses one `COPY` table per language selected from `Accept-Language`, the
 * same self-contained pattern any host page in this package uses. Nothing here
 * reaches another feature module.
 *
 * @module @yiln-dsh/dsh-fleet/portal
 */

/** Bilingual copy for the portal. */
export const COPY = Object.freeze({
  en: Object.freeze({
    htmlLang: 'en',
    title: 'DeepSeek Harness - Fleet',
    heading: 'Development fleet',
    subtitle: 'One page, every box. Each prefix is its own machine.',
    running: 'running',
    stopped: 'stopped',
    open: 'Open',
    offline: 'not started',
    empty: 'No boxes configured yet.',
    kindLocal: 'local',
    kindSsh: 'ssh',
  }),
  zh: Object.freeze({
    htmlLang: 'zh-CN',
    title: 'DeepSeek Harness - 服务器集群',
    heading: '开发服务器集群',
    subtitle: '一个页面，所有机器。每个前缀都是一台独立的主机。',
    running: '运行中',
    stopped: '已停止',
    open: '打开',
    offline: '未启动',
    empty: '尚未配置任何服务器。',
    kindLocal: '本机',
    kindSsh: 'SSH',
  }),
})

/**
 * Choose the copy table for one request.
 *
 * @param acceptLanguage - the `Accept-Language` header, if any.
 * @returns the `en` or `zh` copy table.
 */
export function selectCopy(acceptLanguage) {
  if (typeof acceptLanguage !== 'string') return COPY.en
  return /\bzh\b/iu.test(acceptLanguage) ? COPY.zh : COPY.en
}

/**
 * Render the portal document.
 *
 * @param options - fleet state to display.
 * @param options.boxes - enabled boxes, in registry order.
 * @param options.running - ids of boxes with a live process.
 * @param options.gatewayPort - the listener port, shown when no box exists.
 * @param options.acceptLanguage - the request's `Accept-Language` value.
 * @returns the HTML document.
 */
export function renderPortal({ boxes, running, gatewayPort, acceptLanguage }) {
  const copy = selectCopy(acceptLanguage)
  const rows = boxes
    .map((box) => {
      const up = running.has(box.id)
      const status = up ? copy.running : copy.stopped
      const action = up
        ? `<a class="open" href="/${escapeHtml(box.id)}/">${escapeHtml(copy.open)}</a>`
        : `<span class="offline">${escapeHtml(copy.offline)}</span>`
      return `<tr>
      <td class="name">${escapeHtml(box.label ?? box.id)}<span class="id">/${escapeHtml(box.id)}/</span></td>
      <td><span class="kind kind-${escapeHtml(box.kind)}">${escapeHtml(box.kind === 'ssh' ? copy.kindSsh : copy.kindLocal)}</span></td>
      <td class="path">${escapeHtml(box.workspace ?? '')}</td>
      <td><span class="status status-${up ? 'up' : 'down'}">${escapeHtml(status)}</span></td>
      <td class="action">${action}</td>
    </tr>`
    })
    .join('\n')

  const body =
    boxes.length === 0
      ? `<p class="empty">${escapeHtml(copy.empty)}</p>`
      : `<table><thead><tr><th></th><th></th><th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`

  return `<!doctype html>
<html lang="${copy.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:48px 24px;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
p.sub{margin:0 0 28px;opacity:.65}
table{width:100%;border-collapse:collapse}
th{display:none}
td{padding:14px 12px;border-bottom:1px solid rgba(128,128,128,.22);vertical-align:middle}
td.name{font-weight:600}
td.name .id{display:block;font-weight:400;font-size:12px;opacity:.5;font-family:ui-monospace,monospace}
td.path{font-family:ui-monospace,monospace;font-size:12px;opacity:.6}
.kind{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid rgba(128,128,128,.4)}
.kind-ssh{border-color:rgba(64,132,255,.55)}
.status{font-size:12px}
.status-up{color:#0a0}
.status-down{opacity:.5}
.open{display:inline-block;padding:6px 16px;border-radius:6px;background:rgba(64,132,255,.14);border:1px solid rgba(64,132,255,.5);text-decoration:none;color:inherit;font-size:13px}
.offline{font-size:12px;opacity:.45}
.empty{opacity:.6}
</style>
</head>
<body><main>
<h1>${escapeHtml(copy.heading)}</h1>
<p class="sub">${escapeHtml(copy.subtitle)}</p>
${body}
</main></body>
</html>
`
}

/** Escape text for HTML body and attribute positions. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Mobile presentation adapter for the auth gateway.
 *
 * The gateway proxies the official DSH frontend instead of owning its React
 * tree. This adapter adds a small, DOM-level mobile shell around the stable
 * semantic markers emitted by the frontend: the root frame, its three columns,
 * and the conversation scrollport. It never changes the /api or WebSocket
 * protocol.
 */

export const MOBILE_LAYOUT_STYLE_ID = "dsh-auth-mobile-layout";
export const MOBILE_LAYOUT_BREAKPOINT = 760;

const MOBILE_LAYOUT_STYLE = String.raw`
/* The official shell keeps a 56px desktop rail on narrow screens. Mobile uses
   the whole viewport for the conversation and opens navigation as a drawer. */
html[data-dsh-auth-mobile] {
  overflow: hidden;
  /* Prevent iOS Safari from enlarging text and making the chat appear zoomed. */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

html[data-dsh-auth-mobile] body {
  overflow: hidden;
  overscroll-behavior: none;
  /* Keep pan/scroll while disabling double-tap page zoom on controls. */
  touch-action: manipulation;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame] {
  grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  /* The mobile shell is a presentation switch, not a panel resize. The
     official desktop transition otherwise makes the first mobile paint look
     like a zoom animation. Drawer transform transitions remain enabled below. */
  transition: none !important;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-center] {
  grid-column: 1 / -1;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: hidden;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] > *,
html[data-dsh-auth-mobile] [data-dsh-mobile-center] [data-conversation-scroll] {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-sidebar] {
  position: absolute;
  z-index: 1002;
  top: 0;
  bottom: 0;
  left: 0;
  /* Matches the official expanded sidebar width (280px) so the drawer never
     shows a gap next to the content it slides. */
  width: min(280px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  transform: translateX(-102%);
  visibility: hidden;
  pointer-events: none;
  overflow: hidden;
  box-shadow: 14px 0 36px rgb(0 0 0 / 24%);
  transition: transform 180ms ease, visibility 0s linear 180ms;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame][data-dsh-mobile-sidebar-open] > [data-dsh-mobile-sidebar] {
  transform: translateX(0);
  visibility: visible;
  pointer-events: auto;
  transition: transform 180ms ease;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-sidebar] > * {
  width: 100% !important;
  max-width: none !important;
  /* The drawer is the scroll container for the session list: the official
     column keeps the list non-scrolling (overflow visible), so content taller
     than the drawer would be clipped without this. */
  height: 100%;
  min-height: 100%;
  padding-bottom: env(safe-area-inset-bottom);
}

/* The official session list keeps overflow visible on the desktop column;
   inside the fixed-height drawer it must scroll instead of clipping. */
html[data-dsh-auth-mobile] [data-dsh-mobile-sidebar] [class*='list'] {
  overflow-y: auto !important;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-sidebar] [class*='regionArea'] {
  overflow-y: hidden;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame] > [data-dsh-mobile-details] {
  position: absolute;
  z-index: 1002;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(100vw - 24px, 520px);
  max-width: calc(100vw - 24px);
  transform: translateX(102%);
  visibility: hidden;
  pointer-events: none;
  overflow: hidden;
  box-shadow: -14px 0 36px rgb(0 0 0 / 24%);
  transition: transform 180ms ease, visibility 0s linear 180ms;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame][data-dsh-mobile-details-open] > [data-dsh-mobile-details] {
  transform: translateX(0);
  visibility: visible;
  pointer-events: auto;
  transition: transform 180ms ease;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-details] > * {
  width: 100% !important;
  max-width: none !important;
  height: 100%;
  min-height: 100%;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-frame] > [data-side] {
  display: none;
}

/* Settings is a second-level desktop split (188px navigation + content).
   On a phone it gets the whole viewport, while its section navigation becomes
   a compact horizontal scroller so the selected detail page has real width. */
html[data-dsh-auth-mobile] [data-dsh-mobile-frame][data-dsh-mobile-settings-open] > [data-dsh-mobile-sidebar] {
  width: 100vw !important;
  max-width: 100vw !important;
  transform: none !important;
  visibility: visible !important;
  pointer-events: auto !important;
  overflow: visible !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_overlay'] {
  position: fixed !important;
  inset: 0 !important;
  z-index: 1100 !important;
  width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  box-sizing: border-box !important;
}

html[data-dsh-auth-mobile] [role='dialog'][class~='VOzbGW_panel'] {
  display: flex !important;
  flex-direction: column !important;
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  max-height: none !important;
  min-height: 0 !important;
  border-radius: 0 !important;
  box-sizing: border-box !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_nav'] {
  flex: 0 0 auto !important;
  flex-direction: row !important;
  align-items: center !important;
  width: 100% !important;
  height: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  max-height: 76px !important;
  padding: max(8px, env(safe-area-inset-top)) 8px 0 !important;
  overflow-x: auto !important;
  overflow-y: hidden !important;
  box-sizing: border-box !important;
  scrollbar-width: none;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_nav']::-webkit-scrollbar {
  display: none;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_navTitle'] {
  display: none !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_navList'] {
  display: flex !important;
  flex: 1 1 auto !important;
  flex-direction: row !important;
  align-items: center !important;
  width: auto !important;
  height: auto !important;
  min-width: max-content !important;
  max-width: none !important;
  padding: 0 0 8px !important;
  gap: 4px !important;
  overflow: visible !important;
  box-sizing: border-box !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_navCell'] {
  flex: 0 0 auto !important;
  width: auto !important;
  min-width: max-content !important;
  white-space: nowrap !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_content'] {
  display: flex !important;
  flex: 1 1 auto !important;
  flex-direction: column !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  min-height: 0 !important;
  box-sizing: border-box !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_header'],
html[data-dsh-auth-mobile] [class~='VOzbGW_options'] {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  box-sizing: border-box !important;
}

html[data-dsh-auth-mobile] [class~='VOzbGW_options'] {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-x: hidden !important;
  box-sizing: border-box !important;
}

/* The adapter keeps both nodes mounted so it can react to a viewport change.
   Its explicit display rules must never override the native hidden contract. */
[data-dsh-auth-mobile-nav][hidden],
[data-dsh-auth-mobile-right-nav][hidden],
[data-dsh-auth-mobile-backdrop][hidden] {
  display: none !important;
}

[data-dsh-auth-mobile-backdrop] {
  position: fixed;
  z-index: 1001;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: rgb(0 0 0 / 34%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}

body[data-ds-dark-theme] [data-dsh-auth-mobile-backdrop] {
  background: rgb(0 0 0 / 52%);
}

body[data-ds-dark-theme] [data-dsh-auth-mobile-nav],
body[data-ds-dark-theme] [data-dsh-auth-mobile-right-nav] {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #1c1f26) 82%, transparent);
}

html[data-dsh-auth-mobile] [data-dsh-auth-mobile-backdrop]:not([hidden]) {
  opacity: 1;
  pointer-events: auto;
}

[data-dsh-auth-mobile-nav] {
  position: fixed;
  z-index: 1004;
  top: max(10px, env(safe-area-inset-top));
  left: max(10px, env(safe-area-inset-left));
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 82%, transparent);
  color: var(--dsw-alias-label-primary, #111827);
  box-shadow: var(--dsw-shadow-lv2, 0 2px 10px rgb(0 0 0 / 12%));
  cursor: pointer;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

[data-dsh-auth-mobile-nav]:hover,
[data-dsh-auth-mobile-right-nav]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 6%));
}

[data-dsh-auth-mobile-nav]:focus-visible,
[data-dsh-auth-mobile-right-nav]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #2563eb);
  outline-offset: 2px;
}

[data-dsh-auth-mobile-right-nav] {
  position: fixed;
  z-index: 1004;
  top: max(10px, env(safe-area-inset-top));
  right: max(10px, env(safe-area-inset-right));
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 82%, transparent);
  color: var(--dsw-alias-label-primary, #111827);
  box-shadow: var(--dsw-shadow-lv2, 0 2px 10px rgb(0 0 0 / 12%));
  cursor: pointer;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

html[data-dsh-auth-mobile-details-open] [data-dsh-auth-mobile-nav],
html[data-dsh-auth-mobile-sidebar-open] [data-dsh-auth-mobile-nav],
html[data-dsh-auth-mobile-sidebar-open] [data-dsh-auth-mobile-right-nav],
html[data-dsh-auth-mobile-details-open] [data-dsh-auth-mobile-right-nav] {
  display: none;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] header {
  padding-left: max(56px, calc(56px + env(safe-area-inset-left))) !important;
  padding-right: max(56px, calc(56px + env(safe-area-inset-right))) !important;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-details] > * {
  padding-bottom: env(safe-area-inset-bottom);
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] header [class*="_titleCluster"] {
  gap: 4px;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] header [class*="_crumb"] {
  max-width: min(48vw, 180px);
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] [role="tablist"] {
  gap: 18px;
  padding-left: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] [role="tablist"]::-webkit-scrollbar {
  display: none;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] [data-conversation-scroll] {
  --dsh-composer-side-clearance: 8px;
  overscroll-behavior-y: contain;
}

html[data-dsh-auth-mobile] [data-dsh-mobile-center] [data-composer-seat] {
  padding-bottom: env(safe-area-inset-bottom);
}

@media (prefers-reduced-motion: reduce) {
  html[data-dsh-auth-mobile] [data-dsh-mobile-sidebar],
  html[data-dsh-auth-mobile] [data-dsh-mobile-details],
  [data-dsh-auth-mobile-backdrop] {
    transition: none;
  }
}
`;

const MOBILE_LAYOUT_BOOT_SCRIPT = String.raw`(function () {
  var override = new URLSearchParams(window.location.search).get("dsh_mode");
  var mobile = override === "mobile";
  if (override !== "desktop" && !mobile) {
    try {
      mobile = window.matchMedia("(max-width: __DSH_MOBILE_BREAKPOINT__px)").matches;
    } catch (_error) {
      mobile = false;
    }
  }
  if (mobile) {
    document.documentElement.setAttribute("data-dsh-auth-mobile", "");
    var viewport = document.querySelector("meta[name=\"viewport\"]");
    if (viewport) viewport.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
  }
})();`;

const MOBILE_LAYOUT_SCRIPT = String.raw`(function () {
  var policy = __DSH_MOBILE_POLICY__;
  if (policy === "off") return;

  var breakpoint = __DSH_MOBILE_BREAKPOINT__;
  var media;
  try {
    media = window.matchMedia("(max-width: " + String(breakpoint) + "px)");
  } catch (_error) {
    media = { matches: false };
  }

  var frameObserver;
  var nav;
  var rightNav;
  var backdrop;
  var lastFrame;
  var lastNavLabel;
  var lastRightLabel;
  var interactionSidebar;
  var interactionDetails;
  var mobileDetailsOpen = false;

  function setAttributeState(node, name, enabled) {
    if (!node) return;
    if (enabled) node.setAttribute(name, "");
    else node.removeAttribute(name);
  }

  function frameOf() {
    var overlay = document.querySelector("[data-shell-overlay]");
    return overlay ? overlay.parentElement : null;
  }

  function sidebarToggle(frame) {
    var sidebar = frame ? frame.querySelector("[data-dsh-mobile-sidebar]") : null;
    if (!sidebar) return null;
    return sidebar.querySelector("button[class*='_toggle']")
      || sidebar.querySelector("button[aria-label*='sidebar' i]")
      || sidebar.querySelector("button[aria-label*='侧边栏']");
  }

  function detailsClose(frame) {
    var details = frame ? frame.querySelector("[data-dsh-mobile-details]") : null;
    if (!details) return null;
    return details.querySelector("button[class*='_close']")
      || details.querySelector("button[class*='dsh-rp-icon-button']")
      || details.querySelector("button[aria-label*='close' i]")
      || details.querySelector("button[aria-label*='关闭']")
      || details.querySelector("button[aria-label*='收起']");
  }

  function rightPanelSource(frame) {
    var details = frame ? frame.querySelector("[data-dsh-mobile-details]") : null;
    if (!details) return null;
    return details.querySelector("button[aria-label*='Expand right panel' i]")
      || details.querySelector("button[aria-label*='展开右侧面板']")
      || details.querySelector("button[class*='dsh-rp-rail-button']")
      || details.querySelector("[role='tablist'] button");
  }

  function rightPanelExpandSource(frame) {
    var details = frame ? frame.querySelector("[data-dsh-mobile-details]") : null;
    if (!details) return null;
    return details.querySelector("button[aria-label*='Expand right panel' i]")
      || details.querySelector("button[aria-label*='展开右侧面板']");
  }

  function panelSessionRow(target, sidebar) {
    if (!target || typeof target.closest !== "function" || !sidebar) return null;
    var row = target.closest("[role='treeitem'][aria-selected]");
    if (!row || !sidebar.contains(row) || row.hasAttribute("aria-expanded")) return null;
    var button = target.closest("button");
    if (button && button !== row) return null;
    return row;
  }

  function closeSidebarAfterSelection() {
    var frame = frameOf();
    if (!isMobile() || !frame || frame.hasAttribute("data-sidebar-collapsed")) return;
    var toggle = sidebarToggle(frame);
    if (toggle && typeof toggle.click === "function") toggle.click();
  }

  function onSidebarClick(event) {
    var row = panelSessionRow(event.target, interactionSidebar);
    if (!row) return;
    /* Let React's row onClick select the session first, then close the drawer. */
    window.setTimeout(closeSidebarAfterSelection, 0);
  }

  function onSidebarDragStart(event) {
    if (isMobile()) event.preventDefault();
  }

  function syncMobileDragging(sidebar, mobile) {
    if (!sidebar) return;
    var rows = sidebar.querySelectorAll("[role='treeitem']");
    Array.prototype.forEach.call(rows, function (row) {
      if (mobile) {
        if (!row.hasAttribute("data-dsh-auth-mobile-original-draggable")) {
          row.setAttribute("data-dsh-auth-mobile-original-draggable", row.getAttribute("draggable") === "true" ? "true" : "false");
        }
        if (row.getAttribute("draggable") === "true") row.setAttribute("draggable", "false");
      } else {
        var original = row.getAttribute("data-dsh-auth-mobile-original-draggable");
        if (original === "true") row.setAttribute("draggable", "true");
        else if (original === "false") row.removeAttribute("draggable");
        row.removeAttribute("data-dsh-auth-mobile-original-draggable");
      }
    });
  }

  function bindSidebar(frame) {
    var sidebar = frame ? frame.querySelector("[data-dsh-mobile-sidebar]") : null;
    if (interactionSidebar === sidebar) return;
    if (interactionSidebar) {
      interactionSidebar.removeEventListener("click", onSidebarClick, true);
      interactionSidebar.removeEventListener("dragstart", onSidebarDragStart, true);
    }
    interactionSidebar = sidebar;
    if (interactionSidebar) {
      interactionSidebar.addEventListener("click", onSidebarClick, true);
      interactionSidebar.addEventListener("dragstart", onSidebarDragStart, true);
    }
  }

  function bindDetails(frame) {
    var details = frame ? frame.querySelector("[data-dsh-mobile-details]") : null;
    if (interactionDetails === details) return;
    if (interactionDetails) interactionDetails.removeEventListener("click", onDetailsClick, true);
    interactionDetails = details;
    if (interactionDetails) interactionDetails.addEventListener("click", onDetailsClick, true);
  }

  function onDetailsClick(event) {
    var button = event.target && typeof event.target.closest === "function"
      ? event.target.closest("button")
      : null;
    if (!button || !button.classList.contains("dsh-rp-icon-button")) return;
    window.setTimeout(function () {
      if (!isMobile()) return;
      mobileDetailsOpen = false;
      sync();
    }, 0);
  }

  function clickPanelToggle(frame) {
    var sideOpen = frame && !frame.hasAttribute("data-sidebar-collapsed");
    if (isMobile() && mobileDetailsOpen && !sideOpen) {
      mobileDetailsOpen = false;
      var close = detailsClose(frame);
      if (close && typeof close.click === "function") close.click();
      sync();
      return;
    }
    var target = sideOpen ? sidebarToggle(frame) : detailsClose(frame);
    if (target && typeof target.click === "function") target.click();
  }

  function openRightPanel(frame) {
    var details = frame ? frame.querySelector("[data-dsh-mobile-details]") : null;
    if (!details) return;
    var source = rightPanelSource(frame);
    if (!source) return;
    mobileDetailsOpen = true;
    var expand = rightPanelExpandSource(frame);
    if (expand && typeof expand.click === "function") expand.click();
    sync();
  }

  function copyRightIcon(source) {
    while (rightNav.firstChild) rightNav.removeChild(rightNav.firstChild);
    var icon = source.querySelector("svg") || source;
    if (icon && icon.tagName && icon.tagName.toLowerCase() === "svg") rightNav.appendChild(icon.cloneNode(true));
  }

  function copyIcon(source) {
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    var icon = source.querySelector('svg[class*="panelIcon"]')
      || source.querySelector("svg");
    if (icon) nav.appendChild(icon.cloneNode(true));
  }

  function ensureUi() {
    if (!nav) {
      nav = document.createElement("button");
      nav.type = "button";
      nav.setAttribute("data-dsh-auth-mobile-nav", "");
      nav.addEventListener("click", function () {
        var frame = frameOf();
        var toggle = sidebarToggle(frame);
        if (toggle && typeof toggle.click === "function") toggle.click();
      });
      document.body.appendChild(nav);
    }
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.setAttribute("data-dsh-auth-mobile-backdrop", "");
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.hidden = true;
      backdrop.addEventListener("click", function () {
        clickPanelToggle(frameOf());
      });
      document.body.appendChild(backdrop);
    }
    if (!rightNav) {
      rightNav = document.createElement("button");
      rightNav.type = "button";
      rightNav.setAttribute("data-dsh-auth-mobile-right-nav", "");
      rightNav.addEventListener("click", function () {
        openRightPanel(frameOf());
      });
      document.body.appendChild(rightNav);
    }
  }

  function markFrame(frame) {
    if (!frame) return;
    frame.setAttribute("data-dsh-mobile-frame", "");
    var columns = frame.children;
    if (columns[0]) columns[0].setAttribute("data-dsh-mobile-sidebar", "");
    if (columns[1]) columns[1].setAttribute("data-dsh-mobile-center", "");
    if (columns[2]) columns[2].setAttribute("data-dsh-mobile-details", "");
    if (lastFrame === frame) return;
    lastFrame = frame;
    if (frameObserver) frameObserver.disconnect();
    frameObserver = new MutationObserver(sync);
    frameObserver.observe(frame, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "aria-label", "draggable"],
    });
  }

  function clearFrame(frame) {
    if (!frame) {
      bindSidebar(null);
      bindDetails(null);
      mobileDetailsOpen = false;
      return;
    }
    syncMobileDragging(frame.querySelector("[data-dsh-mobile-sidebar]"), false);
    bindSidebar(null);
    bindDetails(null);
    mobileDetailsOpen = false;
    frame.removeAttribute("data-dsh-mobile-frame");
    Array.prototype.forEach.call(frame.children, function (column) {
      column.removeAttribute("data-dsh-mobile-sidebar");
      column.removeAttribute("data-dsh-mobile-center");
      column.removeAttribute("data-dsh-mobile-details");
    });
    if (lastFrame === frame) {
      lastFrame = null;
      if (frameObserver) frameObserver.disconnect();
      frameObserver = null;
    }
  }

  function isMobile() {
    var override = new URLSearchParams(window.location.search).get("dsh_mode");
    if (override === "mobile") return true;
    if (override === "desktop") return false;
    return Boolean(media.matches);
  }

  function sync() {
    if (!document.body) return;
    var frame = frameOf();
    var mobile = isMobile();
    if (!mobile) {
      document.documentElement.removeAttribute("data-dsh-auth-mobile");
      document.documentElement.removeAttribute("data-dsh-auth-mobile-sidebar-open");
      document.documentElement.removeAttribute("data-dsh-auth-mobile-details-open");
      document.documentElement.removeAttribute("data-dsh-auth-mobile-settings-open");
      clearFrame(frame);
      if (nav) nav.hidden = true;
      if (rightNav) rightNav.hidden = true;
      if (backdrop) backdrop.hidden = true;
      lastRightLabel = null;
      return;
    }

    ensureUi();
    markFrame(frame);
    bindSidebar(frame);
    bindDetails(frame);
    syncMobileDragging(frame ? frame.querySelector("[data-dsh-mobile-sidebar]") : null, true);
    document.documentElement.setAttribute("data-dsh-auth-mobile", "");
    var sidebar = frame ? frame.querySelector("[data-dsh-mobile-sidebar]") : null;
    var settingsOpen = Boolean(document.querySelector("[class~='VOzbGW_overlay']"));
    if (settingsOpen && sidebar) sidebar.scrollLeft = 0;
    setAttributeState(frame, "data-dsh-mobile-settings-open", settingsOpen);
    setAttributeState(document.documentElement, "data-dsh-auth-mobile-settings-open", settingsOpen);
    var sideOpen = Boolean(frame && !frame.hasAttribute("data-sidebar-collapsed"));
    var detailsOpen = mobileDetailsOpen;
    setAttributeState(frame, "data-dsh-mobile-sidebar-open", sideOpen);
    setAttributeState(frame, "data-dsh-mobile-details-open", detailsOpen);
    setAttributeState(document.documentElement, "data-dsh-auth-mobile-sidebar-open", sideOpen);
    setAttributeState(document.documentElement, "data-dsh-auth-mobile-details-open", detailsOpen);

    var source = sidebarToggle(frame);
    var label = source ? source.getAttribute("aria-label") : null;
    if (source && label !== lastNavLabel) {
      copyIcon(source);
      if (label) nav.setAttribute("aria-label", label);
      else nav.removeAttribute("aria-label");
      lastNavLabel = label;
    } else if (!source) {
      while (nav.firstChild) nav.removeChild(nav.firstChild);
      nav.removeAttribute("aria-label");
      lastNavLabel = null;
    }
    nav.hidden = source === null;

    var rightSource = rightPanelSource(frame);
    var rightLabel = rightSource ? rightSource.getAttribute("aria-label") : null;
    if (rightSource && rightLabel !== lastRightLabel) {
      copyRightIcon(rightSource);
      if (rightLabel) rightNav.setAttribute("aria-label", rightLabel);
      else rightNav.removeAttribute("aria-label");
      lastRightLabel = rightLabel;
    } else if (!rightSource) {
      while (rightNav.firstChild) rightNav.removeChild(rightNav.firstChild);
      rightNav.removeAttribute("aria-label");
      lastRightLabel = null;
    }
    rightNav.hidden = rightSource === null || sideOpen || detailsOpen;
    backdrop.hidden = !sideOpen && !detailsOpen;
  }

  function start() {
    if (!document.body) return;
    ensureUi();
    var bodyObserver = new MutationObserver(sync);
    bodyObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "aria-label", "draggable"],
    });
    if (typeof media.addEventListener === "function") media.addEventListener("change", sync);
    else if (typeof media.addListener === "function") media.addListener(sync);
    window.addEventListener("popstate", sync);
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      var frame = frameOf();
      var sideOpen = frame && !frame.hasAttribute("data-sidebar-collapsed");
      if (isMobile() && mobileDetailsOpen && !sideOpen) {
        event.preventDefault();
        clickPanelToggle(frame);
        return;
      }
      var target = sideOpen ? sidebarToggle(frame) : detailsClose(frame);
      if (target && typeof target.click === "function") {
        event.preventDefault();
        target.click();
      }
    });
    sync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();`;

function spliceAfterOpeningTag(html, expression, markup) {
  const match = expression.exec(html);
  if (match === null) return `${markup}${html}`;
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

function spliceBeforeTag(html, expression, markup) {
  const match = expression.exec(html);
  if (match === null) return `${markup}${html}`;
  return `${html.slice(0, match.index)}${markup}${html.slice(match.index)}`;
}

/**
 * Add the mobile shell to an official DSH index document.
 *
 * The operation is idempotent and intentionally leaves the document untouched
 * when mobileMode is "off". `dsh_mode=mobile|desktop` remains a page-local
 * override for debugging and explicit launcher links.
 */
export function injectMobileLayout(html, mobileMode = "auto", mobileBreakpoint = MOBILE_LAYOUT_BREAKPOINT) {
  if (typeof html !== "string" || mobileMode === "off" || html.includes(`id="${MOBILE_LAYOUT_STYLE_ID}"`)) return html;
  const breakpoint = Number.isSafeInteger(mobileBreakpoint)
    && mobileBreakpoint >= 320
    && mobileBreakpoint <= 1600
    ? mobileBreakpoint
    : MOBILE_LAYOUT_BREAKPOINT;
  const style = `<style id="${MOBILE_LAYOUT_STYLE_ID}" data-plugin="auth-webserver">${MOBILE_LAYOUT_STYLE}</style>`;
  const boot = `<script data-dsh-auth-mobile-boot="1">${MOBILE_LAYOUT_BOOT_SCRIPT
    .replace("__DSH_MOBILE_BREAKPOINT__", String(breakpoint))}</script>`;
  const script = `<script data-dsh-auth-mobile-layout="1">${MOBILE_LAYOUT_SCRIPT
    .replace("__DSH_MOBILE_POLICY__", JSON.stringify("auto"))
    .replace("__DSH_MOBILE_BREAKPOINT__", String(breakpoint))}</script>`;
  let out = spliceAfterOpeningTag(html, /<head(?:\s[^>]*)?>/iu, style);
  out = spliceBeforeTag(out, /<\/head>/iu, boot);
  const closingBody = /<\/body>/iu.exec(out);
  if (closingBody === null) return `${out}${script}`;
  return `${out.slice(0, closingBody.index)}${script}${out.slice(closingBody.index)}`;
}

/** Expose the generated payload for focused adapter tests without exporting implementation details. */
export function mobileLayoutPayload() {
  return { style: MOBILE_LAYOUT_STYLE, boot: MOBILE_LAYOUT_BOOT_SCRIPT, script: MOBILE_LAYOUT_SCRIPT };
}

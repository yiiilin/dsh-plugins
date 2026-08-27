/**
 * @yiln-dsh/dsh-plugin-right-panel — fixed right-side panel host.
 *
 * Owns the Web GUI's `details` slot and exposes a small Client service for
 * page metadata. Page bodies are still rendered through the keyed
 * `right-panel.page` child Slot, so extensions keep normal Slot lifecycle and
 * isolation semantics.
 */
window.__ModuleLoader__.load({
  id: "@yiln-dsh/dsh-plugin-right-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    const inject = ["slots", "layout"];
    const WIDTH_KEY = "dsh-plugin-right-panel.detailsWidth";
    const LEGACY_WIDTH_KEY = "dsh-plugin-file-explorer.detailsWidth";
    const WIDTH_MIN = 300;
    const MAX_RAIL_PAGES = 6;
    const RAIL_WIDTH = 56;

    const LOCALE_NS = "right-panel";
    const ZH_DICT = {
      "panel.title": "右侧面板",
      "panel.region": "右侧面板",
      "panel.regionCollapsed": "右侧面板（已收起）",
      "panel.rail": "右侧面板页面",
      "panel.page": "右侧面板页面",
      collapse: "收起右侧面板",
      "collapse.rail": "收起右侧面板到图标栏",
      expand: "展开右侧面板",
      more: "更多页面",
      "more.label": "更多右侧面板页面",
      search: "搜索页面",
      "search.label": "搜索右侧面板页面",
      empty: "无匹配页面",
      unavailable: "此页面不可用",
      "renderer.missing": "无页面渲染器",
      current: "当前",
    };
    const EN_DICT = {
      "panel.title": "Right Panel",
      "panel.region": "Right panel",
      "panel.regionCollapsed": "Right panel (collapsed)",
      "panel.rail": "Right panel pages",
      "panel.page": "Right panel page",
      collapse: "Collapse right panel",
      "collapse.rail": "Collapse right panel into icon rail",
      expand: "Expand right panel",
      more: "More pages",
      "more.label": "More right panel pages",
      search: "Search pages",
      "search.label": "Search right panel pages",
      empty: "No matching pages",
      unavailable: "This page is unavailable",
      "renderer.missing": "No page renderer",
      current: "Current",
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    function createPageRegistry() {
      const pages = new Map();
      const listeners = new Set();
      let activeId = null;
      let snapshot = { pages: [], activeId: null };

      const sortedPages = () => [...pages.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
      const emit = () => {
        snapshot = { pages: sortedPages(), activeId };
        for (const listener of listeners) listener();
      };

      const firstPageId = () => {
        const first = sortedPages()[0];
        return first === undefined ? null : first.id;
      };

      const registerPage = (definition) => {
        if (definition === null || typeof definition !== "object") return () => {};
        const id = typeof definition.id === "string" ? definition.id.trim() : "";
        if (id === "") return () => {};
        const page = {
          id,
          title: typeof definition.title === "string" && definition.title.trim() !== "" ? definition.title : id,
          group: typeof definition.group === "string" && definition.group.trim() !== "" ? definition.group : "Other",
          order: Number.isFinite(definition.order) ? definition.order : 0,
          placement: definition.placement === "menu" ? "menu" : "rail",
          icon: definition.icon || null,
          badge: definition.badge,
        };
        pages.set(id, page);
        if (activeId === null || !pages.has(activeId)) activeId = id;
        emit();
        return () => {
          if (pages.get(id) !== page) return;
          pages.delete(id);
          if (activeId === id) activeId = firstPageId();
          emit();
        };
      };

      const service = {
        registerPage,
        open(id) {
          if (!pages.has(id) || activeId === id) return;
          activeId = id;
          emit();
        },
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      return service;
    }

    function svgIcon(children, size = 16) {
      return React.createElement("svg", {
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      }, children);
    }

    const panelIcon = React.createElement(React.Fragment, null,
      React.createElement("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
      React.createElement("line", { x1: 8, y1: 4, x2: 8, y2: 20 }),
      React.createElement("line", { x1: 5, y1: 8, x2: 6, y2: 8 }),
      React.createElement("line", { x1: 5, y1: 12, x2: 6, y2: 12 }),
    );
    const moreIcon = React.createElement(React.Fragment, null,
      React.createElement("circle", { cx: 5, cy: 12, r: 1 }),
      React.createElement("circle", { cx: 12, cy: 12, r: 1 }),
      React.createElement("circle", { cx: 19, cy: 12, r: 1 }),
    );
    const searchIcon = React.createElement(React.Fragment, null,
      React.createElement("circle", { cx: 10.5, cy: 10.5, r: 6.5 }),
      React.createElement("line", { x1: 15.5, y1: 15.5, x2: 21, y2: 21 }),
    );
    const closeIcon = React.createElement(React.Fragment, null,
      React.createElement("line", { x1: 18, y1: 6, x2: 6, y2: 18 }),
      React.createElement("line", { x1: 6, y1: 6, x2: 18, y2: 18 }),
    );
    const expandIcon = React.createElement(React.Fragment, null,
      React.createElement("polyline", { points: "15 5 8 12 15 19" }),
    );
    const collapseIcon = React.createElement(React.Fragment, null,
      React.createElement("polyline", { points: "9 5 16 12 9 19" }),
    );

    function pageIcon(page, size) {
      if (typeof page.icon === "function") return page.icon(size);
      return page.icon || svgIcon(panelIcon, size);
    }

    function PageButton(props) {
      const page = props.page;
      const active = page.id === props.activeId;
      return React.createElement("button", {
        type: "button",
        className: "dsh-rp-rail-button" + (active ? " dsh-rp-rail-button-active" : ""),
        onClick: () => props.onSelect(page.id),
        title: page.title,
        "aria-label": page.title,
        "aria-current": active ? "page" : undefined,
      },
        pageIcon(page, 17),
        page.badge !== undefined && page.badge !== null && page.badge !== ""
          ? React.createElement("span", { className: "dsh-rp-badge" }, String(page.badge))
          : null,
      );
    }

    function createMoreMenu(t) {
      return function MoreMenu(props) {
      const [query, setQuery] = React.useState("");
      const normalized = query.trim().toLocaleLowerCase();
      const filtered = props.pages.filter((page) => {
        if (normalized === "") return true;
        return page.title.toLocaleLowerCase().includes(normalized)
          || page.group.toLocaleLowerCase().includes(normalized)
          || page.id.toLocaleLowerCase().includes(normalized);
      });
      const groups = [];
      const grouped = new Map();
      for (const page of filtered) {
        if (!grouped.has(page.group)) {
          const group = { name: page.group, pages: [] };
          grouped.set(page.group, group);
          groups.push(group);
        }
        grouped.get(page.group).pages.push(page);
      }
      return React.createElement("div", { className: "dsh-rp-menu", role: "menu" },
        React.createElement("div", { className: "dsh-rp-menu-search" },
          svgIcon(searchIcon, 14),
          React.createElement("input", {
            type: "search",
            value: query,
            autoFocus: true,
            placeholder: t("search"),
            "aria-label": t("search.label"),
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        React.createElement("div", { className: "dsh-rp-menu-list" },
          groups.length === 0
            ? React.createElement("div", { className: "dsh-rp-menu-empty" }, t("empty"))
            : groups.map((group) => React.createElement("div", { key: group.name, className: "dsh-rp-menu-group" },
                React.createElement("div", { className: "dsh-rp-menu-group-title" }, group.name),
                group.pages.map((page) => React.createElement("button", {
                  key: page.id,
                  type: "button",
                  className: "dsh-rp-menu-item" + (page.id === props.activeId ? " dsh-rp-menu-item-active" : ""),
                  role: "menuitem",
                  onClick: () => props.onSelect(page.id),
                },
                  React.createElement("span", { className: "dsh-rp-menu-item-icon" }, pageIcon(page, 16)),
                  React.createElement("span", { className: "dsh-rp-menu-item-label" }, page.title),
                  page.id === props.activeId ? React.createElement("span", { className: "dsh-rp-menu-item-current" }, t("current")) : null,
                )),
              )),
        ),
      );
      };
    }

    function createRightPanel(t) {
      const MoreMenu = createMoreMenu(t);
      return function RightPanel(props) {
      const service = props.rightPanel;
      const snapshot = React.useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
      const pages = snapshot.pages;
      const activeId = snapshot.activeId;
      const activePage = pages.find((page) => page.id === activeId) || pages[0] || null;
      const hasSession = typeof props.useSessions !== "function"
        ? true
        : props.useSessions((state) => {
            const current = state.current;
            if (current === undefined) return false;
            const row = state.byId[current];
            return row !== undefined && row.blank !== true;
          });
      const [collapsed, setCollapsed] = React.useState(false);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const controls = props.controls;

      const preferred = pages.filter((page) => page.placement !== "menu");
      const railPages = preferred.slice(0, MAX_RAIL_PAGES);
      const railIds = new Set(railPages.map((page) => page.id));
      const overflowPages = pages.filter((page) => !railIds.has(page.id));

      const openPage = (id) => {
        service.open(id);
        setMenuOpen(false);
        if (collapsed) {
          setCollapsed(false);
          controls.releaseRail();
          try { props.layout.openDetails(); } catch (_e) { }
          controls.restoreWidth();
        }
      };
      const collapse = () => {
        setMenuOpen(false);
        setCollapsed(true);
        controls.setRail(true);
        try { props.layout.closeDetails(); } catch (_e) { }
      };
      const expand = () => {
        setCollapsed(false);
        controls.releaseRail();
        try { props.layout.openDetails(); } catch (_e) { }
        controls.restoreWidth();
      };

      React.useEffect(() => {
        if (!hasSession || pages.length === 0) {
          controls.releaseRail();
          try { props.layout.closeDetails(); } catch (_e) { }
          return undefined;
        }
        setCollapsed(false);
        controls.releaseRail();
        try { props.layout.openDetails(); } catch (_e) { }
        controls.restoreWidth();
        return undefined;
      }, [hasSession, pages.length]);

      React.useEffect(() => () => {
        controls.releaseRail();
      }, []);

      if (!hasSession || pages.length === 0) return null;

      const renderedPage = typeof props.renderSlot === "function" && activePage !== null
        ? props.renderSlot("right-panel.page", { pageId: activePage.id }, {
            entryKey: activePage.id,
            fallback: React.createElement("div", { className: "dsh-rp-empty" }, t("unavailable")),
          })
        : React.createElement("div", { className: "dsh-rp-empty" }, t("renderer.missing"));

      const rail = React.createElement("div", {
        className: "dsh-rp-rail",
        role: "tablist",
        "aria-label": t("panel.rail"),
      },
        railPages.map((page) => React.createElement(PageButton, {
          key: page.id,
          page,
          activeId,
          onSelect: openPage,
        })),
        overflowPages.length > 0
          ? React.createElement("button", {
              type: "button",
              className: "dsh-rp-rail-button dsh-rp-more-button" + (menuOpen ? " dsh-rp-rail-button-active" : ""),
              onClick: () => setMenuOpen((value) => !value),
              title: t("more"),
              "aria-label": t("more.label"),
              "aria-expanded": menuOpen,
            }, svgIcon(moreIcon, 17))
          : null,
        React.createElement("div", { className: "dsh-rp-rail-spacer" }),
        collapsed
          ? React.createElement("button", {
              type: "button",
              className: "dsh-rp-rail-button",
              onClick: expand,
              title: t("expand"),
              "aria-label": t("expand"),
            }, svgIcon(expandIcon, 17))
          : null,
      );

      const main = React.createElement("div", {
        className: "dsh-rp-main" + (collapsed ? " dsh-rp-main-collapsed" : ""),
      },
        collapsed
          ? null
          : React.createElement(React.Fragment, null,
              React.createElement("div", { className: "dsh-rp-header" },
                React.createElement("button", {
                  type: "button",
                  className: "dsh-rp-icon-button",
                  onClick: collapse,
                  title: t("collapse"),
                  "aria-label": t("collapse.rail"),
                }, svgIcon(collapseIcon, 16)),
                React.createElement("div", { className: "dsh-rp-header-icon" }, activePage ? pageIcon(activePage, 16) : svgIcon(panelIcon, 16)),
                React.createElement("div", { className: "dsh-rp-title" }, activePage ? activePage.title : t("panel.title")),
              ),
              React.createElement("div", { className: "dsh-rp-page", role: "tabpanel", "aria-label": activePage ? activePage.title : t("panel.page") }, renderedPage),
            ),
      );

      return React.createElement("div", {
        className: "dsh-rp-shell" + (collapsed ? " dsh-rp-shell-collapsed" : ""),
        role: "region",
        "aria-label": collapsed ? t("panel.regionCollapsed") : t("panel.region"),
      },
        main,
        rail,
        menuOpen
          ? React.createElement(MoreMenu, { pages: overflowPages, activeId, onSelect: openPage })
          : null,
      );
      };
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      const layout = ctx.get("layout");
      if (slots === undefined || layout === undefined) return;
      const locale = ctx.get("locale");
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "right-panel: locale");
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
      const RightPanel = createRightPanel(t);

      const style = document.createElement("style");
      style.id = "dsh-plugin-right-panel-style";
      style.setAttribute("data-plugin", "dsh-plugin-right-panel");
      style.textContent = `
.dsh-rp-shell,
.dsh-rp-shell-collapsed {
  position: relative;
  height: 100%;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-rp-main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dsh-rp-main-collapsed {
  visibility: hidden;
  pointer-events: none;
}
.dsh-rp-header {
  flex: 0 0 auto;
  min-height: 48px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-rp-header-icon {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-rp-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.dsh-rp-icon-button,
.dsh-rp-rail-button {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #57534e);
  cursor: pointer;
}
.dsh-rp-icon-button {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}
.dsh-rp-icon-button:hover,
.dsh-rp-rail-button:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-rp-rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  padding: 10px 6px;
  overflow-y: auto;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
}
.dsh-rp-rail-button {
  position: relative;
}
.dsh-rp-rail-button-active {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-brand-primary, #4f46e5);
}
.dsh-rp-rail-spacer {
  flex: 1 1 auto;
  min-height: 8px;
}
.dsh-rp-badge {
  position: absolute;
  top: 2px;
  right: 1px;
  min-width: 14px;
  height: 14px;
  box-sizing: border-box;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--dsw-alias-state-error-primary, #b91c1c);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}
.dsh-rp-page {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.dsh-rp-empty {
  height: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 12px;
  text-align: center;
}
.dsh-rp-menu {
  position: absolute;
  z-index: 30;
  right: 48px;
  bottom: 8px;
  width: min(268px, calc(100% - 64px));
  max-height: min(72vh, 460px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
}
.dsh-rp-menu-search {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 36px;
  box-sizing: border-box;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-rp-menu-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 12px;
}
.dsh-rp-menu-list {
  min-height: 0;
  overflow-y: auto;
  padding: 5px;
}
.dsh-rp-menu-group + .dsh-rp-menu-group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-rp-menu-group-title {
  padding: 4px 8px;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.dsh-rp-menu-item {
  width: 100%;
  min-height: 34px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.dsh-rp-menu-item:hover,
.dsh-rp-menu-item-active {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-rp-menu-item-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-rp-menu-item-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-rp-menu-item-current {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 10px;
}
.dsh-rp-menu-empty {
  padding: 18px 10px;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 12px;
  text-align: center;
}
[data-dsh-rp-rail] {
  grid-template-columns: var(--dsh-rp-sidebar, 280px) minmax(0, 1fr) 56px !important;
}
`;
      document.head.append(style);
      ctx.effect(() => () => style.remove(), "right-panel stylesheet");

      let panelActions = null;
      let savedWidth = 0;
      try {
        savedWidth = Number(window.localStorage.getItem(WIDTH_KEY)) || Number(window.localStorage.getItem(LEGACY_WIDTH_KEY)) || 0;
      } catch (_e) { }

      const findDetailsColumn = () => {
        const byClass = document.querySelector('[class*="detailsCol"]');
        if (byClass !== null) return byClass;
        const handle = document.querySelector('[data-side="details"]');
        return handle !== null ? handle.previousElementSibling : null;
      };
      const persistWidth = () => {
        const column = findDetailsColumn();
        if (column === null) return;
        const width = Math.round(column.getBoundingClientRect().width);
        if (width < WIDTH_MIN) return;
        savedWidth = width;
        try { window.localStorage.setItem(WIDTH_KEY, String(width)); } catch (_e) { }
      };
      const onDocumentPointerUp = () => persistWidth();
      document.addEventListener("pointerup", onDocumentPointerUp, true);
      ctx.effect(() => () => document.removeEventListener("pointerup", onDocumentPointerUp, true));

      if (typeof Object.getPrototypeOf(layout).attachPanels === "function") {
        const proto = Object.getPrototypeOf(layout);
        const originalAttach = proto.attachPanels;
        proto.attachPanels = function (actions) {
          panelActions = actions;
          return originalAttach.call(this, actions);
        };
        ctx.effect(() => () => { proto.attachPanels = originalAttach; });
      }
      const restoreWidth = () => {
        if (savedWidth < WIDTH_MIN || panelActions === null || typeof panelActions.setDetails !== "function") return;
        try { panelActions.setDetails(savedWidth); } catch (_e) { }
      };

      let railActive = false;
      const frameOfDetails = () => {
        const column = findDetailsColumn();
        return column === null ? null : column.parentElement;
      };
      const syncRailVar = () => {
        const frame = frameOfDetails();
        if (frame === null) return;
        const sideCol = frame.children.length > 0 ? frame.children[0] : null;
        const sidebarPx = sideCol === null ? 280 : Math.round(sideCol.getBoundingClientRect().width);
        try { frame.style.setProperty("--dsh-rp-sidebar", `${sidebarPx}px`); } catch (_e) { }
      };
      const applyRail = () => {
        const frame = frameOfDetails();
        if (frame === null) return;
        if (railActive) {
          frame.setAttribute("data-dsh-rp-rail", "");
          syncRailVar();
        } else {
          frame.removeAttribute("data-dsh-rp-rail");
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
            railObserver.disconnect();
            const currentFrame = frameOfDetails();
            if (currentFrame !== null) currentFrame.removeAttribute("data-dsh-rp-rail");
            railActive = false;
          };
        });
      }

      const controls = {
        setRail(active) {
          railActive = active;
          applyRail();
        },
        releaseRail,
        restoreWidth,
      };
      const rightPanel = createPageRegistry();
      ctx.effect(() => {
        const disposeService = ctx.reflect.provide("rightPanel", rightPanel);
        const disposeDetails = slots.register({
          name: "details",
          id: "right-panel",
          // Boot plugins see the raw SlotRegistry (no auto-allocated shadowing
          // priority like dynamic loads get), and the built-in details panel
          // registers at priority 0. Register lower so this host shadows it.
          priority: -1,
          children: {
            "right-panel.page": { kind: "keyed", scope: "session" },
          },
          inject: () => ({ rightPanel }),
        }, (props) => React.createElement(RightPanel, {
          ...props,
          layout,
          controls,
          rightPanel,
        }));
        return () => {
          disposeDetails();
          disposeService();
          controls.releaseRail();
        };
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

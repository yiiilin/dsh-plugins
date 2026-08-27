# @yiln-dsh/dsh-plugin-right-panel

A fixed right-side page host for the DSH Web GUI.

The plugin owns the built-in `details` Slot once and renders contributed pages
through a keyed `right-panel.page` child Slot. Other Client plugins register
page metadata through the `rightPanel` Client service and register the matching
page body in that child Slot.

## Layout

- A stable header shows the active page title and collapse action.
- A 56px icon rail keeps the most important pages available.
- Additional pages are grouped and searchable from the overflow menu.
- Collapsing the panel keeps a real right-edge rail in the application layout.
- The panel width is persisted under `dsh-plugin-right-panel.detailsWidth`;
  the previous file-explorer width key is read once as a migration fallback.

## Client page contract

The service is available as `ctx.get('rightPanel')` after the plugin is mounted.
A page registers metadata such as `id`, `title`, `icon`, `group`, `order`, and
`placement` (`rail` or `menu`). Its body is registered in the keyed
`right-panel.page` Slot with the same `key`.

The Slot name and registration options are the public extension seam. The
right-panel shell owns navigation, active-page state, overflow management,
width, and collapse behavior.

## Install

The package version is `@yiln-dsh/dsh-plugin-right-panel@0.1.0`.

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-right-panel
```

Or from npm:

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-right-panel@latest
```

The page-contributing plugin (for example
`@yiln-dsh/dsh-plugin-file-explorer`) must also be installed in the same
`web` profile; restart `dsh web` after install so the client bundle loads.

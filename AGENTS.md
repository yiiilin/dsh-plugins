# AGENTS.md

Guidance for agents working in this repository. Follow these rules unless the
human explicitly overrides them.

## Repository layout

- Each plugin lives in its own `dsh-plugin-<name>/` directory and is a
  standalone npm package (`@yiln-dsh/dsh-plugin-<name>`).
- The root `README.md` keeps a plugin table and a version table; each plugin
  directory has its own `README.md` that documents the plugin.
- Local installs use `file:` dependencies copied into
  `~/.dsh/profiles/web/node_modules/`. `link:` dependencies (e.g.
  `dsh-plugin-right-panel`) point at the source and always reflect changes;
  `file:` copies only refresh on reinstall (`dsh plugin --profile web remove`
  + `add file:/path/to/dsh-plugin-<name>`).

## Release rule — README must be updated with every new version

Every release **must** update the README files in the same change that bumps
the version. Do not bump `package.json` or run `npm publish` with stale docs.

Before publishing a new version:

1. Bump the `version` field in `dsh-plugin-<name>/package.json` (semver:
   patch for fixes, minor for additive features, major for breaking changes).
2. Update the plugin's own `README.md`:
   - the published-package version line, e.g.
     `The published package is \`@yiln-dsh/dsh-plugin-<name>@x.y.z\`.`,
   - any tarball file-name examples that embed the version,
   - the feature description when the release adds or changes behavior.
3. Update the version table in the root `README.md` to the new version.
4. Commit the `package.json` bump and the README updates together in one
   commit, then `git push origin main`.
5. Only then run `npm publish --access public` from the plugin directory.

## i18n rule

All user-visible text in client modules must go through the plugin's
locale dictionary (`ZH_DICT` / `EN_DICT` registered via
`ctx.locale.register(LOCALE_NS, { zh, en })` and bound with
`locale.bind(LOCALE_NS)`), never hardcoded strings. Adding new UI copy
requires adding the key to both dictionaries in the same change.

## Verification

- Run `node --check` on every changed `.js` file before committing.
- After modifying a plugin, keep the local profile in sync: reinstall the
  `file:` copies if the change needs to take effect locally, and remember
  that the running daemon loads plugins only at startup.
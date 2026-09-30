# Unified Suite Verification

## Contract and Structure

Root package: `@yiln-dsh/dsh-plugins@0.1.0` (unpublished).
Target: DSH `0.2.0-rc.2`; one package manifest, dependency tree, version,
bundle patch and generated public Client entry.

Six Host rows keep their Loader IDs and full Config exports. A no-op bare
package row anchors Client discovery. Five browser factories are composed as
independent Cordis children; activation awaits them and the parent owns style
cleanup. Mentor has a unique stylesheet ID to avoid suite-level deduplication
collisions. Source Client registration wrappers are internal inputs to the
builder, not additional public Client entries.

The root package and migration contract tests failed before implementation
(missing root manifest/client and migration module), then passed. The old
standalone code was copied first so production remained usable until cutover.
Old source/dependency trees were archived only after production verification.

## Checks

- `npm test`: 235 passed, 0 failed, including all prior feature regressions.
- `npm run check`: six Host exports, original Config schemas, unique Loader IDs,
  bare anchor, and all JavaScript syntax validated.
- Packed artifact: one manifest, no legacy npm package directories, no test or
  dependency-cache directories; all three PWA PNGs and runtime helpers present.
- `DSH_EDITOR_QA_URL=http://172.17.0.7:3096/ npm run test:editor`: 7 passed.
- Fresh Node 24 container installed the tarball, not workspace-source shortcuts.
- Plugin inventory displayed one suite. Auth/Web Daemon/Mentor settings tabs
  loaded; all five UI stylesheet owners coexisted, including Mentor.
- Mentor concurrency saved to the original dsh-mentor row and the new module
  address. No external model request was made.
- Metrics, PWA manifest/icon, Markdown-it and Monaco loader returned 200.
- Real repository Git log returned 10 commits; nonexistent delete returned 404.
- A separate six-package legacy profile rehearsal removed all old packages,
  migrated only the two known names and ended with one installed suite.
- Browser startup tests handle both asynchronously appearing and already
  accepted preview notices; the earlier readiness race was corrected in tests.

## Production

The independent systemd transaction stopped the worker, backed up the complete
DSH_HOME, removed six old packages, changed only the Web Daemon and Mentor module
references through the YAML syntax tree, installed the root `file:` package,
validated other dependencies/configuration values, and restarted the worker.

- DSH version unchanged: 0.2.0-rc.2.
- Core 3080 endpoint: expected 401; authenticated gateway login page: 200.
- Profile dependencies: suite, existing Archify, existing local agent preset.
- Auth secret and Passkey records compared byte-for-byte: unchanged.
- Original 3080 GUI: single suite enabled; three configuration tabs, Mentor
  styles and server metrics present; no page errors reported.
- Model/configuration values retained; only known Loader name fields changed.

Backup and archived old project trees:
`/var/backups/dsh-suite-migration-20260930/`.
The migration did not delete or rename persistent plugin-state directories,
Mentor producer/journal identities, cookie names, HTTP endpoints or Git tab IDs.

## Rollback and Limits

After source cleanup, an operator rolling back must stop the worker and restore
both the old Web profile from the DSH_HOME backup and the old project directories
from legacy-workspace to their original paths. Do not overwrite newer Session
or plugin state indiscriminately; preserve it before a rollback.

The suite reuses unchanged business implementations. This pass does not certify
live external Mentor/provider calls, real systemd GUI actions, phone soft-keyboard
behavior, or complete running-child recovery with the new package. Existing fake
boundary tests cover the retained replay, cache and recovery contracts. Individual
Host-row disable does not automatically unload that module's aggregate Client.
Disabling the entire suite remotely can remove the gateway; keep core/SSH access.

No npm release, git commit or push is performed by the consolidation task.

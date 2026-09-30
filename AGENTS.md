# AGENTS.md

## Project Layout

- The workspace root is one npm package: `@yiln-dsh/dsh-plugins`.
- Internal modules live under `src/<feature>/`; they are not independent npm packages.
- Root `package.json` owns the only plugin version, dependencies and scripts.
- Edit Client sources under `src/`, then run `npm run build` to regenerate `client.js`.
- Root `cordis.patch.yml` retains separate feature rows and their Config schemas.

## Compatibility and Migration

Preserve Loader row IDs, HTTP paths, locale/slot IDs, Git tab identity, cookie
names, Auth/Daemon state directories and Mentor producer/journal identities.
Only package/module addresses change when reorganizing the suite. Use the
structured migration helper for old profile `name` overrides; do not globally
replace legacy strings or print configuration secrets.

Local `file:` installs must be refreshed after edits. Test packed installs in an
isolated DSH profile before changing the live profile. A live daemon restart
must run in an independent task with backup, health checks and rollback.

## Verification

Run `npm run build`, `npm run check`, and `npm test` before committing.
Use the Auth fixture and `npm run test:editor` for configuration-editor browser
regressions. Mutating browser tests must use isolated data and test credentials.

## UI Text

All user-visible Client copy goes through each module's locale dictionary.
Add matching keys to both Chinese and English dictionaries in the same change.

## Release

Bump only the root version. Update the root README and compatibility notes in the
same change. Commit/push when requested, and do not publish without an explicit
release request. A release must include regenerated Client output and tests.

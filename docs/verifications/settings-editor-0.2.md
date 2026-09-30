# Settings Editor Regression Verification

## Scope

User-reported Models > Edit configuration file overlap in DSH `0.2.0-rc.2`.
The existing unreleased compatibility work is preserved. This change is part of
Auth Webserver candidate `0.10.5`; no npm publication is performed.

## Reproduction and Root Cause

A disposable Node 24 container copies the installed DSH runtime and installs
only the workspace Auth plugin. It has a separate DSH_HOME, synthetic login,
and two synthetic model providers. No production credentials are used.

The old editor was an inline child of `settings.action`, inside the fixed-height
Settings header flex row. At 803x523 its width was 333.9px and all nine textarea
hit-test samples landed on provider rows or buttons. The mobile Settings CSS
also raises its layer to 1100, above the product modal's default 1000.

The corrected editor uses the product headless Modal/body portal, capped
viewport dimensions, shared keyboard focus ownership, and an explicit mobile
portal layer above Settings. The actual configuration filename is reported by
the Host. Modern profile patch lists are validated separately from legacy YAML
mappings; `!!js` tags are parsed as inert text, not evaluated by the validator.

## RED / GREEN Evidence

Commands run from the Auth plugin directory:

```bash
DSH_EDITOR_QA_URL=http://172.17.0.7:3095/ node --test test/e2e/settings-editor.test.js
node --test test/settings-editor.test.js
npm test
node --test --experimental-test-coverage --test-coverage-include='**/settings-editor.js' test/settings-editor.test.js
```

| Guarantee | RED evidence | GREEN evidence |
| --- | --- | --- |
| Model cards cannot cover the editor | All 9 hit-test points covered; editor width 333.9px | Four viewports: 803x523, 1440x900, 768x1024, 375x812 |
| Mobile Settings cannot cover the editor | All 9 points hit Settings despite a visible portal | All mobile samples hit the editor |
| Tab/Shift+Tab stay in the child; Escape/backdrop preserve Settings | Behavior-preservation check | Models, General, and Built-in plugins journeys pass |
| The editor handles Escape before document consumers | Earlier document handler prevented default and left the editor open | Foreground modal capture closes only the editor |
| Dirty dismissal preserves the draft and asks only once | Behavioral assertions | Cancel and subsequent save pass |
| A failed reload retains unsaved-change protection | Escape closed without asking: 0 confirmations | Draft retained and confirmation count 1 |
| A stalled save has a recovery path | UI stayed at Saving with no deadline | Abort deadline restores Close/Reload, retains draft, blocks blind re-save |
| Modern profile patches can be saved | Valid patch list/!!js rejected as invalid YAML or mapping | Real browser POST saves and GET returns exact content |
| The editor identifies its actual file | No filename returned; header fixed to settings.yaml | Modern cordis.patch.yml and legacy settings.yaml checks pass |
| File limits and optimistic concurrency remain enforced | Existing regression contract | Invalid YAML/providers/revisions and oversized documents rejected |

The stalled-request test shortens only the application's 30000ms timer to 50ms
and injects a pending POST; it checks abort/error handling, not server-side
cancellation. An aborted save has an unknown outcome and is never retried
automatically. Reloading is required before another write.

## Results

- Auth unit/integration suite: 113 passed, 0 failed.
- Browser journeys: 7 passed, 0 failed.
- settings-editor.js coverage: 100% lines, 100% branches, 100% functions.
- Changed JavaScript syntax checks and git diff --check pass.
- Synthetic desktop/mobile screenshots inspected; no provider overlap.
- Scoped axe audit of the editor in light and dark: 0 violations, 0 incomplete checks.
- Production synchronization succeeded using a separate systemd transaction with profile backup/rollback.
- Original `http://127.0.0.1:3080/` Models page: 803x523 editor width 755px, all 9 hit-test points unobscured; filename cordis.patch.yml.
- Original GUI at 375x812: editor width 327px, in viewport, all 9 points unobscured; Escape closes only the editor and preserves Settings.
- Desktop Escape returns focus to the editor launcher. Browser reported no page errors.
- Production configuration compared byte-for-byte with the deployment backup after verification: unchanged. No production Save action was invoked.

## Limits

This is not whole-plugin coverage certification. Phone soft-keyboard behavior,
visualViewport changes, plugin unload during a write, and server-side write
cancellation are not certified. No production configuration is saved during
post-deployment smoke testing. Existing upgrade edits were preserved throughout
validation. No git history was rewritten and no npm release was published.

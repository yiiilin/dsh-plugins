#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCLI, runCLI, rootDir } from './lib.mjs';
import { planInstall, publicPlan, applyPlan, doctor } from './project-install.mjs';

export function runInstall(argv = process.argv.slice(2), { legacyInit = false, upgrade = false } = {}) {
  const args = parseCLI(argv, {
    '--host': 'value', '--rules-file': 'value', '--skill-dir': 'value', '--mode': 'value',
    '--docs-dir': 'value', '--language': 'value', '--layout': 'value', '--apply': 'flag', '--dry-run': 'flag', '--json': 'flag',
  });
  const command = upgrade ? 'upgrade.mjs' : 'install.mjs';
  if (args.flags.help) {
    if (legacyInit) console.log('init.mjs is a deprecated compatibility alias of install.mjs. No configuration-only initialization remains.');
    console.log(`Usage: node ${command} [project] [--host auto|agents|codex|claude|both|custom] [--rules-file FILE.md]\n`
      + '  [--skill-dir .agents/skills/doc-driven-development] [--mode incremental|full]\n'
      + '  [--docs-dir docs] [--language zh-CN] [--layout domain|preserve] [--apply | --dry-run] [--json]\n'
      + 'Default: read-only preview. --apply safely installs/updates owned files and bounded rule blocks.\n'
      + 'A complete project setup includes package + bounded rule entries + configuration/index + receipt + static check.\n'
      + 'Existing prose/configuration is preserved. There is intentionally no --force. See INSTALL.md.'); return;
  }
  if (args.flags.apply && args.flags['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive.');
  const root = rootDir(args.root), plan = planInstall(root, args.flags), output = publicPlan(plan);
  const before = doctor(root);
  output.entrypoint = legacyInit ? 'init-compat' : upgrade ? 'upgrade' : 'install';
  output.documents = { action: 'preserved', migration: 'not-run', notice: 'Skill update is not a project-document migration or evidence refresh. Read UPGRADE.md.' };
  output.sourceVersion = output.version;
  output.previousVersion = before.installedVersion ?? null;
  output.versionChanged = output.previousVersion !== output.version;
  output.activationBefore = before.activation;
  output.setupComplete = false;
  output.applied = Boolean(args.flags.apply);
  if (args.flags.apply) {
    output.result = applyPlan(plan); output.doctor = doctor(root);
    output.setupComplete = output.doctor.activation === 'ready';
    if (!output.setupComplete) process.exitCode = 1;
  }
  output.activation = output.doctor?.activation ?? before.activation;
  if (args.flags.json) console.log(JSON.stringify(output, null, 2));
  else {
    if (upgrade) console.log('UPGRADE from this local release; no network/latest lookup. Existing project documents and approvals are preserved.');
    if (legacyInit) console.log('DEPRECATED init.mjs -> install.mjs: full setup only; never config-only activation.');
    console.log(`${output.applied ? 'APPLIED' : 'PREVIEW ONLY'}: ${root} — v${output.version}`);
    for (const c of output.changes) console.log(`${c.operation.toUpperCase()} ${c.path} — ${c.reason}`);
    for (const w of output.warnings) console.log(`WARN ${w}`);
    console.log(`Rule entries: ${output.rules.map(r => `${r.path} (${r.adapter})`).join(', ')}`);
    if (output.applied) {
      console.log(`Changed: ${output.result.changed}; backup/journal: ${output.result.backup ?? 'none (no change)'}`);
      console.log(`Project activation: ${output.activation}; static installation: ${output.doctor.static}; agent runtime: not-run.`);
      if (!output.setupComplete) console.error('SETUP INCOMPLETE: files may have been applied, but do not report the project as enabled/ready. Review doctor failures.');
      for (const e of output.doctor.errors) console.error(`FAIL ${e}`);
      for (const w of output.doctor.warnings) console.log(`WARN ${w}`);
      console.log(`Next: node ${output.skillPath}/scripts/doctor.mjs . --probe (then use the prompt in a NEW agent session).`);
    } else {
      for (const c of output.changes.filter(c => output.rules.some(r => r.path === c.path))) {
        console.log(`\n--- Proposed managed block in ${c.path} (existing prose is not rewritten) ---`);
        const start = c.proposedText.indexOf('<!-- doc-driven-development:begin -->');
        const end = c.proposedText.indexOf('<!-- doc-driven-development:end -->') + '<!-- doc-driven-development:end -->'.length;
        console.log(c.proposedText.slice(start, end));
      }
      console.log(`\nCurrent project activation: ${output.activation}. PREVIEW IS NOT ACTIVATION.`);
      console.log(`No files written. Setup is not completed by this command. Review this plan, then rerun ${command} with the same options and --apply.`);
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCLI(() => runInstall());

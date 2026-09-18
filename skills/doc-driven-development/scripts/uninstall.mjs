#!/usr/bin/env node
import { parseCLI, runCLI, rootDir } from './lib.mjs';
import { planUninstall, publicPlan, applyPlan } from './project-install.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--apply': 'flag', '--dry-run': 'flag', '--keep-skill': 'flag', '--json': 'flag' });
  if (args.flags.help) {
    console.log('Usage: node uninstall.mjs [project] [--apply | --dry-run] [--keep-skill] [--json]\n'
      + 'Default: preview. Removes only unchanged owned rule blocks and release files.\n'
      + 'Retains project configuration, all design documents, backups and unowned files. No --force.'); return;
  }
  if (args.flags.apply && args.flags['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive.');
  const plan = planUninstall(rootDir(args.root), args.flags), out = publicPlan(plan); out.applied = Boolean(args.flags.apply);
  if (args.flags.apply) out.result = applyPlan(plan);
  if (args.flags.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${out.applied ? 'APPLIED' : 'PREVIEW ONLY'}: uninstall ${out.project}`);
    for (const c of out.changes) console.log(`${c.operation.toUpperCase()} ${c.path} — ${c.reason}`);
    for (const w of out.warnings) console.log(`WARN ${w}`);
    if (out.applied) console.log(`Changed: ${out.result.changed}; backup/journal: ${out.result.backup ?? 'none'}`);
    else console.log('No files written. Rerun with --apply after review.');
  }
});

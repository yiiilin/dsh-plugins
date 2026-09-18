#!/usr/bin/env node
import { parseCLI, runCLI, rootDir } from './lib.mjs';
import { planInstall, publicPlan, applyPlan, doctor } from './project-install.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), {
    '--host': 'value', '--rules-file': 'value', '--skill-dir': 'value', '--mode': 'value',
    '--docs-dir': 'value', '--language': 'value', '--apply': 'flag', '--dry-run': 'flag', '--json': 'flag',
  });
  if (args.flags.help) {
    console.log('Usage: node install.mjs [project] [--host auto|agents|codex|claude|both|custom] [--rules-file FILE.md]\n'
      + '  [--skill-dir .agents/skills/doc-driven-development] [--mode incremental|full]\n'
      + '  [--docs-dir docs] [--language zh-CN] [--apply | --dry-run] [--json]\n'
      + 'Default: read-only preview. --apply safely installs/updates owned files and bounded rule blocks.\n'
      + 'Existing prose/configuration is preserved. There is intentionally no --force. See INSTALL.md.'); return;
  }
  if (args.flags.apply && args.flags['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive.');
  const root = rootDir(args.root), plan = planInstall(root, args.flags), output = publicPlan(plan);
  output.applied = Boolean(args.flags.apply);
  if (args.flags.apply) { output.result = applyPlan(plan); output.doctor = doctor(root); if (output.doctor.static !== 'passed') process.exitCode = 1; }
  if (args.flags.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`${output.applied ? 'APPLIED' : 'PREVIEW ONLY'}: ${root} — v${output.version}`);
    for (const c of output.changes) console.log(`${c.operation.toUpperCase()} ${c.path} — ${c.reason}`);
    for (const w of output.warnings) console.log(`WARN ${w}`);
    console.log(`Rule entries: ${output.rules.map(r => `${r.path} (${r.adapter})`).join(', ')}`);
    if (output.applied) {
      console.log(`Changed: ${output.result.changed}; backup/journal: ${output.result.backup ?? 'none (no change)'}`);
      console.log(`Static installation: ${output.doctor.static}; agent runtime: not-run.`);
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
      console.log('\nNo files written. Review this plan, then rerun with --apply.');
    }
  }
});

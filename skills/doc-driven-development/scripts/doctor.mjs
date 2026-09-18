#!/usr/bin/env node
import { parseCLI, runCLI, rootDir } from './lib.mjs';
import { doctor, probeText } from './project-install.mjs';

runCLI(() => {
  const args = parseCLI(process.argv.slice(2), { '--json': 'flag', '--strict': 'flag', '--probe': 'flag' });
  if (args.flags.help) {
    console.log('Usage: node doctor.mjs [project] [--json] [--strict] [--probe]\n'
      + 'Read-only installation/entry checks. enabled is only a request; activation is derived from actual setup. Never invokes an AI or edits any project file.\n'
      + '--strict: warnings also fail; --probe: print a smoke-test prompt for a NEW real agent session.\n'
      + 'Exit 0 means STATIC checks only passed, not agent obedience. Runtime always remains not-run.'); return;
  }
  const report = doctor(rootDir(args.root));
  if (args.flags.probe) report.probe = { prompt: probeText(),
    review: 'Compare actual session sources/tool-read trace against the listed rule entries, skill path and configured index. A self-reported list alone is not proof of automatic loading. See INSTALL.md.' };
  if (args.flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Requested enabled: ${report.requestedEnabled ?? 'unknown'} (configuration intent only).`);
    console.log(`Project activation: ${report.activation}; static installation: ${report.static}; agent runtime: ${report.runtime}.`);
    for (const c of report.checks) console.log(`${c.result === 'passed' ? 'OK' : 'FAIL'} ${c.name}`);
    for (const e of report.errors) console.error(`FAIL ${e}`);
    for (const w of report.warnings) console.log(`WARN ${w}`);
    if (report.next) {
      console.log(`Next: ${report.next.note}`);
      if (report.next.previewArgv) console.log(`Preview argv: ${JSON.stringify(report.next.previewArgv)}`);
    }
    console.log('No AI was invoked. ready means complete static setup, not proven runtime loading or obedience.');
    if (report.probe) console.log(`\n--- Copy only the following prompt into a NEW agent session ---\n${report.probe.prompt}\n--- Reviewer: inspect actual loaded sources and tool traces; do not accept an unsupported "I complied" ---`);
  }
  process.exitCode = report.errors.length || (args.flags.strict && report.warnings.length) ? 1 : 0;
});
